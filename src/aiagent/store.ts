/**
 * The daily AI allowance, as data.
 *
 * The product decision is one sentence — every farmer gets 100 credits a day and
 * every AI-powered action spends from that one pot — and this file is that
 * sentence made checkable. Four rules live here rather than in a screen:
 *
 *  · There is *one* pot. A question, a search answered by the assistant, a
 *    recommendation and a photo sent for diagnosis all spend from the same 100.
 *    Splitting them into separate counters is how an app ends up with AI
 *    features that each insist the farmer still has credit.
 *  · The day is the farmer's own day, not UTC's. A farmer in Punjab asking at
 *    11pm should not be told their allowance reset five hours early, so the day
 *    key is built from local date parts.
 *  · Spending is all-or-nothing. A 5-credit scan the farmer cannot afford is
 *    refused outright: taking 3 of the 5 and then failing is the version of this
 *    feature that loses their trust.
 *  · A refusal is not an error. It is the limit doing its job, and the screen is
 *    told which limit so it can say when the allowance comes back.
 *
 * The used figure is derived from the entries when the document is read, so a
 * tampered or half-written document cannot report credit that was never spent —
 * the same reconciliation rule the credit ledger follows.
 */

import type { MessageKey } from '@/i18n/catalog';

/** The approved allowance. One number, quoted by the screen and the store. */
export const DAILY_CREDIT_ALLOWANCE = 100;

/** What one conversational turn costs, whatever it was asked. */
export const CHAT_COST = 1;

/** What one image sent for diagnosis costs. Vision is the expensive call. */
export const SCAN_COST = 5;

export type AiUsageKind = 'chat' | 'scan';

export type AiUsageEntry = {
  id: string;
  kind: AiUsageKind;
  cost: number;
  at: number;
};

export type AiCreditData = {
  /** Local calendar day the `used` figure belongs to: `2026-11-21`. */
  day: string;
  used: number;
  /** A bounded recent log, so the farmer can see where the credits went. */
  entries: AiUsageEntry[];
};

export type SpendResult = {
  data: AiCreditData;
  ok: boolean;
  /** What was charged, or would have been. */
  cost: number;
  remaining: number;
  /** Set only when the action was refused. */
  error?: MessageKey;
};

/** How much one kind of AI action costs. The single place costs are decided. */
export function costOf(kind: AiUsageKind): number {
  return kind === 'scan' ? SCAN_COST : CHAT_COST;
}

/**
 * The farmer's own calendar day.
 *
 * Built from local parts rather than `toISOString`, which would roll the
 * allowance over at 5am in Punjab and hand a farmer a fresh 100 credits in the
 * middle of their morning.
 */
export function dayKey(at: number): string {
  const date = new Date(at);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** When the allowance next resets: the coming local midnight. */
export function resetsAt(at: number): number {
  const date = new Date(at);
  const midnight = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, 0, 0, 0, 0);
  return midnight.getTime();
}

export function createState(now: number = Date.now()): AiCreditData {
  return { day: dayKey(now), used: 0, entries: [] };
}

/** The used figure, derived from the log rather than trusted from the document. */
function usedFrom(entries: readonly AiUsageEntry[]): number {
  return entries.reduce((sum, entry) => sum + entry.cost, 0);
}

/**
 * Bring a document forward to `now`.
 *
 * A stored document from a previous day is not an error and not empty history to
 * be preserved: yesterday's spend has no bearing on today's allowance, so the
 * counter starts again and the log starts clean. Keeping yesterday's entries
 * would make the new day's arithmetic wrong the moment it was recomputed.
 */
export function normalise(data: AiCreditData, now: number): AiCreditData {
  const day = dayKey(now);
  const used = usedFrom(data.entries);

  if (data.day !== day) {
    return { day, used: 0, entries: [] };
  }
  if (used === data.used) return data;
  /* The stored total disagreed with its own log. The log wins, because it is the
     record of what was actually requested. */
  return { ...data, used };
}

export function remaining(data: AiCreditData, now: number): number {
  const fresh = normalise(data, now);
  return Math.max(0, DAILY_CREDIT_ALLOWANCE - fresh.used);
}

export function canAfford(data: AiCreditData, kind: AiUsageKind, now: number): boolean {
  return remaining(data, now) >= costOf(kind);
}

/** Why the farmer cannot act — for the screen's inline explanation. */
export function refusedReason(data: AiCreditData, kind: AiUsageKind, now: number): MessageKey | null {
  if (canAfford(data, kind, now)) return null;
  const left = remaining(data, now);
  /* Two different sentences, because they ask for different things: a farmer with
     3 credits left is told this action costs 5; a farmer with none is told the
     allowance returns tomorrow. */
  return left > 0 ? 'agent.credits.tooFew' : 'agent.credits.exhausted';
}

/**
 * Charge one action.
 *
 * All-or-nothing. The entry is written before the request is made, so a call that
 * fails mid-flight still costs what it cost — the allowance is about usage of the
 * service, not about whether the answer was good.
 */
export function spend(
  data: AiCreditData,
  kind: AiUsageKind,
  now: number,
  id: string = `${kind}-${now}`,
): SpendResult {
  const fresh = normalise(data, now);
  const cost = costOf(kind);
  const left = Math.max(0, DAILY_CREDIT_ALLOWANCE - fresh.used);

  if (left < cost) {
    return {
      data: fresh,
      ok: false,
      cost,
      remaining: left,
      error: left > 0 ? 'agent.credits.tooFew' : 'agent.credits.exhausted',
    };
  }

  const entries = [...fresh.entries, { id, kind, cost, at: now }];
  /* The log is not trimmed: `used` is derived from it, so dropping an old entry
     would hand credits back. It cannot grow without limit either — the allowance
     caps a day at 100 one-credit turns, and the document starts clean at local
     midnight. The bound comes from the business rule, not a slice. */

  return {
    data: { day: fresh.day, used: fresh.used + cost, entries },
    ok: true,
    cost,
    remaining: left - cost,
  };
}

export function serialise(data: AiCreditData): string {
  return JSON.stringify(data);
}

/**
 * Read the phone's or the backend's copy back.
 *
 * Strict, like the other stores: a document whose entries do not parse is thrown
 * away and the day starts from zero. A row that quietly drops a broken entry would
 * be a ledger that under-counts its own spend.
 */
export function hydrate(raw: string | null, now: number): AiCreditData | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<AiCreditData>;
    if (typeof parsed.day !== 'string') return null;
    if (!Array.isArray(parsed.entries)) return null;

    const entries: AiUsageEntry[] = [];
    for (const value of parsed.entries) {
      if (!value || typeof value !== 'object') return null;
      const entry = value as Record<string, unknown>;
      if (typeof entry.id !== 'string') return null;
      if (entry.kind !== 'chat' && entry.kind !== 'scan') return null;
      if (typeof entry.cost !== 'number' || entry.cost <= 0) return null;
      if (typeof entry.at !== 'number') return null;
      entries.push({ id: entry.id, kind: entry.kind, cost: entry.cost, at: entry.at });
    }

    const used = typeof parsed.used === 'number' ? parsed.used : usedFrom(entries);
    return normalise({ day: parsed.day, used, entries }, now);
  } catch {
    return null;
  }
}
