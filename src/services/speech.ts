/**
 * The device's own voice.
 *
 * The weather card and the scan verdict each carry a `Listen` pill, and spoken
 * advice is the whole point of them: the sentence under that pill — when to
 * spray, what is wrong with the plant — is the one a farmer acts on in a field,
 * and often without reading it comfortably. This module is the piece the app was
 * missing, and it is deliberately thin: it wraps the platform's speech synthesis
 * and nothing else, so reading a sentence that is already on screen costs no
 * provider, no key and no network.
 *
 * Three decisions are the module rather than plumbing:
 *
 * · **The natural voice first, the browser's voice as the fallback.** The
 *   farmer asked for a real voice, not a robotic one, so Piper's Urdu neural
 *   voice (`services/piper.ts`) reads first — its model fetched from the
 *   public Piper release, no key and no account — and the browser's own
 *   speech is only the fallback when Piper cannot run. The fallback still
 *   honours the farmer's preference: a Saraiki voice first (`skr-PK`, `skr`,
 *   the app's `sk-PK`, or a name that says Saraiki), because the farmer's own
 *   preference is a native Saraiki speaker; then a voice for the text's own
 *   tag (`ur-PK` first, any `ur` voice after that). The words stay Urdu —
 *   the app has no Saraiki advice text yet — so a Saraiki voice reads Urdu
 *   advice. Where the device has no voice for either, the right answer is
 *   silence the caller can answer, not the platform's default: the default
 *   made the pill always answer, and on a device with no Urdu it answered in
 *   English. Urdu is read by a Saraiki or Urdu voice, or not at all.
 *
 * · **The text arrives whole; the platform gets it in parts.** Engines drop long
 *   utterances mid-sentence, so the words are split at sentence ends and queued.
 *   Splitting on punctuation rather than on a character count is what keeps
 *   "Finish before noon." from being heard as two half-sentences.
 *
 * · **The voice is not the app's to leave running.** Every part queues into one
 *   engine, so a second press replaces the first instead of talking over it, and
 *   `stopSpeaking` exists for the screen to call when it goes away.
 *
 * · **When the device has no voice for the language, the app fetches it.** This
 *   is the case that matters most, because it is the common one: Windows ships no
 *   Urdu speech pack at all (its own capability list offers no Indic or Pakistani
 *   language), iOS ships none, and Android only sometimes. Measured on this
 *   machine, a device with three en-US voices reads an Urdu sentence with an
 *   English voice — the farmer hears English, which is the exact failure this
 *   file exists to prevent. So the Urdu audio is made by Piper's neural voice
 *   (`services/piper.ts`) and played through an `<audio>` element instead.
 *
 *   A keyless web endpoint was tried for this and does not work from a page, and
 *   the file records it so the next person does not spend the same hour on it:
 *   that endpoint answers a bare request with `audio/mpeg`, but with a browser's
 *   own headers it answers **404 `text/html`**, which Chrome then refuses as
 *   `ERR_BLOCKED_BY_ORB` — verified in this app's own network log.
 *
 *   Piper is the voice that runs: its Urdu model (`ur_PK-aegis_female-medium`,
 *   63 MB) is fetched from the public Piper voices release, and the phonemiser
 *   and the model's configuration are served from this app's own origin. There
 *   is no Saraiki Piper model (checked: no `skr` in the release), so the Urdu
 *   voice reads the Urdu advice. A cloud neural voice was considered and set
 *   aside: it sounds human, but it needs an API key the farmer has no time to
 *   provide, and the standing rule is free resources with no key.
 *
 * The speech recogniser is *not* here: `ScanScreen` owns that, because it is a
 * control on a screen rather than a capability of the app.
 */

/** What one utterance may carry before engines start dropping its tail. */
const CHUNK_CHARS = 180;



/**
 * Comfortably under normal speed.
 *
 * Advice is the one thing on these screens a farmer may write down or repeat to
 * someone, and the platforms' default rate is tuned for a screen reader used by
 * someone following along with their eyes. A farmer listening in a field is not
 * following along with his eyes, so the voice reads slower than the default —
 * slow enough to follow, not so slow it drags.
 */
