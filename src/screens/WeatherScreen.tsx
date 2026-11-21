import {
  ChevronLeft,
  CloudRain,
  Droplets,
  RefreshCw,
  Sun,
  Sunrise,
  Sunset,
  Thermometer,
  Volume2,
  Wind,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Locale } from '@/i18n/catalog';
import { useLocale } from '@/i18n/LocaleProvider';
import { LOCALE_REGISTRY } from '@/i18n/locales';
import { formatDateTime, formatWeekdayDate, intlLocale } from '@/i18n/format';
import { useLocation } from '@/location/LocationProvider';
import { useForecast, useWeather } from '@/services/hooks';
import { daylightProgress, sunTimes, type SunTimes } from '@/services/sun';
import { useSpeech } from '@/speech/SpeechProvider';

/**
 * The sky over the farmer's own place, at full size.
 *
 * The Home card carries the one number a farmer needs before walking out. This
 * screen is what the card opens into: the same reading, given room — the sun's
 * real path across today, the three times that path is pinned to, the numbers the
 * card squeezes into a line, and the next few days.
 *
 * The next-days cards are tabs rather than decoration: selecting one replaces the
 * hero, sun times and metric tiles with that day's forecast. Today is the first
 * tab and the default, so opening the screen always shows the reading the Home
 * card just showed.
 *
 * Two rules inherited from the card, because a bigger screen is not a licence to
 * relax them:
 *
 * · every figure comes from the weather service, and a missing one is an em dash,
 *   never a zero. The sun times are not in that service at all, so they are
 *   *computed* from the farmer's coordinates (`services/sun`) rather than guessed
 *   from a 6 AM–6 PM placeholder. Where the sun does not cross the horizon, no
 *   times are printed.
 *
 * · the reading's age travels with it. The exact observation day and time sit
 *   under the location, and the refresh control asks the same service the card
 *   asks.
 *
 * Motion is deliberate rather than decorative: the temperature counts up once,
 * the arc draws itself and the sun travels to *now* along it, and the tiles settle
 * in behind. All of it yields to `prefers-reduced-motion`, because a screen that
 * animates at a farmer with vestibular sensitivity is a screen they cannot use.
 */

const TODAY = 'today';

const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Whether a number may animate at all.
 *
 * requestAnimationFrame is throttled to a standstill in a tab that is not on
 * screen. A count-up that starts at zero and never receives a frame would sit
 * there claiming 0°, which is not a slow animation — it is a wrong reading. So
 * animation is opt-in on visibility as well as on the motion preference.
 */
const canAnimate = () =>
  typeof document !== 'undefined' && !document.hidden && !prefersReducedMotion();

