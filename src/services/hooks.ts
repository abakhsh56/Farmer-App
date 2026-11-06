/**
 * Screen-facing reads of the service layer.
 *
 * The PRD's rule is that nothing may be hard-wired to a provider, and that the
 * UI and the assistant must read the *same* normalised service so they can never
 * disagree about the number in front of the farmer. Screens therefore do not
 * touch a provider directly and do not import a fixture: they ask these hooks,
 * which ask the configured provider.
 *
 * Three behaviours here are the point of the file rather than plumbing:
 *
 * · A refresh never blanks the screen. When the radius changes or a retry is
 *   pressed, the previous answer stays visible and `refreshing` goes true, because
 *   a dealer list that disappears and reappears is worse than one that is a second
 *   out of date. `status` is therefore about whether there is anything to show,
 *   not about whether a request is in flight.
 *
 * · An answer is trusted for a minute. Switching tabs unmounts a screen, and
 *   coming back used to re-ask for everything a second after it was answered;
 *   the cache keyed on the request string stops that. A superseded request is
 *   aborted rather than left running: a search the farmer has already retyped
 *   must not keep its round-trips going.
 *
 * · The provider's own report travels with the data. `sourced` carries the source
 *   label, the observation time, the freshness and the provider's health, so a
 *   screen cannot render a figure without also being able to say where it came
 *   from and how old it is — which is the rule, enforced by the shape.
 *
 * · A failing provider is not a failed screen. A weather service that cannot be
 *   reached yields `status: 'ready'` with `sourced.status === 'failing'`, and the
 *   screen shows the "advice is paused" state from the *data*. Only a broken
 *   promise — a bug or a transport error — produces `status: 'error'`.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { PROFILE_POINT } from '@/data/dealers';
import { useServices, type Services } from './registry';
import type {
  DealerProduct,
  DealerSearchQuery,
  DealerStockist,
  DealerSummary,
  GeoPoint,
  MarketRate,
  ProductHit,
  ProductSearchQuery,
  Sourced,
  WeatherDay,
  WeatherNow,
} from './types';

export type Resource<T> = {
  /** 'loading' only while there is nothing to show yet. */
  status: 'loading' | 'ready' | 'error';
  /** True while a request is in flight over content that is already on screen. */
  refreshing: boolean;
  data: T;
  /** The provider's report: source, observation time, freshness and health. */
  sourced: Sourced<T> | null;
  /** Set only when the call itself failed — a bug or a transport error. */
  error: string | null;
  loadedAt: number | null;
  retry: () => void;
};

const EMPTY: readonly never[] = [];

/** How long a finished answer is trusted before the next mount re-asks. */
const CACHE_TTL_MS = 60_000;

/*
 * Finished answers keyed by the request string, shared by every screen: a
 * tab switch unmounts a screen, and coming back within the minute reuses the
 * answer instead of re-asking. Only successes are kept — a failure is never
 * cached — and a retry drops the entry first, so "ask again" really asks.
 */
const resourceCache = new Map<string, { at: number; value: Sourced<unknown> }>();

