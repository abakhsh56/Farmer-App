import { describe, expect, it } from 'vitest';
import {
  computeCardAdvisory,
  expertAnswerFromPosts,
  pestReportsFromPosts,
  type CardAdvisoryInput,
  type AdvisoryPost,
} from './advisory';
import type { CropInstance, Insight } from '../insights/store';
import type { Sourced, WeatherDay, WeatherHour, WeatherNow } from './types';

/**
 * The ten signal-driven items, tested where they can be.
 *
 * Each item fires only on its own signal, in the PRD alert model's priority
 * order, at most three. A missing value stays missing, stale weather pauses
 * the weather items but not the knowledge-backed ones, and no crop means one
 * plain item, never a fake window. Times are built from the local day so the
 * today/tomorrow boundary holds in any timezone the suite runs in.
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = (() => {
  const d = new Date();
  d.setHours(10, 0, 0, 0);
  return d.getTime();
})();

function hour(atMs: number, over: Partial<WeatherHour> = {}): WeatherHour {
  return {
    timeMs: atMs,
    tempC: 25,
    humidityPct: 60,
    dewPointC: 19,
    windKph: 8,
    precipProbPct: 0,
    precipMm: 0,
    weatherCode: 0,
    conditionText: 'Clear sky',
    ...over,
  };
}

function dayHours(overrides: Record<number, Partial<WeatherHour>> = {}): WeatherHour[] {
  const out: WeatherHour[] = [];
  for (let i = 0; i < 24; i += 1) out.push(hour(NOW + i * HOUR, overrides[i] ?? {}));
  return out;
}

function sourcedNow(over: Partial<WeatherNow> = {}): Sourced<WeatherNow> {
  return {
    data: {
      tempC: 25,
      feelsLikeC: 26,
      humidityPct: 60,
      precipMm: 0,
      windKph: 8,
      windDir: 'N',
      conditionText: 'Clear sky',
      weatherCode: 0,
      ...over,
    },
    sourceLabel: 'Open-Meteo',
    observedAt: NOW,
    fetchedAt: NOW,
    freshness: 'fresh',
    status: 'live',
  };
}

function sourcedHourly(hours: WeatherHour[]): Sourced<WeatherHour[]> {
  return {
    data: hours,
    sourceLabel: 'Open-Meteo',
    observedAt: NOW,
    fetchedAt: NOW,
    freshness: 'fresh',
    status: 'live',
  };
}

function failingHourly(): Sourced<WeatherHour[]> {
  return {
    data: [],
    sourceLabel: 'Open-Meteo',
    observedAt: NOW,
    fetchedAt: NOW,
    freshness: 'unavailable',
    status: 'failing',
    error: 'Hourly ingestion is not deployed yet.',
  };
}

function forecastDay(date: string, precipMm: number | null): WeatherDay {
  return { date, minC: 22, maxC: 32, precipMm, conditionText: 'Clear sky' };
}

function sourcedForecast(days: WeatherDay[]): Sourced<WeatherDay[]> {
  return {
    data: days,
    sourceLabel: 'Open-Meteo',
    observedAt: NOW,
    fetchedAt: NOW,
    freshness: 'fresh',
    status: 'live',
  };
}

const CROP: CropInstance = {
  id: 'c1',
  nameKey: 'crop.cotton',
  stageKey: 'crop.stage.growing',
  stageConfirmed: true,
  plantedAt: NOW - 30 * DAY,
  primary: true,
};

function insight(over: Partial<Insight> = {}): Insight {
  return {
    id: 'i1',
    cropId: 'c1',
    kind: 'activity',
    priority: 'normal',
    titleKey: 'insight.wheat.title',
    bodyKey: 'insight.wheat.body',
    actionKey: 'insight.wheat.action',
    sourceKey: 'intel.source.knowledge',
    knowledgeVersion: '1',
    confidence: 0.9,
    createdAt: NOW - DAY,
    validUntil: NOW + 7 * DAY,
    status: 'active',
    ...over,
  };
}

const SOURCES = {
  weather: 'Open-Meteo',
  community: 'Community',
  communityExpert: 'Community + expert',
  knowledge: 'Knowledge base',
};

function baseInput(over: Partial<CardAdvisoryInput> = {}): CardAdvisoryInput {
  const days = [0, 1, 2, 3].map((i) =>
    forecastDay(new Date(NOW + i * DAY).toISOString().slice(0, 10), 0),
  );
  return {
    now: sourcedNow(),
    hourly: sourcedHourly(dayHours()),
    forecast: sourcedForecast(days),
    crop: CROP,
    insights: [],
    actedInsights: [],
    pestReports: [],
    expertAnswer: null,
    sources: SOURCES,
    ...over,
  };
}

describe('computeCardAdvisory', () => {
  it('is a single no-crop item when the farmer has no crop', () => {
    const items = computeCardAdvisory(baseInput({ crop: null }), NOW);
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe('noCrop');
    expect(items[0]?.priority).toBe(20);
  });

  it('is a single no-data item when the weather cannot be read and nothing else fires', () => {
    const items = computeCardAdvisory(baseInput({ hourly: failingHourly() }), NOW);
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe('noData');
  });

  it('shows the computed spray window, priority 10', () => {
    const items = computeCardAdvisory(baseInput(), NOW);
    const spray = items.find((item) => item.kind === 'spray');
    expect(spray).toBeDefined();
    expect(spray?.priority).toBe(10);
    expect(spray?.spray?.state).toBe('window');
  });

  it('puts a thunderstorm do-not-spray first, priority 1', () => {
    const items = computeCardAdvisory(
      baseInput({ now: sourcedNow({ weatherCode: 95 }) }),
      NOW,
    );
    expect(items[0]?.kind).toBe('spray');
    expect(items[0]?.priority).toBe(1);
    expect(items[0]?.spray?.state).toBe('do-not-spray');
  });

  it('puts heavy rain do-not-spray at priority 5', () => {
    const items = computeCardAdvisory(
      baseInput({ now: sourcedNow({ weatherCode: 65 }) }),
      NOW,
    );
    expect(items[0]?.priority).toBe(5);
    expect(items[0]?.spray?.state).toBe('do-not-spray');
  });

  it('raises the spray window to priority 8 when a pest report gives a reason to spray', () => {
    const items = computeCardAdvisory(
      baseInput({
        pestReports: [{ id: 'p1', placeLabel: 'Wazirabad', createdAt: NOW - DAY, verified: false }],
      }),
      NOW,
    );
    expect(items.find((item) => item.kind === 'spray')?.priority).toBe(8);
  });

  it('warns to finish before rain when rain is expected inside the day', () => {
    const items = computeCardAdvisory(
      baseInput({ hourly: sourcedHourly(dayHours({ 4: { precipProbPct: 70 } })) }),
      NOW,
    );
    const rainfree = items.find((item) => item.kind === 'rainfree');
    expect(rainfree).toBeDefined();
    expect(rainfree?.priority).toBe(6);
    expect(rainfree?.rainAtMs).toBe(NOW + 4 * HOUR);
  });

  it('raises an outbreak for a verified report in warm humid nights', () => {
    /* Hour 12 is 22:00 — a night hour, warm and humid. */
    const items = computeCardAdvisory(
      baseInput({
        hourly: sourcedHourly(dayHours({ 12: { humidityPct: 75 } })),
        pestReports: [{ id: 'p1', placeLabel: 'Wazirabad', createdAt: NOW - DAY, verified: true }],
      }),
      NOW,
    );
    const outbreak = items.find((item) => item.kind === 'outbreak');
    expect(outbreak).toBeDefined();
    expect(outbreak?.priority).toBe(7);
    expect(outbreak?.verified).toBe(true);
  });

  it('raises a pest threshold for an unverified report in warm humid nights', () => {
    const items = computeCardAdvisory(
      baseInput({
        hourly: sourcedHourly(dayHours({ 12: { humidityPct: 75 } })),
        pestReports: [{ id: 'p1', placeLabel: 'Wazirabad', createdAt: NOW - DAY, verified: false }],
      }),
      NOW,
    );
    expect(items.find((item) => item.kind === 'pestThreshold')?.priority).toBe(8);
    expect(items.find((item) => item.kind === 'outbreak')).toBeUndefined();
  });

  it('warns of heat at 40° and cold at 5°, as a general weather warning', () => {
    const hot = computeCardAdvisory(baseInput({ now: sourcedNow({ tempC: 42 }) }), NOW);
    expect(hot.find((item) => item.kind === 'stress')?.stressMode).toBe('heat');
    const cold = computeCardAdvisory(baseInput({ now: sourcedNow({ tempC: 3 }) }), NOW);
    expect(cold.find((item) => item.kind === 'stress')?.stressMode).toBe('cold');
  });

  it('prefers the knowledge base weather insight over the generic extreme', () => {
    const items = computeCardAdvisory(
      baseInput({
        now: sourcedNow({ tempC: 42 }),
        insights: [insight({ kind: 'weather', titleKey: 'insight.irrigation.title' })],
      }),
      NOW,
    );
    const stress = items.find((item) => item.kind === 'stress');
    expect(stress?.insightId).toBe('i1');
    expect(stress?.tempC).toBeUndefined();
  });

  it('shows harvest-ready for boll formation with a dry window ahead', () => {
    const items = computeCardAdvisory(
      baseInput({ crop: { ...CROP, stageKey: 'crop.stage.bollFormation' } }),
      NOW,
    );
    const harvest = items.find((item) => item.kind === 'harvest');
    expect(harvest?.harvestMode).toBe('ready');
    expect(harvest?.priority).toBe(11);
  });

  it('shows harvest-before-rain for boll formation when rain is coming', () => {
    const days = [0, 1, 2].map((i) =>
      forecastDay(new Date(NOW + i * DAY).toISOString().slice(0, 10), i === 1 ? 5 : 0),
    );
    const items = computeCardAdvisory(
      baseInput({
        crop: { ...CROP, stageKey: 'crop.stage.bollFormation' },
        forecast: sourcedForecast(days),
        hourly: sourcedHourly(dayHours({ 6: { precipProbPct: 70 } })),
      }),
      NOW,
    );
    expect(items.find((item) => item.kind === 'harvest')?.harvestMode).toBe('beforeRain');
  });

  it('does not fire harvest for a stage the client cannot name as a maturity', () => {
    const items = computeCardAdvisory(baseInput(), NOW);
    expect(items.find((item) => item.kind === 'harvest')).toBeUndefined();
  });

  it('shows the crop-stage action from an activity insight, priority 12', () => {
    const items = computeCardAdvisory(baseInput({ insights: [insight()] }), NOW);
    const stage = items.find((item) => item.kind === 'stage');
    expect(stage?.priority).toBe(12);
    expect(stage?.insightId).toBe('i1');
  });

  it('shows the fertilizer dose only when the knowledge base raises it, priority 13', () => {
    const items = computeCardAdvisory(
      baseInput({
        insights: [
          insight({
            id: 'i2',
            kind: 'activity',
            titleKey: 'product.urea',
            bodyKey: 'insight.wheat.body',
          }),
        ],
      }),
      NOW,
    );
    const fertilizer = items.find((item) => item.kind === 'fertilizer');
    expect(fertilizer?.priority).toBe(13);
    expect(fertilizer?.insightId).toBe('i2');
    /* An activity insight with no nutrient in its key is a stage action, not a dose. */
    expect(computeCardAdvisory(baseInput({ insights: [insight()] }), NOW).find((i) => i.kind === 'fertilizer')).toBeUndefined();
  });

  it('says skip watering when rain is forecast in the next day', () => {
    const items = computeCardAdvisory(
      baseInput({ hourly: sourcedHourly(dayHours({ 6: { precipProbPct: 70 } })) }),
      NOW,
    );
    expect(items.find((item) => item.kind === 'irrigation')?.irrigationMode).toBe('skip');
  });

  it('says water now after a three-day dry spell', () => {
    /* No rain anywhere in the hourly run or the forecast: a dry spell. */
    const items = computeCardAdvisory(baseInput(), NOW);
    expect(items.find((item) => item.kind === 'irrigation')?.irrigationMode).toBe('now');
  });

  it('follows up when an expert answered the farmer’s question', () => {
    const items = computeCardAdvisory(
      baseInput({ expertAnswer: { postId: 'q1', createdAt: NOW - DAY } }),
      NOW,
    );
    const followup = items.find((item) => item.kind === 'followup');
    expect(followup?.followupMode).toBe('expertAnswered');
    expect(followup?.priority).toBe(15);
  });

  it('follows up to check leaves a few days after the farmer acted', () => {
    const items = computeCardAdvisory(
      baseInput({
        actedInsights: [insight({ id: 'i9', status: 'acted', createdAt: NOW - 3 * DAY })],
      }),
      NOW,
    );
    expect(items.find((item) => item.kind === 'followup')?.followupMode).toBe('checkLeaves');
  });

  it('caps the card at three items, in priority order', () => {
    const items = computeCardAdvisory(
      baseInput({
        hourly: sourcedHourly(dayHours({ 4: { precipProbPct: 70 }, 12: { humidityPct: 75 } })),
        pestReports: [{ id: 'p1', placeLabel: 'Wazirabad', createdAt: NOW - DAY, verified: true }],
        insights: [insight(), insight({ id: 'i2', titleKey: 'product.urea' })],
        expertAnswer: { postId: 'q1', createdAt: NOW - DAY },
      }),
      NOW,
    );
    expect(items).toHaveLength(3);
    const priorities = items.map((item) => item.priority);
    expect(priorities).toEqual([...priorities].sort((a, b) => a - b));
    expect(items[0]?.kind).toBe('rainfree');
  });

  it('stale weather pauses the weather items but keeps the knowledge-backed ones', () => {
    const items = computeCardAdvisory(
      baseInput({ hourly: failingHourly(), insights: [insight()] }),
      NOW,
    );
    expect(items.find((item) => item.kind === 'spray')).toBeUndefined();
    expect(items.find((item) => item.kind === 'stage')).toBeDefined();
    expect(items.find((item) => item.kind === 'noData')).toBeUndefined();
  });
});

