/**
 * The Urdu voice the app carries.
 *
 * This exists because the device cannot be relied on for one. Measured on the
 * machine this was written on: Windows offers no Urdu speech pack at all — its
 * whole installable list stops at `pt-BR`, `zh-CN` and friends, with nothing
 * Indic or Pakistani — and iOS ships no Urdu voice either, so a phone that has
 * one is the exception rather than the rule. Without this file the app's answer
 * on such a device is to read Urdu script with an English voice, which is the
 * failure the Listen pills exist to avoid.
 *
 * So the voice is carried instead of borrowed: Piper's `ur_PK` model,
 * phonemised by espeak-ng and run by onnxruntime. No key, no account, and
 * no request to a vendor that charges — the model is the public Piper
 * release, fetched once and kept for the session. The phonemiser and the
 * model's configuration are served from this app's own origin; only the
 * 63 MB model itself comes from elsewhere, because GitHub refuses a file
 * that large through its API and it is therefore not in the repo.
 *
 * Everything here is loaded once and kept: the model is 63 MB and the
 * phonemiser's data is 18 MB. The load starts in the background when the home
 * screen opens — a phone has no hover, so the pill's hover warm-up never fires
 * there, and a first press would otherwise begin with the whole download on a
 * slow connection. That costs a farmer who never presses Listen the download;
 * it is the price of a pill that answers when he does press it, and the model
 * is kept for the session once it arrives. A first press still needs the
 * network for the model; after that the voice is in memory, and a repeat press
 * costs nothing. The browser's own voice is the fallback when the model cannot
 * be reached — see `SpeechProvider` — and only when it has a Saraiki or Urdu
 * voice of its own; otherwise the press is answered with a message, never
 * with an English voice reading Urdu script.
 *
 * There is no Saraiki voice to prefer here: Piper publishes no Saraiki model
 * (checked: no `skr` in the Piper voices release), so the Urdu voice reads
 * the Urdu advice. A native Saraiki speaker speaking Urdu is the voice the
 * farmer asked for, and this is the closest a free voice gets to it.
 *
 * The protocol is Piper's own, not invented here: text → phoneme ids →
 * `input`/`input_lengths`/`scales` into the voice → float PCM → WAV.
 */

type PiperConfig = {
  audio: { sample_rate: number };
  espeak: { voice: string };
  inference: { noise_scale: number; length_scale: number; noise_w: number };
  speaker_id_map: Record<string, number>;
};

type PhonemizerFactory = (options: {
  print: (data: string) => void;
  printErr: (message: string) => void;
  locateFile: (url: string) => string;
}) => Promise<{ callMain: (args: string[]) => void }>;

type PhonemizerWindow = Window & { createPiperPhonemize?: PhonemizerFactory };

/* The sentence splitter lives in its own module now: the cloud voice uses
   the same boundaries, so a reading stopped on one voice and resumed on the
   other continues from the same sentence. Re-exported here so existing
   imports of `splitForVoice` from this module keep working. */
import { splitForVoice } from './voiceParts';
export { splitForVoice };

/** The phonemiser and the model's configuration, served from this app's own origin. */
const BASE = '/piper';
const VOICE = 'ur_PK-aegis_female-medium';
/*
 * The model itself — 63 MB, which GitHub refuses through its API, so it is
 * not in the repo. It comes from the public Piper voices release on Hugging
 * Face (no key, no account): the same file the repo's `public/piper` copy
 * came from, byte for byte. The address is the release's stable `resolve`
 * link, which redirects to its CDN; the CDN answers cross-origin requests,
 * so a page on this app's origin can fetch it.
 */
const MODEL_URL =
  'https://huggingface.co/rhasspy/piper-voices/resolve/main/ur/ur_PK/aegis_female/medium/ur_PK-aegis_female-medium.onnx';
const CONFIG_URL = `${BASE}/${VOICE}.onnx.json`;
const PIPER_WASM = `${BASE}/piper_phonemize.wasm`;
const PIPER_DATA = `${BASE}/piper_phonemize.data`;

/**
 * How much slower the voice reads than the model's own pace.
 *
 * The model at its own pace reads too fast for advice a farmer acts on in a
 * field — a comfortable speed is a quarter slower. This scales the phoneme
 * durations (`length_scale`), so every part is made slower, not just played
 * slower; a part already made at the old pace is never replayed, because the
 * cache is per session and a new build starts empty.
 */
const LENGTH_SCALE_SLOWDOWN = 1.25;

