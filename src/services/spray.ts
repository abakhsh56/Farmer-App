/**
 * The spray window, computed from live weather — never a fixed clock.
 *
 * The card used to print "Best time to spray: 6 to 9 AM" from a catalogue
 * string, whatever the sky was doing. That is a guess dressed as advice: a
 * farmer who sprays at 7 AM into a 25 km/h wind loses the chemical to drift,
 * and one who sprays before rain loses it to wash-off. So the window is
 * computed here, from the hourly forecast for the farmer's own point, and the
 * card only ever prints what the numbers imply.
 *
 * The alert model is the server's (`alert_rules`, 20261103000900), carried
 * into the client so the two agree about what outranks what:
 *
 * · category is always 'weather' — a spray decision is a weather decision.
 * · level is 'urgent' when a thunderstorm is observed (do not spray, priority
 *   1), 'watch' when heavy rain is observed (do not spray, priority 5), and
 *   'info' for the routine window itself (priority 10). A do-not-spray
 *   warning therefore always outranks the window, and the window outranks
 *   routine info (default 20). Priorities are the same 1–100 scale the
 *   server orders by, lower first.
 * · the firing condition is the hourly forecast plus the observed condition,
 *   never a clock: a window is a run of hours that are calm, cool, humid
 *   enough and dry. When no such run exists, the advice says so and names
 *   the reason — it never falls back to a fixed time.
 *
 * Two gates, both deliberate:
 *
 * · no live data, no window. A missing number is null, never zero, and an
 *   hour whose wind was never reported is not a calm hour. When the hourly
 *   forecast is failing or the current reading is not usable, the state is
 *   'no-data' and the screen says the advice is paused.
 * · no crop, no spray advice. Spraying is crop work, and a farmer who has
 *   not named a crop has nothing to spray. The state is 'no-crop' and the
 *   card says so plainly instead of inventing a window for nobody.
 *
 * The function is pure — no network, no clock of its own — so the same
 * numbers always give the same window, and a test can prove it.
 */

import type { MessageKey } from '../i18n/catalog';
import type { Sourced, WeatherHour, WeatherNow } from './types';

/** Alert vocabulary, shared with the server's alert_rules. */
export type SprayAlertCategory = 'weather';
export type SprayAlertLevel = 'info' | 'watch' | 'urgent';

/** What the card shows, and why. */
export type SprayState = 'window' | 'do-not-spray' | 'no-window' | 'no-data' | 'no-crop';

export type SprayAdvice = {
  state: SprayState;
  category: SprayAlertCategory;
  level: SprayAlertLevel;
  /**
   * Lower runs first, on the server's 1–100 scale: thunderstorm 1, heavy
   * rain 5, spray window 10, routine info 20.
   */
  priority: number;
  /** Start of the computed window, epoch ms. Null unless state is 'window'. */
  windowStartMs: number | null;
  /** End of the computed window, epoch ms. Null unless state is 'window'. */
  windowEndMs: number | null;
  /** Whether the window starts today or tomorrow, in the farmer's own day. */
  day: 'today' | 'tomorrow' | null;
  /** The reason code the screen turns into a sentence. */
  reason:
    | 'calm'
    | 'thunderstorm'
    | 'heavy-rain'
    | 'wind'
    | 'rain'
    | 'heat'
    | 'no-data'
    | 'no-crop';
};

/**
 * WMO codes the server's alert_rules treat as "do not spray" — the same
 * sets, so a warning the server would raise and a window the client would
 * print can never disagree about the same hour.
 */
const DO_NOT_SPRAY_URGENT = new Set([95, 96, 99]);
const DO_NOT_SPRAY_WATCH = new Set([65, 67, 82]);

/**
 * What makes one hour safe to spray in.
 *
 * · wind at or under 15 km/h, so the spray lands on the crop instead of
 *   drifting onto the neighbour's field.
 * · temperature at or under 32°C, so droplets do not evaporate before they
 *   land and the chemical does not scorch the leaf.
 * · humidity at or above 40%, for the same evaporation reason.
 * · rain probability under 30% and no rain in the hour, so the spray is
 *   not washed off before it dries.
 * · no thunderstorm or heavy-rain code, which is a do-not-spray on its own.
 *
 * A number the source did not report is not a pass: an hour whose wind was
 * never measured is not a calm hour.
 */
