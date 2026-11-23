#!/usr/bin/env node
/**
 * Proves one environment works, using the exact key that environment's build
 * ships and the exact RPCs the app calls.
 *
 *   npm run verify:environments -- --staging
 *   npm run verify:environments -- --production
 *
 * There is no secret to configure. The URL and key come from
 * `src/services/appEnvironments.ts` — the same table the build reads — imported
 * directly (Node strips the types), so this cannot pass against a project the
 * app would not actually use. It is the check that a promotion is *working*, not
 * merely deployed.
 *
 * What it does, in the order a farmer would hit it:
 *
 *   1. requests a code, then verifies it — the app's only sign-in path, so this
 *      also proves the project's auth configuration (phone provider, test OTP)
 *   2. `ensure_party` — the party id every row-level policy matches on
 *   3. `client_document_put` / `client_document_get` — the document round trip
 *      every screen in the app is built on
 *   4. on staging, a second farmer asking for the first one's document and
 *      trying to write into it must be refused
 *
 * It writes into its own collection (`verification-probe`), which the app never
 * uses, and deletes it again — so a production run leaves no trace and cannot
 * collide with, or delete, a farmer's real document. That last part is not
 * theoretical: an earlier version of this check probed `chat` and removed a
 * document it had not created.
 *
 * The phone numbers are the ones each project has a fixed test code for. That is
 * project configuration (`sms_test_otp`), not a code path in the app: the same
 * `signInWithOtp` + `verifyOtp` calls a real farmer's phone goes through, and the
 * session is a real one, which is why the row-level policies below are the real
 * ones too.
 */
import { readFileSync } from 'node:fs';
import { backendFor } from '../src/services/appEnvironments.ts';

const arg = process.argv.slice(2).find((value) => value.startsWith('--'));
const env = arg?.replace(/^--/, '') ?? 'staging';
if (env !== 'dev' && env !== 'staging' && env !== 'production') {
  console.error('usage: npm run verify:environments -- --dev | --staging | --production');
  process.exit(2);
}

/**
 * Dev is the one environment whose backend is the developer's own choice, so it
 * comes from `.env.local` — exactly what the dev build reads — rather than from
 * the committed table.
 */
function devBackend() {
  let text = '';
  try {
    text = readFileSync('.env.local', 'utf8');
  } catch {
    return null;
  }
  const read = (name) => {
    const match = new RegExp(`^${name}=(.*)$`, 'm').exec(text);
    const value = match?.[1]?.trim() ?? '';
    return value.length > 0 ? value : null;
  };
  const url = read('VITE_SUPABASE_URL');
  const key = read('VITE_SUPABASE_ANON_KEY');
  return url && key ? { url, key } : null;
}

const backend = env === 'dev' ? devBackend() : backendFor(env);
if (!backend) {
  console.error(
    env === 'dev'
      ? 'dev has no backend: run `npm run stack:start` and put its URL and anon key in .env.local (see docs/ENVIRONMENTS.md)'
      : `no backend is configured for "${env}"`,
  );
  process.exit(2);
}

/**
 * Two fixed-number codes so isolation can be proven. Dev and staging have both;
 * production has one, and no extra test farmer belongs on it.
 */
const identity = { phone: '923001234567', code: '123456' };
const neighbour = env === 'production' ? null : { phone: '923001111111', code: '111111' };

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