type PiperVoice = {
  ort: typeof import('onnxruntime-web');
  session: import('onnxruntime-web').InferenceSession;
  config: PiperConfig;
  phonemize: (text: string) => Promise<number[]>;
};

let voice: Promise<PiperVoice> | null = null;

/**
 * Whether the voice is arriving, ready, or not started.
 *
 * The model is 63 MB and there is no smaller Urdu model — Piper publishes no
 * Urdu voice below medium, so the first press on a slow connection used to
 * sit in silence while the download ran. The pill now shows that wait (see
 * `SpeechProvider.voiceLoading`), which needs to know the load's state rather
 * than just its promise. A failed load is not remembered, so the state returns
 * to `idle` on failure and the next press tries again.
 */
export type VoiceLoadState = 'idle' | 'loading' | 'ready';

let loadState: VoiceLoadState = 'idle';
const loadStateListeners = new Set<(state: VoiceLoadState) => void>();

export function getVoiceLoadState(): VoiceLoadState {
  return loadState;
}

export function subscribeVoiceLoadState(listener: (state: VoiceLoadState) => void): () => void {
  loadStateListeners.add(listener);
  return () => {
    loadStateListeners.delete(listener);
  };
}

function setLoadState(state: VoiceLoadState): void {
  if (loadState === state) return;
  loadState = state;
  for (const listener of loadStateListeners) listener(state);
}

/**
 * Brings the phonemiser in from this app's own origin.
 *
 * A `<script>` tag rather than an import, and not by preference: the published
 * package cannot be imported at all — its `main` is an absolute path
 * (`/build/piper_phonemize.js`), which resolves to `C:\build\…` and fails — and
 * the build has no ESM export either. It is a UMD file whose top-level `var`
 * becomes a global when it is loaded as a classic script, so that is how it is
 * loaded. The file itself is served from `public/piper`, alongside the espeak-ng
 * data and the `.wasm` this factory is told to find with `locateFile`.
 */
function loadPhonemizer(): Promise<PhonemizerFactory> {
  const target = window as PhonemizerWindow;
  if (target.createPiperPhonemize) return Promise.resolve(target.createPiperPhonemize);

  return new Promise<PhonemizerFactory>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `${BASE}/piper_phonemize.js`;
    script.onload = () => {
      const factory = target.createPiperPhonemize;
      script.remove();
      if (factory) resolve(factory);
      else reject(new Error('The phonemiser did not register itself.'));
    };
    script.onerror = () => reject(new Error('The phonemiser could not be loaded.'));
    document.head.append(script);
  });
}

/**
 * Builds the voice once, and only when something actually asks to speak.
 *
 * Kept as a promise rather than a value so two presses in the same second share
 * one load — the model is 63 MB and racing two downloads of it is the one way
 * this design wastes a farmer's data.
 */