const MAX_WIND_KPH = 15;
const MAX_TEMP_C = 32;
const MIN_HUMIDITY_PCT = 40;
const MAX_RAIN_PROB_PCT = 30;
const MIN_WINDOW_HOURS = 2;

export function isSprayHour(hour: WeatherHour): boolean {
  if (hour.weatherCode !== null && hour.weatherCode !== undefined) {
    if (DO_NOT_SPRAY_URGENT.has(hour.weatherCode)) return false;
    if (DO_NOT_SPRAY_WATCH.has(hour.weatherCode)) return false;
  }
  if (hour.windKph === null || hour.windKph > MAX_WIND_KPH) return false;
  if (hour.tempC === null || hour.tempC > MAX_TEMP_C) return false;
  if (hour.humidityPct === null || hour.humidityPct < MIN_HUMIDITY_PCT) return false;
  if (hour.precipProbPct !== null && hour.precipProbPct >= MAX_RAIN_PROB_PCT) return false;
  if (hour.precipMm !== null && hour.precipMm > 0) return false;
  return true;
}

/** The single factor that blocks an hour, in the order that matters most. */
function blockingReason(hour: WeatherHour): 'thunderstorm' | 'heavy-rain' | 'rain' | 'wind' | 'heat' | 'humidity' | null {
  if (hour.weatherCode !== null && hour.weatherCode !== undefined) {
    if (DO_NOT_SPRAY_URGENT.has(hour.weatherCode)) return 'thunderstorm';
    if (DO_NOT_SPRAY_WATCH.has(hour.weatherCode)) return 'heavy-rain';
  }
  if (hour.precipProbPct !== null && hour.precipProbPct >= MAX_RAIN_PROB_PCT) return 'rain';
  if (hour.precipMm !== null && hour.precipMm > 0) return 'rain';
  if (hour.windKph === null || hour.windKph > MAX_WIND_KPH) return 'wind';
  if (hour.tempC === null || hour.tempC > MAX_TEMP_C) return 'heat';
  if (hour.humidityPct === null || hour.humidityPct < MIN_HUMIDITY_PCT) return 'humidity';
  return null;
}