const RATE = 0.85;

/**
 * The speech engine, read through a check rather than assumed.
 *
 * `jsdom` has neither, and neither do locked-down browsers, so the capability is
 * probed once here and every caller above can stay free of `try`/`catch`.
 */
function engine(): { synth: SpeechSynthesis; Utterance: typeof SpeechSynthesisUtterance } | null {
  if (typeof window === 'undefined') return null;
  if (typeof window.speechSynthesis === 'undefined') return null;
  if (typeof window.SpeechSynthesisUtterance === 'undefined') return null;
  return { synth: window.speechSynthesis, Utterance: window.SpeechSynthesisUtterance };
}

/** False when this device cannot speak at all, whatever the language. */
export function speechSupported(): boolean {
  return engine() !== null;
}

/** The language part of a BCP 47 tag: `ur-PK` → `ur`. */
export function baseLanguage(tag: string): string {
  return tag.split('-')[0]?.toLowerCase() ?? '';
}

/**
 * The voice that should read this language, or `undefined` when the device has
 * none.
 *
 * Saraiki first, always — the farmer's own voice preference is a native
 * Saraiki speaker. A Saraiki voice is matched by its tag (`skr-PK`, `skr`, and
 * the app's own Saraiki tag `sk-PK`) or by its name, and it reads the Urdu
 * advice the app has: there is no Saraiki advice text to read yet (the Saraiki
 * catalogue is navigation only), so the voice is Saraiki and the words stay
 * Urdu. Only when the device has no Saraiki voice at all does the requested
 * tag win — an exact tag over the same language in another region (`ur-PK`
 * over `ur-IN`), because the two differ in the words the voice gets right. A
 * voice for another language is never a substitute: without a Saraiki or
 * matching voice the answer is `undefined`, and the caller answers that
 * instead of silence.
 */
export function pickVoice(
  voices: readonly SpeechSynthesisVoice[],
  tag: string,
): SpeechSynthesisVoice | undefined {
  const wanted = tag.toLowerCase();
  const base = baseLanguage(tag);
  /* Saraiki first: the farmer's preferred voice. `skr` is the language's own
     code; `sk-PK` is the tag the app's Saraiki locale carries. Bare `sk` is
     deliberately not matched — it is Slovak's code, not Saraiki's. */
  const saraiki =
    voices.find((voice) => voice.lang.toLowerCase() === 'skr-pk') ??
    voices.find((voice) => baseLanguage(voice.lang) === 'skr') ??
    voices.find((voice) => voice.lang.toLowerCase() === 'sk-pk') ??
    voices.find((voice) => voice.name.toLowerCase().includes('saraiki'));
  if (saraiki) return saraiki;
  return (
    voices.find((voice) => voice.lang.toLowerCase() === wanted) ??
    voices.find((voice) => baseLanguage(voice.lang) === base) ??
    /* A voice whose tag is unhelpful but whose name says Urdu — some engines
       report the language loosely and the name plainly. */
    voices.find((voice) => voice.name.toLowerCase().includes('urdu'))
  );
}

/**
 * The text in parts the platform can finish.
 *
 * Sentences are packed up to the limit and never split across parts, except when
 * a single sentence is longer than the limit — where it is broken on a space,
 * because a voice that starts mid-word is the one artefact a listener cannot
 * account for.
 */
export function splitForSpeech(text: string, limit = CHUNK_CHARS): string[] {
  const sentences = text
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?۔؟])\s+/)
    .filter((sentence) => sentence.length > 0);

  const parts: string[] = [];
  let current = '';

  for (const sentence of sentences) {
    if (current.length === 0) current = sentence;
    else if (current.length + sentence.length + 1 <= limit) current = `${current} ${sentence}`;
    else {
      parts.push(current);
      current = sentence;
    }

    while (current.length > limit) {
      const space = current.lastIndexOf(' ', limit);
      const cut = space > 0 ? space : limit;
      parts.push(current.slice(0, cut));
      current = current.slice(cut).trim();
    }
  }

  if (current.length > 0) parts.push(current);
  return parts;
}

