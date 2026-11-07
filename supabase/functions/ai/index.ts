/**
 * The AI gateway.
 *
 * The app calls this, never the model vendor. Two consequences follow, and both
 * are PRD requirements rather than implementation preferences:
 *
 *   · The OpenAI key lives here, in the function's environment. A key in the
 *     APK is a key published on the internet.
 *   · The gate, the knowledge base and the confidence rule are enforced on the
 *     server, so a farmer's device cannot make the model answer something the
 *     app is not allowed to say — and the knowledge version cited in an answer
 *     cannot differ from the one the server actually used.
 *
 *   Live data: a rates or weather question is answered from `market_rates()` /
 *   `latest_weather()` rows fetched here, never from memory; the rows are cited
 *   with source and observed date.
 *
 * Routes, after the function name:
 *
 *   POST /ai/ask       { question, context }        → AiAnswer
 *   POST /ai/diagnose  { imageRef, context }        → AiScanResult
 *   GET  /ai/health                                 → which pieces are configured
 *
 * The shape of the reply is the client's `AiAnswer`/`AiScanResult` contract.
 * Nothing is invented to fill a gap: when the knowledge base does not cover the
 * question, the reply is `not_covered` with an escalation, which is what the
 * development provider does and what the tests assert.
 */

import {
  adminClient,
  callerOf,
  clean,
  fail,
  json,
  preflight,
  readJson,
  routeOf,
} from '../_shared/server.ts';
import { retrieveKnowledge, type KnowledgeHit } from '../_shared/knowledge.ts';
import { complete, modelConfigured, parseJsonObject, providerStatus } from '../_shared/model.ts';

const FUNCTION = 'ai';

/** Mirrors `AI_CONFIDENCE_THRESHOLD` in the client's service contract. */
const CONFIDENCE_THRESHOLD = 70;

type Gate = 'agriculture' | 'off_domain' | 'not_covered';

type Citation = {
  kind: 'knowledge' | 'weather' | 'market' | 'crop_fact' | 'scan';
  label: string;
  version?: number;
};

type AiContext = {
  cropCode?: string;
  cropStage?: string;
  district?: string;
  language: string;
  /** Optional location for `latest_weather()`; absent when the client sent none. */
  lat?: number;
  lon?: number;
  weatherUsable?: boolean;
  signalSubjects?: string[];
};

type AiAnswer = {
  gate: Gate;
  confidence: number;
  text?: string;
  refusalReasonKey?: string;
  citations: Citation[];
  escalate: boolean;
  caveats: string[];
};

type AiScanResult = {
  gate: Gate;
  diagnosis: string | null;
  confidence: number;
  uncertaintyKey: string | null;
  product?: {
    canonicalId: string;
    name: string;
    registrationNo: string | null;
    listingDealerIds: string[];
  };
  citations: Citation[];
  escalate: boolean;
};

/* -------------------------------------------------------------------------- */
/* Gates                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Terms that place a question outside what this app is for.
 *
 * A word list is a crude instrument, and it is used here deliberately as a
 * *pre-filter* rather than as the decision: a question that looks off-domain is
 * only refused outright when no published knowledge matches it. A farmer asking
 * "how do I price my crop" contains no agricultural keyword at all, and must not
 * be refused because of that.
 */
const OFF_DOMAIN = [
  'cricket', 'football', 'movie', 'song', 'politics', 'election', 'bitcoin',
  'crypto', 'lottery', 'visa', 'passport', 'recipe', 'joke', 'weather in london',
];

const AGRICULTURE_SIGNALS = [
  'crop', 'wheat', 'cotton', 'rice', 'maize', 'sugarcane', 'fertiliser',
  'fertilizer', 'khad', 'pesticide', 'spray', 'water', 'irrigation', 'seed',
  'soil', 'harvest', 'sowing', 'pest', 'disease', 'weed', 'insect', 'leaf',
  'yield', 'mandi', 'price', 'market', 'weather', 'rain', 'livestock', 'cattle',
  'animal', 'buffalo', 'goat', 'wheat', 'گندم', 'کپاس', 'چاول', 'مکئی', 'کھاد',
  'پانی', 'بیج', 'مٹی', 'فصل', 'کیڑا', 'بیماری', 'منڈی', 'بارش', 'موسم',
];

