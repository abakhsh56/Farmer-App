/**
 * What the assistant does with a farmer's sentence.
 *
 * The PRD draws a hard line: AI may explain and converse, but canonical weather,
 * prices, dealer verification and stock come from system sources. A general
 * model answering "what is the weather like today?" is the failure case, not the
 * feature. So a question is first routed:
 *
 *   weather  → the same weather service the Home card reads
 *   dealers  → the same dealer search the Shop tab runs, with the radius parsed
 *              out of the sentence ("within 10 km")
 *   market   → the same market provider the mandi screen uses
 *   anything else → the knowledge-grounded assistant, which has its own
 *              agriculture gate, confidence, citations and escalation
 *
 * Two consequences worth stating, because they are the reason this file is not
 * just a prompt:
 *
 *  · The assistant cannot invent a temperature or a price, because it never holds
 *    one — the reply carries the provider's own reading, its observation time and
 *    its source label, and the screen prints them.
 *  · An empty result is a real answer. "No shop within 10 km has listed this" is
 *    what the dealer service said, and saying it is better than a model guessing
 *    that somewhere nearby probably has stock.
 *
 * Routing is deliberately keyword-based and small. It is not a language model
 * pretending to be a router: a wrong route here means the farmer is shown a
 * correct answer to a slightly different question, and keeping the rules legible
 * is what makes that inspectable.
 */

import type {
  AiAnswer,
  AiContext,
  AiScanResult,
  DealerSummary,
  MarketRate,
  Sourced,
  WeatherNow,
} from '@/services/types';

/** Everything the router is allowed to read. */
export type AgentDeps = {
  ask: (question: string, context: AiContext) => Promise<AiAnswer>;
  diagnose: (imageRef: string, context: AiContext) => Promise<AiScanResult>;
  weather: () => Promise<Sourced<WeatherNow>>;
  dealers: (radiusKm: number) => Promise<Sourced<DealerSummary[]>>;
  market: () => Promise<Sourced<MarketRate[]>>;
  /** The radius in play, used when the farmer did not name one. */
  radiusKm: number;
  /** The farmer's language, passed to the knowledge assistant. */
  language: string;
  cropCode?: string;
};

export type AgentReply =
  | { kind: 'weather'; reading: Sourced<WeatherNow> }
  /*
   * `failed` is what keeps a broken service from reading as an empty one. A
   * provider that could not be reached returns no rows, and "no shop within
   * 10 km has that" and "the shop list could not be loaded" are different
   * statements — the second one is true, and the farmer can act on it.
   */
  | {
      kind: 'dealers';
      radiusKm: number;
      dealers: DealerSummary[];
      source: string;
      observedAt: number;
      failed: boolean;
    }
  | { kind: 'market'; rates: MarketRate[]; source: string; observedAt: number; failed: boolean }
  | { kind: 'answer'; answer: AiAnswer }
  | { kind: 'scan'; result: AiScanResult }
  | { kind: 'failed'; message: string };

const WEATHER = /weather|rain|temperature|forecast|humid|wind|بارش|موسم|درجہ حرارت|ہوا|گرمی|سردی/i;
const DEALER = /dealer|shop|store|dukan|سٹور|دکان|ڈیلر|دکاندار|nearby|قریب/i;
const MARKET = /rate|price|mandi|بھاؤ|منڈی|قیمت|نرخ|بازار بھاؤ/i;
const RADIUS = /(\d+(?:\.\d+)?)\s*(?:km|kms|kilometer|kilometre|kilometers|kilometres|کلومیٹر)/i;

/** The radius a sentence names, clamped to what the product allows. */
export function parseRadius(question: string, fallback: number): number {
  const match = RADIUS.exec(question);
  if (!match) return fallback;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(100, Math.max(1, value));
}

/** Which source a question belongs to. Exported so the route is testable. */
export type AgentIntent = 'weather' | 'dealers' | 'market' | 'knowledge';

export function route(question: string): AgentIntent {
  const text = question.trim();
  /* Weather first: "will it rain before I spray" is a weather question even though
     it mentions spraying, and answering it from the spray bulletin alone would
     drop the part the farmer actually asked. */
  if (WEATHER.test(text)) return 'weather';
  /* A radius is only ever attached to a shop question, so naming one is enough. */
  if (DEALER.test(text) || RADIUS.test(text)) return 'dealers';
  if (MARKET.test(text)) return 'market';
  return 'knowledge';
}

/**
 * Ask the assistant, and route the question to the service that owns the answer.
 *
 * Every branch returns the source it used, so the screen can say where a number
 * came from. A provider that could not be reached is reported as a reading that
 * failed rather than as an answer — the screen shows the same "not available"
 * line the weather card would.
 */
export async function respond(question: string, deps: AgentDeps): Promise<AgentReply> {
  const intent = route(question);

  try {
    if (intent === 'weather') {
      const reading = await deps.weather();
      return { kind: 'weather', reading };
    }

    if (intent === 'dealers') {
      const radiusKm = parseRadius(question, deps.radiusKm);
      const found = await deps.dealers(radiusKm);
      return {
        kind: 'dealers',
        radiusKm,
        dealers: found.data,
        source: found.sourceLabel,
        observedAt: found.observedAt,
        failed: found.status === 'failing' || found.error !== undefined,
      };
    }

    if (intent === 'market') {
      const rates = await deps.market();
      return {
        kind: 'market',
        rates: rates.data,
        source: rates.sourceLabel,
        observedAt: rates.observedAt,
        failed: rates.status === 'failing' || rates.error !== undefined,
      };
    }

    const answer = await deps.ask(question, {
      ...(deps.cropCode ? { cropCode: deps.cropCode } : {}),
      language: deps.language,
    });
    return { kind: 'answer', answer };
  } catch (failure) {
    return {
      kind: 'failed',
      message: failure instanceof Error ? failure.message : 'The service could not be reached.',
    };
  }
}

/** A photo sent to the assistant is a diagnosis, not a chat turn. */
export async function diagnosePhoto(
  imageRef: string,
  deps: AgentDeps,
): Promise<AgentReply> {
  try {
    const result = await deps.diagnose(imageRef, {
      ...(deps.cropCode ? { cropCode: deps.cropCode } : {}),
      language: deps.language,
    });
    return { kind: 'scan', result };
  } catch (failure) {
    return {
      kind: 'failed',
      message: failure instanceof Error ? failure.message : 'The service could not be reached.',
    };
  }
}