/*
 * There is no `spokenVoice` any more, and its absence is the fix.
 *
 * It used to return the platform's default when the device had no voice for the
 * language, so that a pressed speaker always answered. Measured on this machine,
 * that answered in English — three en-US voices reading Urdu script — which a
 * farmer cannot tell apart from wrong advice. A voice for another language is
 * not a substitute for a missing one; the app's own Urdu voice
 * (`services/piper.ts`) is, and when it cannot run the right answer is silence.
 */

export type SpeakOptions = {
  /** BCP 47 tag, e.g. `ur-PK`. */
  lang: string;
  /** Omitted when the device has not delivered a voice list; the engine decides. */
  voice?: SpeechSynthesisVoice;
  /** Fired when the first part actually begins — not when it was queued. */
  onStart?: () => void;
  /** Fired when the last part ends, or when the engine refuses a part. */
  onEnd?: () => void;
  /**
   * Fired when the first part is refused before it ever begins — the
   * engine has no voice it will use, or it rejected the utterance. This
   * is the signal that queueing succeeded but speaking did not start,
   * which the boolean return alone cannot tell apart.
   */
  onStartFailed?: () => void;
  /**
   * Fired when the last part ends naturally — the reading ran to its end,
   * not a stop or a refusal. The caller uses it to forget a resume position,
   * so a fresh press starts from the beginning.
   */
  onComplete?: () => void;
  /**
   * Fired when a part begins, with its absolute index in the text. The
   * caller records it as the resume position, so a press after Stop
   * continues from the sentence it was on.
   */
  onPartStart?: (index: number) => void;
  /**
   * Resumes a reading that was stopped: parts before this index are not
   * queued, so the reading continues from the sentence it was on instead of
   * starting again from the beginning.
   */
  fromPart?: number;
};

/**
 * The voice list, waiting briefly for it to arrive when it is empty.
 *
 * The list is delivered late: the first read is often empty and the real
 * list arrives on `voiceschanged`. Reading it once and declaring "no voice"
 * is how a press on a device that has one fails before it is tried. Waits
 * at most a second; a device with no voices at all still resolves, with an
 * empty list, so the caller can answer that instead of hanging.
 */
export function waitForVoices(timeoutMs = 1000): Promise<readonly SpeechSynthesisVoice[]> {
  const target = engine();
  if (!target) return Promise.resolve([]);
  const current = target.synth.getVoices();
  if (current.length > 0) return Promise.resolve(current);
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      target.synth.removeEventListener('voiceschanged', onChange);
      resolve(target.synth.getVoices());
    };
    const onChange = () => finish();
    target.synth.addEventListener('voiceschanged', onChange);
    setTimeout(finish, timeoutMs);
  });
}

/* --------------------------------------------------------------------------
   The voice the app carries — Piper's Urdu model, run on this device.
   -------------------------------------------------------------------------- */

let voicePlayer: HTMLAudioElement | null = null;
/** Bumped by every stop, so a model still waking up cannot start talking later. */
let voiceToken = 0;
/** Object URLs handed to the element and not yet freed — one per part unplayed. */
let voiceUrls: string[] = [];

function freeVoiceUrl(url: string): void {
  voiceUrls = voiceUrls.filter((pending) => pending !== url);
  URL.revokeObjectURL(url);
}

/** Drops everything waiting to be played. Called by a stop, and by a new press. */
function freeVoiceUrls(): void {
  for (const url of voiceUrls) URL.revokeObjectURL(url);
  voiceUrls = [];
}