function load(): Promise<PiperVoice> {
  voice ??= (async () => {
    setLoadState('loading');
    const [ort, factory, config] = await Promise.all([
      import('onnxruntime-web/wasm'),
      loadPhonemizer(),
      fetch(CONFIG_URL).then((response) => {
        if (!response.ok) throw new Error(`The voice configuration could not be read (${response.status}).`);
        return response.json() as Promise<PiperConfig>;
      }),
    ]);

    const runtime = ((ort as unknown as { default?: typeof import('onnxruntime-web') }).default ??
      ort) as typeof import('onnxruntime-web');

    /*
     * One thread, and the runtime's own bundled wasm.
     *
     * Threads would need `SharedArrayBuffer`, which needs cross-origin isolation
     * headers this app does not set — asking for them here would trade a working
     * voice on every device for a faster one on some.
     *
     * And `wasmPaths` is deliberately *not* set. Pointing it at a directory makes
     * the runtime fetch its wasm glue as a module at press time, and this app's
     * own server cannot serve that request: the bundler appends a marker to
     * runtime imports, which a file served straight off disk refuses — measured
     * as a 500 on `/piper/ort/ort-wasm-simd-threaded.mjs?import` and a warning of
     * "no available backend found". The build this imports has the runtime
     * inlined, so leaving the path alone is both simpler and the only version
     * that works.
     */
    if (runtime.env?.wasm) runtime.env.wasm.numThreads = 1;

    const modelResponse = await fetch(MODEL_URL);
    if (!modelResponse.ok) throw new Error(`The Urdu voice could not be read (${modelResponse.status}).`);
    const session = await runtime.InferenceSession.create(await modelResponse.arrayBuffer(), {
      executionProviders: ['wasm'],
    });

    /*
     * One phonemiser instance per sentence, which is how Piper's own runtime
     * does it: the Emscripten module runs `main` once and keeps its virtual file
     * system, so a second sentence on the same instance would be spoken as if it
     * followed the first — a pause in the text where the farmer wrote none.
     */
    const phonemize = async (text: string): Promise<number[]> => {
      const errors: string[] = [];

      const ids = await new Promise<number[]>((resolve, reject) => {
        let settled = false;
        const fail = (failure: unknown) => {
          if (settled) return;
          settled = true;
          reject(
            failure instanceof Error
              ? failure
              : new Error(errors.join(' ') || 'The words could not be phonemised.'),
          );
        };

        void factory({
          /* The phonemiser hands its answer back through `print`, as JSON. */
          print: (data: string) => {
            if (settled) return;
            try {
              const parsed = JSON.parse(data) as { phoneme_ids?: number[] };
              if (parsed.phoneme_ids) {
                settled = true;
                resolve(parsed.phoneme_ids);
              }
            } catch {
              /* Anything that is not the answer is noise on stdout. */
            }
          },
          /*
           * espeak-ng writes progress and word-level notes to stderr as a matter
           * of course, so these are kept for the error message rather than
           * treated as a failure — one stray line must not cost the farmer the
           * whole reading.
           */
          printErr: (message) => errors.push(message),
          locateFile: (url) =>
            url.endsWith('.wasm') ? PIPER_WASM : url.endsWith('.data') ? PIPER_DATA : url,
        })
          .then((instance) => {
            try {
              instance.callMain([
                '-l',
                config.espeak.voice,
                '--input',
                JSON.stringify([{ text }]),
                '--espeak_data',
                '/espeak-ng-data',
              ]);
            } catch (failure) {
              fail(failure);
            }
          })
          .catch(fail);
      });

      if (ids.length === 0) {
        throw new Error(errors.join(' ') || 'The words produced no audio.');
      }
      return ids;
    };

    setLoadState('ready');
    return { ort: runtime, session, config, phonemize };
  })()
    /*
     * A failed load is not remembered.
     *
     * This is the bug that made the voice work "sometimes": the promise was kept
     * even when it rejected, so one bad first press — a model read that lost a
     * race with the dev server, a transient network stall on the 63 MB — left
     * every later press failing instantly and falling back to the platform's
     * English voice for the rest of the session. Forgetting the failure costs one
     * retry; remembering it costs the feature.
     */
    .catch((failure: unknown) => {
      setLoadState('idle');
      voice = null;
      throw failure;
    });

  return voice;
}

/** Float PCM to a 16-bit mono WAV, which every browser plays without a decoder. */
function encodeWav(pcm: Float32Array, sampleRate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + pcm.length * 2);
  const view = new DataView(buffer);

  const writeText = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
  };

  writeText(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length * 2, true);
  writeText(8, 'WAVE');
  writeText(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, 'data');
  view.setUint32(40, pcm.length * 2, true);

  for (let index = 0; index < pcm.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, pcm[index] ?? 0));
    view.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }

  return buffer;
}

/**
 * Sentences already made, by their own words.
 *
 * The voice is deterministic enough for this to be honest — Piper's noise scales
 * make each run slightly different, not different words — and it is the only way
 * to make a *repeat* press instant, because there is no smaller Urdu model to
 * switch to: the two published Urdu voices are both 60.6 MB medium models, so the
 * compute cannot be cut, only avoided.
 *
 * It earns its keep twice over. The weather advice is read again whenever the
 * farmer presses `Listen` a second time, and nothing is made the second time. And
 * a finger resting on the pill makes the first sentence before the press lands
 * (see `warmUrduVoice`), so the press starts from the first sound.
 */
const madeParts = new Map<string, Blob>();

/**
 * How many sentences are kept. A sentence is ~60 KB of 16-bit WAV, so this is
 * about 1.5 MB at worst — small next to the 63 MB model, and it only ever holds
 * advice this session has already heard.
 */
const MADE_PARTS_LIMIT = 24;

function rememberPart(words: string, audio: Blob): Blob {
  if (madeParts.size >= MADE_PARTS_LIMIT) {
    const oldest = madeParts.keys().next().value;
    if (oldest !== undefined) madeParts.delete(oldest);
  }
  madeParts.set(words, audio);
  return audio;
}

/** The WAV for one sentence: already in memory, or made and kept. */
async function partFor(loaded: PiperVoice, words: string): Promise<Blob> {
  const ready = madeParts.get(words);
  if (ready) return ready;
  return rememberPart(words, await makePart(loaded, words));
}

