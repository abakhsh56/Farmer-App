import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpeechProvider, useSpeech, type SpeechValue } from '@/speech/SpeechProvider';

/**
 * The voice on a real phone: Piper's Urdu model is 63 MB and there is no
 * smaller Urdu model, so on a slow connection the first press used to sit in
 * silence while the download ran — and when it could not run, the browser's
 * fallback answered in English. These tests pin the three rules that fix it:
 * the model is fetched in the background when Home opens, the pill shows
 * that wait, and Urdu is read by a Saraiki or Urdu voice, or not at all.
 */

const piperMock = vi.hoisted(() => ({
  loadState: 'idle' as 'idle' | 'loading' | 'ready',
  listeners: new Set<(state: 'idle' | 'loading' | 'ready') => void>(),
  warmCalls: 0,
  synthesiseResult: false,
}));

function setPiperLoadState(state: 'idle' | 'loading' | 'ready'): void {
  piperMock.loadState = state;
  for (const listener of piperMock.listeners) listener(state);
}

vi.mock('@/services/piper', () => ({
  getVoiceLoadState: () => piperMock.loadState,
  subscribeVoiceLoadState: (listener: (state: 'idle' | 'loading' | 'ready') => void) => {
    piperMock.listeners.add(listener);
    return () => {
      piperMock.listeners.delete(listener);
    };
  },
  warmUrduVoice: () => {
    piperMock.warmCalls += 1;
  },
  synthesiseUrduSpeech: async () => piperMock.synthesiseResult,
}));

/**
 * A speech engine for the tests. jsdom ships none, so the real one is
 * absent here — which is also how the no-engine path is exercised.
 *
 * `behavior` is what the engine does with an utterance: `start` begins it
 * and ends it, `refuse` errors it before it ever begins, and `manual`
 * records it without answering, so the test drives each part itself.
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
  behavior: 'start' | 'refuse' | 'manual',
  initialVoices: SpeechSynthesisVoice[] = [],
) {
  let currentVoices = [...initialVoices];
  const listeners = new Map<string, Set<() => void>>();
  const spoken: FakeUtterance[] = [];
  const synth = {
    getVoices: () => [...currentVoices],
    speak: (utterance: FakeUtterance) => {
      spoken.push(utterance);
      if (behavior === 'manual') return;
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
  return { spoken };
}

function removeSpeechEngine() {
  delete (window as unknown as Record<string, unknown>).speechSynthesis;
  delete (window as unknown as Record<string, unknown>).SpeechSynthesisUtterance;
}

function voice(lang: string, name: string): SpeechSynthesisVoice {
  return { lang, name } as SpeechSynthesisVoice;
}

/** Renders the provider and hands the test its context value. */
function renderProvider() {
  let captured: SpeechValue | null = null;
  function Probe() {
    const value = useSpeech();
    captured = value;
    return (
      <div>
        <span data-testid="voice-loading">{value.voiceLoading ? 'loading' : 'idle'}</span>
        <span data-testid="speaking">{value.speaking ?? 'none'}</span>
      </div>
    );
  }
  const rendered = render(
    <SpeechProvider>
      <Probe />
    </SpeechProvider>,
  );
  return {
    ...rendered,
    get value(): SpeechValue {
      if (!captured) throw new Error('SpeechProvider did not render its child.');
      return captured;
    },
  };
}

afterEach(() => {
  removeSpeechEngine();
  piperMock.loadState = 'idle';
  piperMock.listeners.clear();
  piperMock.warmCalls = 0;
  piperMock.synthesiseResult = false;
});

