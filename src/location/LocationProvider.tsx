import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { MAX_RADIUS_KM, PROFILE_POINT } from '@/data/dealers';
import { serviceConfig } from '@/services/config';
import {
  clearSavedLocation,
  readSavedLocation,
  serverSourceOf,
  writeSavedLocation,
  type PickedSource,
  type SavedLocation,
} from '@/services/location';
import { currentSessionUser, getSupabaseClient } from '@/services/supabaseClient';
import type { GeoPoint } from '@/services/types';
import { useSession } from '@/session/SessionProvider';

/**
 * Where the app thinks the farmer is, and which of those answers is allowed to persist.
 *
 * This exists because "the location" is three different facts that were previously
 * one constant:
 *
 *   · the **saved location** — the farmer's own, on the server, and the thing that
 *     weather, nearby dealers, market relevance and the assistant's context are all
 *     supposed to be about;
 *   · a **temporary area** — "show me shops near Kot Ladha", which the PRD says must
 *     never silently replace the saved location; and
 *   · the **default area** — what a farmer who has saved nothing gets, so the first
 *     screen is useful before any choice has been made.
 *
 * The state machine keeps them apart on purpose. `temporary` is component state and
 * lives for the session; `saved` is changed by `save()` and by nothing else. There
 * is no code path from a picker to the profile, which is how the rule survives a
 * future edit to a screen.
 *
 * Anyone can save. This used to require an account, because the server was the
 * only place a saved location could live — which made the app's first genuinely
 * useful act, telling it where you are, the one thing a farmer could not do
 * before signing up. But a location is not *said to anyone*: it is not a post, a
 * message or a credit request, and nothing is published by writing it down. So a
 * guest's choice is kept on the phone, drives exactly the same screens, and is
 * handed to the account when they make one. Installing the app and using it is
 * enough.
 */

export type TemporaryArea = {
  label: string;
  lat: number;
  lon: number;
  /** How the point was obtained, kept so a save reports the truthful source. */
  source: PickedSource;
};

export type LocationValue = {
  /** The farmer's saved location, or null when there is none. */
  saved: SavedLocation | null;
  /** A temporary search area for this session, or null. */
  temporary: TemporaryArea | null;
  /** Where the app currently reads weather, dealers and context from. */
  activePoint: GeoPoint;
  /**
   * The origin a dealer search should pass. Present only for a temporary area:
   * when it is absent the *server* uses the signed-in farmer's saved location,
   * which keeps "temporary" and "saved" from being decided in two places.
   */
  searchOrigin: GeoPoint | undefined;
  /** What to call the active place in the UI. */
  placeLabel: string;
  isTemporary: boolean;
  hasSaved: boolean;
  /**
   * True when the saved location lives on this phone rather than in an account.
   *
   * The screen says which, because "saved to your account" shown to a farmer who
   * has no account is a false statement about where their data is — and the point
   * of letting a guest save one is that it stays theirs either way.
   */
  savedOnDevice: boolean;
  /**
   * How far the app looks for shops, in kilometres — the one number the Dealers,
   * Home and Scan screens all read.
   *
   * It lives here rather than in each screen for the same reason the point does:
   * it is a property of *where the farmer is looking from*, so three screens
   * keeping three copies is how the app ends up showing shops 25 km away on one
   * tab and "no shop within 10 km" on the next. It is saved with the location,
   * because the radius the server searches with is part of the record.
   */
  radiusKm: number;
  setRadiusKm: (next: number) => void;
  /** Always true: anyone can save. The write goes to the account when there
   * is one and to the phone otherwise. */
  canSave: boolean;
  canClearSaved: boolean;
  loading: boolean;
  saving: boolean;
  error: string | null;
  setTemporary: (area: TemporaryArea | null) => void;
  clearTemporary: () => void;
  /** Explicit save. Throws the server's own refusal when it will not accept it. */
  save: (input: {
    label?: string;
    lat?: number;
    lon?: number;
    source?: PickedSource;
    radiusKm?: number;
  }) => Promise<SavedLocation>;
  forget: () => Promise<void>;
  refresh: () => void;
};

const LocationContext = createContext<LocationValue | null>(null);