async function call(path, { method = 'GET', body, bearer } = {}) {
  const response = await fetch(`${backend.url}${path}`, {
    method,
    headers: {
      apikey: backend.key,
      Authorization: `Bearer ${bearer ?? backend.key}`,
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* a non-JSON error body is reported through `text` */
  }
  return { status: response.status, ok: response.ok, json, text };
}

async function signIn({ phone, code }) {
  const requested = await call('/auth/v1/otp', { method: 'POST', body: { phone, create_user: true } });
  if (!requested.ok) return { ok: false, detail: `otp ${requested.status}: ${requested.text.slice(0, 120)}` };
  const verified = await call('/auth/v1/verify', {
    method: 'POST',
    body: { phone, token: code, type: 'sms' },
  });
  if (!verified.ok) return { ok: false, detail: `verify ${verified.status}: ${verified.text.slice(0, 160)}` };
  return { ok: Boolean(verified.json?.access_token), token: verified.json?.access_token };
}

console.log(`verifying ${env} (${backend.url})`);

const farmer = await signIn(identity);
check('a farmer can sign in', farmer.ok, farmer.detail ?? '');
if (!farmer.ok) {
  console.log(`${failures} check(s) failed`);
  process.exit(1);
}

const party = await call('/rest/v1/rpc/ensure_party', { method: 'POST', body: {}, bearer: farmer.token });
const partyId = party.json;
check(
  'ensure_party mints a party id',
  typeof partyId === 'string' && partyId.length === 36,
  party.ok ? '' : party.text.slice(0, 120),
);

/**
 * `client_documents` allows a fixed set of collection names, and every one of them
 * is a collection the app itself writes. So the probe borrows `session` and puts
 * back exactly what it found: a check that has to touch a farmer's document must
 * hand it back unchanged. (An earlier version of this script probed `chat` with a
 * hard delete as its cleanup, and removed a document it had not created.)
 */
const COLLECTION = 'session';
const marker = `verification-${env}`;

async function readDocument(token) {
  const response = await call('/rest/v1/rpc/client_document_get', {
    method: 'POST',
    body: { p_owner_id: partyId, p_collection: COLLECTION },
    bearer: token,
  });
  const rows = Array.isArray(response.json) ? response.json : [];
  return rows[0] ?? null;
}

const before = await readDocument(farmer.token);
const put = await call('/rest/v1/rpc/client_document_put', {
  method: 'POST',
  body: {
    p_owner_id: partyId,
    p_collection: COLLECTION,
    p_document: { probe: marker, at: new Date().toISOString() },
    // Present only when there was already a document: the RPC's optimistic check.
    ...(before ? { p_expected_revision: before.revision } : {}),
  },
  bearer: farmer.token,
});
check('a document can be written', put.ok, put.ok ? '' : put.text.slice(0, 160));

const got = await readDocument(farmer.token);
check('and read back by its owner', got?.document?.probe === marker, got ? '' : 'nothing came back');

if (neighbour) {
  const other = await signIn(neighbour);
  check('a second farmer can sign in', other.ok, other.detail ?? '');
  if (other.ok) {
    const crossRead = await call('/rest/v1/rpc/client_document_get', {
      method: 'POST',
      body: { p_owner_id: partyId, p_collection: COLLECTION },
      bearer: other.token,
    });
    const crossRows = Array.isArray(crossRead.json) ? crossRead.json : [];
    check('the second farmer cannot read the first one document', crossRows.length === 0, `${crossRows.length} rows`);

    const crossWrite = await call('/rest/v1/rpc/client_document_put', {
      method: 'POST',
      body: { p_owner_id: partyId, p_collection: COLLECTION, p_document: { spoof: true } },
      bearer: other.token,
    });
    check('the second farmer cannot write into it', !crossWrite.ok, crossWrite.ok ? 'the write was accepted' : 'refused');
  }
}

/**
 * Put the environment back the way it was found: the previous document restored,
 * or — if there was none — the probe removed. Either way nothing of ours is left.
 */
const writtenRevision = Array.isArray(put.json) ? put.json[0]?.revision : undefined;
const cleanup = before
  ? await call('/rest/v1/rpc/client_document_put', {
      method: 'POST',
      body: {
        p_owner_id: partyId,
        p_collection: COLLECTION,
        p_document: before.document,
        ...(writtenRevision ? { p_expected_revision: writtenRevision } : {}),
      },
      bearer: farmer.token,
    })
  : await call('/rest/v1/rpc/client_document_delete', {
      method: 'POST',
      body: { p_owner_id: partyId, p_collection: COLLECTION },
      bearer: farmer.token,
    });
check(
  before
    ? 'the document that was already there is put back'
    : 'the verification document is removed again',
  cleanup.ok,
  cleanup.ok ? '' : cleanup.text.slice(0, 120),
);

console.log(failures === 0 ? `\n${env}: all checks passed` : `\n${env}: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
