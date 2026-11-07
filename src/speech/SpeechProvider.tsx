import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  pickVoice,
  speakText,
  speakWithAppVoice,
  speechSupported,
  stopSpeaking,
  waitForVoices,
  warmAppVoice,
} from '@/services/speech';
import { useCapabilityRecorder } from '@/capability/CapabilityProvider';

/**
 * Who is talking, and whether this device can.
 *
 * Read-aloud is a capability of the *device*, not a service, so it lives above
 * the screens rather than inside one: the weather card and the scan verdict read
 * advice aloud in the same voice, and leaving one screen has to be able to stop
 * what the other started. Holding it in a provider is also what makes one voice
 * at a time structural — there is a single `speaking` id, so two pills cannot
 * both believe they are the one playing.
 *
 * The one subtlety is that a device's voice list is delivered *late*: the first
 * read is usually empty and the real list arrives on `voiceschanged`. Reporting
 * "this language cannot be read" before that arrives would grey out a control
 * that works, so an empty list is `unknown`, not `absent`.
 *
 * Speaking never refuses for want of a matching voice. The voice is Piper's
 * Urdu neural voice first — a real human-like voice, not the platform's
 * robotic one — loaded from the public Piper release (no key, no account;
 * see `services/piper.ts`). Only when that voice cannot run does the
 * browser's own text-to-speech answer: a native Saraiki voice when the
 * device has one — reading the Urdu advice the app has, since there is no
 * Saraiki advice text yet — and otherwise a matched Urdu voice, and
 * otherwise the engine's best voice for the language tag.
 *
 * Queueing is not starting. The engine can take the words and then refuse
 * them — no voice it will use, or the utterance rejected — and that refusal
 * arrives as an error on the first part, not as a thrown exception. `speak`
 * therefore resolves true only when the first part actually begins, and
 * resolves false when it cannot start, so a press the engine refuses is
 * answered instead of looking like nothing happened. The same rule holds
 * for Piper: its first part playing is the start, and a model that cannot
 * be reached is a fall-through to the browser's voice, not a silence.
 */

export type SpeechValue = {
  /** False when the platform has no speech at all — no voice can change that. */
  supported: boolean;
  /** The id passed to `speak` for whatever is being read, or null. */
  speaking: string | null;
  /**
   * Reads the text aloud. Resolves true only when the first part actually
   * begins speaking — queueing is not starting, and a press the engine
   * refuses resolves false so the caller can answer it instead of silence.
   *
   * Piper's Urdu neural voice is tried first, because it is the human-like
   * one; the browser's own voice is the fallback when Piper cannot run.
   * The browser's 2.5-second "has not begun" timeout applies only to the
   * browser phase — Piper's first press downloads a 63 MB model, which no
   * fixed timeout can judge, and the pill shows its Stop state while it
   * loads so the farmer can cancel it.
   */
  speak: (input: { id: string; text: string; lang: string }) => Promise<boolean>;
  /**
   * Starts getting the voice this language will be read in ready, without
   * speaking.
   *
   * Called when a finger or a keyboard is already on the pill, so the press
   * is not the moment the 63 MB model starts arriving — nor the moment the
   * first sentence has to be made, because warming makes that one too. The
   * browser's own voice needs no warming; only Piper does.
   */
  warm: (lang: string, text: string) => void;
  stop: () => void;
};

const SpeechContext = createContext<SpeechValue | null>(null);