function sameLocalDay(aMs: number, bMs: number): boolean {
  const a = new Date(aMs);
  const b = new Date(bMs);
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function noWindowAdvice(
  reason: SprayAdvice['reason'],
): SprayAdvice {
  return {
    state: 'no-window',
    category: 'weather',
    level: 'info',
    priority: 10,
    windowStartMs: null,
    windowEndMs: null,
    day: null,
    reason,
  };
}

/**
 * The spray advice for a farmer, from their live weather and their crop.
 *
 * `now` is the current reading (the observed condition), `hourly` is the
 * hourly forecast for the next day, `hasCrop` is whether the farmer has
 * named a crop, and `nowMs` is the farmer's clock. The order of the checks
 * is the priority order: a farmer with no crop gets the no-crop state before
 * any weather is read, and a do-not-spray condition outranks any window.
 */
export function computeSprayAdvice(input: {
  now: Sourced<WeatherNow> | null;
  hourly: Sourced<WeatherHour[]> | null;
  hasCrop: boolean;
  nowMs: number;
}): SprayAdvice {
  const { now, hourly, hasCrop, nowMs } = input;

  if (!hasCrop) {
    return {
      state: 'no-crop',
      category: 'weather',
      level: 'info',
      priority: 20,
      windowStartMs: null,
      windowEndMs: null,
      day: null,
      reason: 'no-crop',
    };
  }

  const nowUsable =
    now !== null && now.status !== 'failing' && now.error === undefined && now.freshness === 'fresh';
  const hourlyUsable =
    hourly !== null && hourly.status !== 'failing' && hourly.error === undefined && hourly.data.length > 0;
  if (!nowUsable || !hourlyUsable || hourly === null) {
    return {
      state: 'no-data',
      category: 'weather',
      level: 'info',
      priority: 20,
      windowStartMs: null,
      windowEndMs: null,
      day: null,
      reason: 'no-data',
    };
  }

  /* Do not spray, from the observed condition first, then the current hour. */
  const observedCode = now?.data.weatherCode ?? null;
  const currentHour = hourly.data[0] ?? null;
  const currentCode = observedCode ?? currentHour?.weatherCode ?? null;
  if (currentCode !== null && DO_NOT_SPRAY_URGENT.has(currentCode)) {
    return {
      state: 'do-not-spray',
      category: 'weather',
      level: 'urgent',
      priority: 1,
      windowStartMs: null,
      windowEndMs: null,
      day: null,
      reason: 'thunderstorm',
    };
  }
  if (currentCode !== null && DO_NOT_SPRAY_WATCH.has(currentCode)) {
    return {
      state: 'do-not-spray',
      category: 'weather',
      level: 'watch',
      priority: 5,
      windowStartMs: null,
      windowEndMs: null,
      day: null,
      reason: 'heavy-rain',
    };
  }

  /* The window: the earliest run of suitable hours, at least two long. */
  const hours = hourly.data;
  let runStart = -1;
  for (let i = 0; i < hours.length; i += 1) {
    const hour = hours[i];
    if (!hour) continue;
    if (isSprayHour(hour)) {
      if (runStart === -1) runStart = i;
      const runLength = i - runStart + 1;
      if (runLength >= MIN_WINDOW_HOURS) {
        /* Extend the run while the hours stay suitable. */
        let last = i;
        while (last + 1 < hours.length) {
          const next = hours[last + 1];
          if (!next || !isSprayHour(next)) break;
          last += 1;
        }
        const start = hours[runStart];
        const lastHour = hours[last];
        if (!start || !lastHour) break;
        return {
          state: 'window',
          category: 'weather',
          level: 'info',
          priority: 10,
          windowStartMs: start.timeMs,
          windowEndMs: lastHour.timeMs + 60 * 60 * 1000,
          day: sameLocalDay(start.timeMs, nowMs) ? 'today' : 'tomorrow',
          reason: 'calm',
        };
      }
    } else {
      runStart = -1;
    }
  }

  /* No run long enough: name the factor that blocked the most hours. */
  const blocked: Record<string, number> = { wind: 0, rain: 0, heat: 0, humidity: 0 };
  for (const hour of hours) {
    const reason = blockingReason(hour);
    if (reason === 'thunderstorm' || reason === 'heavy-rain' || reason === 'rain') {
      blocked.rain = (blocked.rain ?? 0) + 1;
    } else if (reason !== null) {
      blocked[reason] = (blocked[reason] ?? 0) + 1;
    }
  }
  const dominant = (Object.entries(blocked) as Array<[string, number]>).sort(
    (a, b) => b[1] - a[1],
  )[0]?.[0];
  const reason: SprayAdvice['reason'] =
    dominant === 'wind' ? 'wind' : dominant === 'rain' ? 'rain' : dominant === 'heat' ? 'heat' : 'wind';
  return noWindowAdvice(reason);
}

/**
 * The two lines the card prints for an advice, in the language the caller
 * translates into.
 *
 * One function for both surfaces (Home card and Weather screen), so a farmer
 * moving between them never reads two different windows for the same
 * morning. `translate` is the screen's `t` — or the Urdu `tIn` for the
 * read-aloud voice, which is how the spoken advice and the printed advice
 * stay the same sentence.
 */
export function sprayAdviceLines(
  translate: (key: MessageKey, values?: Record<string, string | number>) => string,
  advice: SprayAdvice,
  startLabel: string,
  endLabel: string,
): { title: string; body: string } {
  switch (advice.state) {
    case 'window': {
      const day = translate(advice.day === 'tomorrow' ? 'weather.spray.tomorrow' : 'weather.spray.today');
      return {
        title: translate('weather.spray.window', { day, start: startLabel, end: endLabel }),
        body: translate('weather.spray.reasonCalm'),
      };
    }
    case 'do-not-spray': {
      return {
        title: translate('weather.spray.doNot'),
        body: translate(
          advice.reason === 'thunderstorm' ? 'weather.spray.doNotThunder' : 'weather.spray.doNotRain',
        ),
      };
    }
    case 'no-window': {
      return {
        title: translate('weather.spray.noWindow'),
        body: translate(
          advice.reason === 'rain'
            ? 'weather.spray.noWindowRain'
            : advice.reason === 'heat'
              ? 'weather.spray.noWindowHeat'
              : 'weather.spray.noWindowWind',
        ),
      };
    }
    case 'no-crop': {
      return {
        title: translate('weather.spray.noCrop'),
        body: translate('weather.spray.noCropBody'),
      };
    }
    case 'no-data': {
      return {
        title: translate('weather.spray.noData'),
        body: translate('weather.spray.noDataBody'),
      };
    }
  }
}
