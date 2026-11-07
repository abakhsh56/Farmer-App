/**
 * Behaviour signals: the learning input for the per-farmer algorithm.
 *
 * A signal is behaviour, never a fact. It says "this farmer searched for urea",
 * "they scanned a cotton leaf", "they opened this advice", "they dismissed
 * that one" — and the recommendation engine reorders relevance from it. It is
 * never copied into crop facts and never triggers a notification on its own,
 * which is the contract the `behaviour_signals` table states for itself.
 *
 * Three rules shape this module:
 *
 *  · Fire-and-forget. Recording a signal must never block the UI or surface an
 *    error to the farmer. A failed write is lost learning, not a broken screen,
 *    so every failure is swallowed here and `recordSignal` returns void.
 *
 *  · Coarse only. A signal carries a type, a source, a topic and a crop code —
 *    never message text, never a question's wording, never a phone number. The
 *    search term is the one exception, because the term *is* the topic.
 *
 *  · Only the farmer's own rows. The table's row level security only lets a
 *    farmer write rows whose `farmer_id` is their own party, so a guest or a
 *    demo account without a server party id records nothing at all. The UUID
 *    check below is the client-side half of that: a contact-based id (the
 *    `phone:0300…` form a guest account carries) would fail the table's foreign
 *    key anyway, so it is dropped before a request is made.
 *
 * The insert goes straight to the `behaviour_signals` table, which already
 * exists on staging from the base migrations. There is no RPC for it and none
 * is invented here: the table's own policy is the write path.
 */

import { serviceConfig } from './config';
import { getSupabaseClient } from './supabaseClient';

/** The sources the `behaviour_signals` table accepts — its check constraint. */
export type SignalSource =
  | 'ui_interaction'
  | 'search'
  | 'scan'
  | 'chat'
  | 'community_read'
  | 'notification_open';

export type SignalStrength = 'weak' | 'moderate' | 'strong';

export type BehaviourSignalInput = {
  /** What the farmer did, in the engine's own vocabulary. */
  signalType: string;
  source: SignalSource;
  /**
   * The coarse topic: a search term, an insight title key, a dealer id.
   * Never free message text or a question's wording.
   */
  subject?: string | null;
  /** A crop catalogue code, or a `crop.<code>` message key — normalised here. */
  cropCode?: string | null;
  strength?: SignalStrength;
  /** Extra coarse context, e.g. a scan verdict kind. Never message text. */
  detail?: Record<string, unknown>;
};

/**
 * The crop codes the catalogue on staging knows, so a bad code never reaches
 * the foreign key. Kept beside the table it guards rather than imported from a
 * seed file, because the catalogue is data and this is the client's contract
 * with it.
 */
const KNOWN_CROP_CODES = new Set([
  'cotton',
  'wheat',
  'rice',
  'maize',
  'sugarcane',
  'gram',
  'potato',
  'mustard',
  'mungbean',
  'onion',
]);

/**
 * A crop code from either form the client holds it in — the bare catalogue code
 * or the `crop.<code>` message key the screens and stores use. Anything else
 * answers null, so a made-up code is dropped rather than failing the insert
 * against the catalogue foreign key.
 */
export function toCropCode(value: string | null | undefined): string | null {
  if (!value) return null;
  const code = value.startsWith('crop.') ? value.slice('crop.'.length) : value;
  return KNOWN_CROP_CODES.has(code) ? code : null;
}

/** A party id the server will accept as a farmer: a UUID, nothing else. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isRecordablePartyId(partyId: string | null | undefined): partyId is string {
  return typeof partyId === 'string' && UUID_RE.test(partyId);
}

/** A subject is a topic label, not a transcript — anything longer is trimmed. */
const SUBJECT_MAX = 120;

export function normaliseSubject(subject: string | null | undefined): string | null {
  if (!subject) return null;
  const trimmed = subject.trim();
  if (!trimmed) return null;
  return trimmed.length > SUBJECT_MAX ? trimmed.slice(0, SUBJECT_MAX) : trimmed;
}

/** The narrow slice of the query builder this service uses. */
type BehaviourSignalsTable = {
  insert: (row: Record<string, unknown>) => Promise<{ error: { message: string } | null }>;
};

/**
 * How long an identical signal is treated as the same tap, not a new one.
 *
 * A double tap on an insight, or a search confirmed twice in a row, is one
 * expression of interest. Recording it twice would tell the engine the farmer
 * is twice as interested, which is a lie the UI told, not a fact about them.
 */
const DEDUPE_MS = 5_000;

const recent = new Map<string, number>();

/** Test seam: the dedupe cache is module state, so a test needs a way to clear it. */
export function resetSignalDedupeForTests(): void {
  recent.clear();
}

function dedupeKey(
  partyId: string,
  input: BehaviourSignalInput,
  subject: string | null,
  cropCode: string | null,
): string {
  return [partyId, input.source, input.signalType, subject ?? '', cropCode ?? ''].join('|');
}

/**
 * Record one behaviour signal for the farmer, and return immediately.
 *
 * The write runs after the return, on its own clock: the caller never awaits
 * it and never hears about it. A guest, a demo account, a missing backend, a
 * refused write — all of them end here, silently, because none of them is the
 * farmer's problem.
 */
export function recordSignal(partyId: string | null | undefined, input: BehaviourSignalInput): void {
  if (!isRecordablePartyId(partyId)) return;
  const subject = normaliseSubject(input.subject);
  const cropCode = toCropCode(input.cropCode);

  const key = dedupeKey(partyId, input, subject, cropCode);
  const now = Date.now();
  const last = recent.get(key);
  if (last !== undefined && now - last < DEDUPE_MS) return;
  recent.set(key, now);
  /* The cache only ever holds one entry per distinct signal in the window, and
     a session that ran for hours would still grow it without bound — so a full
     cache is swept of anything outside the window before it grows further. */
  if (recent.size > 500) {
    for (const [entryKey, at] of recent) {
      if (now - at >= DEDUPE_MS) recent.delete(entryKey);
    }
  }

  void (async () => {
    try {
      const client = await getSupabaseClient(serviceConfig.supabase);
      if (!client) return;
      const table = client.from('behaviour_signals') as unknown as BehaviourSignalsTable;
      const { error } = await table.insert({
        farmer_id: partyId,
        signal_type: input.signalType,
        crop_code: cropCode,
        subject,
        strength: input.strength ?? 'moderate',
        source: input.source,
        detail: input.detail ?? {},
      });
      if (error) {
        /* A refused write is lost learning. It is not retried: a signal that
           needed retrying would arrive late and out of order, and the engine
           reads recency as relevance. */
        return;
      }
    } catch {
      return;
    }
  })();
}