function looksOffDomain(question: string): boolean {
  const lower = question.toLowerCase();
  const hit = OFF_DOMAIN.some((term) => lower.includes(term));
  if (!hit) return false;
  // Only off-domain if nothing agricultural appears beside it.
  return !AGRICULTURE_SIGNALS.some((term) => lower.includes(term));
}

/* -------------------------------------------------------------------------- */
/* Live data: mandi rates and weather                                         */
/* -------------------------------------------------------------------------- */

const MARKET_TERMS = [
  'mandi', 'market', 'price', 'rate', 'bhao', 'bhaav', 'منڈی', 'قیمت', 'بھاؤ',
];

const WEATHER_TERMS = [
  'weather', 'rain', 'temperature', 'forecast', 'mosam', 'موسم', 'بارش',
];

/** Question words (English and Urdu) mapped to `market_commodities.code`. */
const COMMODITY_WORDS: Array<[string, string]> = [
  ['wheat', 'wheat'], ['گندم', 'wheat'],
  ['cotton', 'cotton'], ['کپاس', 'cotton'],
  ['rice', 'rice'], ['چاول', 'rice'],
  ['maize', 'maize'], ['corn', 'maize'], ['مکئی', 'maize'],
  ['sugarcane', 'sugarcane'], ['گنا', 'sugarcane'],
  ['potato', 'potato'], ['آلو', 'potato'],
  ['onion', 'onion'], ['پیاز', 'onion'],
  ['gram', 'gram'], ['چنا', 'gram'],
];

function asksAbout(question: string, terms: string[]): boolean {
  const lower = question.toLowerCase();
  return terms.some((term) => lower.includes(term));
}

function commodityIn(question: string): string | null {
  const lower = question.toLowerCase();
  const found = COMMODITY_WORDS.find(([word]) => lower.includes(word));
  return found ? found[1] : null;
}

type MarketRateRow = {
  commodity_code: string;
  commodity_name_en: string;
  market_name: string;
  observed_on: string;
  age_hours: number | null;
  min_price: number | null;
  max_price: number | null;
  modal_price: number | null;
  currency: string;
  source_code: string;
  source_name: string;
  is_recent: boolean;
};

type WeatherRow = {
  provider_code: string;
  provider_name: string;
  attribution: string | null;
  observed_at: string;
  age_minutes: number | null;
  freshness: string;
  is_usable: boolean;
  temp_c: number | null;
  humidity_pct: number | null;
  precip_mm: number | null;
  wind_kph: number | null;
  condition_text: string | null;
};

/**
 * Latest rate per market from `market_rates()`. `is_recent` is reported, never
 * filtered: a stale rate is shown as stale, not silently dropped or refreshed
 * with a guess. A missing price stays "not reported", never zero.
 */
async function fetchMarketRates(
  client: ReturnType<typeof adminClient>,
  commodity: string | null,
): Promise<MarketRateRow[]> {
  const { data, error } = await client.rpc('market_rates', { p_commodity: commodity });
  if (error || !Array.isArray(data)) return [];
  return (data as Array<Record<string, unknown>>)
    .filter((row) => typeof row.commodity_code === 'string' && typeof row.market_name === 'string')
    .slice(0, 8) as unknown as MarketRateRow[];
}

/**
 * Pakistan, bounding box — the same box the app's weather provider enforces.
 * The AI weather path serves Pakistani farmers only: a location outside it is
 * treated as no location, so `latest_weather` is never asked about it.
 */
function inPakistan(lat: number, lon: number): boolean {
  return lat >= 23.5 && lat <= 37.1 && lon >= 60.8 && lon <= 77.0;
}

