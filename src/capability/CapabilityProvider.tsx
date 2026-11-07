/**
 * How much detail this farmer wants — learned, not asked.
 *
 * The profile lives in a persistent document, collection `'capability'`, and
 * follows the account like every other store: a farmer's preference is his
 * own, and it does not leak onto the next account on a shared phone. The
 * level is inferred from behaviour signals (voice use, read-aloud, long
 * text opened or dismissed, flows finished or abandoned, message length,
 * language) and the farmer can change it himself from the profile screen —
 * his own choice is never overridden by a later signal.
 *
 * `useCapability` throws outside the provider (a screen that reads the
 * level must be inside the app). `useCapabilityRecorder` is the safe
 * no-op outside it, for providers that record evidence and sit above or
 * beside this one in the tree.
 */

import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import { ownerFor, usePersistentDocument } from '@/services/persistence';
import { useSession } from '@/session/SessionProvider';
import {
  clearCapabilityChoice,
  hydrateCapability,
  recordCapabilityEvent,
  seedCapabilityProfile,
  serialiseCapability,
  setCapabilityLevel,
  type CapabilityEventKind,
  type CapabilityLevel,
  type CapabilityProfile,
} from '@/services/capability';

type CapabilityValue = {
  profile: CapabilityProfile;
  level: CapabilityLevel;
  setLevel: (level: CapabilityLevel) => void;
  clearChoice: () => void;
  recordEvent: (kind: CapabilityEventKind) => void;
};

const CapabilityContext = createContext<CapabilityValue | null>(null);

export function CapabilityProvider({ children }: { children: ReactNode }) {
  const { account } = useSession();
  const ownerId = useMemo(() => ownerFor(account?.id ?? null), [account?.id]);
  const { data, setData } = usePersistentDocument<CapabilityProfile>({
    collection: 'capability',
    ownerId,
    seed: () => seedCapabilityProfile(),
    hydrate: (raw) => hydrateCapability(raw),
    serialise: serialiseCapability,
  });

  const recordEvent = useCallback(
    (kind: CapabilityEventKind) => setData((current) => recordCapabilityEvent(current, kind)),
    [setData],
  );
  const setLevel = useCallback(
    (level: CapabilityLevel) => setData((current) => setCapabilityLevel(current, level)),
    [setData],
  );
  const clearChoice = useCallback(
    () => setData((current) => clearCapabilityChoice(current)),
    [setData],
  );

  const value = useMemo<CapabilityValue>(
    () => ({ profile: data, level: data.level, setLevel, clearChoice, recordEvent }),
    [data, setLevel, clearChoice, recordEvent],
  );

  return <CapabilityContext.Provider value={value}>{children}</CapabilityContext.Provider>;
}

export function useCapability(): CapabilityValue {
  const value = useContext(CapabilityContext);
  if (value === null) throw new Error('useCapability must be used inside CapabilityProvider');
  return value;
}

/** For providers that record evidence and may render outside the provider. */
export function useCapabilityRecorder(): Pick<CapabilityValue, 'recordEvent'> {
  const value = useContext(CapabilityContext);
  return useMemo(
    () => ({ recordEvent: value?.recordEvent ?? (() => {}) }),
    [value],
  );
}
