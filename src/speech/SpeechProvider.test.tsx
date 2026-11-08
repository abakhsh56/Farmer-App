import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { serviceConfig } from '@/services/config';
import { SpeechProvider, useSpeech, type SpeechValue } from '@/speech/SpeechProvider';

/**
 * The voice on a real phone: the cloud voice answers first — a few kilobytes
 * of MP3 per sentence from the server, so it is fast on a village connection
 * with no 63 MB model to download. Piper's Urdu model is the fallback when
 * the server voice cannot run, and the browser's own voice is the fallback
 * after that. These tests pin the rules that fix the slow first press: the
 * cloud voice is tried first, preload and warm start no download, the pill
 * shows the wait when Piper is loading, and Urdu is read by a Saraiki or
 * Urdu voice, or not at all.
 */

const piperMock = vi.hoisted(() => ({
  loadState: 'idle' as 'idle' | 'loading' | 'ready',
  listeners: new Set<(state: 'idle' | 'loading' | 'ready') => void>(),
  warmCalls: 0,
  synthesiseCalls: 0,
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
  synthesiseUrduSpeech: async () => {
    piperMock.synthesiseCalls += 1;
    return piperMock.synthesiseResult;
  },
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

/**
 * The cloud voice's endpoint, set for one test and restored after it.
 * `serviceConfig` is a plain object, not frozen, so a test can point it at a
 * fake server — and the real one is `null` in this test environment, which is
 * how the existing tests exercise the fall-through to Piper and the browser.
 */
const CLOUD_URL = 'https://example.supabase.co/functions/v1/speak';
/* The deployed function checks the project's anon key, so a test that
   expects a request must carry one. */
const CLOUD_KEY = 'test-anon-key';
const savedEndpoint = serviceConfig.speakEndpoint;
const savedAnonKey = serviceConfig.supabase.anonKey;

function setCloudEndpoint(url: string | null): void {
  serviceConfig.speakEndpoint = { url, configured: url !== null };
}

function setCloudKey(key: string | null): void {
  serviceConfig.supabase.anonKey = key;
}

/**
 * A fake `<audio>` element. jsdom's `play()` is not implemented — it logs
 * and returns `undefined`, so `play().then` throws — and `createObjectURL`
 * is missing entirely. The stub plays a part and ends it on the next tick,
 * so the reading moves to the next part.
 */
function installAudioElement() {
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  const originalPlay = HTMLAudioElement.prototype.play;
  URL.createObjectURL = () => 'blob:fake-audio';
  URL.revokeObjectURL = (_url: string) => undefined;
  HTMLAudioElement.prototype.play = function (this: HTMLAudioElement) {
    queueMicrotask(() => {
      this.onended?.(new Event('ended'));
    });
    return Promise.resolve();
  };
  return () => {
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
    HTMLAudioElement.prototype.play = originalPlay;
  };
}

/** A fake server that answers with MP3. */
function installCloudServer() {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (url: string) => {
    calls.push(url);
    return {
      ok: true,
      status: 200,
      blob: async () => new Blob(['fake-mp3'], { type: 'audio/mpeg' }),
    };
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
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
  piperMock.synthesiseCalls = 0;
  piperMock.synthesiseResult = false;
  vi.unstubAllGlobals();
  serviceConfig.speakEndpoint = savedEndpoint;
  serviceConfig.supabase.anonKey = savedAnonKey;
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

  it('starts no model download when preloadVoice is called', async () => {
    installSpeechEngine('start', [voice('ur-PK', 'Urdu (Pakistan)')]);
    const { value, unmount } = renderProvider();
    value.preloadVoice();
    /* The cloud voice needs no warm-up, and Piper is only a fallback — so
       preloadVoice starts no download at all. */
    expect(piperMock.warmCalls).toBe(0);
    unmount();
  });

  it('starts no model download when warm is called', async () => {
    installSpeechEngine('start', [voice('ur-PK', 'Urdu (Pakistan)')]);
    const { value, unmount } = renderProvider();
    value.warm('ur-PK', 'صاف آسمان ہے۔');
    /* Warming Piper would start the 63 MB download the farmer complained
       about, so warm does nothing now. */
    expect(piperMock.warmCalls).toBe(0);
    unmount();
  });
});

describe('the cloud voice is tried first', () => {
  it('reads with the server voice and never reaches Piper or the browser', async () => {
    const engine = installSpeechEngine('start', [voice('ur-PK', 'Urdu (Pakistan)')]);
    setCloudEndpoint(CLOUD_URL);
    setCloudKey(CLOUD_KEY);
    const { calls } = installCloudServer();
    const restoreAudio = installAudioElement();
    piperMock.synthesiseResult = true;
    const { value, unmount } = renderProvider();
    let started: boolean | undefined;
    await act(async () => {
      started = await value.speak({ id: 'weather', text: 'صاف آسمان ہے۔', lang: 'ur-PK' });
    });
    expect(started).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(CLOUD_URL);
    /* Neither fallback was used: Piper's synthesis was never asked for,
       and the browser's engine was never handed the words. */
    expect(piperMock.synthesiseCalls).toBe(0);
    expect(engine.spoken).toHaveLength(0);
    expect(screen.getByTestId('speaking')).toHaveTextContent('none');
    restoreAudio();
    unmount();
  });

  it('falls through to the next voice when the server cannot be reached', async () => {
    const urdu = voice('ur-PK', 'Urdu (Pakistan)');
    const engine = installSpeechEngine('start', [urdu]);
    setCloudEndpoint(CLOUD_URL);
    setCloudKey(CLOUD_KEY);
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network down');
    }));
    /* Piper is tried and cannot run either, so the browser's Urdu voice
       reads — the press is answered, not silent. */
    piperMock.synthesiseResult = false;
    const { value, unmount } = renderProvider();
    let started: boolean | undefined;
    await act(async () => {
      started = await value.speak({ id: 'weather', text: 'صاف آسمان ہے۔', lang: 'ur-PK' });
    });
    expect(started).toBe(true);
    expect(piperMock.synthesiseCalls).toBe(1);
    expect(engine.spoken).toHaveLength(1);
    expect(engine.spoken[0]?.voice).toBe(urdu);
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