export function SpeechProvider({ children }: { children: ReactNode }) {
  const supported = speechSupported();
  const [voices, setVoices] = useState<readonly SpeechSynthesisVoice[]>(() =>
    supported ? window.speechSynthesis.getVoices() : [],
  );
  const [speaking, setSpeaking] = useState<string | null>(null);
  /* Pressing read-aloud is the farmer saying he listens rather than reads —
     the strongest voice-first signal there is. */
  const capability = useCapabilityRecorder();
  /* A speak still waiting on its first part to begin, so a deliberate stop —
     or a newer press — can settle it as handled rather than letting the
     refusal the stop causes report a failure the farmer did not have. */
  const cancelPendingSpeak = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!supported) return;
    const synth = window.speechSynthesis;
    const sync = () => setVoices(synth.getVoices());

    sync();
    synth.addEventListener('voiceschanged', sync);
    return () => {
      synth.removeEventListener('voiceschanged', sync);
      /* The app is going away; a phone that keeps reading advice from a closed
         tab is the failure this line exists for. */
      synth.cancel();
    };
  }, [supported]);

  const stop = useCallback(() => {
    /* A press stopped on purpose is not a failure: settle any speak still
       waiting on a start as handled, so the caller does not show a toast
       for a refusal the farmer did not have. */
    cancelPendingSpeak.current?.();
    cancelPendingSpeak.current = null;
    setSpeaking(null);
    stopSpeaking();
  }, []);

  const warm = useCallback(
    (_lang: string, text: string) => {
      /* The browser's own voice needs no warming — it answers the moment it
         is asked. Piper does: the 63 MB model and the first sentence are
         made now, so the press starts at the first sound instead of waiting
         for a download. A failure here is silent on purpose — nothing was
         asked for yet, and the press that follows reports the cause itself. */
      if (text) warmAppVoice(text);
    },
    [],
  );

  const speak = useCallback<SpeechValue['speak']>(
    async ({ id, text, lang }) => {
      try {
        /* He asked to hear it: record the preference before anything else. */
        capability.recordEvent('readAloud');
        if (!text.trim()) return false;

        /* A newer press replaces one still waiting to start; the older one
           is superseded, not failed, so it must not report a toast. */
        cancelPendingSpeak.current?.();
        /* The pill answers the press at once. The speaking state is the
           truth of whether a voice actually began, not of whether the words
           were queued: a press no voice can read clears the state and
           resolves false, so the caller answers it instead of silence. */
        setSpeaking(id);
        return await new Promise<boolean>((resolve) => {
          let settled = false;
          /* The browser's "has not begun" timer, set only in the browser
             phase below — Piper's first press downloads a 63 MB model,
             which no fixed timeout can judge. */
          let timer: ReturnType<typeof setTimeout> | undefined;
          const settle = (value: boolean) => {
            if (settled) return;
            settled = true;
            if (timer !== undefined) clearTimeout(timer);
            cancelPendingSpeak.current = null;
            if (!value) setSpeaking((current) => (current === id ? null : current));
            resolve(value);
          };
          cancelPendingSpeak.current = () => settle(true);
          const onEnd = () => {
            setSpeaking((current) => (current === id ? null : current));
          };

          void (async () => {
            /* Piper first: the natural neural voice. A model that cannot be
               reached is a fall-through to the browser's voice, not a
               silence — and a press stopped or superseded while the model
               was loading is handled, not failed. */
            const piperStarted = await speakWithAppVoice(text, onEnd);
            if (settled) return;
            if (piperStarted) {
              settle(true);
              return;
            }

            /* The browser's own voice: a Saraiki voice first when the
               device has one, then a matched Urdu voice; without either the
               utterance still goes to the engine with the language set, and
               the engine picks its best voice for it — which on a phone
               with Urdu installed is the Urdu voice. */
            if (!supported) {
              settle(false);
              return;
            }
            /* The voice list arrives late, so wait briefly for it before
               deciding there is none — a press on a device that has a voice
               but has not delivered it yet must not fail before it is tried. */
            const liveVoices = await waitForVoices(1000);
            if (settled) return;
            const allVoices = liveVoices.length > 0 ? liveVoices : voices;
            const voice = pickVoice(allVoices, lang);
            /* A first part that has not begun in this long is not going to:
               the engine has refused it without saying so, and leaving the
               pill in its speaking state would be the same silence. */
            timer = setTimeout(() => {
              stopSpeaking();
              settle(false);
            }, 2500);
            const onStart = () => settle(true);
            const onStartFailed = () => settle(false);
            const queued = speakText(text, { lang, voice, onStart, onEnd, onStartFailed });
            if (!queued) settle(false);
          })();
        });
      } catch {
        /* A press that cannot speak is a false the caller can answer, never
           a throw that leaves the pill exactly as it was. */
        setSpeaking((current) => (current === id ? null : current));
        return false;
      }
    },
    [supported, voices, capability],
  );

  const value = useMemo<SpeechValue>(
    () => ({ supported, speaking, speak, warm, stop }),
    [supported, speaking, speak, warm, stop],
  );

  return <SpeechContext.Provider value={value}>{children}</SpeechContext.Provider>;
}

export function useSpeech(): SpeechValue {
  const context = useContext(SpeechContext);
  if (!context) {
    throw new Error('useSpeech must be used inside a SpeechProvider');
  }
  return context;
}
