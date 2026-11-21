/**
 * The Urdu voice endpoint.
 *
 * A serverless function, not client code, because the credential cannot be in the
 * app: anything the browser can read is inlined into the JavaScript and shipped
 * inside the APK. `GEMINI_API_KEY` lives here, in the deployment's environment,
 * and never reaches a device. This replaces the 79 MB on-device model the app
 * used to carry, which is what makes an APK and an OTA update small.
 *
 * The request is the same one Google documents for Gemini TTS: `generateContent`
 * with the AUDIO response modality and an explicit `ur-PK` speech config. Gemini
 * answers with raw PCM (24 kHz, 16-bit, mono) in base64, so the header is added
 * here — an `<audio>` element cannot play headerless PCM.
 *
 * Refusals are machine codes, not prose, so the app can say the one true thing:
 *
 *   503 voice-not-configured   the deployment has no GEMINI_API_KEY yet
 *   502 voice-upstream-failed  the provider answered, but not with audio
 *   429 voice-busy             the provider's free-tier rate limit was hit
 *   405 method-not-allowed     anything but POST
 *
 * Nothing here logs the text it was given or the key it used.
 */

type RequestBody = {
  text?: unknown;
  language?: unknown;
};

/** Model and voice are overridable so a rename never needs a code change. */
const MODEL = process.env.GEMINI_TTS_MODEL ?? 'gemini-3.8-flash-tts';
const VOICE = process.env.GEMINI_TTS_VOICE ?? 'Kore';
const LANGUAGE = 'ur-PK';

/** Gemini TTS returns 24 kHz, 16-bit, mono PCM. */
const SAMPLE_RATE = 24000;
const CHANNELS = 1;
const BITS = 16;

/** Longest text one request accepts. The app splits well before this. */
const MAX_CHARS = 900;

function wav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = (SAMPLE_RATE * CHANNELS * BITS) / 8;
  const blockAlign = (CHANNELS * BITS) / 8;

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(BITS, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

type HandlerRequest = {
  method?: string;
  body?: unknown;
};

type HandlerResponse = {
  status: (code: number) => HandlerResponse;
  setHeader: (name: string, value: string) => void;
  json: (body: unknown) => void;
  send: (body: Buffer) => void;
  end: (body?: string) => void;
};

function readBody(body: unknown): RequestBody {
  if (typeof body === 'string') {
    try {
      return JSON.parse(body) as RequestBody;
    } catch {
      return {};
    }
  }
  if (body && typeof body === 'object') return body as RequestBody;
  return {};
}

export default async function handler(req: HandlerRequest, res: HandlerResponse): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'method-not-allowed' });
    return;
  }

  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    /*
     * Deliberately 503 and not an empty 200: an app that cannot speak must be
     * able to tell the difference between "no key configured" and "the model has
     * nothing to say", and the farmer is never shown a broken player.
     */
    res.status(503).json({ error: 'voice-not-configured' });
    return;
  }

  const { text, language } = readBody(req.body);
  const spoken = typeof text === 'string' ? text.trim() : '';

  if (!spoken || spoken.length > MAX_CHARS) {
    res.status(400).json({ error: 'text-required', maxChars: MAX_CHARS });
    return;
  }

  // Urdu only: this endpoint exists to read one language, and a request for
  // another is a bug in the caller rather than a feature.
  const wanted = typeof language === 'string' ? language.toLowerCase() : LANGUAGE.toLowerCase();
  if (!wanted.startsWith('ur')) {
    res.status(400).json({ error: 'unsupported-language' });
    return;
  }

  const upstream = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': key,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: spoken }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            languageCode: LANGUAGE,
            voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } },
          },
        },
      }),
    },
  ).catch(() => null);

  if (!upstream) {
    res.status(502).json({ error: 'voice-upstream-failed' });
    return;
  }

  if (upstream.status === 429) {
    res.status(429).json({ error: 'voice-busy' });
    return;
  }

  if (!upstream.ok) {
    // The provider's own code, never its body: an error body can echo the input.
    res.status(502).json({ error: 'voice-upstream-failed', status: upstream.status });
    return;
  }

  const payload = (await upstream.json().catch(() => null)) as {
    candidates?: { content?: { parts?: { inlineData?: { data?: string; mimeType?: string } }[] } }[];
  } | null;

  const inline = payload?.candidates?.[0]?.content?.parts?.find((part) => part.inlineData?.data)?.inlineData;

  if (!inline?.data) {
    res.status(502).json({ error: 'voice-upstream-failed', reason: 'no-audio' });
    return;
  }

  const audio = Buffer.from(inline.data, 'base64');
  // Some responses already carry a WAV container; wrapping it again would make a
  // file no player opens.
  const body = inline.mimeType?.includes('wav') ? audio : wav(audio);

  res.setHeader('Content-Type', 'audio/wav');
  res.setHeader('Content-Length', String(body.length));
  res.status(200).send(body);
}