/** Runs the model for one sentence. This is the expensive, thread-blocking part. */
async function makePart(loaded: PiperVoice, words: string): Promise<Blob> {
  const { ort, session, config, phonemize } = loaded;
  const ids = await phonemize(words);
  const hasSpeakers = Object.keys(config.speaker_id_map ?? {}).length > 0;

  const feeds: Record<string, import('onnxruntime-web').Tensor> = {
    input: new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]),
    /* One batch, one length: the shape is `[1]`, and the *value* is how many
       phonemes there are. Declaring the length as the dimension instead — as
       Piper's own wrapper does — makes the runtime reject the tensor. */
    input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
    scales: new ort.Tensor(
      'float32',
      Float32Array.from([
        config.inference.noise_scale,
        config.inference.length_scale * LENGTH_SCALE_SLOWDOWN,
        config.inference.noise_w,
      ]),
    ),
  };
  if (hasSpeakers) {
    feeds.sid = new ort.Tensor('int64', BigInt64Array.from([0n]), [1]);
  }

  const output = await session.run(feeds);
  const pcm = output.output?.data;
  if (!(pcm instanceof Float32Array)) throw new Error('The voice returned no audio.');

  return new Blob([encodeWav(pcm, config.audio.sample_rate)], { type: 'audio/wav' });
}

/**
 * Reads text aloud as WAV parts, entirely on this device.
 *
 * Returns false when the voice cannot run — no WASM, no storage, a model that
 * cannot be read. The cause is logged, and *not remembered*: the failed load is
 * dropped so the next press tries again rather than failing instantly for the
 * rest of the session. False means nothing was said, and callers treat it as
 * such — Urdu is never handed to a voice that does not speak it.
 *
 * `onPart` is given each sentence the moment it exists, not at the end: speech
 * starts while the rest of the passage is still being made. This is the
 * difference between a pill that answers and a pill that sits there — see
 * `splitForVoice` — and a sentence already in `madeParts` arrives with no model
 * work at all. `onPart` is also given the sentence's absolute index, so the
 * caller knows which part is playing.
 *
 * `fromPart` resumes a reading that was stopped: parts before it are not made
 * and not handed over, so a press after Stop continues from the sentence it
 * was on instead of starting again from the beginning.
 */
export async function synthesiseUrduSpeech(
  text: string,
  onPart: (audio: Blob, index: number) => void,
  fromPart = 0,
): Promise<boolean> {
  try {
    const loaded = await load();
    const parts = splitForVoice(text);
    if (parts.length === 0) return false;

    for (let index = fromPart; index < parts.length; index += 1) {
      const part = parts[index];
      if (part === undefined) continue;
      onPart(await partFor(loaded, part), index);
    }

    return true;
  } catch (failure) {
    /*
     * Told, not dropped: a voice that stops working is otherwise
     * indistinguishable from a device that never had one, and the difference is
     * the whole reason this file exists. The message is the only thing standing
     * between "the press did nothing" and a five-minute hunt.
     */
    console.warn('[speech] the Urdu voice could not run:', failure);
    return false;
  }
}

/**
 * Starts getting the voice ready without saying anything.
 *
 * Two things are done here, and both exist because the model cannot be swapped
 * for a faster one — Piper publishes no Urdu voice smaller than the 60.6 MB
 * medium (checked: `aegis_female` and `fasih` are the only two, both medium, both
 * 60.6 MB; there is no low or x_low model to switch to):
 *
 * · the 63 MB model and 18 MB phonemiser start arriving (the press would
 *   otherwise begin with that download);
 * · the *first sentence* is made and kept, so the press starts at the first
 *   sound instead of waiting for the model to run. This is the one that answers
 *   a press in a few hundred milliseconds rather than a few seconds.
 *
 * Called when the home screen opens (`SpeechProvider.preloadVoice`) and from
 * the `Listen` pill's hover and focus (`SpeechProvider.warm`): a finger rests
 * there and a keyboard lands there before either presses it. Nothing is said —
 * `onPart` is not called and no audio is played.
 *
 * A failure is deliberately silent: nothing was asked for yet, and the press that
 * follows reports the cause itself. It is also not remembered — in `load`, a
 * rejected attempt is dropped.
 */
export function warmUrduVoice(text?: string): void {
  void (async () => {
    const loaded = await load();
    const first = text ? splitForVoice(text)[0] : undefined;
    if (first) await partFor(loaded, first);
  })().catch(() => undefined);
}