/**
 * Reads the text with the app's own Urdu voice, part by part.
 *
 * Resolves true once the first part is playing, false when nothing was made at
 * all. The caller does *not* hand Urdu to another voice when that happens — it
 * says nothing and lets the next press bring the model up — so a `false` here
 * means `piper.ts` has already logged the real cause.
 *
 * **Why one part at a time.** The model runs on this thread, and it used to make
 * the whole passage before handing over a single WAV: 13 seconds of audio for the
 * weather advice, and the farmer heard none of it until the last sentence was
 * built. Now the first sentence plays while the rest is being made, which is what
 * makes a press feel answered — the wait is one sentence, not one passage. The
 * parts are handed over in reading order and played back to back, and each break
 * lands on a sentence end, so the joins are heard as pauses rather than seams.
 *
 * The first call of a page load also pays for 63 MB of model and 18 MB of
 * phonemiser; `piper.ts` keeps them afterwards, forgets a failed attempt, and
 * offers a warm-up for a finger that is already on the pill.
 */
export async function speakWithAppVoice(
  text: string,
  onEnd?: () => void,
  options?: {
    /**
     * Resumes a reading that was stopped: parts before this index are not
     * made and not played, so the reading continues from the sentence it
     * was on instead of starting again from the beginning.
     */
    fromPart?: number;
    /**
     * Fired when a part begins playing, with its absolute index in the text.
     * The caller records it as the resume position.
     */
    onPartStart?: (index: number) => void;
    /**
     * Fired when the last part ends naturally — the reading ran to its end,
     * not a stop. The caller uses it to forget a resume position, so a
     * fresh press starts from the beginning.
     */
    onComplete?: () => void;
  },
): Promise<boolean> {
  if (typeof window === 'undefined' || typeof window.Audio === 'undefined') return false;
  const token = ++voiceToken;

  const { synthesiseUrduSpeech } = await import('./piper');
  const element = (voicePlayer ??= new window.Audio());

  /* One voice at a time: a newer press replaces the part still being heard. */
  element.onended = null;
  element.onerror = null;
  element.pause();
  freeVoiceUrls();

  const queue: { url: string; index: number }[] = [];
  let synthesisFinished = false;
  let busy = false;
  let handed = 0;
  let answered = false;
  let settle: (started: boolean) => void = () => undefined;
  const started = new Promise<boolean>((resolve) => {
    settle = resolve;
  });
  const answer = (value: boolean) => {
    if (answered) return;
    answered = true;
    settle(value);
  };

  /** Hands the next part to the element, or finishes when there is none left. */
  const pump = () => {
    /* Stopped, or replaced by a newer press: the queue is not ours any more. */
    if (token !== voiceToken || busy) return;

    const next = queue.shift();
    if (!next) {
      if (synthesisFinished) {
        onEnd?.();
        /* The last part ended on its own: the reading ran to its end, so a
           fresh press starts from the beginning. A stop never reaches here —
           the token is bumped before the queue is drained. */
        options?.onComplete?.();
      }
      return;
    }

    busy = true;
    const done = () => {
      busy = false;
      freeVoiceUrl(next.url);
      pump();
    };
    element.onended = done;
    /* A part that will not play is skipped rather than left as a silence in the
       middle of the advice; the reading only stops if the last part fails. */
    element.onerror = done;
    element.src = next.url;
    void element.play().then(
      () => {
        answer(true);
        /* This part is playing: a Stop now leaves the resume position on it. */
        options?.onPartStart?.(next.index);
      },
      done,
    );
  };

  const spoken = await synthesiseUrduSpeech(
    text,
    (audio, index) => {
      /* The farmer stopped, or pressed again, while this part was being made. */
      if (token !== voiceToken) return;
      const url = URL.createObjectURL(audio);
      voiceUrls.push(url);
      queue.push({ url, index });
      handed += 1;
      pump();
    },
    options?.fromPart ?? 0,
  );

  synthesisFinished = true;
  if (token !== voiceToken) {
    /* A newer press owns the voice now, and it must not have its state cleared. */
    answer(true);
  } else if (!spoken && handed === 0) {
    answer(false);
  }
  pump();

  return started;
}

