import { describe, expect, it } from 'vitest';
import {
  computeSprayAdvice,
  isSprayHour,
  sprayAdviceLines,
  type SprayAdvice,
} from './spray';
import type { Sourced, WeatherHour, WeatherNow } from './types';

/**
 * The spray window, computed from live weather — tested where it can be.
 *
 * The point of these tests is the one the fixed string could never pass: the
 * window moves when the numbers move. A calm evening is an evening window, a
 * windy morning is no window, and a thunderstorm is a do-not-spray — not
 * "6 to 9 AM" in every case. Times are built from the local day so the
 * today/tomorrow boundary holds in any timezone the suite runs in.
 */

const HOUR = 60 * 60 * 1000;

function localDayStart(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 10 AM on the local day, the "now" every case below reads from. */
const NOW = localDayStart(Date.now()) + 10 * HOUR;

function hour(atMs: number, over: Partial<WeatherHour> = {}): WeatherHour {
  return {
    timeMs: atMs,
    tempC: 25,
    humidityPct: 60,
    windKph: 8,
    precipProbPct: 0,
    precipMm: 0,
    weatherCode: 0,
    conditionText: 'Clear sky',
    ...over,
  };
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
    sourceLabel: 'test',
    observedAt: NOW,
    fetchedAt: NOW,
    freshness: 'fresh',
    status: 'live',
  };
}

function sourcedHourly(hours: WeatherHour[]): Sourced<WeatherHour[]> {
  return {
    data: hours,
    sourceLabel: 'test',
    observedAt: NOW,
    fetchedAt: NOW,
    freshness: 'fresh',
    status: 'live',
  };
}

/** A day of hours from NOW, calm unless overridden. */
function dayHours(overrides: Record<number, Partial<WeatherHour>> = {}): WeatherHour[] {
  const out: WeatherHour[] = [];
  for (let i = 0; i < 24; i += 1) {
    out.push(hour(NOW + i * HOUR, overrides[i] ?? {}));
  }
  return out;
}

describe('isSprayHour', () => {
  it('passes a calm, cool, dry hour', () => {
    expect(isSprayHour(hour(NOW))).toBe(true);
  });

  it('refuses a windy hour, so spray does not drift', () => {
    expect(isSprayHour(hour(NOW, { windKph: 20 }))).toBe(false);
  });

  it('refuses a hot hour, so droplets do not evaporate', () => {
    expect(isSprayHour(hour(NOW, { tempC: 35 }))).toBe(false);
  });

  it('refuses dry air, so droplets do not evaporate', () => {
    expect(isSprayHour(hour(NOW, { humidityPct: 30 }))).toBe(false);
  });

  it('refuses a likely-rain hour, so spray is not washed off', () => {
    expect(isSprayHour(hour(NOW, { precipProbPct: 60 }))).toBe(false);
    expect(isSprayHour(hour(NOW, { precipMm: 1 }))).toBe(false);
  });

  it('refuses thunderstorm and heavy-rain codes', () => {
    expect(isSprayHour(hour(NOW, { weatherCode: 95 }))).toBe(false);
    expect(isSprayHour(hour(NOW, { weatherCode: 65 }))).toBe(false);
  });

  it('refuses a missing number — an unmeasured wind is not a calm wind', () => {
    expect(isSprayHour(hour(NOW, { windKph: null }))).toBe(false);
    expect(isSprayHour(hour(NOW, { tempC: null }))).toBe(false);
  });
});

