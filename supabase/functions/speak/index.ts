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
 * The vendor is Google Cloud Text-to-Speech, and the key lives here, in the
 * function's environment (`GOOGLE_CLOUD_TTS_API_KEY`). A key in the APK is a
 * key published on the internet. The voice is Urdu (`ur-PK`), the natural
 * WaveNet female first — there is no Saraiki voice to prefer, because Google
 * publishes none, so the Urdu voice reads the Urdu advice, a native Saraiki
 * speaker speaking Urdu. The pace is a quarter slower than the model's own,
 * which is the speed the advice is written to be heard at.
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
 *   · The voice is retried only when Google refuses the *name* (400). A bad
 *     key (401/403), a limit (429) or a server error is not fixed by another
 *     voice, so it is reported at once instead of being retried three times.
 */

import { CORS, clean, fail, json, preflight, readJson } from '../_shared/server.ts';

/**
 * The Google Cloud Text-to-Speech key.
 *
 * Read from the function's environment, never from code and never from the
 * client. Set it with `supabase secrets set GOOGLE_CLOUD_TTS_API_KEY=<key>`
 * (or in the dashboard's function secrets). Until it is set the function
 * answers 503 and the app falls back to the voice it carries — the press
 * still works, only slower.
 */
const TTS_KEY_ENV = 'GOOGLE_CLOUD_TTS_API_KEY';

/**
 * The voices to try, in order.
 *
 * WaveNet first: its model was trained on recordings of people speaking, so
 * it carries the emphasis and inflection a flat voice drops. The female
 * first, then the male, then the standard female — a voice that does not
 * exist is a 400 from Google, and the next one is tried.
 */
const VOICES = ['ur-PK-Wavenet-A', 'ur-PK-Wavenet-B', 'ur-PK-Standard-A'];

/** The language the advice is written in. Google publishes no Saraiki voice. */
const LANGUAGE_CODE = 'ur-PK';

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
 * is this one.
 */
const SPEAKING_RATE = 0.8;

/** Google Cloud Text-to-Speech, synthesis endpoint. */
const TTS_URL = 'https://texttospeech.googleapis.com/v1/text:synthesize';

type Synthesis =
  | { audio: Uint8Array }
  | { error: string; status: number };

/**
 * Makes the audio for one sentence.
 *
 * Returns the MP3 bytes, or an error with the status the client should see.
 * A missing key is a 503 — the service is not configured, which the app
 * answers by falling back to the voice it carries, not by failing the press.
 */
async function synthesise(text: string, speakingRate: number): Promise<Synthesis> {
  const key = Deno.env.get(TTS_KEY_ENV) ?? null;
  if (!key) {
    return { error: 'The voice service is not configured on the server.', status: 503 };
  }

  for (const voice of VOICES) {
    const response = await fetch(TTS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        /* The key travels in a header, not in the URL — a URL is logged, a
           header is not. */
        'X-Goog-Api-Key': key,
      },
      body: JSON.stringify({
        input: { text },
        voice: { languageCode: LANGUAGE_CODE, name: voice },
        audioConfig: { audioEncoding: 'MP3', speakingRate },
      }),
    });

    if (response.ok) {
      const data = (await response.json()) as { audioContent?: unknown };
      if (typeof data.audioContent !== 'string' || data.audioContent.length === 0) {
        return { error: 'The voice service returned no audio.', status: 502 };
      }
      const binary = atob(data.audioContent);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      return { audio: bytes };
    }

    /*
     * Only a 400 is a property of the voice name — this voice does not exist,
     * so the next one is tried. A bad key (401/403), a limit (429) or a
     * server error is not fixed by another voice, and retrying it would bill
     * the same failure three times.
     */
    if (response.status !== 400) {
      const status = response.status === 401 || response.status === 403 ? 503 : 502;
      return {
        error:
          response.status === 401 || response.status === 403
            ? 'The voice service key is not valid on the server.'
            : `The voice service could not speak (${response.status}).`,
        status,
      };
    }
  }

  return { error: 'No Urdu voice is available from the voice service.', status: 502 };
}

Deno.serve(async (req) => {
  const options = preflight(req);
  if (options) return options;

  if (req.method === 'GET') {
    return json({
      ok: true,
      configured: (Deno.env.get(TTS_KEY_ENV) ?? null) !== null,
      voice: VOICES[0],
    });
  }

  if (req.method !== 'POST') return fail('Use POST.', 405);

  const body = await readJson<{ text?: unknown; speakingRate?: unknown }>(req);
  const text = clean(body?.text, MAX_TEXT_CHARS);
  if (!text) return fail('A text is required.');

  const speakingRate =
    typeof body?.speakingRate === 'number' && Number.isFinite(body.speakingRate)
      ? Math.min(2, Math.max(0.25, body.speakingRate))
      : SPEAKING_RATE;

  const result = await synthesise(text, speakingRate);
  if ('error' in result) return fail(result.error, result.status);

  return new Response(result.audio, {
    status: 200,
    headers: { ...CORS, 'Content-Type': 'audio/mpeg' },
  });
});