/**
 * The radius the farmer last chose, kept on the device.
 *
 * Device-scoped rather than account-scoped on purpose. A guest chooses how far to
 * look and that choice has to survive the next launch, but it is not an
 * attributable act — nothing is written in the farmer's name — so it does not get
 * to create an account requirement. When the same farmer has a *saved* location,
 * the radius stored with it wins, because that is the one the account owns.
 */
const RADIUS_KEY = 'agri-shop.radius';
const DEFAULT_RADIUS_KM = 10;

function readStoredRadius(): number {
  try {
    const raw = localStorage.getItem(RADIUS_KEY);
    const value = raw === null ? Number.NaN : Number(raw);
    // Validated against the product's own limit, so a hand-edited or stale value
    // cannot make the app ask the server for a search it will refuse.
    if (Number.isFinite(value) && value >= 1 && value <= MAX_RADIUS_KM) {
      return Math.round(value);
    }
  } catch {
    /* private mode — fall through to the default */
  }
  return DEFAULT_RADIUS_KM;
}

/**
 * The saved location when there is no account — kept on the phone.
 *
 * Same record, same fields, written somewhere that exists without a server. The
 * device copy is used by a guest and handed to the account on sign-in rather than
 * kept alongside it, so there is only ever one answer to "where is this farmer".
 */
const LOCATION_KEY = 'agri-shop.location';