/** Latest reading from `latest_weather()`; null when no reading exists. */
async function fetchWeather(
  client: ReturnType<typeof adminClient>,
  lat: number,
  lon: number,
): Promise<WeatherRow | null> {
  if (!inPakistan(lat, lon)) return null;
  const { data, error } = await client.rpc('latest_weather', { p_lat: lat, p_lon: lon });
  if (error || !Array.isArray(data)) return null;
  const row = (data as Array<Record<string, unknown>>)[0];
  if (!row || typeof row.observed_at !== 'string') return null;
  return row as unknown as WeatherRow;
}

function priceText(row: MarketRateRow): string {
  if (row.modal_price !== null && row.modal_price !== undefined) return `${row.modal_price}`;
  if (row.min_price !== null && row.min_price !== undefined && row.max_price !== null && row.max_price !== undefined) {
    return `${row.min_price}–${row.max_price}`;
  }
  return 'not reported';
}

/** The live rows, rendered for the model with source and observed date. */
function liveDataBlock(rates: MarketRateRow[], weather: WeatherRow | null): string {
  const lines: string[] = [];
  for (const row of rates) {
    lines.push(
      `- ${row.commodity_name_en} — ${row.market_name}: ${priceText(row)} ${row.currency} per 40kg, ` +
        `observed ${row.observed_on} (${row.age_hours ?? '?'}h ago), source ${row.source_name} (${row.source_code}), ` +
        `recent: ${row.is_recent ? 'yes' : 'no'}.`,
    );
  }
  if (weather) {
    if (weather.is_usable) {
      lines.push(
        `- Weather (${weather.provider_name}): ${weather.temp_c ?? 'not reported'}°C, ` +
          `humidity ${weather.humidity_pct ?? 'not reported'}%, rain ${weather.precip_mm ?? 'not reported'}mm, ` +
          `wind ${weather.wind_kph ?? 'not reported'} kph, ${weather.condition_text ?? ''}; ` +
          `observed ${weather.observed_at} (${weather.age_minutes ?? '?'} min ago), freshness ${weather.freshness}.`,
      );
    } else {
      lines.push(
        `- Weather reading is NOT usable (freshness: ${weather.freshness}, observed ${weather.observed_at}). ` +
          `Do not give weather-dependent advice.`,
      );
    }
  }
  return lines.join('\n');
}

/** Confidence for an answer grounded only in live data, not knowledge. */
function liveConfidence(rates: MarketRateRow[], weather: WeatherRow | null): number {
  if (rates.length > 0) return rates.some((row) => row.is_recent) ? 80 : 60;
  if (weather && weather.is_usable) return 80;
  return 0;
}

/* -------------------------------------------------------------------------- */
/* Grounding                                                                  */
/* -------------------------------------------------------------------------- */

function caveatsFor(
  hits: KnowledgeHit[],
  context: AiContext,
  mode: 'keyword' | 'semantic',
  rates: MarketRateRow[] = [],
): string[] {
  const caveats: string[] = [];
  if (mode === 'keyword') {
    caveats.push('Answers are drawn from a keyword index over published entries.');
  }
  if (rates.some((row) => !row.is_recent)) {
    caveats.push('Some cited rates are not recent; the observed date is shown, treat them as the last reported rate, not today\'s.');
  }
  if (!context.cropCode) {
    caveats.push('No crop was confirmed, so the answer is not crop-specific.');
  }
  if (context.weatherUsable === false) {
    caveats.push('Weather is not usable right now, so no weather-dependent step is given.');
  }
  const oldest = hits.reduce((acc, hit) => Math.max(acc, hit.version), 0);
  if (oldest > 1) {
    caveats.push(`Some cited entries have been revised (up to version ${oldest}).`);
  }
  return caveats;
}

function citationsFor(
  hits: KnowledgeHit[],
  context: AiContext,
  rates: MarketRateRow[] = [],
  weather: WeatherRow | null = null,
): Citation[] {
  const citations: Citation[] = hits.map((hit) => ({
    kind: 'knowledge' as const,
    label: hit.topic || hit.slug,
    version: hit.version,
  }));
  if (context.cropCode) {
    citations.push({
      kind: 'crop_fact',
      label: [context.cropCode, context.cropStage].filter(Boolean).join(', '),
    });
  }
  for (const row of rates) {
    citations.push({
      kind: 'market',
      label: `${row.commodity_name_en} — ${row.market_name}, observed ${row.observed_on} (${row.source_name})`,
    });
  }
  if (weather && weather.is_usable) {
    citations.push({
      kind: 'weather',
      label: `${weather.provider_name}, observed ${weather.observed_at} (${weather.freshness})`,
    });
  }
  return citations;
}