describe('the browser fallback never reads Urdu in English', () => {
  it('resolves false and speaks nothing when only an English voice exists', async () => {
    const engine = installSpeechEngine('start', [voice('en-US', 'English (United States)')]);
    piperMock.synthesiseResult = false;
    const { value, unmount } = renderProvider();
    let started: boolean | undefined;
    await act(async () => {
      started = await value.speak({ id: 'weather', text: 'صاف آسمان ہے۔', lang: 'ur-PK' });
    });
    expect(started).toBe(false);
    /* No utterance was handed to the engine at all — the English voice
       never got the Urdu words. */
    expect(engine.spoken).toHaveLength(0);
    expect(screen.getByTestId('speaking')).toHaveTextContent('none');
    unmount();
  });

  it('reads with the Urdu voice when Piper cannot run and one is installed', async () => {
    const urdu = voice('ur-PK', 'Urdu (Pakistan)');
    const engine = installSpeechEngine('start', [urdu]);
    piperMock.synthesiseResult = false;
    const { value, unmount } = renderProvider();
    let started: boolean | undefined;
    await act(async () => {
      started = await value.speak({ id: 'weather', text: 'صاف آسمان ہے۔', lang: 'ur-PK' });
    });
    expect(started).toBe(true);
    expect(engine.spoken).toHaveLength(1);
    expect(engine.spoken[0]?.voice).toBe(urdu);
    unmount();
  });
});

describe('the pill shows the voice arriving', () => {
  it('reports loading while the model downloads and idle once it is ready', async () => {
    installSpeechEngine('start', [voice('ur-PK', 'Urdu (Pakistan)')]);
    setPiperLoadState('loading');
    const { unmount } = renderProvider();
    expect(screen.getByTestId('voice-loading')).toHaveTextContent('loading');
    act(() => {
      setPiperLoadState('ready');
    });
    await waitFor(() =>
      expect(screen.getByTestId('voice-loading')).toHaveTextContent('idle'),
    );
    unmount();
  });

  it('starts the model download when preloadVoice is called', async () => {
    installSpeechEngine('start', [voice('ur-PK', 'Urdu (Pakistan)')]);
    const { value, unmount } = renderProvider();
    value.preloadVoice();
    await waitFor(() => expect(piperMock.warmCalls).toBe(1));
    unmount();
  });
});

describe('a press after Stop resumes from the sentence it was on', () => {
  /* Three sentences, each too long to pack with the next, so the text is
     three parts and the indices are the sentence numbers. */
  const THREE_PARTS =
    'The spray window opens at noon and closes before the evening rain arrives over the fields and roads. ' +
    'Winds stay light through the afternoon, so the spray settles on the leaves where it should fall and stay. ' +
    'Finish before noon, because the rain after four will wash the spray away from the crop rows and soil.';

  it('continues from the stopped part instead of starting again', async () => {
    const urdu = voice('ur-PK', 'Urdu (Pakistan)');
    const engine = installSpeechEngine('manual', [urdu]);
    piperMock.synthesiseResult = false;
    const { value, unmount } = renderProvider();

    /* First press: the three parts queue, then part 0 begins. */
    let firstStarted: Promise<boolean> | undefined;
    act(() => {
      firstStarted = value.speak({ id: 'weather', text: THREE_PARTS, lang: 'ur-PK' });
    });
    /* Let the async speak flow reach speakText and queue the parts. */
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(engine.spoken).toHaveLength(3);
    act(() => {
      engine.spoken[0]?.onstart?.();
    });
    await expect(firstStarted).resolves.toBe(true);

    /* Part 1 begins — the resume position is now the second sentence. */
    act(() => {
      engine.spoken[1]?.onstart?.();
    });
    /* Stop mid-part-1. */
    act(() => {
      value.stop();
    });

    /* Second press: it resumes from part 1, not part 0. */
    const queuedBefore = engine.spoken.length;
    let secondStarted: Promise<boolean> | undefined;
    act(() => {
      secondStarted = value.speak({ id: 'weather', text: THREE_PARTS, lang: 'ur-PK' });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const resumed = engine.spoken.slice(queuedBefore);
    expect(resumed.map((utterance) => utterance.text)).toEqual([
      'Winds stay light through the afternoon, so the spray settles on the leaves where it should fall and stay.',
      'Finish before noon, because the rain after four will wash the spray away from the crop rows and soil.',
    ]);
    act(() => {
      resumed[0]?.onstart?.();
    });
    await expect(secondStarted).resolves.toBe(true);
    unmount();
  });
});