function readStoredLocation(): SavedLocation | null {
  try {
    const raw = localStorage.getItem(LOCATION_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Partial<SavedLocation>;
    /* Validated rather than trusted: a half-written or older document must read as
       "no location", never as a location at coordinates that are not numbers. */
    if (typeof parsed.lat !== 'number' || typeof parsed.lon !== 'number' || !parsed.label) {
      return null;
    }

    return {
      label: parsed.label,
      lat: parsed.lat,
      lon: parsed.lon,
      source:
        parsed.source === 'device_permission' || parsed.source === 'dealer_record'
          ? parsed.source
          : 'profile_entry',
      setAt: typeof parsed.setAt === 'number' ? parsed.setAt : null,
      radiusKm: typeof parsed.radiusKm === 'number' ? parsed.radiusKm : DEFAULT_RADIUS_KM,
    };
  } catch {
    /* private mode, or a document this version cannot read */
    return null;
  }
}

function writeStoredLocation(location: SavedLocation | null): void {
  try {
    if (location === null) localStorage.removeItem(LOCATION_KEY);
    else localStorage.setItem(LOCATION_KEY, JSON.stringify(location));
  } catch {
    /* storage unavailable — the choice still applies for this session */
  }
}

export function LocationProvider({ children }: { children: ReactNode }) {
  const { account } = useSession();
  const [saved, setSaved] = useState<SavedLocation | null>(null);
  const [temporary, setTemporaryState] = useState<TemporaryArea | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [radiusKm, setRadiusKmState] = useState<number>(readStoredRadius);

  const setRadiusKm = useCallback((next: number) => {
    const clamped = Math.min(MAX_RADIUS_KM, Math.max(1, Math.round(next)));
    setRadiusKmState(clamped);
    try {
      localStorage.setItem(RADIUS_KEY, String(clamped));
    } catch {
      /* storage unavailable — the choice still applies for this session */
    }
  }, []);

  const backendLive = serviceConfig.supabase.configured;
  /*
   * Signed in means the account is a real one the server issued — not just a
   * local document. The session store's account can exist without a party id
   * (a demo/local account created without the server), and a party id is what
   * the database matches every policy against. An account without one owns
   * nothing on the server, so it is a guest for every server write, and its
   * location lives on the phone.
   */
  const signedIn = account !== null && account.partyId !== null;

  /*
   * Whether Supabase itself has a live session for this farmer, right now.
   *
   * The local account document and the Supabase token live in different stores
   * and can drift apart: the document survives a cleared or expired token, so
   * a party id alone is not proof the server will answer. A server write needs
   * the token, so the decision is made from the session itself — read locally,
   * no network — rather than from the account the phone remembers.
   */
  const hasRealSession = useCallback(async (): Promise<boolean> => {
    if (!backendLive) return false;
    try {
      await getSupabaseClient(serviceConfig.supabase);
      const user = await currentSessionUser();
      return user !== null;
    } catch {
      return false;
    }
  }, [backendLive]);

  /*
   * Which answer is read depends on whether there is an account to read it from.
   *
   * A guest reads the phone, so their area survives the next launch and the first
   * screen is about the right place before any account exists. A signed-in farmer
   * reads the account — and if it has nothing while the phone does, the phone's
   * answer is handed over once and the device copy is dropped, so the account is
   * the single source from then on. That mirrors what the other stores already do
   * with a guest's work when they sign in, and it means nobody has to choose their
   * area twice.
   *
   * Signing out therefore leaves nothing behind: the account's location goes with
   * it, and the phone's own copy was dropped as soon as the account answered.
   */
  useEffect(() => {
    if (!signedIn || !backendLive) {
      setSaved(readStoredLocation());
      return;
    }

    let cancelled = false;
    setLoading(true);

    void (async () => {
      try {
        /*
         * No live session: the server cannot answer for this farmer, so the
         * phone's copy is the truth for now. The hand-over runs when a session
         * exists; attempting it now would only raise "Sign in to save a
         * location." on every launch, and the device copy would be lost from
         * the screen even though it is still on the phone.
         */
        const live = await hasRealSession();
        if (cancelled) return;
        if (!live) {
          setSaved(readStoredLocation());
          setError(null);
          return;
        }

        const found = await readSavedLocation();
        if (cancelled) return;
        const onDevice = readStoredLocation();

        /*
         * When both hold a location, the newer one wins. A device copy saved
         * after the server's row is the farmer's latest choice; discarding it
         * for a stale server row is how a just-saved location silently reverted
         * to a village the farmer had already left. A row with no timestamp is
         * treated as older than one that has one.
         */
        const deviceNewer =
          onDevice !== null &&
          onDevice.setAt !== null &&
          (found === null || found.setAt === null || onDevice.setAt > found.setAt);

        if (deviceNewer && onDevice) {
          const migrated = await writeSavedLocation({
            label: onDevice.label,
            lat: onDevice.lat,
            lon: onDevice.lon,
            source: onDevice.source,
            radiusKm: onDevice.radiusKm,
          });
          if (cancelled) return;
          setSaved(migrated);
          setRadiusKm(migrated.radiusKm);
          writeStoredLocation(null);
          setError(null);
          return;
        }

        if (found) {
          setSaved(found);
          /*
           * The account's radius is what the server searches with, so it is
           * adopted — and mirrored onto the device, so a cold start shows the
           * right range for the moment before the account answers.
           *
           * It is adopted *here*, from the account, and not from every saved
           * location. A device's own record also carries a radius, and letting
           * that win meant the range a farmer chose in the filter was silently
           * reverted at the next launch: the sheet wrote the phone's preference,
           * the saved record still held the older number, and the older one kept
           * overwriting it. One owner per value — the account when there is one,
           * the phone otherwise.
           */
          setRadiusKm(found.radiusKm);
          /*
           * And the phone's own copy goes now, for the same reason it goes in the
           * hand-over below: the account has answered, so there is exactly one
           * answer and it is not this one. Leaving it meant the phone kept the
           * *guest's* area, which reappears the moment anyone uses this phone
           * without an account — the previous farmer's village, shown to the next
           * person to hold the phone. A cold start also read it and showed a place
           * the account had already contradicted.
           */
          writeStoredLocation(null);
          setError(null);
          return;
        }

        if (!onDevice) {
          setSaved(null);
          setError(null);
          return;
        }

        const migrated = await writeSavedLocation({
          label: onDevice.label,
          lat: onDevice.lat,
          lon: onDevice.lon,
          source: onDevice.source,
          radiusKm: onDevice.radiusKm,
        });
        if (cancelled) return;
        setSaved(migrated);
        setRadiusKm(migrated.radiusKm);
        writeStoredLocation(null);
        setError(null);
      } catch (failure) {
        if (cancelled) return;
        setError(failure instanceof Error ? failure.message : 'The saved location could not be read.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [backendLive, signedIn, account?.partyId, attempt, setRadiusKm, hasRealSession]);

  const setTemporary = useCallback((area: TemporaryArea | null) => {
    setTemporaryState(area);
    setError(null);
  }, []);

  const clearTemporary = useCallback(() => setTemporaryState(null), []);

  const save = useCallback(
    async (input: {
      label?: string;
      lat?: number;
      lon?: number;
      source?: PickedSource;
      radiusKm?: number;
    }): Promise<SavedLocation> => {
      /*
       * The point being saved defaults to the temporary area, which is what the
       * farmer was just looking at. It is never *inferred* silently from a search:
       * this function only runs because a save control was pressed.
       */
      const label = (input.label ?? temporary?.label ?? saved?.label ?? '').trim();
      const lat = input.lat ?? temporary?.lat ?? saved?.lat;
      const lon = input.lon ?? temporary?.lon ?? saved?.lon;
      const source = serverSourceOf(input.source ?? temporary?.source ?? 'map');

      if (lat === undefined || lon === undefined) {
        throw new Error('There is no location to save yet.');
      }

      const radiusKm = input.radiusKm ?? saved?.radiusKm ?? DEFAULT_RADIUS_KM;

      setSaving(true);
      try {
        /*
         * Where it is written depends on whether there is a real session to
         * write it with — not on whether the farmer is *allowed* to choose.
         * A local account document is not a session: the token may have
         * expired or never existed in this browser, and the server refuses a
         * write without one. When there is no live session the phone is the
         * honest place for the location, and it drives exactly the same
         * screens; the hand-over moves it to the account on sign-in.
         */
        let result: SavedLocation;
        const live = signedIn ? await hasRealSession() : false;
        if (live) {
          result = await writeSavedLocation({ label, lat, lon, source, radiusKm });
        } else {
          result = { label, lat, lon, source, setAt: Date.now(), radiusKm };
          writeStoredLocation(result);
        }

        setSaved(result);
        setError(null);
        return result;
      } catch (failure) {
        const message =
          failure instanceof Error ? failure.message : 'The location could not be saved.';
        setError(message);
        throw new Error(message);
      } finally {
        setSaving(false);
      }
    },
    [temporary, saved, signedIn, hasRealSession],
  );

  const forget = useCallback(async () => {
    setSaving(true);
    try {
      // Only the server's copy is cleared when there is a live session to
      // clear it with; the phone's copy is always cleared, so a guest's
      // forget never fails on a server it cannot reach.
      if (signedIn && (await hasRealSession())) await clearSavedLocation();
      writeStoredLocation(null);
      setSaved(null);
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The location could not be cleared.');
    } finally {
      setSaving(false);
    }
  }, [signedIn, hasRealSession]);

  const value = useMemo<LocationValue>(() => {
    /*
     * The saved location is the authority for where the farmer is. A temporary
     * area is a dealer search ("show me shops near Kot Ladha"), and the PRD says
     * it must never silently replace the saved location — so it only fills in
     * when there is no saved location yet (onboarding, before the first save).
     * Preferring it above the saved location is how a stale search hijacked the
     * weather, the dealers and the mandi rates for the farmer's own village.
     */
    const activePoint: GeoPoint = saved
      ? { lat: saved.lat, lon: saved.lon }
      : temporary
        ? { lat: temporary.lat, lon: temporary.lon }
        : PROFILE_POINT;

    const placeLabel = saved?.label ?? temporary?.label ?? '';

    return {
      saved,
      temporary,
      radiusKm,
      setRadiusKm,
      activePoint,
      // Only a temporary area is passed as an origin. Absent means "ask the
      // server for the saved location", so the two never compete.
      searchOrigin: temporary ? { lat: temporary.lat, lon: temporary.lon } : undefined,
      placeLabel,
      isTemporary: saved === null && temporary !== null,
      hasSaved: saved !== null,
      savedOnDevice: saved !== null && !signedIn,
      canSave: true,
      canClearSaved: saved !== null,
      loading,
      saving,
      error,
      setTemporary,
      clearTemporary,
      save,
      forget,
      refresh: () => setAttempt((current) => current + 1),
    };
  }, [
    saved,
    temporary,
    radiusKm,
    setRadiusKm,
    loading,
    saving,
    error,
    signedIn,
    setTemporary,
    clearTemporary,
    save,
    forget,
  ]);

  return <LocationContext.Provider value={value}>{children}</LocationContext.Provider>;
}

export function useLocation(): LocationValue {
  const context = useContext(LocationContext);
  if (!context) {
    throw new Error('useLocation must be used inside a LocationProvider');
  }
  return context;
}
