/**
 * The parts a text is read in, in the order they are read: one sentence each.
 *
 * This is a latency decision, and it is measured rather than assumed. Making
 * the voice blocks this thread (onnxruntime in the page) and it runs at roughly three
 * quarters of real time on the machine this was written on: the weather advice is
 * 14 seconds of audio and takes about 18 seconds of model work. Packing several
 * sentences into one part therefore does not save the wait, it *hides* it as a
 * silence — and that is what a farmer heard. Every sentence is made on its own, so
 * a part is finished in about the time the part before it takes to listen to, and
 * the gaps land exactly on the sentence ends, where a pause is expected anyway.
 *
 * Two things follow that are worth knowing before changing this: a longer part is
 * not faster overall, only later; and the voice is genuinely slower than speech
 * here, which is why the fixes that matter are a smaller model or multi-threaded
 * wasm (`numThreads` in `load` is 1 — threads need cross-origin isolation).
 *
 * A single sentence longer than `limit` is still broken at a space, because a
 * voice that starts mid-word is the one artefact a listener cannot account for.
 *
 * Both audio voices — the cloud voice and the carried Piper voice — split the
 * text with this one function, so a reading stopped on one voice and resumed
 * on the other continues from the same sentence: the resume position is a part
 * index, and the index only means the same thing when the boundaries do.
 * The browser's own voice packs sentences instead (`splitForSpeech` in
 * `services/speech.ts`), so its indices do not line up with these.
 */

/** What one part may carry before it is broken at a space. */
export const VOICE_PART_CHARS = 200;

export function splitForVoice(text: string, limit = VOICE_PART_CHARS): string[] {
  const sentences = text
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?۔؟])\s+/)
    .filter((sentence) => sentence.length > 0);

  const parts: string[] = [];
  for (const sentence of sentences) {
    let rest = sentence;
    while (rest.length > limit) {
      const space = rest.lastIndexOf(' ', limit);
      const cut = space > 0 ? space : limit;
      parts.push(rest.slice(0, cut));
      rest = rest.slice(cut).trim();
    }
    if (rest.length > 0) parts.push(rest);
  }

  return parts;
}