function useResource<T>(
  key: string,
  empty: T,
  load: (services: Services, signal: AbortSignal) => Promise<Sourced<T>>,
  enabled = true,
): Resource<T> {
  const services = useServices();
  const [attempt, setAttempt] = useState(0);
  const [sourced, setSourced] = useState<Sourced<T> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [inFlight, setInFlight] = useState(enabled);

  /* The loader closes over the current arguments; reading it through a ref keeps
     the effect keyed on the request rather than on a function identity that
     changes every render. */
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    if (!enabled) {
      setInFlight(false);
      return;
    }

    /* A fresh answer from the last minute is the answer: no request, no wait. */
    const cached = resourceCache.get(key);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      setSourced(cached.value as Sourced<T>);
      setError(null);
      setLoadedAt(cached.at);
      setInFlight(false);
      return;
    }

    let cancelled = false;
    /*
     * Aborting is what stops the request, not just its answer: a superseded
     * search used to keep all of its round-trips running while the farmer had
     * already typed the next word. The signal is handed to the loader, which
     * hands it to the provider; a provider that cannot abort ignores it.
     */
    const controller = new AbortController();
    setInFlight(true);

    void (async () => {
      try {
        const result = await loadRef.current(services, controller.signal);
        if (cancelled || controller.signal.aborted) return;
        resourceCache.set(key, { at: Date.now(), value: result });
        setSourced(result);
        setError(null);
        setLoadedAt(Date.now());
      } catch (failure) {
        if (cancelled || controller.signal.aborted) return;
        /* An aborted request is not a failed screen: the question was withdrawn. */
        if (failure instanceof Error && failure.name === 'AbortError') return;
        setError(failure instanceof Error ? failure.message : 'The service could not be reached.');
      } finally {
        if (!cancelled) setInFlight(false);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [key, attempt, enabled, services]);

  const retry = useCallback(() => {
    /* A retry means "ask again": drop the cached answer first, or the retry
       would hand back the same answer it already has. */
    resourceCache.delete(key);
    setAttempt((value) => value + 1);
  }, [key]);

  const hasContent = sourced !== null;
  return {
    status: error !== null && !hasContent ? 'error' : hasContent || !inFlight ? 'ready' : 'loading',
    refreshing: inFlight && hasContent,
    data: sourced?.data ?? empty,
    sourced,
    error,
    loadedAt,
    retry,
  };
}

/* -------------------------------------------------------------------------- */
/* Weather                                                                    */
/* -------------------------------------------------------------------------- */

/** The one weather read in the app. The assistant's context is built from it. */
export function useWeather(point: GeoPoint = PROFILE_POINT): Resource<WeatherNow> {
  return useResource<WeatherNow>(
    `weather:${point.lat.toFixed(3)},${point.lon.toFixed(3)}`,
    {
      tempC: null,
      feelsLikeC: null,
      humidityPct: null,
      precipMm: null,
      windKph: null,
      windDir: null,
      conditionText: null,
    },
    (services, signal) => services.weather.current(point, signal),
  );
}

export function useForecast(
  point: GeoPoint = PROFILE_POINT,
  days = 3,
): Resource<WeatherDay[]> {
  return useResource<WeatherDay[]>(
    `forecast:${point.lat.toFixed(3)},${point.lon.toFixed(3)}:${days}`,
    EMPTY as unknown as WeatherDay[],
    (services, signal) => services.weather.forecast(point, days, signal),
  );
}

/* -------------------------------------------------------------------------- */
/* Market                                                                     */
/* -------------------------------------------------------------------------- */

export function useMarketRates(commodity?: string): Resource<MarketRate[]> {
  return useResource<MarketRate[]>(
    `rates:${commodity ?? 'all'}`,
    EMPTY as unknown as MarketRate[],
    (services, signal) => services.market.rates(commodity, signal),
  );
}

/* -------------------------------------------------------------------------- */
/* Dealers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Dealer search.
 *
 * `origin` is present only for a temporary search area. Passing it never changes
 * the farmer's profile location — the provider is told where to look, not who is
 * looking — which is what makes the rule structural rather than a promise.
 */
export function useDealerSearch(query: DealerSearchQuery): Resource<DealerSummary[]> {
  const { radiusKm, query: text, tags, origin } = query;
  const key = [
    'dealers',
    Math.round(radiusKm * 10),
    text?.trim().toLowerCase() ?? '',
    [...(tags ?? [])].sort().join('+'),
    origin ? `${origin.lat.toFixed(3)},${origin.lon.toFixed(3)}` : 'profile',
  ].join(':');

  return useResource<DealerSummary[]>(
    key,
    EMPTY as unknown as DealerSummary[],
    (services, signal) =>
      services.dealer.search({
        radiusKm,
        query: text,
        tags,
        origin,
      }, signal),
  );
}

/**
 * Product search — the same question as dealer search, asked about stock.
 *
 * Keyed like its sibling, on radius, text and origin together: pointing the app at
 * a different area is then a different request rather than a cached answer about
 * the old one, which is the mistake the key exists to make impossible.
 */
export function useProductSearch(query: ProductSearchQuery): Resource<ProductHit[]> {
  const { radiusKm, query: text, origin } = query;
  const key = [
    'product-search',
    Math.round(radiusKm * 10),
    text?.trim().toLowerCase() ?? '',
    origin ? `${origin.lat.toFixed(3)},${origin.lon.toFixed(3)}` : 'profile',
  ].join(':');

  return useResource<ProductHit[]>(
    key,
    EMPTY as unknown as ProductHit[],
    (services, signal) => services.dealer.searchProducts({ radiusKm, query: text, origin }, signal),
  );
}

export function useDealerProducts(dealerId: string | null): Resource<DealerProduct[]> {
  return useResource<DealerProduct[]>(
    `products:${dealerId ?? 'none'}`,
    EMPTY as unknown as DealerProduct[],
    (services, signal) => services.dealer.products(dealerId as string, signal),
    dealerId !== null,
  );
}

/**
 * Where one canonical product can be bought right now.
 *
 * The scan asks this, rather than quoting listings of its own, so the price on a
 * diagnosis is the price on the shop's own page. The key carries the radius and
 * the origin so that pointing the app at a different area is a different request
 * rather than a cached answer about the old one.
 */
export function useStockists(
  canonicalProductId: string,
  radiusKm: number,
  origin?: GeoPoint,
): Resource<DealerStockist[]> {
  const key = [
    'stockists',
    canonicalProductId,
    Math.round(radiusKm * 10),
    origin ? `${origin.lat.toFixed(3)},${origin.lon.toFixed(3)}` : 'profile',
  ].join(':');

  return useResource<DealerStockist[]>(
    key,
    EMPTY as unknown as DealerStockist[],
    (services, signal) => services.dealer.stockists({ canonicalProductId, radiusKm, origin }, signal),
  );
}
