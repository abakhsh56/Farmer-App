import {
  AlertTriangle,
  ChevronRight,
  Cloud,
  CreditCard,
  MapPin,
  RefreshCw,
  Sprout,
  Volume2,
} from 'lucide-react';
import { useEffect } from 'react';
import { SectionLabel } from '@/components/SectionLabel';
import { CropCard, NotificationBell } from '@/components/insights/Insights';
import { MandiRatesCard } from '@/components/MandiRatesCard';
import { useCredit } from '@/credit/CreditProvider';
import { shopsHoldingCredit } from '@/credit/store';
import { useLocale } from '@/i18n/LocaleProvider';
import {
  formatHour,
  formatMoney,
  formatRelativeTime,
  formatWeekdayDate,
} from '@/i18n/format';
import { useLocation } from '@/location/LocationProvider';
import { initialsOf } from '@/lib/initials';
import { useCommunity } from '@/community/CommunityProvider';
import { ME, PLACES, type TopicId } from '@/data/community';
import { useInsights } from '@/insights/InsightProvider';
import { useForecast, useHourly, useWeather } from '@/services/hooks';
import {
  computeCardAdvisory,
  expertAnswerFromPosts,
  pestReportsFromPosts,
  type AdvisoryItem,
} from '@/services/advisory';
import { renderAdvisoryCopy } from '@/services/advisoryCopy';
import { useCapability } from '@/capability/CapabilityProvider';
import { isWeatherStale, isWeatherUsable } from '@/services/types';
import { useSession } from '@/session/SessionProvider';
import { useSpeech } from '@/speech/SpeechProvider';
import { LOCALE_REGISTRY } from '@/i18n/locales';

const midnight = (date: Date) => {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
};

const TODAY = midnight(new Date());

/** One day in ms — the unit the crop-watch ranking erodes urgency by. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Home answers one question — *is there anything I need to do today?* — so
 * everything on it is either an action or the evidence behind one.
 *
 * Three things are deliberate. Advice comes from the canonical insight list
 * rather than being written here, which is why the old amber "pink bollworm"
 * strip is gone: it and the insight card were two versions of one
 * recommendation. The weather figure carries its age; a number without it would
 * be a claim the app cannot support. And the mandi rates strip is gone too:
 * every tile it drew was a labelled non-authoritative `research_feed` row nine
 * days old, so the section showed three prices the app was at the same time
 * telling the farmer not to trust. The rate service and its tests remain; the
 * surface that could not stand behind its numbers does not. When a real AMIS
 * source is decided, the strip can come back with it.
 */
