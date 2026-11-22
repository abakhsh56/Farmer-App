import { describe, expect, it } from 'vitest';
import {
  CHAT_COST,
  DAILY_CREDIT_ALLOWANCE,
  SCAN_COST,
  canAfford,
  createState,
  dayKey,
  hydrate,
  normalise,
  remaining,
  resetsAt,
  serialise,
  spend,
} from './store';

/**
 * The allowance rule, as tests.
 *
 * These are the assertions that make "100 credits a day, one pot" a fact about
 * the build rather than a sentence in a brief: the same ledger is spent by chat
 * and by scans, a scan the farmer cannot afford is refused without charging
 * part of it, and the counter returns at the farmer's own midnight.
 */

const NOON = new Date(2026, 10, 21, 12, 0, 0).getTime();
const NEXT_NOON = new Date(2026, 10, 22, 12, 0, 0).getTime();

describe('daily AI credits', () => {
  it('starts a new farmer at the full allowance', () => {
    const state = createState(NOON);
    expect(remaining(state, NOON)).toBe(DAILY_CREDIT_ALLOWANCE);
    expect(state.used).toBe(0);
  });

  it('charges chat and scans from one pot', () => {
    let state = createState(NOON);
    const chat = spend(state, 'chat', NOON);
    expect(chat.ok).toBe(true);
    expect(chat.cost).toBe(CHAT_COST);

    state = chat.data;
    const scan = spend(state, 'scan', NOON + 1);
    expect(scan.ok).toBe(true);
    expect(scan.cost).toBe(SCAN_COST);
    expect(scan.remaining).toBe(DAILY_CREDIT_ALLOWANCE - CHAT_COST - SCAN_COST);
  });

  it('refuses a scan it cannot fully pay for, and charges nothing', () => {
    let state = createState(NOON);
    /* Spend down to 3 credits: affordable for a question, not for a scan. */
    for (let i = 0; i < DAILY_CREDIT_ALLOWANCE - 3; i += 1) {
      state = spend(state, 'chat', NOON + i).data;
    }
    expect(remaining(state, NOON)).toBe(3);

    const refused = spend(state, 'scan', NOON + 1000);
    expect(refused.ok).toBe(false);
    expect(refused.error).toBe('agent.credits.tooFew');
    expect(remaining(refused.data, NOON)).toBe(3);
    expect(refused.data.used).toBe(state.used);
  });

  it('names the exhausted case differently from the too-expensive one', () => {
    let state = createState(NOON);
    for (let i = 0; i < DAILY_CREDIT_ALLOWANCE; i += 1) {
      state = spend(state, 'chat', NOON + i).data;
    }
    expect(remaining(state, NOON)).toBe(0);
    expect(canAfford(state, 'chat', NOON)).toBe(false);
    expect(spend(state, 'chat', NOON + 50).error).toBe('agent.credits.exhausted');
  });

  it('never exceeds the allowance, however many times it is charged', () => {
    let state = createState(NOON);
    let charged = 0;
    for (let i = 0; i < 500; i += 1) {
      const result = spend(state, 'chat', NOON + i);
      if (!result.ok) break;
      charged += 1;
      state = result.data;
    }
    expect(charged).toBe(DAILY_CREDIT_ALLOWANCE);
    expect(state.used).toBe(DAILY_CREDIT_ALLOWANCE);
  });

  it('returns the full allowance on the farmer’s next local day', () => {
    let state = createState(NOON);
    for (let i = 0; i < 40; i += 1) state = spend(state, 'chat', NOON + i).data;
    expect(remaining(state, NOON)).toBe(60);
    expect(remaining(state, NEXT_NOON)).toBe(DAILY_CREDIT_ALLOWANCE);
  });

  it('resets at local midnight, not at midnight UTC', () => {
    const reset = resetsAt(NOON);
    const date = new Date(reset);
    expect(date.getHours()).toBe(0);
    expect(date.getMinutes()).toBe(0);
    expect(dayKey(NOON)).toBe('2026-11-21');
    expect(dayKey(reset)).toBe('2026-11-22');
  });

  it('derives the total from the log, so a tampered document cannot refund', () => {
    const state = createState(NOON);
    const charged = spend(state, 'scan', NOON).data;
    const lying = { ...charged, used: 0 };
    expect(normalise(lying, NOON).used).toBe(SCAN_COST);
    expect(remaining(lying, NOON)).toBe(DAILY_CREDIT_ALLOWANCE - SCAN_COST);
  });

  it('round-trips through storage and refuses a malformed document', () => {
    const state = spend(createState(NOON), 'chat', NOON).data;
    expect(hydrate(serialise(state), NOON)).toEqual(state);
    expect(hydrate('not json', NOON)).toBeNull();
    expect(hydrate(JSON.stringify({ day: '2026-11-21', entries: [{ id: 'x' }] }), NOON)).toBeNull();
  });
});
