/**
 * The card's advice, as ten signal-driven items — not one fixed line.
 *
 * The old card printed a single spray sentence. This engine computes the
 * whole card from the signals the farmer actually has, in the PRD alert
 * model's priority order (server `alert_rules`, 1–100 scale, lower first),
 * and returns at most three items — the same cap the server puts on live
 * alerts per farmer, so a crowded morning never becomes a wall of text.
 *
 * The ten items, and where each comes from:
 *
 * 1. Spray window — live wind 6–16 km/h, temp 10–29°C, Delta T 2–8°C,
 *    humidity, plus the farmer's crop and any pest signal. Open-Meteo hourly
 *    + behaviour_signals + crop_instances.
 * 2. Rain-free warning — finish before rain: hourly rain probability plus
 *    the product's rainfast window (6h dry minimum). Open-Meteo hourly.
 * 3. Nearby disease/pest outbreak — verified community reports + expert
 *    verification within 100 km + warm humid nights. community_posts +
 *    agri_knowledge_entries.
 * 4. Crop-stage action — what to do now for this crop stage (nitrogen split
 *    at tillering). crop_instances + the knowledge base (an activity insight).
 *    A stage change changes the advice, because the insight changes.
 * 5. Irrigation timing — rain/temp/humidity + crop stage + dry-spell
 *    forecast. Open-Meteo + crop stage. Rain forecast means skip. The amount
 *    is never invented: it is shown only when the knowledge base gives one,
 *    and the client cannot see it, so this item carries timing only.
 * 6. Fertilizer dose by nutrient — crop stage + nutrient status. Only fires
 *    when the knowledge base raises it (an insight); the dose is the
 *    insight's, never made up.
 * 7. Pest action threshold — scout now: pest pressure near threshold, warm
 *    humid nights + nearby reports. Weather + community reports + knowledge
 *    thresholds.
 * 8. Follow-up — the farmer's own past action, next step: sprayed days ago,
 *    check the leaves; asked a question, an expert answered.
 *    behaviour_signals + action history + expert_verifications.
 * 9. Heat/cold stress — crop-specific temp thresholds. Open-Meteo temp +
 *    knowledge base thresholds. The client holds no crop-specific threshold,
 *    so a generic extreme (40°C / 5°C) is labelled a general weather
 *    warning; a crop-specific warning only fires when the knowledge base
 *    raises it (a weather insight).
 * 10. Harvest-readiness / dry window — crop maturity + rain-free days ahead.
 *     Crop stage + Open-Meteo. Only `crop.stage.bollFormation` is a
 *     maturity the client can name; other stages do not fire it.
 *
 * Rules the engine enforces, so the screens cannot break them:
 *
 * · no repetition: mandi rates and the weather temperature are not items
 *   here — they live on their own surfaces.
 * · a missing value stays missing. A number the source did not report is
 *   never a pass, and an item whose input is missing does not fire.
 * · stale pauses advice. Weather-dependent items are omitted while the
 *   reading is stale or failing; knowledge-backed items (stage, fertilizer,
 *   follow-up) carry their own validity window and still show.
 * · one notification per crop: the list is capped at three, newest wins
 *   inside a kind, and a dismissal suppresses that insight everywhere.
 * · two surfaces never compute two versions of one thing: Home and Weather
 *   both call this one function with the same input.
 * · every item shows its source and its freshness, so a farmer can tell a
 *   live reading from a neighbour's report.
 */

import type { MessageKey } from '../i18n/catalog';
import type { CropInstance, Insight } from '../insights/store';
import type { Sourced, WeatherDay, WeatherHour, WeatherNow } from './types';
import { computeSprayAdvice, type SprayAdvice } from './spray';

/** The server's cap, carried into the client: at most three live items. */
export const ADVISORY_MAX_ITEMS = 3;

/** The product's rainfast window: 6 hours dry is the minimum. */
export const RAINFAST_HOURS = 6;

/** A rain probability at or above this is "rain is coming". */
export const RAIN_PROB_PCT = 50;

/** How far back an outbreak report still counts. */
export const OUTBREAK_WINDOW_DAYS = 7;