export function HomeScreen({
  onScan,
  onOpenProfile,
  onOpenLocationSearch,
  onOpenCommunity,
  onOpenWeather,
}: {
  onScan: () => void;
  onOpenProfile: () => void;
  onOpenLocationSearch: () => void;
  onOpenCommunity: () => void;
  onOpenWeather: () => void;
}) {
  const { t, locale, tIn } = useLocale();
  const credit = useCredit();
  const { account, requestIdentity } = useSession();
  /*
   * The header says the farmer's own name once there is one, and says plainly
   * that nobody is signed in otherwise. It used to say a fixture name — which
   * on a shared phone read as the previous account still being logged in.
   */
  const farmerName = account?.name?.trim() || t('farmer.guestName');
  const farmerFirstName = farmerName.split(/\s+/)[0] ?? farmerName;
  const now = Date.now();

  /*
   * The weather comes from the same normalised service the assistant reads. That
   * is not tidiness: a Home card showing 34° while the assistant cites 31° for
   * the same morning is the exact failure the rule about "one weather source"
   * exists to prevent, and it is only preventable if the two read the same call.
   */
  /*
   * Weather is read for the location the farmer actually has — the saved one, or
   * the temporary area they are looking at — rather than a constant in the app.
   * That is what makes "the saved location drives weather" a property of the code
   * instead of a promise: there is no other point available to this call.
   */
  const location = useLocation();
  const weather = useWeather(location.activePoint);
  const reading = weather.sourced;
  const weatherUsable = reading !== null && isWeatherUsable(reading);
  /*
   * The hourly forecast the spray window is computed from. It is a separate
   * read from the current conditions, because a window is a run of hours and
   * the current reading cannot say which hours are calm.
   */
  const hourly = useHourly(location.activePoint, 24);
  /* The daily forecast the irrigation and harvest items read: rain in the
     next three days means skip watering, a dry window means harvest. */
  const forecast = useForecast(location.activePoint, 7);
  /*
   * Advice pauses for two reasons and they must not read the same: a reading too
   * old to spray on ("out of date") is not a service that answered nothing
   * ("not available"). A failed call also returns a reading, with no numbers in
   * it, so only freshness separates the two.
   */
  const readingStale = reading !== null && isWeatherStale(reading);

  /*
   * What is happening around the farmer's crop, built from the two places this
   * app already learns it: advice the system raised for this crop (the canonical
   * insight list — the same record the notification bell references, never a
   * second wording), and reports neighbours filed about pests or the same crop.
   *
   * Both sides are scoped rather than sampled: advice only for crops the farmer
   * has added, reports only from the feed they can already see, newest first and
   * a handful at most. Every row carries where it came from and how old it is —
   * an alert with no provenance is a rumour with a nice font.
   *
   * The crop is read here, before the spoken advice, because the spray window
   * is only advice for a farmer who has one: the window is computed from the
   * live hourly forecast and the crop, and the voice must say the same window
   * the card prints.
   */
  const insights = useInsights();
  const community = useCommunity();
  const crop = insights.primary;
  const cropTopic = crop ? (crop.nameKey.replace('crop.', '') as TopicId) : null;

  /*
   * The card's advice, computed from the farmer's live signals — ten
   * signal-driven items in the PRD alert model's priority order, at most
   * three, never a fixed line. The same function and the same input drive
   * the Weather screen, so the two surfaces never print two versions of
   * one morning.
   *
   * · spray window from the live hourly forecast and the crop, rain-free
   *   warning from the rain probability, outbreak and pest threshold from
   *   the community feed, stage and fertilizer from the knowledge base,
   *   irrigation and harvest from the daily forecast, follow-up from the
   *   farmer's own actions and the expert's answer.
   * · a missing value stays missing and stale weather pauses the
   *   weather items; the knowledge-backed ones stand on their own validity.
   * · every item carries its source and its freshness, printed beside it.
   */
  const capability = useCapability();
  const advisory: AdvisoryItem[] = computeCardAdvisory(
    {
      now: reading,
      hourly: hourly.sourced,
      forecast: forecast.sourced,
      crop: crop ?? null,
      insights: crop ? insights.forCrop(crop.id) : [],
      actedInsights: crop
        ? insights.forCrop(crop.id).filter((entry) => entry.status === 'acted')
        : [],
      pestReports: pestReportsFromPosts(
        community.posts,
        (postId) => community.expertAnswered(postId),
        ME,
        (placeId) => {
          const place = PLACES.find((entry) => entry.id === placeId);
          return place ? t(place.labelKey) : t('location.none');
        },
      ),
      expertAnswer: expertAnswerFromPosts(
        community.posts,
        (postId) => community.expertAnswered(postId),
        ME,
      ),
      sources: {
        weather: reading?.sourceLabel ?? t('advisory.source.openMeteo'),
        community: t('advisory.source.community'),
        communityExpert: t('advisory.source.communityExpert'),
        knowledge: t('advisory.source.knowledge'),
      },
    },
    now,
  );
  /* The words for each item, shaped to this farmer's capability — the same
     advice, short and plain for one farmer, numbered and reasoned for
     another. The listen text is always Urdu. */
  const advisoryCopyCtx = {
    t,
    tUr: (key: Parameters<typeof t>[0], values?: Parameters<typeof t>[1]) =>
      tIn('ur', key, values),
    formatHour: (hour: number) => formatHour(hour, t),
    formatHourUr: (hour: number) =>
      formatHour(hour, (key, values) => tIn('ur', key, values)),
  };
  const advisoryCopies = advisory.map((item) =>
    renderAdvisoryCopy(item, capability.level, advisoryCopyCtx),
  );

  /*
   * Where a tap on an advisory row goes. An insight-backed row opens the
   * insight; a community row opens the thread it came from; a weather row
   * opens the Weather screen. A row with no destination is not a button.
   */
  const advisoryDestination = (item: AdvisoryItem): (() => void) | null => {
    if (item.insightId !== undefined) return () => insights.open(item.insightId as string);
    if (item.postId !== undefined) {
      return () => {
        community.openThread(item.postId as string);
        onOpenCommunity();
      };
    }
    if (
      item.kind === 'spray' ||
      item.kind === 'rainfree' ||
      item.kind === 'irrigation' ||
      item.kind === 'harvest' ||
      item.kind === 'stress'
    ) {
      return onOpenWeather;
    }
    return null;
  };

  /*
   * The words behind the Listen pill on the weather card — always in Urdu.
   *
   * Read-aloud is Urdu by decision, not by accident of the interface: the farmer
   * pressed a speaker to *hear* the advice, and the language this app is written
   * for — and the one a voice is actually installed for on these phones — is
   * Urdu. So the words are looked up in `ur` whatever the screen is set to, and
   * the screen and the voice are deliberately allowed to disagree. Numerals are
   * spoken from the same values the card prints, so what is heard and what is
   * seen cannot be two different mornings.
   */
  const speech = useSpeech();
  const speechTag = LOCALE_REGISTRY.ur.tag;
  const listening = speech.speaking === 'weather';
  /*
   * The words behind the Listen pill — always in Urdu, and the advice part
   * is the top advisory item's own listen text, so what is heard is the
   * same advice the card prints, in the words this farmer reads.
   */
  const topListen = advisoryCopies[0]?.listenText ?? '';
  const spokenAdvice =
    reading && weatherUsable
      ? [
          reading.data.conditionKey
            ? tIn('ur', reading.data.conditionKey)
            : reading.data.conditionText,
          reading.data.tempC === null
            ? null
            : tIn('ur', 'weather.spokenTemp', { value: Math.round(reading.data.tempC) }),
          reading.data.humidityPct === null
            ? null
            : tIn('ur', 'weather.humidity', { value: reading.data.humidityPct }),
          reading.data.windKph === null
            ? null
            : reading.data.windKph > 0
              ? tIn('ur', 'weather.windValue', { speed: Math.round(reading.data.windKph) })
              : tIn('ur', 'weather.wind'),
          topListen || null,
        ]
          .filter((part): part is string => Boolean(part))
          .join('. ')
      : '';

  /*
   * Leaving Home leaves the voice behind. The reading belongs to the card that
   * was pressed, and a phone still talking about spraying after the farmer has
   * walked to the dealer list is the app talking to itself.
   */
  const stopSpeech = speech.stop;
  useEffect(() => () => stopSpeech(), [stopSpeech]);

  /*
   * Insight advice is not listed here any more: it lives in the advisory
   * list on the weather card, in the farmer's own words, and a second
   * wording here would be a second version of the same recommendation.
   * What stays is what the neighbours are saying, clustered by signal.
   */

  /*
   * Derived intelligence, not echoed posts: relevant discussions are clustered
   * by signal (pest vs the farmer's crop) so each row summarises what the
   * discussion amounts to — how many field reports, how much discussion,
   * whether an expert weighed in — instead of quoting one neighbour's message.
   * Tapping opens the most-discussed thread, not the community tab root.
   */
  const relevantPosts = community.posts.filter(
    (post) =>
      post.removed === undefined &&
      // The farmer's own posts are not "what is happening around" them.
      post.author !== ME &&
      (post.topics.includes('pest') || (cropTopic !== null && post.topics.includes(cropTopic))),
  );
  const reportRows = (['pest', 'crop'] as const)
    .map((signal) => {
      const inCluster = relevantPosts
        .filter((post) =>
          signal === 'pest' ? post.topics.includes('pest') : !post.topics.includes('pest'),
        )
        .slice(0, 5);
      if (inCluster.length === 0) return null;
      const totalReplies = inCluster.reduce((sum, post) => sum + community.replyCount(post.id), 0);
      const expertInvolved = inCluster.some(
        (post) => community.topAnswer(post.id) !== undefined || community.expertAnswered(post.id),
      );
      const latest = inCluster.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
      const busiest = inCluster.reduce((a, b) =>
        community.replyCount(b.id) > community.replyCount(a.id) ? b : a,
      );
      const places = [...new Set(inCluster.map((post) => post.place))];
      const placeLabels = places.map((placeId) => {
        const place = PLACES.find((entry) => entry.id === placeId);
        return place ? t(place.labelKey) : t('location.none');
      });
      const signalLabel =
        signal === 'pest'
          ? t('community.topic.pest')
          : crop
            ? t(crop.nameKey)
            : t('community.topic.pest');
      return {
        id: `cluster-${signal}`,
        icon: signal === 'pest' ? AlertTriangle : Sprout,
        tint:
          signal === 'pest'
            ? 'bg-amber-50 text-amber-700 dark:bg-amber-500/20 dark:text-amber-100'
            : 'bg-muted text-muted-foreground',
        chip: signal === 'pest' ? t('home.watch.alert') : null,
        title: `${signalLabel} · ${t('community.replies', { count: totalReplies })}`,
        meta: [
          placeLabels.join(', '),
          formatRelativeTime(latest.createdAt, now, t),
          expertInvolved ? t('community.expertAnswered') : null,
        ]
          .filter((part): part is string => Boolean(part))
          .join(' · '),
        /* A discussed pest signal outranks a plain crop update; expert
           discussion adds weight but stays below direct advice. */
        urgency: (signal === 'pest' ? 50 : 30) + (expertInvolved ? 5 : 0),
        createdAt: latest.createdAt,
        onClick: () => {
          community.openThread(busiest.id);
          onOpenCommunity();
        },
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);

  /*
   * One list, ranked — not advice stacked on top of reports. Urgency sets the
   * starting line (a live pest alert, then other advice, then a pest report,
   * then an update) and recency breaks the tie: age subtracts ten points per
   * day, so a fresh neighbour report rises above week-old advice while a
   * high-priority alert stays where the farmer needs it.
   */
  const watchRows = [...reportRows]
    .map((row) => ({
      ...row,
      score: row.urgency - Math.min(((now - row.createdAt) / DAY_MS) * 10, 40),
    }))
    .sort((a, b) => b.score - a.score || b.createdAt - a.createdAt)
    .slice(0, 4);

  /*
   * The card is a total, never a statement. Credit is carried at up to four shops,
   * so a figure for one of them would be this card picking a favourite; paid and
   * owed are summed across every open agreement for the single bar it draws. The
   * shops themselves — what was bought, what is left — are on the credit screen
   * behind the entry row.
   */
  const openAgreements = credit.data.agreements.filter((entry) => entry.closedAt === null);
  const outstanding = openAgreements.reduce((sum, entry) => sum + credit.outstandingOf(entry), 0);
  const repaid = openAgreements.reduce(
    (sum, agreement) => {
      const request = credit.requestById(agreement.requestId);
      const terms = request?.terms.find((version) => version.version === agreement.termsVersion);
      return {
        paid: sum.paid + agreement.paid,
        total: sum.total + (terms ? terms.amount + terms.fee : 0),
      };
    },
    { paid: 0, total: 0 },
  );
  const paidPercent = repaid.total > 0 ? Math.round((repaid.paid / repaid.total) * 100) : 0;
  const shops = shopsHoldingCredit(credit.data);
  const waiting = credit.awaiting[0];

  return (
    <div className="flex flex-col gap-3 px-4 pt-4 pb-4">
      <header className="flex items-center gap-2.5">
        {/* The avatar is the profile entry point. The design puts the farmer's own
            face here and the tab bar's fifth item was "Me"; moving that destination
            into this circle keeps one control instead of two competing ones. */}
        <button
          type="button"
          aria-label={t('profile.open')}
          onClick={onOpenProfile}
          className="grid size-11 shrink-0 place-items-center rounded-full bg-brand text-subheading font-medium text-brand-foreground"
        >
          {initialsOf(farmerName)}
        </button>

        <div className="min-w-0 flex-1">
          <p className="truncate text-subheading">
            {t('home.greeting', { name: farmerFirstName })}
          </p>
          {/*
            The place line is a control, not a caption: it is the name of the
            area the weather and the shops are read for, so tapping it is how a
            farmer changes that area. It is labelled with both what it opens and
            what it currently holds, because a name alone would not say that.
          */}
          <button
            type="button"
            aria-label={`${t('location.title')}: ${location.placeLabel || t('location.none')}`}
            onClick={onOpenLocationSearch}
            className="mt-0.5 flex max-w-full items-center gap-1 text-label text-muted-foreground"
          >
            <MapPin className="size-3.5 shrink-0" aria-hidden />
            <span className="truncate">
              {location.placeLabel || t('location.none')}
            </span>
            {location.isTemporary ? (
              <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-caption">
                {t('location.temporary')}
              </span>
            ) : null}
          </button>
        </div>

        <NotificationBell />
      </header>

      {/* The one dark block on the screen — and the reason the rest of the page
          (cream, white cards) reads as calm rather than flat. */}
      <section className="rounded-lg bg-surface-inverted px-4 py-4 text-cream-50">
        <div className="flex items-center justify-between gap-3">
          <p className="text-overline text-brand uppercase">
            {t('weather.today', { date: formatWeekdayDate(TODAY, locale) })}
          </p>
          {weatherUsable ? (
            /*
              The pill was drawn by the design and had no handler at all — a
              control whose destination did not exist. It now reads the card out
              loud, in Urdu, and it works the moment it is pressed: the device's
              own Urdu voice when it has one, real Urdu audio when it does not.
            */
            <button
              type="button"
              /*
                Warming on the way in, not on the press: a finger rests on this
                pill and a keyboard lands on it before either presses it, and the
                model is 63 MB, so the load starts there — and the first sentence
                is made there too, which is what makes the press start at the
                first sound. Nothing is said until the press. The device's own
                Urdu voice skips this entirely: there is nothing to fetch.
              */
              onPointerEnter={() => speech.warm(speechTag, spokenAdvice)}
              onFocus={() => speech.warm(speechTag, spokenAdvice)}
              onClick={() =>
                listening
                  ? speech.stop()
                  : speech.speak({ id: 'weather', text: spokenAdvice, lang: speechTag })
              }
              aria-label={listening ? t('weather.stopListening') : t('weather.listen')}
              className="flex items-center gap-1.5 rounded-full bg-white/12 px-3 py-1.5 text-label text-white"
            >
              <Volume2 className="size-4" aria-hidden />
              {listening ? t('weather.stopListening') : t('weather.listen')}
            </button>
          ) : null}
        </div>

        {weather.status === 'loading' ? (
          <p className="mt-3 text-body-sm text-white/70">{t('weather.loading')}</p>
        ) : null}

        {reading !== null ? (
          /*
            The card's number is the door to the sky. It used to be a plain block,
            which left the fuller weather screen with no way in from the only
            surface that carries weather. Listen and Refresh sit outside this
            control, so each press still does exactly one thing.

            The door stays open even when the reading failed: a farmer whose
            weather could not be fetched still needs the detail screen (it shows
            the forecast and the reason), and hiding the only way in behind a
            temperature that is not there left him with nowhere to go.
          */
          <button
            type="button"
            onClick={onOpenWeather}
            className="mt-3 flex w-full items-center gap-3 text-start motion-safe:transition-transform motion-safe:active:scale-95"
          >
            <Cloud className="size-9 shrink-0 text-white" aria-hidden />
            {reading.data.tempC !== null ? (
              <>
                {/* lining-nums matters: Cormorant defaults to old-style figures, and a
                temperature set in text figures reads as a broken number. */}
                <span className="font-serif text-display lining-nums tabular-nums">
                  {Math.round(reading.data.tempC)}°
                </span>
                <span className="block text-label leading-relaxed text-white/70">
                  {reading.data.conditionKey
                    ? t(reading.data.conditionKey)
                    : (reading.data.conditionText ?? '')}
                  <br />
                  {reading.data.humidityPct !== null
                    ? `${t('weather.humidity', { value: reading.data.humidityPct })} · `
                    : ''}
                  {reading.data.windKph !== null
                    ? t('weather.windValue', { speed: Math.round(reading.data.windKph) })
                    : ''}
                </span>
              </>
            ) : (
              <span className="block text-label leading-relaxed text-white/70">
                {t('weather.open')}
              </span>
            )}
            <ChevronRight
              className="ms-auto size-4 shrink-0 self-start text-white/60 rtl:rotate-180"
              aria-hidden
            />
            <span className="sr-only">{t('weather.open')}</span>
          </button>
        ) : null}

        {/*
          The card's advice: up to three items, computed from this farmer's
          live signals and worded for how much detail he wants. Each row
          carries its source and its freshness — an alert with no provenance
          is a rumour with a nice font — and a tap opens where it came from:
          the insight, the community thread, or the Weather screen. When the
          reading cannot carry weather advice, the list still shows what the
          knowledge base raised, and a retry sits under it.
        */}
        {advisory.length > 0 ? (
          <div className="mt-3.5 border-t border-white/20 pt-3.5">
            <ul className="flex flex-col gap-3">
              {advisory.map((item, index) => {
                const copy = advisoryCopies[index];
                const go = advisoryDestination(item);
                if (!copy) return null;
                const row = (
                  <>
                    <p className="text-lead">{copy.title}</p>
                    <p className="mt-1 text-body-sm leading-relaxed text-white/75">{copy.body}</p>
                    <p className="mt-1 text-caption text-white/60">
                      {item.source} · {formatRelativeTime(item.observedAt, now, t)}
                    </p>
                  </>
                );
                return (
                  <li key={`${item.kind}-${index}`}>
                    {go ? (
                      <button
                        type="button"
                        onClick={go}
                        className="w-full text-start motion-safe:transition-transform motion-safe:active:scale-[0.98]"
                      >
                        {row}
                      </button>
                    ) : (
                      row
                    )}
                  </li>
                );
              })}
            </ul>
            {!weatherUsable ? (
              <button
                type="button"
                onClick={weather.retry}
                className="mt-3 rounded-full bg-white/12 px-4 py-2 text-label text-white"
              >
                {t('common.tryAgain')}
              </button>
            ) : null}
          </div>
        ) : (
          /*
           * Advice that depends on the weather is paused when the reading cannot
           * carry it — but the numbers above, if any, stay: they are the reason the
           * advice is paused, and hiding them would leave the farmer unable to see
           * why. What never happens is advice without a reading behind it.
           */
          <div className="mt-3.5 border-t border-white/20 pt-3.5">
            {/* Two different failures, said differently: a reading that is too old
                to spray on is not the same as a service that answered nothing. */}
            <p className="text-subheading">
              {readingStale ? t('weather.stale.title') : t('weather.unavailable.title')}
            </p>
            <p className="mt-1 text-body-sm leading-relaxed text-white/75">
              {readingStale && reading
                ? t('weather.stale', {
                    age: formatRelativeTime(reading.observedAt, Date.now(), t),
                  })
                : t('weather.unavailable.body')}
            </p>
            <button
              type="button"
              onClick={weather.retry}
              className="mt-3 rounded-full bg-white/12 px-4 py-2 text-label text-white"
            >
              {t('common.tryAgain')}
            </button>
          </div>
        )}

        {reading ? (
          <p className="mt-3 flex items-center gap-1.5 text-caption text-white/60">
            {t('weather.updated', { time: formatRelativeTime(reading.observedAt, now, t) })}
            {/*
              The provider credit that used to be printed here is gone at the
              farmer's request: this line is read in a field, and "Open-Meteo"
              answers a question nobody standing in a cotton field was asking.
              What they do ask is for a newer number, which is what the control
              beside it is for — `weather.retry` is the same reload the stale
              card uses, so a card that is merely old has the same remedy as one
              that failed. While it is in flight the pill says so instead of
              flickering the age, because a refresh that looks like nothing
              happened invites a second press.
            */}
            <button
              type="button"
              onClick={weather.retry}
              disabled={weather.refreshing}
              aria-label={t('weather.refresh')}
              className="flex items-center gap-1 rounded-full px-2 py-1 text-caption text-white disabled:opacity-60"
            >
              <RefreshCw
                className={weather.refreshing ? 'size-3 animate-spin' : 'size-3'}
                aria-hidden
              />
              {t('weather.refresh')}
            </button>
            {!weatherUsable && reading.data.tempC !== null ? (
              <>
                <AlertTriangle className="size-3.5 shrink-0 text-amber-300" aria-hidden />
                {t('weather.stale', {
                  age: formatRelativeTime(reading.observedAt, now, t),
                })}
              </>
            ) : null}
          </p>
        ) : null}
      </section>

      {/*
        The farmer's crop, in one card: advice when there is any, the scanner
        always — "what does my crop need" and "what is wrong with this leaf" are
        one question asked two ways. The block this replaced was a second, louder
        answer to the same question, with the same destination.
      */}
      <CropCard onScan={onScan} />

      {/*
        Mandi rates sit directly above My Credit: after sign-in the credit
        card appears, and the rates are the first thing above it — the order
        the farmer reads the morning in. The widget reads live rates from
        market_rates(); a rate from another day is never shown as today's.
      */}
      <MandiRatesCard />

      {/*
        The credit card is account data, so before there is an account it is not
        drawn at all — no figure, not even a zero, no shop line and no button. A
        guest's way in is the *My Credit* tile above.
      */}
      {account ? (
        <section className="rounded-lg border border-border bg-card p-4">
          <SectionLabel>{t('credit.title')}</SectionLabel>

          <p className="mt-2 font-serif text-figure lining-nums tabular-nums">
            {formatMoney(outstanding, locale, t)}
          </p>
          <p className="mt-1 text-label text-muted-foreground">
            {shops.length > 0
              ? t('credit.home.shops', { count: shops.length })
              : t('credit.home.none')}
          </p>

          {openAgreements.length > 0 ? (
            <>
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-secondary">
                <div
                  className="h-full rounded-full bg-brand"
                  style={{ width: `${paidPercent}%` }}
                />
              </div>
              <div className="mt-1.5 flex items-baseline justify-between text-caption text-muted-foreground">
                <span>{t('credit.card.paid', { percent: paidPercent })}</span>
                <span className="tabular-nums">
                  {t('credit.card.outstanding', { amount: formatMoney(outstanding, locale, t) })}
                </span>
              </div>
            </>
          ) : null}

          {waiting ? (
            <button
              type="button"
              onClick={() => credit.open(waiting.id)}
              className="mt-3 flex w-full items-center gap-2 rounded-md bg-amber-50 px-3 py-2.5 text-start dark:bg-amber-500/20"
            >
              <AlertTriangle className="size-4 shrink-0 text-amber-700 dark:text-amber-100" aria-hidden />
              <span className="flex-1 text-label leading-snug text-amber-900 dark:text-amber-100">
                {t('credit.home.answer')}
              </span>
              <ChevronRight className="size-4 shrink-0 text-amber-700 rtl:rotate-180 dark:text-amber-100" aria-hidden />
            </button>
          ) : null}

          {/*
           * The door to the ledger, and the whole card's only action — words and a
           * chevron, no filled button and no pill: the card already carries a
           * figure, so the way out of it does not need to shout. Asking for credit
           * is deliberately not offered here: it is its own flow, entered from the
           * credit screen, so this card summarises what is owed rather than being a
           * place where new debt is started.
           */}
          <button
            type="button"
            onClick={() => credit.open()}
            className="mt-3 flex w-full items-center justify-between gap-2 text-start"
          >
            <span className="text-label text-brand">{t('credit.entry')}</span>
            <ChevronRight className="size-4 shrink-0 text-brand rtl:rotate-180" aria-hidden />
          </button>
        </section>
      ) : (
        /*
          The credit door before there is an account to hold any: one row, no
          figure and no filled button, opening the credit screen once through.
        */
        <button
          type="button"
          onClick={() => requestIdentity(() => credit.open(), 'session.why.creditBook')}
          className="flex w-full items-center gap-3 rounded-lg border border-border bg-card p-4 text-start"
        >
          <span className="grid size-10 shrink-0 place-items-center rounded-full bg-muted">
            <CreditCard className="size-5 text-brand" aria-hidden />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-body-sm font-medium">{t('profile.credit')}</span>
            <span className="mt-0.5 block text-caption text-muted-foreground">
              {t('quick.credit.note')}
            </span>
          </span>
          <ChevronRight className="size-4 shrink-0 text-brand rtl:rotate-180" aria-hidden />
        </button>
      )}

      <section className="pb-2">
        <SectionLabel
          action={
            <button type="button" onClick={onOpenCommunity} className="text-label text-brand">
              {t('common.seeAll')}
            </button>
          }
        >
          {t('home.watch.title')}
        </SectionLabel>

        {watchRows.length === 0 ? (
          <p className="mt-2 text-body-sm text-muted-foreground">{t('home.watch.empty')}</p>
        ) : (
          /* One card with divided rows, not a stack of separate boxes: the rows
             are one feed, and four identical borders read as four unrelated
             notices. The chevron is the affordance the separate boxes were
             standing in for. */
          <ul className="mt-2 divide-y divide-border rounded-lg border border-border bg-card">
            {watchRows.map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  onClick={row.onClick}
                  className="flex w-full items-start gap-3 px-4 py-3 text-start"
                >
                  <span
                    className={`mt-0.5 grid size-9 shrink-0 place-items-center rounded-md ${row.tint}`}
                  >
                    <row.icon className="size-4" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    {row.chip ? (
                      <span className="mb-1 inline-block rounded-full bg-amber-50 px-2 py-0.5 text-caption font-medium text-amber-700 dark:bg-amber-500/20 dark:text-amber-100">
                        {row.chip}
                      </span>
                    ) : null}
                    <span className="block text-body font-medium leading-snug">{row.title}</span>
                    <span className="mt-1 block truncate text-caption text-muted-foreground">
                      {row.meta}
                    </span>
                  </span>
                  <ChevronRight
                    className="mt-1 size-4 shrink-0 text-muted-foreground rtl:rotate-180"
                    aria-hidden
                  />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

