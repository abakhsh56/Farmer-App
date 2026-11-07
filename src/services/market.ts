/**
 * Mandi rates, as the farmer reads them — per 40 kg maund, honestly dated.
 *
 * AMIS reports prices per 100 kg; the farmer buys and sells by the 40 kg
 * maund, so a per-100-kg price is divided by 2.5 and a per-40-kg price is
 * shown as it is. A unit the code does not recognise is never guessed — the
 * price is left missing rather than converted wrong. A missing modal price
 * is missing, never zero: zero is a price a farmer can be offered.
 *
 * The widget shows today's rates only. A rate observed on another day is
 * not shown as today's — the tile says "No rate today" instead. That is the
 * rule that keeps a stale number from being read as a live one.
 */

import type { MarketRate } from './types';

/** The commodities the widget carries, in the order the mockup sets. */
export const MANDI_WIDGET_COMMODITIES = ['cotton', 'wheat', 'maize'] as const;

/** 100 kg is 2.5 maunds of 40 kg. */
export const KG_100_TO_MAUND = 2.5;

/**
 * The modal price per 40 kg maund, or null when it cannot be known: no
 * modal price reported, or a unit the code does not recognise.
 */
export function maundPrice(rate: MarketRate): number | null {
  if (rate.modalPrice === null) return null;
  const unit = rate.unit.trim().toLowerCase().replace(/\s+/g, '');
  if (unit === '100kg' || unit === '100') return rate.modalPrice / KG_100_TO_MAUND;
  if (unit === '40kg' || unit === '40') return rate.modalPrice;
  return null;
}

/** True when the rate was observed on the farmer's own calendar day. */
export function isTodayRate(rate: MarketRate, nowMs: number): boolean {
  const observed = new Date(rate.observedOn).getTime();
  if (!Number.isFinite(observed)) return false;
  const a = new Date(observed);
  const b = new Date(nowMs);
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export type MandiSourceKind = 'govt' | 'community' | 'other';

/**
 * Which of the two sources a rate came from. AMIS is the government source;
 * a community-promoted rate is the local one. Anything else is shown as
 * reported, without a tag.
 */
export function mandiSourceKind(sourceLabel: string): MandiSourceKind {
  const lower = sourceLabel.toLowerCase();
  if (lower.includes('amis')) return 'govt';
  if (lower.includes('community') || lower.includes('local')) return 'community';
  return 'other';
}
