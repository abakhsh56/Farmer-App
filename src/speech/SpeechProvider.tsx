import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  pickVoice,
  speakText,
  speechSupported,
  stopSpeaking,
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
 * Speaking never refuses for want of a matching voice. The voice is the
 * browser's own text-to-speech, Saraiki first and Urdu after: a native Saraiki
 * voice when the device has one — reading the Urdu advice the app has, since
 * there is no Saraiki advice text yet — and otherwise a matched Urdu voice,
 * and otherwise the engine's best voice for the language tag — which on a
 * phone with Urdu installed is the Urdu voice. There is no second voice to
 * fall back to: the carried Piper model is excluded (63 MB, not in the repo),
 * so a press that cannot speak at all — no speech engine, or no words —
 * returns false, and the caller answers it instead of silence.
 */

export type SpeechValue = {
  /** False when the platform has no speech at all — no voice can change that. */
  supported: boolean;
  /** The id passed to `speak` for whatever is being read, or null. */
  speaking: string | null;
  /** Returns false only when the platform has no speech at all. */
  speak: (input: { id: string; text: string; lang: string }) => boolean;
  /**
   * Starts getting the voice this language will be read in ready, without
   * speaking.
   *
   * The device's own voice needs no warming — it answers the moment it is
   * asked — so this is a no-op kept for the call sites. Warming existed to
   * pre-load the carried Piper model, and that model is excluded.
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
    setSpeaking(null);
    stopSpeaking();
  }, []);

  const warm = useCallback(
    (_lang: string, _text: string) => {
      /* The device's own voice needs no warming — it answers the moment it is
         asked. Warming existed to pre-load the carried Piper model, and that
         model is excluded, so there is nothing to warm. */
    },
    [],
  );

  const speak = useCallback<SpeechValue['speak']>(
    ({ id, text, lang }) => {
      /* He asked to hear it: record the preference before anything else. */
      capability.recordEvent('readAloud');
      const onEnd = () => setSpeaking((current) => (current === id ? null : current));
      /* The voice list arrives late, so read it fresh at the press — the
         cached list can still be empty when the farmer taps. */
      const liveVoices = supported ? window.speechSynthesis.getVoices() : [];
      const allVoices = liveVoices.length > 0 ? liveVoices : voices;
      const voice = pickVoice(allVoices, lang);
      /* Built-in text-to-speech is the voice now: the carried Piper model is
         excluded, so there is no second voice to fall back to. A Saraiki voice
         is used first when the device has one, then a matched Urdu voice;
         without either the utterance still goes to the engine with the
         language set, and the engine picks its best voice for it — which on a
         phone with Urdu installed is the Urdu voice. speakText reports whether
         it started, so a press that cannot speak is a false the caller can
         answer, not silence. */
      const started = speakText(text, { lang, voice, onEnd });
      setSpeaking(started ? id : null);
      return started;
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
