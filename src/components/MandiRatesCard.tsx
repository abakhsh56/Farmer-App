/**
 * Mandi rates, live from market_rates() — above My Credit, never below it.
 *
 * The layout follows the design mockup's content (three commodity tiles,
 * price per 40 kg maund, source and date on each), but the look is the
 * app's own design system: cream canvas, clay accent, serif figures, the
 * 20px card radius — never the mockup's styling.
 *
 * The rules, so the widget cannot mislead:
 *
 * · a rate is shown only when it was observed today and is quotable. A
 *   rate from another day is not shown as today's — its tile says "No rate
 *   today" instead. Yesterday's number is never today's number.
 * · a missing modal price is missing, never zero.
 * · AMIS prices arrive per 100 kg and are divided by 2.5 for the maund;
 *   per-40-kg prices are shown as they are. An unrecognised unit is never
 *   guessed.
 * · every tile carries its source — AMIS Punjab (government) or Community
 *   local — and the day it was observed.
 * · the Listen pill reads the rates aloud in Urdu, in short plain words.
 */

import { Loader2, Volume2 } from 'lucide-react';
import { toast } from 'sonner';
import { SectionLabel } from '@/components/SectionLabel';
import { useLocale } from '@/i18n/LocaleProvider';
import { formatDay, formatNumber } from '@/i18n/format';
import { LOCALE_REGISTRY } from '@/i18n/locales';
import { useLocation } from '@/location/LocationProvider';
import { useMarketRates } from '@/services/hooks';
import { isRateQuotable, type MarketRate } from '@/services/types';
import {
  isTodayRate,
  mandiSourceKind,
  maundPrice,
  MANDI_WIDGET_COMMODITIES,
} from '@/services/market';
import { useSpeech } from '@/speech/SpeechProvider';

/** One tile's worth of honesty: the price, or the reason there is none. */
export type MandiTile = {
  commodity: string;
  name: string;
  pricePerMaund: number | null;
  sourceLabel: string;
  sourceKind: 'govt' | 'community' | 'other';
  marketName: string;
  observedOn: string | null;
  isToday: boolean;
};

export function mandiTiles(rates: MarketRate[], nowMs: number): MandiTile[] {
  return MANDI_WIDGET_COMMODITIES.map((commodity) => {
    const rate = rates.find((entry) => entry.commodity === commodity) ?? null;
    const price = rate !== null ? maundPrice(rate) : null;
    const today = rate !== null && isTodayRate(rate, nowMs);
    const quotable = rate !== null && isRateQuotable(rate, nowMs);
    return {
      commodity,
      name: rate?.nameEn ?? commodity,
      /* Only a quotable rate observed today is a price. Anything else is
         "no rate today", not a stale number dressed as a live one. */
      pricePerMaund: today && quotable ? price : null,
      sourceLabel: rate?.sourceLabel ?? '',
      sourceKind: rate !== null ? mandiSourceKind(rate.sourceLabel) : 'other',
      marketName: rate?.marketName ?? '',
      observedOn: rate?.observedOn ?? null,
      isToday: today,
    };
  });
}

export function MandiRatesCard() {
  const { t, tIn, locale } = useLocale();
  const location = useLocation();
  const rates = useMarketRates();
  const speech = useSpeech();
  const speechTag = LOCALE_REGISTRY.ur.tag;
  const now = Date.now();

  const tiles = mandiTiles(rates.data, now);
  const live = tiles.filter((tile) => tile.pricePerMaund !== null);
  const marketName =
    live[0]?.marketName || location.placeLabel || t('market.wazirabad');
  const listening = speech.speaking === 'mandi';
  /* The pill shows a spinner while the voice is still arriving, not a
     Listen that sits silent — a press joins the download already running. */
  const voiceLoading = speech.voiceLoading && !listening;

  /*
   * The Urdu sentence the Listen pill reads: the live prices, then the
   * commodities with no rate today, so a farmer who listens hears the same
   * honesty the tiles show.
   */
  const spoken = tiles
    .map((tile) => {
      const cropUr =
        tile.commodity === 'cotton'
          ? tIn('ur', 'crop.cotton')
          : tile.commodity === 'wheat'
            ? tIn('ur', 'crop.wheat')
            : tIn('ur', 'crop.maize');
      return tile.pricePerMaund !== null
        ? tIn('ur', 'mandi.spoken.rate', {
            crop: cropUr,
            price: formatNumber(Math.round(tile.pricePerMaund), 'ur'),
          })
        : tIn('ur', 'mandi.spoken.noRate', { crop: cropUr });
    })
    .join('. ');

  return (
    <section aria-label={t('mandi.title')}>
      <SectionLabel
        action={
          live.length > 0 ? (
            <button
              type="button"
              onClick={() => {
                if (listening) {
                  speech.stop();
                  return;
                }
                /* speak resolves only when the first part actually begins;
                   a press the engine refuses resolves false and is answered
                   here, not with silence. */
                void speech
                  .speak({ id: 'mandi', text: spoken, lang: speechTag })
                  .then((started) => {
                    if (!started) {
                      toast.error(t('weather.listenUnavailable'));
                    }
                  })
                  .catch(() => {
                    toast.error(t('weather.listenUnavailable'));
                  });
              }}
              aria-label={
                listening
                  ? t('weather.stopListening')
                  : voiceLoading
                    ? t('weather.listenLoading')
                    : t('weather.listen')
              }
              className="flex items-center gap-1 text-label text-brand"
            >
              {voiceLoading ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <Volume2 className="size-4" aria-hidden />
              )}
              {listening
                ? t('weather.stopListening')
                : voiceLoading
                  ? t('weather.listenLoading')
                  : t('weather.listen')}
            </button>
          ) : null
        }
      >
        {t('mandi.title')} · {marketName}
      </SectionLabel>

      {rates.status === 'loading' ? (
        <p className="mt-2 text-body-sm text-muted-foreground">{t('weather.loading')}</p>
      ) : rates.data.length === 0 ? (
        <p className="mt-2 text-body-sm text-muted-foreground">{t('mandi.empty')}</p>
      ) : (
        <>
          <div className="mt-2 grid grid-cols-3 gap-2">
            {tiles.map((tile) => (
              <div
                key={tile.commodity}
                className="rounded-lg border border-border bg-card p-3"
              >
                <p className="text-label text-muted-foreground">{tile.name}</p>
                {tile.pricePerMaund !== null ? (
                  <>
                    <p className="mt-1 font-serif text-subheading lining-nums tabular-nums">
                      {formatNumber(Math.round(tile.pricePerMaund), locale)}
                    </p>
                    <p className="mt-1 text-caption text-muted-foreground">
                      {tile.sourceKind === 'govt'
                        ? t('mandi.source.govt')
                        : tile.sourceKind === 'community'
                          ? t('mandi.source.local')
                          : tile.sourceLabel}
                    </p>
                    <p className="text-caption text-muted-foreground">
                      {t('mandi.today')}
                    </p>
                  </>
                ) : (
                  <p className="mt-1 text-body-sm text-muted-foreground">
                    {t('mandi.noRateToday')}
                  </p>
                )}
              </div>
            ))}
          </div>
          <p className="mt-1.5 text-caption text-muted-foreground">
            {t('mandi.perMaund')}
            {rates.sourced !== null
              ? ` · ${formatDay(new Date(rates.sourced.observedAt), locale)}`
              : ''}
          </p>
        </>
      )}
    </section>
  );
}