/**
 * Starts getting the app's Urdu voice ready without pressing anything: the model
 * arrives, and the sentence the farmer is about to hear is made in advance.
 *
 * `text` is the advice the pill would read, which is known before it is pressed.
 * Wired to the `Listen` pill's hover and focus — see `SpeechProvider.warm`.
 */
export function warmAppVoice(text: string): void {
  void import('./piper')
    .then((piper) => piper.warmUrduVoice(text))
    .catch(() => undefined);
}

/**
 * Starts getting the app's Urdu voice ready in the background, without
 * pressing anything and without knowing the words yet: the model arrives so
 * a press finds it already there.
 *
 * Called when the home screen opens — a phone has no hover, so the pill's
 * hover/focus warm-up never fires there, and the first press would otherwise
 * begin with the 63 MB download on a slow connection. Nothing is said, and
 * the pill shows the voice arriving (see `SpeechProvider.voiceLoading`).
 */
export function preloadAppVoice(): void {
  void import('./piper')
    .then((piper) => piper.warmUrduVoice())
    .catch(() => undefined);
}

/**
 * Reads the text aloud. Returns false only when it could not even be
 * queued — no engine, or no words. Queueing is not starting: whether the
 * first part actually begins is reported through `onStart`, and a refusal
 * before it begins through `onStartFailed`. A caller that treats the
 * boolean as "speaking" will show a speaking state for a press the engine
 * refused, which is how a tap that does nothing looks like it worked.
 */
export function speakText(
  text: string,
  {
    lang,
    voice,
    onStart,
    onEnd,
    onStartFailed,
    onComplete,
    onPartStart,
    fromPart = 0,
  }: SpeakOptions,
): boolean {
  const target = engine();
  if (!target) return false;

  /* A resume starts from the sentence it was on, not from the beginning. */
  const parts = splitForSpeech(text).slice(fromPart);
  if (parts.length === 0) return false;

  /* One voice at a time: a second press replaces the first rather than layering
     two readings of the same advice. */
  target.synth.cancel();

  let started = false;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    onEnd?.();
  };
  const failToStart = () => {
    if (started || finished) return;
    finished = true;
    /* Clear the parts still waiting, so a refused first part does not leave
       the rest queued behind it. */
    target.synth.cancel();
    onStartFailed?.();
    onEnd?.();
  };

  parts.forEach((part, index) => {
    const absoluteIndex = fromPart + index;
    const utterance = new target.Utterance(part);
    utterance.lang = lang;
    if (voice) utterance.voice = voice;
    utterance.rate = RATE;

    const isFirst = index === 0;
    const isLast = index === parts.length - 1;
    utterance.onstart = () => {
      /* Every part reports where it began, so a Stop leaves the resume
         position on the sentence it was on. */
      onPartStart?.(absoluteIndex);
      if (isFirst) {
        started = true;
        onStart?.();
      }
    };
    if (isFirst) {
      /* An error before the first part begins is a refusal, not an ending;
         after speaking has begun it is an ending like any other. */
      utterance.onerror = () => {
        if (!started) failToStart();
        else finish();
      };
    }
    if (isLast) {
      utterance.onend = () => {
        finish();
        /* The last part ended on its own: the reading ran to its end, so a
           fresh press starts from the beginning. A stop never reaches here —
           cancelling fires an error, not an end. */
        onComplete?.();
      };
      if (!isFirst) {
        utterance.onerror = () => finish();
      }
    }

    target.synth.speak(utterance);
  });

  return true;
}

/** Everything queued or in progress stops. Safe to call when nothing is speaking. */
export function stopSpeaking(): void {
  engine()?.synth.cancel();

  /* Bumping the token is what stops the queue: a part still being made is
     dropped, and the pump refuses to hand over the next one. */
  voiceToken += 1;
  if (voicePlayer) {
    voicePlayer.onended = null;
    voicePlayer.onerror = null;
    voicePlayer.pause();
  }
  freeVoiceUrls();
}