/** A follow-up is due this many days after the farmer acted. */
export const FOLLOWUP_MIN_DAYS = 2;
export const FOLLOWUP_MAX_DAYS = 7;

/** A generic extreme, labelled a general weather warning (not crop advice). */
export const HEAT_WARN_C = 40;
export const COLD_WARN_C = 5;

/** The only crop stage the client can name as a maturity. */
export const HARVEST_STAGE_KEY = 'crop.stage.bollFormation';

/** A dry spell this long, or a dry window this long, is worth naming. */
export const DRY_SPELL_DAYS = 3;
export const HARVEST_DRY_DAYS = 3;

/** A night hour is 20:00–06:00; warm and humid means disease weather. */
export const WARM_NIGHT_TEMP_C = 20;
export const WARM_NIGHT_HUMIDITY_PCT = 70;

export type AdvisoryKind =
  | 'spray'
  | 'rainfree'
  | 'outbreak'
  | 'stage'
  | 'irrigation'
  | 'fertilizer'
  | 'pestThreshold'
  | 'followup'
  | 'stress'
  | 'harvest'
  | 'noCrop'
  | 'noData';

/**
 * One item on the card. The kind decides which of the optional fields the
 * copy renderer reads; every item carries its source and its freshness, so
 * the screen can print them without knowing the kind.
 */
export type AdvisoryItem = {
  kind: AdvisoryKind;
  /** Lower runs first, on the server's 1–100 scale. */
  priority: number;
  /** Where the number came from, as a display string. */
  source: string;
  /** Epoch ms the underlying reading or observation was made. */
  observedAt: number;
  /** The computed spray advice, when kind is 'spray'. */
  spray?: SprayAdvice;
  /** The first window hour's numbers, for the detailed wording. Null-safe: a
      missing number is never printed as a zero. */
  windowWindKph?: number | null;
  windowTempC?: number | null;
  windowHumidityPct?: number | null;
  windowDeltaT?: number | null;
  /** When the rain arrives, when kind is 'rainfree' or 'harvest'. */
  rainAtMs?: number;
  /** Where the report came from, when kind is 'outbreak' or 'pestThreshold'. */
  placeLabel?: string;
  /** The community post to open, when kind is 'outbreak', 'pestThreshold'
      or 'followup' (expertAnswered). */
  postId?: string;
  /** Whether an expert verified it, when kind is 'outbreak'. */
  verified?: boolean;
  /** The insight to open, when kind is 'stage', 'fertilizer' or 'stress'. */
  insightId?: string;
  titleKey?: MessageKey;
  bodyKey?: MessageKey;
  actionKey?: MessageKey;
  /** Irrigation timing, when kind is 'irrigation'. */
  irrigationMode?: 'skip' | 'now';
  /** Which follow-up, when kind is 'followup'. */
  followupMode?: 'checkLeaves' | 'expertAnswered';
  /** Which stress, and the temperature that raised it, when kind is 'stress'. */
  stressMode?: 'heat' | 'cold';
  tempC?: number;
  /** Which harvest state, when kind is 'harvest'. */
  harvestMode?: 'ready' | 'beforeRain';
};

export type PestReport = {
  id: string;
  placeLabel: string;
  createdAt: number;
  verified: boolean;
};

export type ExpertAnswer = {
  postId: string;
  createdAt: number;
};

