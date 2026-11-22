import { describe, expect, it } from 'vitest';
import { parseRadius, respond, route, type AgentDeps } from './agent';
import type { AiAnswer, DealerSummary, Sourced } from '@/services/types';

/**
 * The router's rules, as tests.
 *
 * Two of them are load-bearing:
 *
 *  · A question about the sky, a shop or a price is answered by the service that
 *    owns it, not by the language model — so the test asserts the route, not the
 *    wording of an answer.
 *  · A provider that failed is *reported as failed*. Empty and broken look the
 *    same in an array, and turning a 500 into "no shop within 10 km has that" is
 *    a lie about the farmer's neighbourhood.
 */

const NOW = new Date(2026, 10, 21, 12).getTime();

const sourced = <T>(data: T, overrides: Partial<Sourced<T>> = {}): Sourced<T> => ({
  data,
  sourceLabel: 'Supabase dealer projection',
  observedAt: NOW,
  fetchedAt: NOW,
  freshness: 'fresh',
  status: 'live',
  ...overrides,
});

const answer: AiAnswer = {
  text: 'Scout for pink bollworm from the first square.',
  confidence: 70,
  caveats: [],
  citations: [],
  escalate: false,
  gate: 'agriculture',
};

function deps(overrides: Partial<AgentDeps> = {}): AgentDeps {
  return {
    ask: async () => answer,
    diagnose: async () => {
      throw new Error('not used');
    },
    weather: async () => sourced({} as never),
    dealers: async () => sourced<DealerSummary[]>([]),
    market: async () => sourced([]),
    radiusKm: 10,
    language: 'en',
    ...overrides,
  };
}

describe('asking the assistant', () => {
  it('sends each kind of question to the service that owns the answer', () => {
    expect(route('What is the weather like today?')).toBe('weather');
    expect(route('Which dealers are within 10 km?')).toBe('dealers');
    /* A radius is only ever attached to a shop question. */
    expect(route('anything within 5 km')).toBe('dealers');
    expect(route('What is the cotton rate in the mandi today?')).toBe('market');
    expect(route('How do I control pink bollworm?')).toBe('knowledge');
    /* Urdu routes on the same words, because the farmer may type either. */
    expect(route('آج موسم کیسا ہے؟')).toBe('weather');
    expect(route('10 کلومیٹر کے اندر کون سی دکانیں ہیں؟')).toBe('dealers');
  });

  it('reads the radius out of the sentence and clamps it to the product limit', () => {
    expect(parseRadius('dealers within 10 km', 25)).toBe(10);
    expect(parseRadius('dealers within 2.5 kilometres', 25)).toBe(2.5);
    expect(parseRadius('dealers within 5000 km', 25)).toBe(100);
    expect(parseRadius('dealers within 0 km', 25)).toBe(25);
    expect(parseRadius('dealers near me', 25)).toBe(25);
  });

  it('answers a shop question from the dealer service, nearest first', async () => {
    const found: DealerSummary[] = [
      { id: 'dealer.a', name: 'A', distanceKm: 1.4 } as DealerSummary,
      { id: 'dealer.b', name: 'B', distanceKm: 8.2 } as DealerSummary,
    ];
    const reply = await respond(
      'Which dealers are within 10 km?',
      deps({ dealers: async () => sourced(found) }),
    );
    expect(reply.kind).toBe('dealers');
    if (reply.kind !== 'dealers') return;
    expect(reply.failed).toBe(false);
    expect(reply.radiusKm).toBe(10);
    expect(reply.dealers.map((dealer) => dealer.id)).toEqual(['dealer.a', 'dealer.b']);
  });

  it('reports a dealer service that failed as failed, not as no shops nearby', async () => {
    const reply = await respond(
      'Which dealers are within 10 km?',
      deps({
        dealers: async () =>
          sourced<DealerSummary[]>([], { status: 'failing', error: 'No search origin was given.' }),
      }),
    );
    expect(reply.kind).toBe('dealers');
    if (reply.kind !== 'dealers') return;
    /* The screen prints a different sentence for this, and it was the difference
       between "there is nothing near you" and "we could not ask". */
    expect(reply.failed).toBe(true);
    expect(reply.dealers).toHaveLength(0);
  });

  it('reports a market feed that failed rather than quoting no prices', async () => {
    const reply = await respond(
      'What is the cotton rate today?',
      deps({ market: async () => sourced([], { status: 'failing', error: 'down' }) }),
    );
    expect(reply.kind).toBe('market');
    if (reply.kind !== 'market') return;
    expect(reply.failed).toBe(true);
  });

  it('passes anything else to the knowledge assistant with the farmer’s context', async () => {
    let asked: { question: string; language: string } | null = null;
    const reply = await respond(
      'How do I control pink bollworm?',
      deps({
        cropCode: 'cotton',
        language: 'ur',
        ask: async (question, context) => {
          asked = { question, language: context.language };
          return answer;
        },
      }),
    );
    expect(reply.kind).toBe('answer');
    expect(asked).toEqual({ question: 'How do I control pink bollworm?', language: 'ur' });
  });

  it('turns a thrown service into a failure the screen can show', async () => {
    const reply = await respond(
      'What is the weather like today?',
      deps({
        weather: async () => {
          throw new Error('offline');
        },
      }),
    );
    expect(reply.kind).toBe('failed');
    if (reply.kind !== 'failed') return;
    expect(reply.message).toBe('offline');
  });
});
