import { afterEach, describe, expect, it, vi } from 'vitest';

import { pickVoice, speakText, waitForVoices } from './speech';

/**
 * The voice the app reads with: Saraiki first, Urdu after.
 *
 * The farmer's own preference is a native Saraiki speaker, so a Saraiki voice
 * wins over an Urdu one even when the words being read are Urdu — the app has
 * no Saraiki advice text yet, only navigation, so the voice is Saraiki and the
 * words stay Urdu. Without a Saraiki voice the Urdu matches run in their old
 * order, and without either the answer is `undefined`, never an English voice.
 * Bare `sk` is deliberately not Saraiki here: it is Slovak's code.
 */

function voice(lang: string, name: string): SpeechSynthesisVoice {
  return { lang, name } as SpeechSynthesisVoice;
}

/**
 * A speech engine for the tests. jsdom ships none, so the real one is
 * absent here — which is also how the no-engine path is exercised.
 *
 * `behavior` is what the engine does with an utterance: `start` begins it
 * and ends it, `refuse` errors it before it ever begins — the way an
 * engine with no voice it will use answers a queued utterance.
 */
type FakeUtterance = {
  text: string;
  lang: string;
  voice?: SpeechSynthesisVoice;
  rate: number;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
};

function installSpeechEngine(
  behavior: 'start' | 'refuse',
  initialVoices: SpeechSynthesisVoice[] = [],
) {
  let currentVoices = [...initialVoices];
  const listeners = new Map<string, Set<() => void>>();
  const spoken: FakeUtterance[] = [];
  const synth = {
    getVoices: () => [...currentVoices],
    speak: (utterance: FakeUtterance) => {
      spoken.push(utterance);
      /* The engine answers asynchronously, as a real one does. */
      queueMicrotask(() => {
        if (behavior === 'start') {
          utterance.onstart?.();
          utterance.onend?.();
        } else {
          utterance.onerror?.();
        }
      });
    },
    cancel: () => {},
    addEventListener: (type: string, fn: () => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: () => void) => {
      listeners.get(type)?.delete(fn);
    },
  };
  class Utterance implements FakeUtterance {
    text: string;
    lang = '';
    voice?: SpeechSynthesisVoice;
    rate = 1;
    onstart: (() => void) | null = null;
    onend: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(text: string) {
      this.text = text;
    }
  }
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
  Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: Utterance, configurable: true });
  return {
    spoken,
    setVoices: (next: SpeechSynthesisVoice[]) => {
      currentVoices = [...next];
    },
    emitVoicesChanged: () => {
      listeners.get('voiceschanged')?.forEach((fn) => fn());
    },
  };
}

function removeSpeechEngine() {
  delete (window as unknown as Record<string, unknown>).speechSynthesis;
  delete (window as unknown as Record<string, unknown>).SpeechSynthesisUtterance;
}

describe('pickVoice prefers a Saraiki voice', () => {
  it('takes an exact skr-PK voice over an Urdu one', () => {
    const saraiki = voice('skr-PK', 'Saraiki');
    const urdu = voice('ur-PK', 'Urdu (Pakistan)');
    expect(pickVoice([urdu, saraiki], 'ur-PK')).toBe(saraiki);
  });

  it('takes a skr voice over an Urdu one', () => {
    const saraiki = voice('skr', 'Saraiki');
    const urdu = voice('ur-PK', 'Urdu (Pakistan)');
    expect(pickVoice([urdu, saraiki], 'ur-PK')).toBe(saraiki);
  });

  it('takes the app Saraiki tag sk-PK over an Urdu one', () => {
    const saraiki = voice('sk-PK', 'Saraiki');
    const urdu = voice('ur-PK', 'Urdu (Pakistan)');
    expect(pickVoice([urdu, saraiki], 'ur-PK')).toBe(saraiki);
  });

  it('takes a voice named Saraiki even when its tag is unhelpful', () => {
    const saraiki = voice('und', 'Google Saraiki');
    const urdu = voice('ur-PK', 'Urdu (Pakistan)');
    expect(pickVoice([urdu, saraiki], 'ur-PK')).toBe(saraiki);
  });

  it('prefers an exact Saraiki tag over a looser one', () => {
    const exact = voice('skr-PK', 'Saraiki Pakistan');
    const loose = voice('skr', 'Saraiki');
    expect(pickVoice([loose, exact], 'ur-PK')).toBe(exact);
  });

  it('does not treat a Slovak sk-SK voice as Saraiki', () => {
    const slovak = voice('sk-SK', 'Slovak');
    const urdu = voice('ur-PK', 'Urdu (Pakistan)');
    expect(pickVoice([slovak, urdu], 'ur-PK')).toBe(urdu);
    expect(pickVoice([slovak], 'ur-PK')).toBeUndefined();
  });
});

