/**
 * The cloud voice.
 *
 * The app used to carry its own Urdu voice (Piper's model, 63 MB) and download
 * it on the farmer's phone. On a village connection that download is the whole
 * experience: the first press sits in silence while 63 MB arrives, and a
 * farmer who never gets it never hears the advice. So the voice is made on
 * the server now, and the phone only downloads a few kilobytes of MP3 per
 * sentence — fast even on a slow connection, and nothing to preload.
 *
 * The vendor is Fish Audio, and the key lives here, in the function's
 * environment (`FISH_AUDIO_API_KEY`). A key in the APK is a key published
 * on the internet. The voice is Ayesha, a Fish official Urdu voice — natural,
 * conversational, clear. There is no Saraiki voice in Fish's library, so the
 * Urdu voice reads the Urdu advice, a native Saraiki speaker speaking Urdu.
 * The pace is a quarter slower than the model's own, which is the speed the
 * advice is written to be heard at.
 *
 * Routes, after the function name — there are none. This function answers the
 * bare path, not a sub-route, so the client's call is a plain POST to the
 * function URL:
 *
 *   POST /speak  { text, speakingRate? }  → audio/mpeg
 *   GET  /speak                           → { ok, configured, voice }
 *
 * The health answer is booleans and a name only. It answers "is the key
 * working?" without ever echoing the key — a health check that prints a
 * prefix of a secret is a health check that leaks it.
 *
 * Two guards bound what one call can cost:
 *
 *   · The text is capped at 500 characters. A narration part is under 200,
 *     so the cap never binds a real reading — it binds a caller sending a
 *     whole page.
 *   · The free model (`s2.1-pro-free`) costs $0, but it is a fair-use
 *     prototype model with no latency guarantees, so a slow or refused
 *     generation is answered by falling back, not by retrying it three
 *     times.
 */

import { CORS, clean, fail, json, preflight, readJson } from '../_shared/server.ts';

/**
 * The Fish Audio API key.
 *
 * Read from the function's environment, never from code and never from the
 * client. Set it with `supabase secrets set FISH_AUDIO_API_KEY=<redacted>`
 * (or in the dashboard's function secrets). Until it is set the function
 * answers 503 and the app falls back to the voice it carries — the press
 * still works, only slower.
 */
const TTS_KEY_ENV = 'FISH_AUDIO_API_KEY';

/**
 * The voice to read with: Ayesha, a Fish official Urdu voice.
 *
 * The ID is a public voice-library identifier, not a secret — it names the
 * voice the way a library card names a book. Ayesha is female, young adult,
 * tagged natural, conversational, professional and clear, and she reads short
 * weather and farming advice in fluent Urdu. Fish publishes no Saraiki
 * voice, so this is the closest a free voice gets: the Urdu voice reads the
 * Urdu advice.
 */
const VOICE_ID = '1737c90ee182475ebefdd4684b6ab1f6';

/** The free model: $0, for testing, prototyping and small use. */
const MODEL = 's2.1-pro-free';

/** The language the advice is written in. Fish publishes no Saraiki voice. */
const LANGUAGE = 'ur';

/**
 * How much text one request may carry.
 *
 * A narration part is a sentence under 200 characters, so this never binds a
 * real reading — it binds a caller sending a whole page, which is how one
 * request becomes a bill.
 */
const MAX_TEXT_CHARS = 500;

/**
 * How much slower the voice reads than the model's own pace.
 *
 * The advice is written to be heard in a field, not skimmed on a screen, so
 * it reads a quarter slower. The client may pass its own rate; the default
 * is this one. Fish Audio's prosody speed runs 0.5 to 2.0, so a rate below
 * 0.5 is raised to 0.5 rather than refused.
 */
const SPEAKING_RATE = 0.8;

/** Fish Audio, text-to-speech endpoint. */
const TTS_URL = 'https://api.fish.audio/v1/tts';

type Synthesis =
  | { audio: Uint8Array }
  | { error: string; status: number };

/**
 * Makes the audio for one sentence.
 *
 * Returns the MP3 bytes, or an error with the status the client should see.
 * A missing key is a 503 — the service is not configured, which the app
 * answers by falling back to the voice it carries, not by failing the press.
 * Fish Audio returns the audio as a stream of MP3 bytes, not as JSON, so the
 * body is read as bytes; an error answer is JSON, and only its status is
 * used, never its text.
 */
async function synthesise(text: string, speakingRate: number): Promise<Synthesis> {
  const key = Deno.env.get(TTS_KEY_ENV) ?? null;
  if (!key) {
    return { error: 'The voice service is not configured on the server.', status: 503 };
  }

  const response = await fetch(TTS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      /* The key travels in a header, not in the URL — a URL is logged, a
         header is not. */
      Authorization: `Bearer ${key}`,
      /* The model travels in its own header, not in the body — that is how
         Fish Audio selects it, and a body field of the same name is ignored. */
      model: MODEL,
    },
    body: JSON.stringify({
      text,
      language: LANGUAGE,
      reference_id: VOICE_ID,
      format: 'mp3',
      mp3_bitrate: 64,
      normalize: true,
      prosody: { speed: speakingRate },
    }),
  });

  if (response.ok) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength === 0) {
      return { error: 'The voice service returned no audio.', status: 502 };
    }
    return { audio: new Uint8Array(buffer) };
  }

  /*
   * A bad key (401/403) is not fixed by retrying, and a limit (429) or a
   * server error is not fixed by another voice — there is only one voice
   * here — so every refusal is reported at once instead of being retried
   * three times. The app answers any of these by falling back to the voice
   * it carries, so a refused press still speaks, only slower.
   */
  if (response.status === 401 || response.status === 403) {
    return { error: 'The voice service key is not valid on the server.', status: 503 };
  }
  return {
    error: `The voice service could not speak (${response.status}).`,
    status: 502,
  };
}

Deno.serve(async (req) => {
  const options = preflight(req);
  if (options) return options;

  if (req.method === 'GET') {
    return json({
      ok: true,
      configured: (Deno.env.get(TTS_KEY_ENV) ?? null) !== null,
      voice: VOICE_ID,
    });
  }

  if (req.method !== 'POST') return fail('Use POST.', 405);

  const body = await readJson<{ text?: unknown; speakingRate?: unknown }>(req);
  const text = clean(body?.text, MAX_TEXT_CHARS);
  if (!text) return fail('A text is required.');

  const speakingRate =
    typeof body?.speakingRate === 'number' && Number.isFinite(body.speakingRate)
      ? Math.min(2, Math.max(0.5, body.speakingRate))
      : SPEAKING_RATE;

  const result = await synthesise(text, speakingRate);
  if ('error' in result) return fail(result.error, result.status);

  return new Response(result.audio, {
    status: 200,
    headers: { ...CORS, 'Content-Type': 'audio/mpeg' },
  });
});