describe('community helpers', () => {
  const posts: AdvisoryPost[] = [
    { id: 'p1', author: 'other', topics: ['pest'], place: 'wazirabad', createdAt: NOW - DAY },
    { id: 'p2', author: 'other', topics: ['pest'], place: 'layyah', createdAt: NOW - 2 * DAY },
    { id: 'p3', author: 'me', topics: ['pest'], place: 'wazirabad', createdAt: NOW },
    { id: 'p4', author: 'other', topics: ['crop'], place: 'wazirabad', createdAt: NOW },
  ];

  it('pestReportsFromPosts keeps only other farmers’ pest posts, newest first', () => {
    const reports = pestReportsFromPosts(posts, () => false, 'me', (place) => place);
    expect(reports.map((r) => r.id)).toEqual(['p1', 'p2']);
  });

  it('marks a report verified when an expert answered it', () => {
    const reports = pestReportsFromPosts(posts, (id) => id === 'p1', 'me', (place) => place);
    expect(reports[0]?.verified).toBe(true);
    expect(reports[1]?.verified).toBe(false);
  });

  it('expertAnswerFromPosts finds the farmer’s own answered question', () => {
    const mine: AdvisoryPost[] = [
      { id: 'q1', author: 'me', topics: ['crop'], place: 'wazirabad', createdAt: NOW - DAY },
      { id: 'q2', author: 'me', topics: ['crop'], place: 'wazirabad', createdAt: NOW - 2 * DAY },
    ];
    expect(expertAnswerFromPosts(mine, (id) => id === 'q2', 'me')).toEqual({
      postId: 'q2',
      createdAt: NOW - 2 * DAY,
    });
    expect(expertAnswerFromPosts(mine, () => false, 'me')).toBeNull();
  });
});
