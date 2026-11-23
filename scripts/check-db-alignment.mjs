#!/usr/bin/env node
// check-db-alignment.mjs — fail when the code calls a backend that the
// repo's migrations do not define.
//
// Read-only: no database access, no writes. Run from the repo root:
//   node scripts/check-db-alignment.mjs
//
// What it checks:
//   1. Every .rpc('name') call in src/ must name a function defined in
//      supabase/migrations/*.sql, or be a known remote AgriShop call
//      (search_marketplace / farmer_api_*, served by the shop projects).
//   2. Every .from('table') read in src/ must name a table/view defined
//      in supabase/migrations/*.sql. (Table reads are checked against
//      the Farmer DB only; the shop side is reached via fetch/RPC.)
//   3. Every import.meta.env.VITE_* read in src/ must be documented in
//      .env.example (warning only).
//   4. Migration chain sanity: file count, duplicate version prefixes,
//      apply-all.sql present.
//   5. Shop wiring presence: shopEnvironments.ts or VITE_MARKETPLACE_*
//      config (warning only — development is behind staging here).
//
// Exit 0 when only warnings; exit 1 on any FAIL.

import { readdir, readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';

const ROOT = process.cwd();

// Remote calls served by the AgriShop Supabase projects, not by this
// repo's migrations. Keep in sync with the AgriShop contract
// (FARMER_MARKETPLACE_INTEGRATION.md / docs/FARMER_APP_INTEGRATION.md).
const REMOTE_RPCS = new Set([
  'search_marketplace',
  'farmer_api_me',
  'farmer_api_thread',
  'farmer_api_send_message',
  'farmer_api_create_credit_request',
  'farmer_api_answer_offer',
  'farmer_api_request_visit',
  'farmer_api_notifications',
  'farmer_api_register_device',
  'farmer_api_join_shop',
]);

async function walk(dir, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules') continue;
      await walk(p, out);
    } else if (['.ts', '.tsx', '.js', '.mjs'].includes(extname(e.name))) {
      if (e.name.includes('.test.')) continue;
      out.push(p);
    }
  }
  return out;
}

function findAll(re, text) {
  const hits = new Set();
  for (const m of text.matchAll(re)) hits.add(m[1]);
  return hits;
}

const failures = [];
const warnings = [];
const notes = [];
const fail = (m) => failures.push(m);
const warn = (m) => warnings.push(m);
const note = (m) => notes.push(m);

// ---- 1. code side ----
const srcFiles = await walk(join(ROOT, 'src'));
let code = '';
for (const f of srcFiles) code += '\n' + await readFile(f, 'utf8');
const calledRpcs = findAll(/\.rpc\(\s*['"]([A-Za-z0-9_]+)['"]/g, code);
const readTables = findAll(/\.from\(\s*['"]([A-Za-z0-9_]+)['"]/g, code);
const usedVars = findAll(/import\.meta\.env\.(VITE_[A-Z0-9_]+)/g, code);
const remoteRefs = findAll(/\b(search_marketplace|farmer_api_[a-z_]+)\b/g, code);

// ---- 2. migration side ----
const migDir = join(ROOT, 'supabase', 'migrations');
let migFiles = [];
try {
  migFiles = (await readdir(migDir)).filter((n) => n.endsWith('.sql')).sort();
} catch {
  fail('supabase/migrations/ is missing or unreadable');
}
let migSql = '';
for (const f of migFiles) migSql += '\n' + await readFile(join(migDir, f), 'utf8');
const definedFns = findAll(
  /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?[A-Za-z0-9_]+"?\.)?"?([A-Za-z0-9_]+)"?\s*\(/gi,
  migSql,
);
const definedTables = new Set([
  ...findAll(
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?[A-Za-z0-9_]+"?\.)?"?([A-Za-z0-9_]+)"?\s*\(/gi,
    migSql,
  ),
  ...findAll(
    /CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+(?:"?[A-Za-z0-9_]+"?\.)?"?([A-Za-z0-9_]+)"?/gi,
    migSql,
  ),
]);

// ---- checks ----
for (const rpc of [...calledRpcs].sort()) {
  if (REMOTE_RPCS.has(rpc)) {
    note(`remote RPC (AgriShop): ${rpc}`);
    continue;
  }
  if (!definedFns.has(rpc)) fail(`RPC called by code but not defined in migrations: ${rpc}`);
}
for (const t of [...readTables].sort()) {
  if (!definedTables.has(t)) fail(`Table read by code but not defined in migrations: ${t}`);
}
for (const rpc of [...remoteRefs].sort()) {
  if (!REMOTE_RPCS.has(rpc)) warn(`Remote-looking call not in the known AgriShop allowlist: ${rpc}`);
  else if (!calledRpcs.has(rpc)) note(`remote call (AgriShop, via fetch): ${rpc}`);
}

let documentedVars = new Set();
try {
  const example = await readFile(join(ROOT, '.env.example'), 'utf8');
  documentedVars = findAll(/^([A-Z0-9_]+)=/gm, example);
} catch {
  warn('.env.example is missing; cannot check VITE_* documentation');
}
for (const v of [...usedVars].sort()) {
  if (!documentedVars.has(v)) warn(`VITE_* var used by code but not documented in .env.example: ${v}`);
}

const versions = migFiles.map((f) => f.split('_')[0]);
const dupes = versions.filter((v, i) => versions.indexOf(v) !== i);
if (dupes.length) fail(`Duplicate migration version prefixes: ${[...new Set(dupes)].join(', ')}`);
note(`${migFiles.length} migration files in supabase/migrations/`);
try {
  await readFile(join(ROOT, 'supabase', 'apply-all.sql'), 'utf8');
} catch {
  warn('supabase/apply-all.sql is missing (expected bundle of the chain)');
}

let shopWired = false;
try {
  await readFile(join(ROOT, 'src', 'services', 'shopEnvironments.ts'), 'utf8');
  shopWired = true;
} catch {
  // absent on this branch
}
if (!shopWired && !usedVars.has('VITE_MARKETPLACE_URL')) {
  warn('No shop environment wiring found (no shopEnvironments.ts, no VITE_MARKETPLACE_URL in code)');
} else if (!shopWired) {
  note('Shop wiring via VITE_MARKETPLACE_URL (no shopEnvironments.ts on this branch)');
}

// ---- report ----
for (const n of notes) console.log(`  note: ${n}`);
for (const w of warnings) console.log(`  warn: ${w}`);
for (const f of failures) console.log(`  FAIL: ${f}`);
console.log(
  `checked ${srcFiles.length} source files, ${calledRpcs.size} RPC calls, ` +
    `${readTables.size} table reads, ${usedVars.size} VITE_* vars against ` +
    `${migFiles.length} migrations (${definedFns.size} functions, ${definedTables.size} tables/views).`,
);
if (failures.length) {
  console.log(`ALIGNMENT FAILED: ${failures.length} problem(s).`);
  process.exit(1);
}
console.log(`ALIGNMENT OK${warnings.length ? ` (${warnings.length} warning(s)).` : '.'}`);
