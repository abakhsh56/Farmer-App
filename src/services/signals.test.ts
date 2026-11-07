import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isRecordablePartyId,
  normaliseSubject,
  recordSignal,
  resetSignalDedupeForTests,
  toCropCode,
} from './signals';

/*
 * The client is counted, not used. `recordSignal` asks `getSupabaseClient` for
 * the one client and inserts one row; what this file proves is that the right
 * row is built, that a guest never reaches the client at all, and that a double
 * tap is one signal. The real Supabase SDK is never loaded here.
 */
const { insert, from, getSupabaseClient } = vi.hoisted(() => {
  const insert = vi.fn(() => Promise.resolve({ error: null }));
  const from = vi.fn(() => ({ insert }));
  const getSupabaseClient = vi.fn(() => Promise.resolve({ from }));
  return { insert, from, getSupabaseClient };
});

vi.mock('./supabaseClient', () => ({ getSupabaseClient }));

const PARTY_ID = 'b0da419c-7763-44e1-886a-5e711ce9c113';

describe('toCropCode', () => {
  it('accepts a bare catalogue code', () => {
    expect(toCropCode('cotton')).toBe('cotton');
    expect(toCropCode('wheat')).toBe('wheat');
  });

  it('strips the message-key prefix the screens use', () => {
    expect(toCropCode('crop.cotton')).toBe('cotton');
    expect(toCropCode('crop.maize')).toBe('maize');
  });

  it('drops a code the catalogue does not know rather than failing the foreign key', () => {
    expect(toCropCode('banana')).toBeNull();
    expect(toCropCode('crop.banana')).toBeNull();
  });

  it('answers null for nothing', () => {
    expect(toCropCode(null)).toBeNull();
    expect(toCropCode(undefined)).toBeNull();
    expect(toCropCode('')).toBeNull();
  });
});

describe('isRecordablePartyId', () => {
  it('accepts a UUID party id', () => {
    expect(isRecordablePartyId(PARTY_ID)).toBe(true);
  });

  it('rejects the contact-based id a guest account carries', () => {
    expect(isRecordablePartyId('phone:03001234567')).toBe(false);
  });

  it('rejects nothing', () => {
    expect(isRecordablePartyId(null)).toBe(false);
    expect(isRecordablePartyId(undefined)).toBe(false);
    expect(isRecordablePartyId('')).toBe(false);
  });
});

describe('normaliseSubject', () => {
  it('trims the topic', () => {
    expect(normaliseSubject('  urea  ')).toBe('urea');
  });

  it('caps a subject at a topic label, not a transcript', () => {
    expect(normaliseSubject('x'.repeat(200))).toHaveLength(120);
  });

  it('answers null for nothing', () => {
    expect(normaliseSubject(null)).toBeNull();
    expect(normaliseSubject('   ')).toBeNull();
  });
});

describe('recordSignal', () => {
  beforeEach(() => {
    insert.mockClear();
    from.mockClear();
    getSupabaseClient.mockClear();
    resetSignalDedupeForTests();
  });

  it('inserts one coarse row for a signed-in farmer', async () => {
    recordSignal(PARTY_ID, {
      signalType: 'search',
      source: 'search',
      subject: 'urea',
      strength: 'moderate',
    });

    await vi.waitFor(() => expect(insert).toHaveBeenCalledTimes(1));
    expect(from).toHaveBeenCalledWith('behaviour_signals');
    expect(insert).toHaveBeenCalledWith({
      farmer_id: PARTY_ID,
      signal_type: 'search',
      crop_code: null,
      subject: 'urea',
      strength: 'moderate',
      source: 'search',
      detail: {},
    });
  });

  it('normalises the crop code before it reaches the foreign key', async () => {
    recordSignal(PARTY_ID, {
      signalType: 'scan',
      source: 'scan',
      subject: 'scan.symptom.holes',
      cropCode: 'crop.cotton',
      strength: 'strong',
    });

    await vi.waitFor(() => expect(insert).toHaveBeenCalledTimes(1));
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ crop_code: 'cotton', signal_type: 'scan', source: 'scan' }),
    );
  });

  it('never reaches the client for a guest', async () => {
    recordSignal(null, { signalType: 'search', source: 'search', subject: 'urea' });
    recordSignal('phone:03001234567', { signalType: 'search', source: 'search', subject: 'urea' });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(getSupabaseClient).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it('records an identical signal once per window, not once per tap', async () => {
    recordSignal(PARTY_ID, { signalType: 'viewed', source: 'ui_interaction', subject: 'insight.x' });
    recordSignal(PARTY_ID, { signalType: 'viewed', source: 'ui_interaction', subject: 'insight.x' });

    await vi.waitFor(() => expect(insert).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(insert).toHaveBeenCalledTimes(1);
  });
});
