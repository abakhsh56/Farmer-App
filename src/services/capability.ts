/**
 * How much detail a farmer wants, learned from how he uses the app — never
 * by asking him, and never by testing him.
 *
 * The farmer is often low-literacy, and two farmers at the same place must
 * see different words for the same advice: one gets a short plain sentence,
 * the other gets the numbers and the reason. The level that picks the words
 * is learned from behaviour signals only:
 *
 * · voice input instead of typing — he prefers to speak, so he prefers to
 *   hear and to read short.
 * · the read-aloud / mic button — he listens rather than reads.
 * · opens vs quickly dismisses long text — a farmer who closes long text
 *   wants it shorter, one who opens it wants more.
 * · completes multi-step flows vs abandons them — finishing means the
 *   wording carried him; abandoning means it did not.
 * · the complexity of his own messages — short plain questions vs long
 *   detailed ones. Only the word count is ever read, never the text.
 * · language preference — Saraiki voice leans simpler; Urdu is neutral.
 *
 * The level lives in the farmer's profile (`simple` / `standard` /
 * `detailed`), learned by the FIE/personalization system from these
 * signals, and the farmer can change it himself — his own choice is never
 * overridden by a later signal. The score is a running total of the
 * evidence weights (positive = simpler); the level moves only once enough
 * evidence exists, and hysteresis keeps it from flickering between two
 * nearby readings.
 */

export type CapabilityLevel = 'simple' | 'standard' | 'detailed';

export type CapabilityEventKind =
  | 'voiceInput'
  | 'readAloud'
  | 'longTextOpened'
  | 'longTextDismissed'
  | 'flowCompleted'
  | 'flowAbandoned'
  | 'messageSimple'
  | 'messageComplex'
  | 'languageSaraiki'
  | 'languageUrdu';

/**
 * Positive means "simpler". A farmer who dictates, listens and closes long
 * text scores up; one who reads long text, finishes flows and writes long
 * questions scores down.
 */
export const CAPABILITY_WEIGHTS: Readonly<Record<CapabilityEventKind, number>> = {
  voiceInput: 3,
  readAloud: 2,
  longTextDismissed: 3,
  longTextOpened: -2,
  flowCompleted: -1,
  flowAbandoned: 2,
  messageSimple: 2,
  messageComplex: -3,
  languageSaraiki: 1,
  languageUrdu: 0,
};

/** A body longer than this is "long text" for the open/dismiss signal. */
export const LONG_BODY_CHARS = 120;

/** Fewer behaviours than this, and the level does not move. */
export const MIN_EVIDENCE = 3;

/** From standard: this far up moves to simple, this far down to detailed. */
export const MOVE_TO_SIMPLE = 6;
export const MOVE_TO_DETAILED = -6;

/** Once at an extreme, the score must fall back this far before leaving it. */
export const STAY_SIMPLE = 2;
export const STAY_DETAILED = -2;

export type CapabilityProfile = {
  level: CapabilityLevel;
  /** Running total of the evidence weights. */
  score: number;
  /** How many behaviour events have been counted. */
  events: number;
  /** 'farmer' means he set it himself — inference never overrides it. */
  source: 'inferred' | 'farmer';
};

export function seedCapabilityProfile(): CapabilityProfile {
  return { level: 'standard', score: 0, events: 0, source: 'inferred' };
}

/** The level a score implies, from where the farmer already is. */
export function inferLevel(score: number, current: CapabilityLevel): CapabilityLevel {
  if (current === 'simple') {
    return score >= STAY_SIMPLE ? 'simple' : 'standard';
  }
  if (current === 'detailed') {
    return score <= STAY_DETAILED ? 'detailed' : 'standard';
  }
  if (score >= MOVE_TO_SIMPLE) return 'simple';
  if (score <= MOVE_TO_DETAILED) return 'detailed';
  return 'standard';
}

/**
 * One behaviour, folded into the profile.
 *
 * A farmer-set level is never overridden: the event is still counted, so
 * clearing his choice later re-infers from the full evidence, but the level
 * itself stays where he put it.
 */
export function recordCapabilityEvent(
  profile: CapabilityProfile,
  kind: CapabilityEventKind,
): CapabilityProfile {
  const next: CapabilityProfile = {
    ...profile,
    score: profile.score + CAPABILITY_WEIGHTS[kind],
    events: profile.events + 1,
  };
  if (profile.source === 'farmer') return next;
  if (next.events < MIN_EVIDENCE) return next;
  return { ...next, level: inferLevel(next.score, profile.level) };
}

/** The farmer's own choice. Never overridden by a later signal. */
export function setCapabilityLevel(
  profile: CapabilityProfile,
  level: CapabilityLevel,
): CapabilityProfile {
  return { ...profile, level, source: 'farmer' };
}

/**
 * The farmer takes his choice back: the level is re-inferred from the
 * accumulated evidence, starting from a neutral 'standard'.
 */
export function clearCapabilityChoice(profile: CapabilityProfile): CapabilityProfile {
  return {
    ...profile,
    source: 'inferred',
    level: inferLevel(profile.score, 'standard'),
  };
}

/** The stored form, for the persistent document. */
export function serialiseCapability(profile: CapabilityProfile): string {
  return JSON.stringify({
    level: profile.level,
    score: profile.score,
    events: profile.events,
    source: profile.source,
  });
}

/**
 * Reads a stored document back. Repairs a missing count (an old document
 * has no `events` yet); rejects garbage — a level that is not one of the
 * three, or a non-number — by returning null, so the caller seeds fresh.
 * A plain object is tolerated as well as the JSON string, for documents
 * written before the string form.
 */
export function hydrateCapability(value: string | Record<string, unknown> | null): CapabilityProfile | null {
  let doc: Record<string, unknown> | null = null;
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (!parsed || typeof parsed !== 'object') return null;
      doc = parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  } else if (value && typeof value === 'object') {
    doc = value;
  }
  if (doc === null) return null;
  const level = doc.level;
  if (level !== 'simple' && level !== 'standard' && level !== 'detailed') return null;
  const score = typeof doc.score === 'number' && Number.isFinite(doc.score) ? doc.score : 0;
  const events = typeof doc.events === 'number' && Number.isFinite(doc.events) ? Math.max(0, Math.trunc(doc.events)) : 0;
  const source = doc.source === 'farmer' ? 'farmer' : 'inferred';
  return { level, score, events, source };
}