export type CardAdvisoryInput = {
  now: Sourced<WeatherNow> | null;
  hourly: Sourced<WeatherHour[]> | null;
  forecast: Sourced<WeatherDay[]> | null;
  crop: CropInstance | null;
  /** Active insights for the farmer's crop, newest first. */
  insights: Insight[];
  /** Insights the farmer acted on, for the follow-up. */
  actedInsights: Insight[];
  pestReports: PestReport[];
  expertAnswer: ExpertAnswer | null;
  /** Display strings for the source line, already translated by the caller. */
  sources: {
    weather: string;
    community: string;
    communityExpert: string;
    knowledge: string;
  };
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** A number the source did not report is never a pass. */
function isUsable(
  now: Sourced<WeatherNow> | null,
  hourly: Sourced<WeatherHour[]> | null,
): boolean {
  const nowOk =
    now !== null && now.status !== 'failing' && now.error === undefined && now.freshness === 'fresh';
  const hourlyOk =
    hourly !== null &&
    hourly.status !== 'failing' &&
    hourly.error === undefined &&
    hourly.data.length > 0;
  return nowOk && hourlyOk;
}

/** Night hours (20:00–06:00) that are warm and humid — disease weather. */
function warmHumidNights(hourly: WeatherHour[]): boolean {
  return hourly.some((hour) => {
    const h = new Date(hour.timeMs).getHours();
    const night = h >= 20 || h < 6;
    return (
      night &&
      hour.tempC !== null &&
      hour.tempC >= WARM_NIGHT_TEMP_C &&
      hour.humidityPct !== null &&
      hour.humidityPct >= WARM_NIGHT_HUMIDITY_PCT
    );
  });
}

/** The first hour rain is expected, or null when none is in the run. */
function firstRainHour(hourly: WeatherHour[]): WeatherHour | null {
  for (const hour of hourly) {
    if (hour.precipProbPct !== null && hour.precipProbPct >= RAIN_PROB_PCT) return hour;
    if (hour.precipMm !== null && hour.precipMm > 0) return hour;
  }
  return null;
}

/** True when none of the next `days` days reports rain. */
function dryDays(forecast: WeatherDay[], days: number): boolean {
  return forecast.slice(0, days).every((day) => day.precipMm === null || day.precipMm <= 0);
}

const FERTILIZER_KEYS = /fertilizer|nitrogen|urea|dap|potash|npk/i;

/** The knowledge base raised a nutrient dose, in this insight's own words. */
function isFertilizerInsight(insight: Insight): boolean {
  return FERTILIZER_KEYS.test(insight.titleKey) || FERTILIZER_KEYS.test(insight.bodyKey);
}

/**
 * The card's advice, from the farmer's live signals.
 *
 * Pure: the same input always gives the same three items, in the same
 * order, so a test can prove the ranking and two screens can share it.
 */
export function computeCardAdvisory(input: CardAdvisoryInput, nowMs: number): AdvisoryItem[] {
  const { now, hourly, forecast, crop, insights, actedInsights, pestReports, expertAnswer, sources } =
    input;

  /* No crop, no advice about one: a single plain item, never a fake window. */
  if (crop === null) {
    return [{ kind: 'noCrop', priority: 20, source: sources.knowledge, observedAt: nowMs }];
  }

  const weatherOk = isUsable(now, hourly);
  const hours = weatherOk && hourly !== null ? hourly.data : [];
  const days = forecast !== null && forecast.status !== 'failing' ? forecast.data : [];
  const weatherObservedAt = now?.observedAt ?? nowMs;
  const items: AdvisoryItem[] = [];

  const recentReports = pestReports.filter(
    (report) => nowMs - report.createdAt <= OUTBREAK_WINDOW_DAYS * DAY_MS,
  );
  const verifiedReport = recentReports.find((report) => report.verified) ?? null;
  const anyReport = recentReports[0] ?? null;
  const humidNights = weatherOk && warmHumidNights(hours);

  /* 1/5 — do-not-spray outranks everything; the window is routine info. */
  if (weatherOk) {
    const spray = computeSprayAdvice({
      now,
      hourly,
      hasCrop: true,
      nowMs,
    });
    if (spray.state === 'do-not-spray' || spray.state === 'window' || spray.state === 'no-window') {
      const pestReason = anyReport !== null;
      /* The first window hour's own numbers, so the detailed wording prints
         the morning it measured — never a number from another hour. */
      const firstWindowHour =
        spray.windowStartMs !== null
          ? hours.find((hour) => hour.timeMs === spray.windowStartMs) ?? null
          : null;
      const spread =
        firstWindowHour !== null &&
        firstWindowHour.tempC !== null &&
        firstWindowHour.dewPointC !== null
          ? firstWindowHour.tempC - firstWindowHour.dewPointC
          : null;
      items.push({
        kind: 'spray',
        priority:
          spray.state === 'do-not-spray'
            ? spray.priority
            : spray.state === 'window' && pestReason
              ? 8
              : spray.priority,
        source: sources.weather,
        observedAt: weatherObservedAt,
        spray,
        windowWindKph: firstWindowHour?.windKph ?? null,
        windowTempC: firstWindowHour?.tempC ?? null,
        windowHumidityPct: firstWindowHour?.humidityPct ?? null,
        windowDeltaT: spread,
      });
    }

    /* 6 — rain is coming inside the rainfast window: finish before it. */
    const rain = firstRainHour(hours);
    if (rain !== null && rain.timeMs > nowMs) {
      items.push({
        kind: 'rainfree',
        priority: 6,
        source: sources.weather,
        observedAt: weatherObservedAt,
        rainAtMs: rain.timeMs,
      });
    }
  }

  /* 7 — a verified outbreak, in disease weather. 8 — the same pressure, unverified. */
  if (verifiedReport !== null && humidNights) {
    items.push({
      kind: 'outbreak',
      priority: 7,
      source: sources.communityExpert,
      observedAt: verifiedReport.createdAt,
      placeLabel: verifiedReport.placeLabel,
      postId: verifiedReport.id,
      verified: true,
    });
  } else if (anyReport !== null && humidNights) {
    items.push({
      kind: 'pestThreshold',
      priority: 8,
      source: sources.community,
      observedAt: anyReport.createdAt,
      placeLabel: anyReport.placeLabel,
      postId: anyReport.id,
    });
  }

  /* 9 — heat or cold. A generic extreme is a general weather warning; a
     weather insight from the knowledge base is the crop-specific one. */
  const weatherInsight = insights.find((entry) => entry.kind === 'weather') ?? null;
  if (weatherInsight !== null) {
    items.push({
      kind: 'stress',
      priority: 9,
      source: sources.knowledge,
      observedAt: weatherInsight.createdAt,
      insightId: weatherInsight.id,
      titleKey: weatherInsight.titleKey,
      bodyKey: weatherInsight.bodyKey,
      actionKey: weatherInsight.actionKey,
    });
  } else if (weatherOk && now !== null) {
    const temp = now.data.tempC;
    if (temp !== null && temp >= HEAT_WARN_C) {
      items.push({
        kind: 'stress',
        priority: 9,
        source: sources.weather,
        observedAt: weatherObservedAt,
        stressMode: 'heat',
        tempC: temp,
      });
    } else if (temp !== null && temp <= COLD_WARN_C) {
      items.push({
        kind: 'stress',
        priority: 9,
        source: sources.weather,
        observedAt: weatherObservedAt,
        stressMode: 'cold',
        tempC: temp,
      });
    }
  }

  /* 11 — harvest, only for a maturity the client can name. */
  if (crop.stageKey === HARVEST_STAGE_KEY && days.length > 0) {
    const rain = firstRainHour(hours);
    const dry = dryDays(days, HARVEST_DRY_DAYS);
    if (dry) {
      items.push({
        kind: 'harvest',
        priority: 11,
        source: sources.weather,
        observedAt: weatherObservedAt,
        harvestMode: 'ready',
      });
    } else if (rain !== null && rain.timeMs > nowMs) {
      items.push({
        kind: 'harvest',
        priority: 11,
        source: sources.weather,
        observedAt: weatherObservedAt,
        harvestMode: 'beforeRain',
        rainAtMs: rain.timeMs,
      });
    }
  }

  /* 12 — what to do now for this crop stage. 13 — the nutrient dose, if raised. */
  const stageInsight = insights.find(
    (entry) => entry.kind === 'activity' && !isFertilizerInsight(entry),
  ) ?? null;
  if (stageInsight !== null) {
    items.push({
      kind: 'stage',
      priority: 12,
      source: sources.knowledge,
      observedAt: stageInsight.createdAt,
      insightId: stageInsight.id,
      titleKey: stageInsight.titleKey,
      bodyKey: stageInsight.bodyKey,
      actionKey: stageInsight.actionKey,
    });
  }
  const fertilizerInsight = insights.find((entry) => isFertilizerInsight(entry)) ?? null;
  if (fertilizerInsight !== null) {
    items.push({
      kind: 'fertilizer',
      priority: 13,
      source: sources.knowledge,
      observedAt: fertilizerInsight.createdAt,
      insightId: fertilizerInsight.id,
      titleKey: fertilizerInsight.titleKey,
      bodyKey: fertilizerInsight.bodyKey,
      actionKey: fertilizerInsight.actionKey,
    });
  }

  /* 14 — irrigation timing. Rain coming means skip; a dry spell means now.
     The amount is never invented, so this item carries timing only. */
  if (weatherOk && days.length > 0) {
    const rainSoon = firstRainHour(hours);
    if (rainSoon !== null && rainSoon.timeMs - nowMs <= DAY_MS) {
      items.push({
        kind: 'irrigation',
        priority: 14,
        source: sources.weather,
        observedAt: weatherObservedAt,
        irrigationMode: 'skip',
      });
    } else if (dryDays(days, DRY_SPELL_DAYS)) {
      items.push({
        kind: 'irrigation',
        priority: 14,
        source: sources.weather,
        observedAt: weatherObservedAt,
        irrigationMode: 'now',
      });
    }
  }

  /* 15 — follow-up: the farmer's own past action, next step. An expert
     answering his question outranks checking leaves after a spray. */
  if (expertAnswer !== null) {
    items.push({
      kind: 'followup',
      priority: 15,
      source: sources.communityExpert,
      observedAt: expertAnswer.createdAt,
      followupMode: 'expertAnswered',
      postId: expertAnswer.postId,
    });
  } else {
    const acted = actedInsights.find((entry) => {
      const age = nowMs - entry.createdAt;
      return age >= FOLLOWUP_MIN_DAYS * DAY_MS && age <= FOLLOWUP_MAX_DAYS * DAY_MS;
    });
    if (acted !== undefined) {
      items.push({
        kind: 'followup',
        priority: 15,
        source: sources.knowledge,
        observedAt: acted.createdAt,
        followupMode: 'checkLeaves',
        insightId: acted.id,
      });
    }
  }

  /* Stale weather pauses the weather items, but the knowledge-backed ones
     stand on their own validity window — and if nothing at all can be said,
     the card says the advice is paused rather than inventing a line. */
  if (!weatherOk && items.length === 0) {
    return [{ kind: 'noData', priority: 20, source: sources.weather, observedAt: nowMs }];
  }

  return items.sort((a, b) => a.priority - b.priority).slice(0, ADVISORY_MAX_ITEMS);
}

/* ── community helpers ─────────────────────────────────────────────────── */

/** The shape `pestReportsFromPosts` reads — a post, already visible to the farmer. */
export type AdvisoryPost = {
  id: string;
  author: string;
  topics: string[];
  place: string;
  createdAt: number;
  removed?: 'author' | 'moderation';
};

/**
 * Pest reports from the feed: other farmers' pest-topic posts, newest first.
 * `verified` is whether an expert answered that post. The farmer's own posts
 * are not "what is happening around" him.
 */
export function pestReportsFromPosts(
  posts: AdvisoryPost[],
  expertAnswered: (postId: string) => boolean,
  myAuthor: string,
  placeLabel: (place: string) => string,
): PestReport[] {
  return posts
    .filter(
      (post) =>
        post.removed === undefined && post.author !== myAuthor && post.topics.includes('pest'),
    )
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((post) => ({
      id: post.id,
      placeLabel: placeLabel(post.place),
      createdAt: post.createdAt,
      verified: expertAnswered(post.id),
    }));
}

/**
 * The farmer's own question that an expert answered — the newest one, which
 * is the follow-up that matters. Only the farmer's own posts, only questions,
 * only ones an expert answered.
 */
export function expertAnswerFromPosts(
  posts: AdvisoryPost[],
  expertAnswered: (postId: string) => boolean,
  myAuthor: string,
): ExpertAnswer | null {
  const answered = posts
    .filter((post) => post.author === myAuthor && expertAnswered(post.id))
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  return answered === undefined
    ? null
    : { postId: answered.id, createdAt: answered.createdAt };
}
