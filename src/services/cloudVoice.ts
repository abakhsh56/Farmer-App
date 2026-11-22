/**
 * The Urdu voice, spoken by a cloud model through this app's own endpoint.
 *
 * This replaces a 63 MB Piper model and an 18 MB phonemiser that were shipped
 * inside the app. That bundle read beautifully with no network, but it cost every
 * install 79 MB and every live update the same 79 MB again — a download a farmer
 * on a rural connection pays for to receive a changed sentence. The voice is the
 * one feature that never needed to be local once a cheap cloud voice existed.
 *
 * What did NOT change is the contract with the screens: `speakWithAppVoice` still
 * asks for this app's Urdu voice and plays it part by part, sentence by sentence,
 * so the first sentence is heard while the rest is being made. `speech.ts` owns
 * that behaviour; this file only answers "give me the audio for this text".
 *
 * Three rules:
 *
 *  · **The key is never here.** The request goes to `/api/tts`, which is a
 *    serverless function holding `GEMINI_API_KEY`. A `VITE_` variable would be
 *    inlined into the JavaScript and shipped in the APK, where anyone can read it.
 *    `VITE_VOICE_ENDPOINT` only moves the endpoint, never carries a credential.
 *
 *  · **Urdu is read by an Urdu voice or not at all.** The endpoint is asked for
 *    `ur-PK` explicitly; there is no falling back to an English voice, because a
 *    farmer cannot tell a wrong-language reading from wrong advice.
 *
 *  · **A part is cached by its text.** Advice is stable for minutes and often
 *    pressed twice; the same sentence is not paid for twice in a session.
 */

/**
 * Where the voice endpoint lives.
 *
 * Two hosts, tried in order, because the same build runs in three places: the
 * Vercel deployment serves `/api/tts` same-origin, and the Worker below is the
 * endpoint that exists for the APKs and for a dev server, which has no functions
 * at all. The first that answers is remembered for the rest of the session, so the
 * farmer pays the failed attempt once.
 *
 * Both hold the key server-side; neither receives it from here. `VITE_VOICE_ENDPOINT`
 * overrides the first one for a deployment that hosts the function elsewhere.
 */
const PRIMARY = ((import.meta.env.VITE_VOICE_ENDPOINT as string | undefined) ?? '/api/tts').trim();
const FALLBACK = 'https://farmer-voice-urdu-tts-d1zqij.freebuff.site';

/** The host that last answered, so a dead primary is not retried every sentence. */
let chosen: string | null = null;

/**
 * How much text one request carries.
 *
 * The first part is what the farmer hears first, so it is the one that matters:
 * a whole passage in one request would make the pill silent until the last
 * sentence was synthesised. The split is on sentence ends, so a join is heard as
 * a pause rather than as two half-sentences.
 */
const CHUNK_CHARS = 220;

/** One synthesised part per sentence, kept for the life of the page. */
const parts = new Map<string, Blob>();

/**
 * Splits on sentence ends, then on length, and never mid-sentence unless a single
 * sentence is longer than one request may carry.
 */
function split(text: string): string[] {
  const sentences = text
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[۔۔?!?])\s+/)
    .filter((sentence) => sentence.length > 0);

  const chunks: string[] = [];
  let current = '';

  for (const sentence of sentences) {
    if (sentence.length > CHUNK_CHARS) {
      if (current) chunks.push(current);
      current = '';
      for (let index = 0; index < sentence.length; index += CHUNK_CHARS) {
        chunks.push(sentence.slice(index, index + CHUNK_CHARS));
      }
      continue;
    }
    if (current.length + sentence.length + 1 > CHUNK_CHARS) {
      chunks.push(current);
      current = sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

function candidates(): string[] {
  if (chosen) return [chosen];
  return [...new Set([PRIMARY, FALLBACK].filter((url) => url.length > 0))];
}

async function fetchPart(text: string, signal?: AbortSignal): Promise<Blob> {
  const cached = parts.get(text);
  if (cached) return cached;

  let lastError: Error | null = null;

  for (const endpoint of candidates()) {
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, language: 'ur-PK' }),
        signal,
      });
    } catch (failure) {
      if (signal?.aborted) throw failure;
      lastError = failure instanceof Error ? failure : new Error('The voice could not be reached.');
      continue;
    }

    if (response.ok) {
      const audio = await response.blob();
      chosen = endpoint;
      parts.set(text, audio);
      return audio;
    }

    /*
     * A refusal is a short machine code, not prose. 429 is the one answer worth
     * stopping for: the provider's own free-tier limit, which the other host would
     * hit just the same.
     */
    if (response.status === 429) {
      throw new Error('The Urdu voice is busy. Try again in a moment.');
    }

    const detail = await response.text().catch(() => '');
    lastError = new Error(`The Urdu voice is not available (${response.status}). ${detail}`.trim());
  }

  throw lastError ?? new Error('The Urdu voice is not available.');
}

/**
 * Synthesises `text` and hands each part over as it arrives.
 *
 * Returns true when at least one part was made. The caller plays them back to
 * back; a part that fails is skipped so one bad sentence does not cost the farmer
 * the rest of the advice.
 */
export async function synthesiseUrduSpeech(
  text: string,
  onPart: (audio: Blob) => void,
  signal?: AbortSignal,
): Promise<boolean> {
  const chunks = split(text);
  let handed = 0;

  for (const chunk of chunks) {
    if (signal?.aborted) break;
    try {
      onPart(await fetchPart(chunk, signal));
      handed += 1;
    } catch (failure) {
      /* The first part failing means no voice at all; later ones are skipped. */
      if (handed === 0) throw failure;
    }
  }

  return handed > 0;
}

/**
 * Gets the first part ready before the pill is pressed.
 *
 * Wired to hover and focus. A failure is silent: the press itself will report
 * whatever is wrong, and a warm-up must never produce a message the farmer did
 * not ask for.
 */
export function warmUrduVoice(text: string): void {
  const first = split(text)[0];
  if (!first) return;
  void fetchPart(first).catch(() => undefined);
}

/** Forgets the session's cached parts. Used by tests and after a language switch. */
export function clearVoiceCache(): void {
  parts.clear();
}
