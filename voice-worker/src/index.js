/**
 * The Urdu voice endpoint, as a Worker.
 *
 * This is the same job as `api/tts.ts` — the sentence in, WAV out, with the key
 * held server-side — hosted where this project can actually reach it today, so
 * all three environments (dev, staging, production) speak without waiting for the
 * Vercel project to be created. When that project exists, `/api/tts` answers
 * first and this is the fallback; `src/services/cloudVoice.ts` tries in that order.
 *
 * `GEMINI_API_KEY` arrives as a Worker secret, not a variable and not a build-time
 * value: nothing here is inlined anywhere, and no device ever sees it.
 *
 * Deliberate limits, because the endpoint is public and the key is somebody's:
 *
 *   · POST only, Urdu only, and at most 900 characters per request — the client
 *     splits by sentence well below that.
 *   · Per-address throttle in the isolate. It forgets when the isolate recycles,
 *     which is the right trade for a free tier: it stops a loop, not a determined
 *     attacker, and the provider's own free-tier quota is the wall behind it.
 *   · The provider's error body is never forwarded, since it can echo the text.
 */

const MODEL = 'gemini-3.8-flash-tts';
const VOICE = 'Kore';
const LANGUAGE = 'ur-PK';

const SAMPLE_RATE = 24000;
const CHANNELS = 1;
const BITS = 16;

const MAX_CHARS = 900;

/** One request a second and forty a day per address, per isolate. */
const MIN_GAP_MS = 1000;
const DAILY_CAP = 40;

/** address → { last, count, day } */
const seen = new Map();

function throttled(address) {
  const today = new Date().toISOString().slice(0, 10);
  const entry = seen.get(address);
  const now = Date.now();

  if (!entry || entry.day !== today) {
    seen.set(address, { last: now, count: 1, day: today });
    return false;
  }
  if (entry.count >= DAILY_CAP) return true;
  if (now - entry.last < MIN_GAP_MS) return true;

  entry.last = now;
  entry.count += 1;
  return false;
}

function wav(pcm) {
  const header = new Uint8Array(44);
  const view = new DataView(header.buffer);
  const byteRate = (SAMPLE_RATE * CHANNELS * BITS) / 8;
  const blockAlign = (CHANNELS * BITS) / 8;

  header.set(new TextEncoder().encode('RIFF'), 0);
  view.setUint32(4, 36 + pcm.length, true);
  header.set(new TextEncoder().encode('WAVE'), 8);
  header.set(new TextEncoder().encode('fmt '), 12);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, CHANNELS, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, BITS, true);
  header.set(new TextEncoder().encode('data'), 36);
  view.setUint32(40, pcm.length, true);

  const out = new Uint8Array(44 + pcm.length);
  out.set(header, 0);
  out.set(pcm, 44);
  return out;
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function json(payload, status, origin) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': origin,
      Vary: 'Origin',
    },
  });
}

/**
 * Any origin is allowed because the same build is served from a Vercel
 * deployment, a laptop's dev server and a Capacitor WebView (`https://localhost`).
 * The endpoint is public and unauthenticated by design; the throttle and the
 * length cap are what keep it from being a free text-to-speech service.
 */
function allow(origin) {
  return origin || '*';
}

export default {
  async fetch(request, env) {
    const origin = allow(request.headers.get('Origin'));

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
          Vary: 'Origin',
        },
      });
    }

    if (request.method !== 'POST') {
      return json({ error: 'method-not-allowed' }, 405, origin);
    }

    if (!env.GEMINI_API_KEY) return json({ error: 'voice-not-configured' }, 503, origin);

    const address = request.headers.get('CF-Connecting-IP') ?? 'unknown';
    if (throttled(address)) return json({ error: 'voice-busy' }, 429, origin);

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'text-required' }, 400, origin);
    }

    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    if (!text || text.length > MAX_CHARS) {
      return json({ error: 'text-required', maxChars: MAX_CHARS }, 400, origin);
    }

    const language = typeof body?.language === 'string' ? body.language.toLowerCase() : LANGUAGE.toLowerCase();
    if (!language.startsWith('ur')) return json({ error: 'unsupported-language' }, 400, origin);

    let upstream;
    try {
      upstream = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
          body: JSON.stringify({
            contents: [{ parts: [{ text }] }],
            generationConfig: {
              responseModalities: ['AUDIO'],
              speechConfig: {
                languageCode: LANGUAGE,
                voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } },
              },
            },
          }),
        },
      );
    } catch {
      return json({ error: 'voice-upstream-failed' }, 502, origin);
    }

    if (upstream.status === 429) return json({ error: 'voice-busy' }, 429, origin);
    if (!upstream.ok) return json({ error: 'voice-upstream-failed', status: upstream.status }, 502, origin);

    const payload = await upstream.json().catch(() => null);
    const inline = payload?.candidates?.[0]?.content?.parts?.find((part) => part.inlineData?.data)?.inlineData;

    if (!inline?.data) return json({ error: 'voice-upstream-failed', reason: 'no-audio' }, 502, origin);

    const pcm = base64ToBytes(inline.data);
    const audio = String(inline.mimeType ?? '').includes('wav') ? pcm : wav(pcm);

    return new Response(audio, {
      status: 200,
      headers: {
        'Content-Type': 'audio/wav',
        'Content-Length': String(audio.length),
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': origin,
        Vary: 'Origin',
      },
    });
  },
};