/**
 * A confidence number for a grounded answer.
 *
 * It is derived from retrieval, not from the model's self-report. A model asked
 * "how confident are you" answers with a number that tracks its tone, not its
 * evidence; retrieval scores track the evidence. This is the same formula the
 * development provider uses, so a question that escalates in tests escalates in
 * production.
 */
function confidenceFor(hits: KnowledgeHit[], context: AiContext): number {
  if (hits.length === 0) return 0;
  const best = hits[0]!;
  const cropBonus = context.cropCode && best.cropCode === context.cropCode ? 5 : 0;
  return Math.round(Math.min(92, 55 + Math.min(best.score, 1) * 35 + cropBonus));
}

function systemPrompt(context: AiContext, hits: KnowledgeHit[], live = ''): string {
  const language = context.language === 'ur' ? 'Urdu' : 'English';
  const knowledge = hits
    .map((hit, index) => `[${index + 1}] ${hit.title} (v${hit.version}, ${hit.provenance})\n${hit.body}`)
    .join('\n\n');

  return [
    'You are an agricultural advisor for smallholder farmers in Punjab, Pakistan.',
    `Answer in ${language}. Keep it short and practical, and name the action to take.`,
    '',
    'Hard rules:',
    '· Use ONLY the numbered knowledge entries below. Do not add facts from memory.',
    '· For prices and weather, use ONLY the live data below. Never quote a rate or a reading from memory.',
    '· If the entries and live data do not answer the question, say so plainly and stop.',
    '· Cite the entries you used by their bracketed number, e.g. [1].',
    '· Cite every rate and weather reading with its source and observed date.',
    '· If a rate is marked not recent, say it is the last reported rate, not today\'s.',
    '· Never name a pesticide dose, brand or product that is not in an entry.',
    '· Do not mention weather unless a reading is provided and marked usable.',
    '',
    `Confirmed crop: ${context.cropCode ?? 'unknown'} (stage: ${context.cropStage ?? 'unknown'})`,
    `District: ${context.district ?? 'unknown'}`,
    `Weather usable for advice: ${context.weatherUsable === true ? 'yes' : 'no'}`,
    '',
    'Knowledge entries:',
    knowledge || '(none retrieved)',
    '',
    'Live data (mandi rates / weather, fetched for this question):',
    live || '(none fetched — no rates or weather question was asked, or no reading exists)',
  ].join('\n');
}

/* -------------------------------------------------------------------------- */
/* Handlers                                                                   */
/* -------------------------------------------------------------------------- */

