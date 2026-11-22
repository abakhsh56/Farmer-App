/**
 * Live updates for the installed Android app.
 *
 * The APK ships one web bundle. This module lets that same install move to a
 * newer bundle without anyone reinstalling: it asks the environment's channel
 * for a manifest, and if the manifest names a bundle the app is not already
 * running, it downloads the zip, checks it, sets it as the next bundle and
 * reloads.
 *
 * Why self-hosted: Capawesome's plugin is MIT and downloads from any URL, so the
 * channel is a GitHub Release asset per environment — no paid service, no vendor
 * account, and the same free path works in production. `sync()` from that plugin
 * talks to Capawesome Cloud and is deliberately not used.
 *
 * One channel per environment, baked in at build time by `VITE_OTA_BASE`:
 *
 *   dev        …/releases/download/ota-dev
 *   staging    …/releases/download/ota-staging
 *   production …/releases/download/ota-production
 *
 * Each release carries two assets, both rewritten on every publish:
 *
 *   bundle.zip   the built web assets, index.html at the root
 *   latest.json  { "bundleId": "…", "checksum": "<sha256 of bundle.zip>" }
 *
 * Rules this follows, in the order they matter:
 *
 *  · Web is never touched. A browser already fetches the deployment's own files,
 *    so the plugin is not even imported into that path at runtime.
 *  · A network or manifest failure is not an error the farmer sees: the app keeps
 *    the bundle inside the APK, which is always a complete, working build.
 *  · `ready()` is called first, before any download, because the plugin rolls the
 *    app back to the shipped bundle if a new bundle never reports itself ready.
 *  · The checksum is verified by the native side, so a truncated or foreign zip
 *    is rejected instead of being booted into.
 */

import { Capacitor } from '@capacitor/core';
import { LiveUpdate } from '@capawesome/capacitor-live-update';

/** Written by `scripts/ota-publish.mjs` next to the zip it describes. */
type Manifest = {
  bundleId: string;
  checksum: string;
};

const MANIFEST_FILE = 'latest.json';
const BUNDLE_FILE = 'bundle.zip';

/**
 * The channel this build watches, or null when the build was made without one
 * (a plain `npm run build` for the browser, or a local debug build).
 */
function channelBase(): string | null {
  const configured = import.meta.env.VITE_OTA_BASE;
  if (typeof configured !== 'string') return null;
  const trimmed = configured.trim().replace(/\/+$/, '');
  return trimmed.length > 0 ? trimmed : null;
}

async function check(base: string): Promise<void> {
  const current = await LiveUpdate.getCurrentBundle();
  const next = await LiveUpdate.getNextBundle();

  const response = await fetch(`${base}/${MANIFEST_FILE}`, { cache: 'no-store' });
  if (!response.ok) return;

  const manifest = (await response.json()) as Manifest | null;
  if (!manifest?.bundleId || typeof manifest.checksum !== 'string') return;

  // Already running it, or already staged it. The second case only needs the
  // reload that a previous attempt did not reach (the app was killed first).
  if (current.bundleId === manifest.bundleId) return;
  if (next.bundleId === manifest.bundleId) {
    await LiveUpdate.reload();
    return;
  }

  await LiveUpdate.downloadBundle({
    url: `${base}/${BUNDLE_FILE}`,
    bundleId: manifest.bundleId,
    checksum: manifest.checksum,
  });
  await LiveUpdate.setNextBundle({ bundleId: manifest.bundleId });
  await LiveUpdate.reload();
}

/**
 * Called once at startup. Never awaited by the render path: an update must not
 * delay the first screen, and a failure must not stop the app from opening.
 */
export function startLiveUpdates(): void {
  if (!Capacitor.isNativePlatform()) return;

  // Before anything else: this is what tells the plugin the running bundle is
  // healthy and stops the automatic rollback timer.
  void LiveUpdate.ready().catch(() => {});

  const base = channelBase();
  if (!base) return;

  void check(base).catch(() => {
    // Offline, a manifest that is not there yet, or a plugin that is not built
    // into this APK. The shipped bundle keeps running.
  });
}