/** Counts from zero to the reading, once. Null stays null — never a fake zero. */
function useCountUp(target: number | null, durationMs = 850): number | null {
  const [value, setValue] = useState<number | null>(() =>
    target === null ? null : canAnimate() ? 0 : target,
  );

  useEffect(() => {
    if (target === null) {
      setValue(null);
      return;
    }
    if (!canAnimate()) {
      setValue(target);
      return;
    }

    let frame = 0;
    const start = performance.now();
    const tick = (at: number) => {
      const progress = Math.min(1, (at - start) / durationMs);
      /* Ease-out cubic: fast where the number is least legible, slow at the end. */
      const eased = 1 - Math.pow(1 - progress, 3);
      setValue(target * eased);
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, durationMs]);

  return target === null ? null : value;
}

/** The sun's seat on the arc: fraction 0 is the left horizon, 1 the right. */
function sunPoint(fraction: number) {
  const angle = Math.PI - Math.PI * fraction;
  return { x: 160 + 140 * Math.cos(angle), y: 100 - 88 * Math.sin(angle) };
}

/** The same travel, animated once on mount so the eye follows it to "now". */
function useAnimatedFraction(target: number): number {
  const [value, setValue] = useState(() => (canAnimate() ? 0 : target));

  useEffect(() => {
    if (!canAnimate()) {
      setValue(target);
      return;
    }

    let frame = 0;
    const start = performance.now();
    const tick = (at: number) => {
      const progress = Math.min(1, (at - start) / 1100);
      const eased = 1 - Math.pow(1 - progress, 3);
      setValue(target * eased);
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target]);

  return value;
}

/** A local calendar date, so "today" matches the date a farmer sees on a phone. */
function localDateKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Forecast dates are provider days in GMT; noon keeps them clear of timezone edges. */
function forecastDate(date: string): Date {
  return new Date(`${date}T12:00:00Z`);
}

function forecastWeekday(date: string, locale: Locale): string {
  return new Intl.DateTimeFormat(intlLocale(locale), {
    weekday: 'short',
    timeZone: 'UTC',
  }).format(forecastDate(date));
}

function forecastDayLabel(date: string, locale: Locale): string {
  return new Intl.DateTimeFormat(intlLocale(locale), {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(forecastDate(date));
}

function temp(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : `${Math.round(value)}°`;
}

function clockTime(at: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(at));
}

export function WeatherScreen({ onBack }: { onBack: () => void }) {
  const { t, tIn, locale } = useLocale();
  const location = useLocation();
  const weather = useWeather(location.activePoint);
  /*
   * Twelve days: ten future tabs, plus today and the one day that can be
   * yesterday locally when Open-Meteo's GMT list starts on the previous date.
   */
  const forecast = useForecast(location.activePoint, 12);
  const [selectedKey, setSelectedKey] = useState<string>(TODAY);
  const speech = useSpeech();
  const speechTag = LOCALE_REGISTRY.ur.tag;

  const now = Date.now();
  const reading = weather.sourced;
  const todayTimes = sunTimes(new Date(now), location.activePoint);

  /*
   * Open-Meteo's daily list starts with its own GMT date, which is not always the
   * date on the farmer's phone. Exactly one forecast day is treated as today: the
   * local date when it is present, otherwise the GMT date, otherwise the first day
   * the source returned. Future tabs are the days *after* that one, so a GMT day
   * that is already yesterday locally cannot appear as a next day.
   */
  const localToday = localDateKey(new Date(now));
  const utcToday = new Date(now).toISOString().slice(0, 10);
  const todayForecast =
    forecast.data.find((day) => day.date === localToday) ??
    forecast.data.find((day) => day.date === utcToday) ??
    forecast.data[0] ??
    null;
  const futureDays = todayForecast
    ? forecast.data.filter((day) => day.date > todayForecast.date).slice(0, 10)
    : [];

  /* A new place is a new set of days; never leave a tab selected in the old one. */
  useEffect(() => {
    setSelectedKey(TODAY);
  }, [location.activePoint.lat, location.activePoint.lon]);

  /* If a refresh returns a shorter forecast, fall back to the reading we have. */
  useEffect(() => {
    if (selectedKey !== TODAY && !forecast.data.some((day) => day.date === selectedKey)) {
      setSelectedKey(TODAY);
    }
  }, [selectedKey, forecast.data]);

  /* Leaving the page, or choosing another day, ends the old reading. */
  const stopSpeech = speech.stop;
  useEffect(() => () => stopSpeech(), [stopSpeech]);
  useEffect(() => {
    stopSpeech();
  }, [selectedKey, stopSpeech]);

  const selectedDay =
    selectedKey === TODAY
      ? null
      : (forecast.data.find((day) => day.date === selectedKey) ?? null);

  const heroTemp = selectedDay ? selectedDay.maxC : (reading?.data.tempC ?? null);
  const animatedTemp = useCountUp(heroTemp);
  const times = selectedDay
    ? sunTimes(forecastDate(selectedDay.date), location.activePoint)
    : todayTimes;

  const condition = selectedDay
    ? selectedDay.conditionKey
      ? t(selectedDay.conditionKey)
      : (selectedDay.conditionText ?? t('weather.noReading'))
    : reading?.data.conditionKey
      ? t(reading.data.conditionKey)
      : (reading?.data.conditionText ?? null);

  /*
   * The speaker reads the headline, not the page: condition, temperature, the
   * day's high and low, rain and wind. Humidity, feels-like, sun times and the
   * rest stay on screen where the farmer can read them; a spoken list of every
   * tile would take longer than looking.
   */
  const listening = speech.speaking === 'weather-screen';
  const spokenTemp = (value: number) =>
    tIn('ur', 'weather.spokenTemp', { value: Math.round(value) });
  const spokenCondition = selectedDay
    ? selectedDay.conditionKey
      ? tIn('ur', selectedDay.conditionKey)
      : selectedDay.conditionText
    : reading?.data.conditionKey
      ? tIn('ur', reading.data.conditionKey)
      : reading?.data.conditionText;
  const spokenMax = selectedDay ? selectedDay.maxC : todayForecast?.maxC;
  const spokenMin = selectedDay ? selectedDay.minC : todayForecast?.minC;
  const spokenHighLow =
    spokenMax == null || spokenMin == null
      ? null
      : `${tIn('ur', 'weather.metricHigh')} ${spokenTemp(spokenMax)}، ${tIn('ur', 'weather.metricLow')} ${spokenTemp(spokenMin)}`;
  const spokenRainMm = selectedDay
    ? selectedDay.precipMm
    : (todayForecast?.precipMm ?? reading?.data.precipMm);
  const spokenRain =
    spokenRainMm == null
      ? null
      : `${tIn('ur', 'weather.metricRain')} ${tIn('ur', 'weather.spokenMm', {
          value: Math.round(spokenRainMm * 10) / 10,
        })}`;
  const spokenWindKph = selectedDay ? selectedDay.windMaxKph : reading?.data.windKph;
  const spokenWind =
    spokenWindKph == null
      ? null
      : spokenWindKph > 0
        ? tIn('ur', 'weather.windValue', { speed: Math.round(spokenWindKph) })
        : tIn('ur', 'weather.wind');
  const spokenNow =
    selectedDay || reading?.data.tempC == null ? null : spokenTemp(reading.data.tempC);
  const spokenSummary = [
    spokenCondition,
    spokenNow,
    spokenHighLow,
    spokenRain,
    spokenWind,
  ]
    .filter((part): part is string => Boolean(part))
    .join('. ');

  return (
    <div className="weather-sky relative flex min-h-dvh flex-col px-5 pt-4 pb-10 text-foreground">
      <header className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={onBack}
          aria-label={t('common.back')}
          className="grid size-10 shrink-0 place-items-center rounded-full bg-white/40 text-foreground motion-safe:transition-transform motion-safe:active:scale-95 dark:bg-white/10"
        >
          <ChevronLeft className="size-5 rtl:rotate-180" aria-hidden />
        </button>

        <div className="min-w-0 text-center">
          <p className="text-title">{t('weather.screenTitle')}</p>
          <p className="mt-0.5 truncate text-label text-foreground/70">
            {location.placeLabel || t('location.none')}
          </p>
          {reading ? (
            <p className="mt-0.5 text-caption text-foreground/60">
              {t('weather.updated', {
                time: formatDateTime(reading.observedAt, locale),
              })}
            </p>
          ) : null}
        </div>

        <button
          type="button"
          onClick={weather.retry}
          aria-label={t('weather.refresh')}
          className="grid size-10 shrink-0 place-items-center rounded-full bg-white/40 text-foreground motion-safe:transition-transform motion-safe:active:scale-95 dark:bg-white/10"
        >
          <RefreshCw
            className={`size-4 ${weather.refreshing ? 'animate-spin' : ''}`}
            aria-hidden
          />
        </button>
      </header>

      {weather.status === 'loading' && !selectedDay ? (
        <div className="mt-16 flex flex-col items-center gap-3" role="status" aria-live="polite">
          <div className="h-24 w-44 animate-pulse rounded-lg bg-foreground/10" />
          <div className="h-4 w-32 animate-pulse rounded-full bg-foreground/10" />
          <span className="sr-only">{t('weather.loading')}</span>
        </div>
      ) : (
        <section
          key={selectedDay?.date ?? TODAY}
          className="mt-8 flex flex-col items-center text-center"
        >
          {/*
            One number, set in the serif at hero size. The count-up is a single
            performance, not a loop: a temperature that keeps moving is a
            temperature a farmer cannot read.
          */}
          <p className="text-hero font-serif lining-nums tabular-nums animate-in fade-in zoom-in-95 duration-700 fill-mode-both motion-reduce:animate-none">
            {animatedTemp === null ? '—' : `${Math.round(animatedTemp)}°`}
          </p>

          <p className="mt-3 text-lead animate-in fade-in slide-in-from-bottom-2 duration-700 delay-150 fill-mode-both motion-reduce:animate-none">
            {condition ?? t('weather.noReading')}
          </p>

          <p className="mt-1 text-label text-foreground/70 animate-in fade-in duration-700 delay-300 fill-mode-both motion-reduce:animate-none">
            {selectedDay
              ? forecastDayLabel(selectedDay.date, locale)
              : t('weather.today', { date: formatWeekdayDate(new Date(now), locale) })}
          </p>

          {selectedDay ? (
            <p className="mt-1 text-caption text-foreground/70">
              {t('weather.metricHigh')} {temp(selectedDay.maxC)} ·{' '}
              {t('weather.metricLow')} {temp(selectedDay.minC)}
            </p>
          ) : null}

          {spokenSummary ? (
            <button
              type="button"
              onPointerEnter={() => speech.warm(speechTag, spokenSummary)}
              onFocus={() => speech.warm(speechTag, spokenSummary)}
              onClick={() =>
                listening
                  ? speech.stop()
                  : speech.speak({
                      id: 'weather-screen',
                      text: spokenSummary,
                      lang: speechTag,
                    })
              }
              aria-label={listening ? t('weather.stopListening') : t('weather.listen')}
              className="mt-3 flex items-center gap-1.5 rounded-full bg-white/40 px-3 py-1.5 text-label text-foreground motion-safe:transition-transform motion-safe:active:scale-95 dark:bg-white/10"
            >
              <Volume2 className="size-4" aria-hidden />
              {listening ? t('weather.stopListening') : t('weather.listen')}
            </button>
          ) : null}

          {!selectedDay && (reading?.status === 'failing' || weather.status === 'error') ? (
            <button
              type="button"
              onClick={weather.retry}
              className="mt-3 rounded-full bg-white/40 px-4 py-2 text-label text-foreground motion-safe:transition-transform motion-safe:active:scale-95 dark:bg-white/10"
            >
              {t('common.tryAgain')}
            </button>
          ) : null}
        </section>
      )}

      {selectedDay ? (
        <SunTimesRow times={times} />
      ) : times ? (
        <section className="mt-10 animate-in fade-in duration-700 fill-mode-both delay-200 motion-reduce:animate-none">
          <SunArc times={times} now={now} />
        </section>
      ) : null}

      {selectedDay ? (
        <section className="mt-8 grid grid-cols-2 gap-3">
          <Metric
            Icon={Thermometer}
            label={t('weather.metricHigh')}
            value={temp(selectedDay.maxC)}
            delay={220}
          />
          <Metric
            Icon={Thermometer}
            label={t('weather.metricLow')}
            value={temp(selectedDay.minC)}
            delay={290}
          />
          <Metric
            Icon={CloudRain}
            label={t('weather.metricRain')}
            value={
              selectedDay.precipMm == null ? '—' : `${selectedDay.precipMm} mm`
            }
            delay={360}
          />
          <Metric
            Icon={Droplets}
            label={t('weather.metricRainChance')}
            value={
              selectedDay.precipChancePct == null
                ? '—'
                : `${Math.round(selectedDay.precipChancePct)}%`
            }
            delay={430}
          />
          <Metric
            Icon={Wind}
            label={t('weather.metricWind')}
            value={
              selectedDay.windMaxKph == null
                ? '—'
                : `${Math.round(selectedDay.windMaxKph)} km/h`
            }
            delay={500}
          />
          <Metric
            Icon={Thermometer}
            label={t('weather.metricFeels')}
            value={temp(selectedDay.feelsMaxC)}
            delay={570}
          />
        </section>
      ) : (
        <section className="mt-8 grid grid-cols-2 gap-3">
          <Metric
            Icon={Droplets}
            label={t('weather.metricHumidity')}
            value={
              reading?.data.humidityPct == null
                ? '—'
                : `${Math.round(reading.data.humidityPct)}%`
            }
            delay={220}
          />
          <Metric
            Icon={Wind}
            label={t('weather.metricWind')}
            value={
              reading?.data.windKph == null
                ? '—'
                : `${Math.round(reading.data.windKph)} km/h`
            }
            delay={290}
          />
          <Metric
            Icon={CloudRain}
            label={t('weather.metricRain')}
            value={reading?.data.precipMm == null ? '—' : `${reading.data.precipMm} mm`}
            delay={360}
          />
          <Metric
            Icon={Thermometer}
            label={t('weather.metricFeels')}
            value={temp(reading?.data.feelsLikeC)}
            delay={430}
          />
        </section>
      )}

      {forecast.data.length > 0 ? (
        <section className="mt-8 animate-in fade-in duration-700 fill-mode-both motion-reduce:animate-none">
          <p className="text-overline uppercase text-foreground/70">
            {t('weather.forecastTitle')}
          </p>
          <div
            role="tablist"
            aria-label={t('weather.forecastTitle')}
            className="mt-2 flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            <DayTab
              label={t('weather.todayTab')}
              maxC={todayForecast?.maxC ?? reading?.data.tempC ?? null}
              minC={todayForecast?.minC ?? null}
              precipMm={todayForecast?.precipMm ?? reading?.data.precipMm ?? null}
              selected={selectedKey === TODAY}
              onSelect={() => setSelectedKey(TODAY)}
            />
            {futureDays.map((day) => (
              <DayTab
                key={day.date}
                label={forecastWeekday(day.date, locale)}
                maxC={day.maxC}
                minC={day.minC}
                precipMm={day.precipMm}
                selected={selectedKey === day.date}
                onSelect={() => setSelectedKey(day.date)}
              />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

/* ── the days ────────────────────────────────────────────────────────────── */

function DayTab({
  label,
  maxC,
  minC,
  precipMm,
  selected,
  onSelect,
}: {
  label: string;
  maxC: number | null;
  minC: number | null;
  precipMm: number | null;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useLocale();

  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onSelect}
      className={`min-w-24 rounded-lg border p-3 text-center motion-safe:transition-transform motion-safe:active:scale-95 ${
        selected
          ? 'border-foreground/50 bg-white/70 ring-1 ring-foreground/30 dark:bg-white/20'
          : 'border-foreground/10 bg-white/40 dark:bg-white/10'
      }`}
    >
      <p className="text-label text-foreground/70">{label}</p>
      <div className="mt-2 flex items-baseline justify-center gap-1.5">
        <span className="font-serif text-subheading tabular-nums">{temp(maxC)}</span>
        <span className="text-caption text-foreground/60 tabular-nums">{temp(minC)}</span>
      </div>
      {precipMm !== null && precipMm > 0 ? (
        <p className="mt-1.5 flex items-center justify-center gap-1 text-caption text-foreground/70">
          <CloudRain className="size-3" aria-hidden />
          {precipMm} mm
        </p>
      ) : (
        <p className="mt-1.5 text-caption text-foreground/50">{t('common.steady')}</p>
      )}
    </button>
  );
}

/* ── the arc ─────────────────────────────────────────────────────────────── */

function SunArc({ times, now }: { times: SunTimes; now: number }) {
  const { t, locale } = useLocale();
  const night = now < times.sunrise || now > times.sunset;
  const fraction = useAnimatedFraction(daylightProgress(now, times));
  const sun = sunPoint(fraction);

  const clock = (at: number) => clockTime(at, intlLocale(locale));

  return (
    <>
      <svg
        viewBox="0 0 320 120"
        className="w-full"
        role="img"
        aria-label={`${t('weather.sunrise')} ${clock(times.sunrise)} · ${t('weather.sunset')} ${clock(times.sunset)}`}
      >
        <line
          x1="14"
          y1="100"
          x2="306"
          y2="100"
          className="stroke-foreground/20"
          strokeWidth="1"
        />
        <path
          d="M 20 100 A 140 88 0 0 1 300 100"
          fill="none"
          pathLength={1}
          strokeDasharray={1}
          strokeDashoffset={1 - fraction}
          className="stroke-foreground/40"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
        {/* A soft glow that breathes, so the sun reads as light rather than a dot. */}
        <circle
          cx={sun.x}
          cy={sun.y}
          r="15"
          className={night ? 'fill-foreground/10' : 'fill-amber-300/60 animate-pulse'}
        />
        <circle
          cx={sun.x}
          cy={sun.y}
          r="6.5"
          className={night ? 'fill-foreground/40' : 'fill-amber-600'}
        />
      </svg>

      <div className="mt-1 grid grid-cols-3 text-center">
        <SunTime Icon={Sunrise} label={t('weather.sunrise')} value={clock(times.sunrise)} />
        <SunTime Icon={Sun} label={t('weather.solarNoon')} value={clock(times.solarNoon)} />
        <SunTime Icon={Sunset} label={t('weather.sunset')} value={clock(times.sunset)} />
      </div>

      {night ? (
        <p className="mt-2 text-center text-caption text-foreground/60">{t('weather.night')}</p>
      ) : null}
    </>
  );
}

function SunTimesRow({ times }: { times: SunTimes | null }) {
  const { t, locale } = useLocale();
  if (!times) return null;

  const clock = (at: number) => clockTime(at, intlLocale(locale));

  return (
    <section className="mt-8 animate-in fade-in duration-700 fill-mode-both motion-reduce:animate-none">
      <div className="grid grid-cols-3 text-center">
        <SunTime Icon={Sunrise} label={t('weather.sunrise')} value={clock(times.sunrise)} />
        <SunTime Icon={Sun} label={t('weather.solarNoon')} value={clock(times.solarNoon)} />
        <SunTime Icon={Sunset} label={t('weather.sunset')} value={clock(times.sunset)} />
      </div>
    </section>
  );
}

function SunTime({
  Icon,
  label,
  value,
}: {
  Icon: LucideIcon;
  label: string;
  value: string;
}) {
  return (
    <div className="flex flex-col items-center gap-1">
      <Icon className="size-4 text-foreground/70" aria-hidden />
      <p className="text-body font-medium tabular-nums">{value}</p>
      <p className="text-caption text-foreground/70">{label}</p>
    </div>
  );
}

/* ── the numbers ──────────────────────────────────────────────────────────── */

function Metric({
  Icon,
  label,
  value,
  delay,
}: {
  Icon: LucideIcon;
  label: string;
  value: string;
  delay: number;
}) {
  return (
    <div
      style={{ animationDelay: `${delay}ms` }}
      className="animate-in fade-in slide-in-from-bottom-2 fill-mode-both rounded-lg border border-foreground/10 bg-white/40 p-3.5 duration-700 motion-safe:transition-transform motion-safe:hover:-translate-y-0.5 motion-reduce:animate-none dark:bg-white/10"
    >
      <p className="flex items-center gap-1.5 text-label text-foreground/70">
        <Icon className="size-3.5 shrink-0" aria-hidden />
        {label}
      </p>
      <p className="mt-1.5 font-serif text-figure lining-nums tabular-nums">{value}</p>
    </div>
  );
}