async function handleAsk(body: Record<string, unknown>): Promise<Response> {
  const question = clean(body.question, 500);
  if (!question) return fail('A question is required.');

  const context = (body.context ?? {}) as AiContext;
  const language = context.language === 'ur' ? 'ur' : 'en';

  // The domain gate runs before retrieval, but only refuses outright when
  // nothing agricultural is present and no published entry matches.
  const client = adminClient();
  const wantsMarket = asksAbout(question, MARKET_TERMS);
  const wantsWeather = asksAbout(question, WEATHER_TERMS);
  const hasLocation =
    typeof context.lat === 'number' &&
    typeof context.lon === 'number' &&
    inPakistan(context.lat, context.lon);
  const [{ hits, mode }, rates, weather] = await Promise.all([
    retrieveKnowledge(client, question, {
      cropCode: context.cropCode ?? null,
      limit: 4,
    }),
    wantsMarket
      ? fetchMarketRates(client, commodityIn(question))
      : Promise.resolve([] as MarketRateRow[]),
    wantsWeather && hasLocation
      ? fetchWeather(client, context.lat as number, context.lon as number)
      : Promise.resolve(null as WeatherRow | null),
  ]);
  // A fetched reading overrides the client's freshness flag: the server's own
  // read is what the answer may cite.
  if (weather) context.weatherUsable = weather.is_usable;

  if (looksOffDomain(question) && hits.length === 0) {
    const refusal: AiAnswer = {
      gate: 'off_domain',
      confidence: 0,
      refusalReasonKey: 'scan.offDomain.title',
      citations: [],
      escalate: false,
      caveats: [],
    };
    return json(refusal);
  }

  // Live rows ground an answer on their own: a rates question needs no
  // knowledge entry. Weather only grounds when the reading is usable.
  const groundedByLive = rates.length > 0 || (weather !== null && weather.is_usable);
  if (hits.length === 0 && !groundedByLive) {
    const uncovered: AiAnswer = {
      gate: 'not_covered',
      confidence: 20,
      refusalReasonKey: 'scan.notCovered.title',
      citations: [],
      escalate: true,
      caveats: [
        'No published knowledge entry matched this question.',
        ...(wantsWeather && !hasLocation
          ? ['No usable location was sent with the question, so no weather reading could be fetched.']
          : []),
        ...(weather && !weather.is_usable
          ? ['The latest weather reading is not usable, so no weather answer could be given.']
          : []),
        'Nothing was invented to fill the gap — a person can answer it.',
      ],
    };
    return json(uncovered);
  }

  if (!modelConfigured()) {
    // Honest degraded mode: the retrieval is real and citable, the prose is not
    // available. Reported as an error rather than answered from the raw entries,
    // because an unedited bulletin is not an answer to a specific question.
    return fail('The model is not configured on the server.', 503);
  }

  const reply = await complete([
    { role: 'system', content: systemPrompt(context, hits, liveDataBlock(rates, weather)) },
    { role: 'user', content: question },
  ], { maxTokens: 600 });

  if (!reply.ok) {
    return fail(`The model could not answer: ${reply.detail}`, 502);
  }

  const confidence = hits.length > 0 ? confidenceFor(hits, context) : liveConfidence(rates, weather);
  const answer: AiAnswer = {
    gate: 'agriculture',
    confidence,
    text: reply.text,
    citations: citationsFor(hits, context, rates, weather),
    escalate: confidence < CONFIDENCE_THRESHOLD,
    caveats: caveatsFor(hits, context, mode, rates),
  };
  return json(answer);
}

/**
 * Diagnosis is a two-stage pipeline, and the order matters.
 *
 * The image is described first, and the description is then matched against the
 * knowledge base. Asking a vision model to name a pesticide directly is how an
 * app ends up recommending a product nobody approved; asking it to describe what
 * it sees keeps the medical judgement inside the authored entries.
 */