describe('pickVoice falls back to Urdu without a Saraiki voice', () => {
  it('takes an exact ur-PK voice', () => {
    const urdu = voice('ur-PK', 'Urdu (Pakistan)');
    expect(pickVoice([urdu], 'ur-PK')).toBe(urdu);
  });

  it('takes any ur voice when there is no exact tag', () => {
    const urdu = voice('ur-IN', 'Urdu (India)');
    expect(pickVoice([urdu], 'ur-PK')).toBe(urdu);
  });

  it('takes a voice named Urdu when its tag is unhelpful', () => {
    const urdu = voice('und', 'Google Urdu');
    expect(pickVoice([urdu], 'ur-PK')).toBe(urdu);
  });

  it('returns undefined rather than an English voice', () => {
    const english = voice('en-US', 'English (United States)');
    expect(pickVoice([english], 'ur-PK')).toBeUndefined();
    expect(pickVoice([], 'ur-PK')).toBeUndefined();
  });
});

/**
 * Queueing is not starting. The boolean `speakText` returns only says the
 * words were queued; whether the first part actually begins is reported
 * through `onStart`, and a refusal before it begins through `onStartFailed`.
 * A caller that treats the boolean as "speaking" shows a speaking state for
 * a press the engine refused — the silent failure this guards against.
 */
describe('speakText reports whether the first part actually begins', () => {
  afterEach(() => {
    removeSpeechEngine();
  });

  it('returns false with no speech engine', () => {
    expect(speakText('hello', { lang: 'ur-PK' })).toBe(false);
  });

  it('returns false for empty text even with an engine', () => {
    installSpeechEngine('start');
    expect(speakText('   ', { lang: 'ur-PK' })).toBe(false);
  });

  it('fires onStart and onEnd when the engine begins', async () => {
    installSpeechEngine('start');
    const onStart = vi.fn();
    const onEnd = vi.fn();
    const onStartFailed = vi.fn();
    expect(speakText('hello', { lang: 'ur-PK', onStart, onEnd, onStartFailed })).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onStartFailed).not.toHaveBeenCalled();
  });

  it('fires onStartFailed and onEnd when the engine refuses the first part', async () => {
    installSpeechEngine('refuse');
    const onStart = vi.fn();
    const onEnd = vi.fn();
    const onStartFailed = vi.fn();
    /* Queued — true — and still refused. The boolean alone cannot tell
       this apart from a reading that began, which is the whole bug. */
    expect(speakText('hello', { lang: 'ur-PK', onStart, onEnd, onStartFailed })).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onStart).not.toHaveBeenCalled();
    expect(onStartFailed).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });
});

describe('waitForVoices waits for a late voice list', () => {
  afterEach(() => {
    removeSpeechEngine();
  });

  it('resolves with an empty list when there is no engine', async () => {
    await expect(waitForVoices(10)).resolves.toEqual([]);
  });

  it('resolves at once when voices are already there', async () => {
    installSpeechEngine('start', [voice('ur-PK', 'Urdu (Pakistan)')]);
    await expect(waitForVoices(10)).resolves.toEqual([voice('ur-PK', 'Urdu (Pakistan)')]);
  });

  it('resolves with the empty list when no voices arrive in time', async () => {
    installSpeechEngine('start', []);
    await expect(waitForVoices(10)).resolves.toEqual([]);
  });

  it('resolves when voiceschanged delivers the list', async () => {
    const engine = installSpeechEngine('start', []);
    const pending = waitForVoices(1000);
    engine.setVoices([voice('ur-PK', 'Urdu (Pakistan)')]);
    engine.emitVoicesChanged();
    await expect(pending).resolves.toEqual([voice('ur-PK', 'Urdu (Pakistan)')]);
  });
});
