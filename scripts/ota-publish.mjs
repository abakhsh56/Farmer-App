#!/usr/bin/env node
/**
 * Publishes a live-update bundle to one environment's channel.
 *
 * The channel is a GitHub Release whose assets are rewritten each time, so the
 * URL an installed app polls never changes:
 *
 *   https://github.com/abakhsh56/Farmer-App/releases/download/ota-dev/bundle.zip
 *   https://github.com/abakhsh56/Farmer-App/releases/download/ota-dev/latest.json
 *
 * Nothing here needs a paid service or a vendor account, and it is the same
 * mechanism for dev, staging and production. `gh` supplies the credentials that
 * are already used to push, so publishing is one command on a machine that can
 * push to the repository:
 *
 *   npm run ota:publish -- --env dev
 *
 * What the installed app does with it is in `src/services/liveUpdate.ts`: it
 * reads `latest.json`, compares `bundleId` with the bundle it is running, and
 * only downloads when they differ. The `bundleId` is the commit and build time,
 * so republishing an identical commit still reaches the phone (the build time
 * changes) while a normal launch makes no download at all.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { zipDirectory } from './lib/zip.mjs';

const ROOT = resolve(process.cwd());
const DIST = join(ROOT, 'dist');
const OUT = join(ROOT, 'artifacts', 'ota');

/** One channel per environment; the tag is the channel. */
const CHANNELS = {
  dev: 'ota-dev',
  staging: 'ota-staging',
  production: 'ota-production',
};

function fail(message, detail) {
  console.error(`\nota-publish: ${message}`);
  if (detail) console.error(detail);
  process.exit(1);
}

function parseArgs(argv) {
  const flags = argv.slice(2);
  let env = 'dev';
  for (let i = 0; i < flags.length; i += 1) {
    if (flags[i] === '--env') env = flags[i + 1];
    else if (flags[i].startsWith('--env=')) env = flags[i].slice('--env='.length);
  }
  if (!CHANNELS[env]) fail(`unknown environment "${env}".`, `  Choose one of: ${Object.keys(CHANNELS).join(', ')}`);
  return { env };
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function gh(args) {
  try {
    return { ok: true, out: execFileSync('gh', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (error) {
    return { ok: false, out: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

const { env } = parseArgs(process.argv);
const tag = CHANNELS[env];

const sha = git(['rev-parse', '--short', 'HEAD']);
const builtAt = new Date().toISOString();
const bundleId = `${sha}-${builtAt.replace(/[-:.TZ]/g, '').slice(0, 14)}`;

console.log(`ota-publish: building the ${env} web bundle…`);
execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], {
  cwd: ROOT,
  env: { ...process.env, VITE_APP_ENV: env },
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

const zip = zipDirectory(DIST);
const checksum = createHash('sha256').update(zip).digest('hex');

mkdirSync(OUT, { recursive: true });
const zipPath = join(OUT, 'bundle.zip');
const manifestPath = join(OUT, 'latest.json');

writeFileSync(zipPath, zip);
writeFileSync(
  manifestPath,
  `${JSON.stringify(
    {
      bundleId,
      checksum,
      environment: env,
      commit: sha,
      builtAt,
      bytes: zip.length,
    },
    null,
    2,
  )}\n`,
);

console.log(`ota-publish: bundle ${bundleId} — ${(zip.length / 1024 / 1024).toFixed(1)} MB, sha256 ${checksum.slice(0, 12)}…`);

/**
 * The release is created once and reused. `--clobber` replaces the two assets,
 * which is what keeps the download URL stable for every phone already installed.
 */
const existing = gh(['release', 'view', tag]);
if (!existing.ok) {
  const notes = `Live-update channel for ${env}. Assets are replaced by \`npm run ota:publish -- --env ${env}\`; installed apps poll \`latest.json\` from this release.`;
  const created = gh(['release', 'create', tag, '--title', `OTA ${env}`, '--notes', notes]);
  if (!created.ok) {
    fail(`could not create the "${tag}" release.`, `  gh said: ${created.out.trim()}\n  Is \`gh auth status\` logged in with push rights to abakhsh56/Farmer-App?`);
  }
}

const uploaded = gh(['release', 'upload', tag, zipPath, manifestPath, '--clobber']);
if (!uploaded.ok) fail(`could not upload the bundle to "${tag}".`, `  gh said: ${uploaded.out.trim()}`);

rmSync(zipPath, { force: true });

console.log(`ota-publish: ${tag} now serves bundle ${bundleId}`);
console.log(`ota-publish: phones on the ${env} build pick it up on their next launch`);