async function handleDiagnose(body: Record<string, unknown>): Promise<Response> {
  const imageRef = clean(body.imageRef, 4000);
  if (!imageRef) return fail('An image reference is required.');

  const context = (body.context ?? {}) as AiContext;

  if (!modelConfigured()) {
    return fail('The model is not configured on the server.', 503);
  }

  const isDataUrl = imageRef.startsWith('data:image/');
  const userContent: Array<Record<string, unknown>> = [
    {
      type: 'text',
      text: [
        'Describe what is visible on this crop leaf or plant, and name the most likely problem.',
        `Crop: ${context.cropCode ?? 'unknown'}, stage: ${context.cropStage ?? 'unknown'}.`,
        'Reply as JSON: {"problem": string, "symptoms": string[], "confidence": number, "is_agriculture": boolean}.',
        'Set is_agriculture false if the image is not a plant. Do not name any pesticide or product.',
      ].join('\n'),
    },
  ];
  if (isDataUrl) {
    userContent.push({ type: 'image_url', image_url: { url: imageRef } });
  }

  const reply = await complete(
    [
      {
        role: 'system',
        content:
          'You are a plant pathologist. You describe what you see and you never recommend a chemical.',
      },
      { role: 'user', content: userContent as unknown as string },
    ],
    { json: true, maxTokens: 400 },
  );

  if (!reply.ok) {
    return fail(`The image could not be read: ${reply.detail}`, 502);
  }

  const parsed = parseJsonObject(reply.text) ?? {};
  const isAgriculture = parsed.is_agriculture !== false;
  const problem = typeof parsed.problem === 'string' ? parsed.problem : null;

  if (!isAgriculture || !problem) {
    const offDomain: AiScanResult = {
      gate: 'off_domain',
      diagnosis: null,
      confidence: 0,
      uncertaintyKey: 'scan.offDomain.title',
      citations: [],
      escalate: false,
    };
    return json(offDomain);
  }

  // The description is matched against published entries; the product chain
  // comes from the knowledge row, never from the model.
  const client = adminClient();
  const { hits } = await retrieveKnowledge(client, problem, {
    cropCode: context.cropCode ?? null,
    limit: 3,
  });

  if (hits.length === 0) {
    const uncovered: AiScanResult = {
      gate: 'not_covered',
      diagnosis: problem,
      confidence: 25,
      uncertaintyKey: 'scan.notCovered.title',
      citations: [],
      escalate: true,
    };
    return json(uncovered);
  }

  const modelConfidence =
    typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)
      ? Math.max(0, Math.min(100, Math.round(parsed.confidence)))
      : 50;
  // Blended, then capped by evidence: a confident model over a thin retrieval
  // does not produce a confident app.
  const confidence = Math.round(Math.min(88, modelConfidence * 0.4 + confidenceFor(hits, context) * 0.6));

  const top = hits[0]!;
  const product = await productChain(client, top);

  const result: AiScanResult = {
    gate: 'agriculture',
    diagnosis: problem,
    confidence,
    uncertaintyKey: confidence < CONFIDENCE_THRESHOLD ? 'scan.uncertainty' : null,
    ...(product ? { product } : {}),
    citations: citationsFor(hits, context),
    escalate: confidence < CONFIDENCE_THRESHOLD,
  };
  return json(result);
}

/**
 * The evidence chain behind a treatment: the canonical product the cited entry
 * names, plus which dealers currently list it. Read from the database, so the
 * shop list cannot disagree with the dealer page.
 */
async function productChain(
  client: ReturnType<typeof adminClient>,
  hit: KnowledgeHit,
): Promise<AiScanResult['product']> {
  const { data } = await client.rpc('ai_product_for_knowledge', { p_slug: hit.slug });
  const rows = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
  const row = rows[0];
  if (!row || typeof row.canonical_id !== 'string' || typeof row.name !== 'string') return undefined;

  const listings = Array.isArray(row.listing_dealer_ids)
    ? (row.listing_dealer_ids as unknown[]).filter((id): id is string => typeof id === 'string')
    : [];

  return {
    canonicalId: row.canonical_id,
    name: row.name,
    registrationNo: typeof row.registration_no === 'string' ? row.registration_no : null,
    listingDealerIds: listings,
  };
}

/* -------------------------------------------------------------------------- */
/* Router                                                                     */
/* -------------------------------------------------------------------------- */

Deno.serve(async (req) => {
  const options = preflight(req);
  if (options) return options;

  const route = routeOf(req, FUNCTION);

  try {
    if (route === 'health') {
      /*
       * Booleans and names only. This endpoint answers "is the key working?"
       * without ever echoing the key — a health check that prints a prefix of a
       * secret is a health check that leaks it.
       */
      return json({ ok: true, ...providerStatus() });
    }

    if (req.method !== 'POST') return fail('Use POST.', 405);

    const caller = await callerOf(req);
    const body = (await readJson<Record<string, unknown>>(req)) ?? {};

    // Identity is recorded for the audit trail but never trusted from the body.
    const context = (body.context ?? {}) as AiContext;
    if (caller.userId) context.signalSubjects = context.signalSubjects ?? [];

    switch (route) {
      case 'ask':
        return await handleAsk(body);
      case 'diagnose':
        return await handleDiagnose(body);
      default:
        return fail(`Unknown route "${route}".`, 404);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unexpected error';
    return fail(detail, 500);
  }
});

