import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { MessageKey } from '@/i18n/catalog';
import { ownerFor, usePersistentDocument } from '@/services/persistence';
import { useSession } from '@/session/SessionProvider';
import {
  DAILY_CREDIT_ALLOWANCE,
  costOf as costOfKind,
  createState,
  hydrate,
  normalise,
  refusedReason as reasonFor,
  remaining as remainingIn,
  resetsAt as resetsAtFrom,
  serialise,
  spend as spendIn,
  type AiCreditData,
  type AiUsageEntry,
  type AiUsageKind,
} from './store';

/**
 * The farmer's daily AI allowance, mounted above every screen that can spend it.
 *
 * It sits here, not inside the assistant, for the reason the credit ledger sits
 * above the dealer screens: a scan started from the Scan tab and a question asked
 * in the assistant are spending the *same* 100, so they must read the same
 * document. A counter owned by one screen would let the other spend it twice.
 *
 * The document belongs to the farmer — the guest's copy on the device, the
 * account's copy once there is one — for the same reason: the allowance is per
 * farmer per day, and a shared phone must not let the next person inherit the
 * previous one's remaining credits.
 *
 * `now` is a state value refreshed on a timer rather than read inline. The day
 * key changes at local midnight; without a tick, a farmer who keeps the app open
 * past midnight would still be told their allowance returns "tomorrow" while the
 * app quietly refused their first question of the new day.
 */

export type AiCreditsValue = {
  status: 'loading' | 'ready' | 'error';
  /** Credits spent today. */
  used: number;
  /** Credits left today, never negative. */
  remaining: number;
  allowance: number;
  /** When the allowance returns, as a timestamp. */
  resetsAt: number;
  /** The recent spend, newest last. */
  entries: AiUsageEntry[];
  costOf: (kind: AiUsageKind) => number;
  /** Why this action is refused, or null when it is affordable. */
  refusedReason: (kind: AiUsageKind) => MessageKey | null;
  /** Charge one action. False means the limit refused it and nothing was spent. */
  spend: (kind: AiUsageKind) => boolean;
  reload: () => void;
};

const AiCreditsContext = createContext<AiCreditsValue | null>(null);

export function AiCreditsProvider({ children }: { children: ReactNode }) {
  const { account } = useSession();
  const ownerId = useMemo(() => ownerFor(account?.id ?? null), [account?.id]);

  const document = usePersistentDocument<AiCreditData>({
    collection: 'ai',
    ownerId,
    seed: createState,
    hydrate,
    serialise,
  });
  const { data: state, setData } = document;

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    /* A minute is enough: the only thing this clock decides is which day it is,
       and a farmer is not charged by the second. */
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const today = useMemo(() => normalise(state, now), [state, now]);

  const value = useMemo<AiCreditsValue>(
    () => ({
      status:
        document.status === 'loading'
          ? 'loading'
          : document.status === 'error'
            ? 'error'
            : 'ready',
      used: today.used,
      remaining: remainingIn(today, now),
      allowance: DAILY_CREDIT_ALLOWANCE,
      resetsAt: resetsAtFrom(now),
      entries: today.entries,
      costOf: (kind) => costOfKind(kind),
      refusedReason: (kind) => reasonFor(today, kind, now),
      spend: (kind) => {
        const result = spendIn(today, kind, Date.now());
        if (result.ok) setData(result.data);
        return result.ok;
      },
      reload: document.reload,
    }),
    [today, now, document.status, document.reload, setData],
  );

  return <AiCreditsContext.Provider value={value}>{children}</AiCreditsContext.Provider>;
}

export function useAiCredits() {
  const context = useContext(AiCreditsContext);
  if (!context) {
    throw new Error('useAiCredits must be used inside an AiCreditsProvider');
  }
  return context;
}