describe('computeSprayAdvice', () => {
  it('says no crop before it reads any weather', () => {
    const advice = computeSprayAdvice({
      now: sourcedNow(),
      hourly: sourcedHourly(dayHours()),
      hasCrop: false,
      nowMs: NOW,
    });
    expect(advice.state).toBe('no-crop');
    expect(advice.priority).toBe(20);
  });

  it('pauses when the hourly forecast is failing, rather than inventing a window', () => {
    const advice = computeSprayAdvice({
      now: sourcedNow(),
      hourly: {
        data: [],
        sourceLabel: 'test',
        observedAt: NOW,
        fetchedAt: NOW,
        freshness: 'unavailable',
        status: 'failing',
        error: 'Hourly ingestion is not deployed yet.',
      },
      hasCrop: true,
      nowMs: NOW,
    });
    expect(advice.state).toBe('no-data');
  });

  it('pauses when the current reading is stale, rather than spraying on old numbers', () => {
    const advice = computeSprayAdvice({
      now: { ...sourcedNow(), freshness: 'stale' },
      hourly: sourcedHourly(dayHours()),
      hasCrop: true,
      nowMs: NOW,
    });
    expect(advice.state).toBe('no-data');
  });

  it('orders do-not-spray for a thunderstorm, urgent, priority 1', () => {
    const advice = computeSprayAdvice({
      now: sourcedNow({ weatherCode: 95 }),
      hourly: sourcedHourly(dayHours()),
      hasCrop: true,
      nowMs: NOW,
    });
    expect(advice.state).toBe('do-not-spray');
    expect(advice.level).toBe('urgent');
    expect(advice.priority).toBe(1);
    expect(advice.reason).toBe('thunderstorm');
  });

  it('orders do-not-spray for heavy rain, watch, priority 5', () => {
    const advice = computeSprayAdvice({
      now: sourcedNow({ weatherCode: 65 }),
      hourly: sourcedHourly(dayHours()),
      hasCrop: true,
      nowMs: NOW,
    });
    expect(advice.state).toBe('do-not-spray');
    expect(advice.level).toBe('watch');
    expect(advice.priority).toBe(5);
    expect(advice.reason).toBe('heavy-rain');
  });

  it('finds the morning window from the numbers, not from a fixed clock', () => {
    /* Windy now, calm 12:00–15:00, windy again after — the window is noon. */
    const hours = dayHours({ 0: { windKph: 20 }, 1: { windKph: 18 }, 5: { windKph: 19 }, 6: { windKph: 22 } });
    const advice = computeSprayAdvice({
      now: sourcedNow(),
      hourly: sourcedHourly(hours),
      hasCrop: true,
      nowMs: NOW,
    });
    expect(advice.state).toBe('window');
    expect(advice.level).toBe('info');
    expect(advice.priority).toBe(10);
    expect(advice.day).toBe('today');
    expect(advice.windowStartMs).toBe(NOW + 2 * HOUR);
    expect(advice.windowEndMs).toBe(NOW + 5 * HOUR);
  });

  it('moves the window to the evening when the morning is windy — it is not fixed to 6–9 AM', () => {
    /* Morning windy, evening calm: the window must be the evening, not the morning. */
    const overrides: Record<number, Partial<WeatherHour>> = {};
    for (let i = 0; i < 8; i += 1) overrides[i] = { windKph: 22 };
    const hours = dayHours(overrides);
    const advice = computeSprayAdvice({
      now: sourcedNow(),
      hourly: sourcedHourly(hours),
      hasCrop: true,
      nowMs: NOW,
    });
    expect(advice.state).toBe('window');
    expect(advice.windowStartMs).toBe(NOW + 8 * HOUR);
  });

  it('finds tomorrow’s window when today has none', () => {
    const hours = dayHours();
    for (let i = 0; i < 14; i += 1) {
      hours[i] = hour(NOW + i * HOUR, { windKph: 25 });
    }
    const advice = computeSprayAdvice({
      now: sourcedNow(),
      hourly: sourcedHourly(hours),
      hasCrop: true,
      nowMs: NOW,
    });
    expect(advice.state).toBe('window');
    expect(advice.day).toBe('tomorrow');
    expect(advice.windowStartMs).toBe(NOW + 14 * HOUR);
  });

  it('names wind when no run is long enough because the wind never drops', () => {
    const hours = dayHours().map((h) => ({ ...h, windKph: 25 }));
    const advice = computeSprayAdvice({
      now: sourcedNow(),
      hourly: sourcedHourly(hours),
      hasCrop: true,
      nowMs: NOW,
    });
    expect(advice.state).toBe('no-window');
    expect(advice.reason).toBe('wind');
  });

  it('names rain when no run is long enough because rain is expected', () => {
    const hours = dayHours().map((h) => ({ ...h, precipProbPct: 80 }));
    const advice = computeSprayAdvice({
      now: sourcedNow(),
      hourly: sourcedHourly(hours),
      hasCrop: true,
      nowMs: NOW,
    });
    expect(advice.state).toBe('no-window');
    expect(advice.reason).toBe('rain');
  });

  it('needs a run of at least two hours — a single calm hour is not a window', () => {
    const overrides: Record<number, Partial<WeatherHour>> = {};
    for (let i = 0; i < 24; i += 1) overrides[i] = { windKph: 25 };
    overrides[3] = {};
    const advice = computeSprayAdvice({
      now: sourcedNow(),
      hourly: sourcedHourly(dayHours(overrides)),
      hasCrop: true,
      nowMs: NOW,
    });
    expect(advice.state).toBe('no-window');
  });
});

describe('sprayAdviceLines', () => {
  /** A translate that returns the key and values, so the test reads the choice, not the wording. */
  const translate = (key: string, values?: Record<string, string | number>) =>
    `${key}${values ? `(${Object.entries(values).map(([k, v]) => `${k}=${v}`).join(',')})` : ''}`;

  function windowAdvice(): SprayAdvice {
    return {
      state: 'window',
      category: 'weather',
      level: 'info',
      priority: 10,
      windowStartMs: NOW + 2 * HOUR,
      windowEndMs: NOW + 5 * HOUR,
      day: 'today',
      reason: 'calm',
    };
  }

  it('renders the computed window with its start, end and day', () => {
    const lines = sprayAdviceLines(translate, windowAdvice(), '12 PM', '3 PM');
    expect(lines.title).toBe('weather.spray.window(day=weather.spray.today,start=12 PM,end=3 PM)');
    expect(lines.body).toBe('weather.spray.reasonCalm');
  });

  it('renders do-not-spray with the thunderstorm reason', () => {
    const lines = sprayAdviceLines(translate, {
      state: 'do-not-spray',
      category: 'weather',
      level: 'urgent',
      priority: 1,
      windowStartMs: null,
      windowEndMs: null,
      day: null,
      reason: 'thunderstorm',
    }, '', '');
    expect(lines.title).toBe('weather.spray.doNot');
    expect(lines.body).toBe('weather.spray.doNotThunder');
  });

  it('renders no-window with the wind reason', () => {
    const lines = sprayAdviceLines(translate, {
      state: 'no-window',
      category: 'weather',
      level: 'info',
      priority: 10,
      windowStartMs: null,
      windowEndMs: null,
      day: null,
      reason: 'wind',
    }, '', '');
    expect(lines.title).toBe('weather.spray.noWindow');
    expect(lines.body).toBe('weather.spray.noWindowWind');
  });
});
