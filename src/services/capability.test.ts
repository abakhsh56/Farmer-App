import { describe, expect, it } from 'vitest';
import {
  clearCapabilityChoice,
  hydrateCapability,
  inferLevel,
  recordCapabilityEvent,
  seedCapabilityProfile,
  serialiseCapability,
  setCapabilityLevel,
} from './capability';

describe('capability inference', () => {
  it('seeds at standard, with no evidence and no farmer choice', () => {
    const profile = seedCapabilityProfile();
    expect(profile.level).toBe('standard');
    expect(profile.score).toBe(0);
    expect(profile.events).toBe(0);
    expect(profile.source).toBe('inferred');
  });

  it('counts evidence without moving the level below the minimum', () => {
    /* Two voice inputs are a score of 6 — enough to be simple, but only two
       behaviours, so the level does not move yet. */
    let profile = seedCapabilityProfile();
    profile = recordCapabilityEvent(profile, 'voiceInput');
    profile = recordCapabilityEvent(profile, 'voiceInput');
    expect(profile.score).toBe(6);
    expect(profile.events).toBe(2);
    expect(profile.level).toBe('standard');
  });

  it('moves to simple once enough voice-first evidence exists', () => {
    let profile = seedCapabilityProfile();
    profile = recordCapabilityEvent(profile, 'voiceInput');
    profile = recordCapabilityEvent(profile, 'voiceInput');
    profile = recordCapabilityEvent(profile, 'readAloud');
    expect(profile.level).toBe('simple');
  });

  it('moves to detailed when the farmer reads long text and writes long questions', () => {
    let profile = seedCapabilityProfile();
    profile = recordCapabilityEvent(profile, 'messageComplex');
    profile = recordCapabilityEvent(profile, 'messageComplex');
    profile = recordCapabilityEvent(profile, 'longTextOpened');
    expect(profile.level).toBe('detailed');
  });

  it('holds simple through hysteresis — a small pull back does not flip it', () => {
    /* Score 9 (simple), then two complex messages (-6) leaves 3, still
       above the stay-simple line of 2. */
    let profile = seedCapabilityProfile();
    profile = recordCapabilityEvent(profile, 'voiceInput');
    profile = recordCapabilityEvent(profile, 'voiceInput');
    profile = recordCapabilityEvent(profile, 'voiceInput');
    expect(profile.level).toBe('simple');
    profile = recordCapabilityEvent(profile, 'messageComplex');
    profile = recordCapabilityEvent(profile, 'messageComplex');
    expect(profile.score).toBe(3);
    expect(profile.level).toBe('simple');
  });

  it('leaves simple only once the score falls back below the stay line', () => {
    let profile = seedCapabilityProfile();
    profile = recordCapabilityEvent(profile, 'voiceInput');
    profile = recordCapabilityEvent(profile, 'voiceInput');
    profile = recordCapabilityEvent(profile, 'voiceInput');
    profile = recordCapabilityEvent(profile, 'messageComplex');
    profile = recordCapabilityEvent(profile, 'messageComplex');
    profile = recordCapabilityEvent(profile, 'messageComplex');
    expect(profile.score).toBe(0);
    expect(profile.level).toBe('standard');
  });

  it('never overrides a level the farmer set himself', () => {
    let profile = seedCapabilityProfile();
    profile = setCapabilityLevel(profile, 'detailed');
    profile = recordCapabilityEvent(profile, 'voiceInput');
    profile = recordCapabilityEvent(profile, 'voiceInput');
    profile = recordCapabilityEvent(profile, 'voiceInput');
    profile = recordCapabilityEvent(profile, 'voiceInput');
    expect(profile.level).toBe('detailed');
    expect(profile.source).toBe('farmer');
  });

  it('re-infers from neutral standard once the farmer takes his choice back', () => {
    let profile = seedCapabilityProfile();
    profile = setCapabilityLevel(profile, 'detailed');
    profile = recordCapabilityEvent(profile, 'voiceInput');
    profile = recordCapabilityEvent(profile, 'voiceInput');
    profile = recordCapabilityEvent(profile, 'voiceInput');
    profile = clearCapabilityChoice(profile);
    expect(profile.source).toBe('inferred');
    expect(profile.level).toBe('simple');
  });

  it('inferLevel is pure and follows the hysteresis bands', () => {
    expect(inferLevel(6, 'standard')).toBe('simple');
    expect(inferLevel(5, 'standard')).toBe('standard');
    expect(inferLevel(-6, 'standard')).toBe('detailed');
    expect(inferLevel(-5, 'standard')).toBe('standard');
    expect(inferLevel(2, 'simple')).toBe('simple');
    expect(inferLevel(1, 'simple')).toBe('standard');
    expect(inferLevel(-2, 'detailed')).toBe('detailed');
    expect(inferLevel(-1, 'detailed')).toBe('standard');
  });
});

describe('capability persistence', () => {
  it('round-trips through serialise and hydrate', () => {
    let profile = seedCapabilityProfile();
    profile = recordCapabilityEvent(profile, 'voiceInput');
    profile = recordCapabilityEvent(profile, 'readAloud');
    const restored = hydrateCapability(serialiseCapability(profile));
    expect(restored).toEqual(profile);
  });

  it('repairs a document missing the events count', () => {
    const restored = hydrateCapability(
      JSON.stringify({ level: 'simple', score: 7, source: 'inferred' }),
    );
    expect(restored).toEqual({ level: 'simple', score: 7, events: 0, source: 'inferred' });
  });

  it('rejects garbage — a level that is not one of the three', () => {
    expect(hydrateCapability(JSON.stringify({ level: 'expert', score: 0 }))).toBeNull();
    expect(hydrateCapability(JSON.stringify({ level: 'simple', score: 'lots' }))).toEqual({
      level: 'simple',
      score: 0,
      events: 0,
      source: 'inferred',
    });
  });

  it('rejects a null or unparseable document', () => {
    expect(hydrateCapability(null)).toBeNull();
    expect(hydrateCapability('not json')).toBeNull();
  });

  it('a plain object is tolerated as well as the JSON string', () => {
    const restored = hydrateCapability({ level: 'detailed', score: -8, events: 4, source: 'farmer' });
    expect(restored).toEqual({ level: 'detailed', score: -8, events: 4, source: 'farmer' });
  });
});
