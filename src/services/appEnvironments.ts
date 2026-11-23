/**
 * The app's own backend, per environment.
 *
 * Until now every environment — a developer's machine, staging, production —
 * read the same Supabase project, because there was one set of credentials for
 * it. That is the arrangement this module replaces: a build now knows which
 * project it belongs to from `VITE_APP_ENV`, the same value that names the OTA
 * channel, the APK flavour and the AgriShop project it talks to.
 *
 * The matrix, and why each cell is what it is:
 *
 *   dev         → `configured`  the developer's own machine. `.env.local` points
 *                                at the local Supabase stack (Docker), so dev
 *                                data never leaves the laptop and never appears
 *                                in a shared project. Left empty, the app runs
 *                                from the phone's own storage, which is the
 *                                documented fallback rather than a broken state.
 *   staging     → the staging project below
 *   production  → the production project below
 *   test        → `local`       the suite never talks to a project at all
 *   unnamed     → `local`       a build nobody labelled must not reach a live
 *                                database by default
 *
 * Why these two keys are committed: they are *publishable* keys. They are baked
 * into every installed app by design, and they grant nothing on their own —
 * every table behind them is guarded by row level security that checks
 * `auth.uid()`. The service-role key and the `sb_secret_…` key never appear in
 * this file, in `.env`, or anywhere a phone can read them.
 *
 * Why the table wins over `.env.local` for staging and production: a developer
 * copy of this repository has a `.env.local` pointing at their local stack. If
 * an explicit `VITE_SUPABASE_*` could override the table, a staging build made
 * on that laptop would talk to a database on localhost, and a production build
 * would fail to reach the real one — a class of bug that looks like "the backend
 * is down". Only `dev` consults the environment file, which is exactly the one
 * environment whose backend is allowed to be a personal choice.
 */

export type AppBackend = { url: string; key: string };

/**
 * What the build should do about its backend.
 *
 *  · `environment` — use this project. Staging and production, unconditionally.
 *  · `configured`  — use `VITE_SUPABASE_*` from the build environment. Dev only.
 *  · `local`       — no backend at all: the on-device repository, which is what
 *                    the tests and an unlabelled build get.
 */
export type AppBackendChoice =
  | { source: 'environment'; backend: AppBackend }
  | { source: 'configured' }
  | { source: 'local' };

/** The staging project: where a release is rehearsed against a real database. */
const STAGING: AppBackend = {
  url: 'https://zmyvkwijloqylvftvhvq.supabase.co',
  key: 'sb_publishable_pY-ChcHkNzrwIdfXfLtBfw_FxZbnHKA',
};

/**
 * The production project: the one every installed production app already uses,
 * which is why promoting the environment split needs no data migration and no
 * reinstall.
 */
const PRODUCTION: AppBackend = {
  url: 'https://swmbmtvwgksicfnfsehg.supabase.co',
  key: 'sb_publishable_eGXh9p7CtMpQKrQFd5FAEQ_CrUQ6Cqt',
};

export function resolveAppBackend(appEnv: string | null | undefined): AppBackendChoice {
  switch (appEnv) {
    case 'production':
      return { source: 'environment', backend: PRODUCTION };
    case 'staging':
      return { source: 'environment', backend: STAGING };
    case 'dev':
      return { source: 'configured' };
    // `test`, an empty value and a typo all land here on purpose. A build that
    // was not told which environment it is for must not pick one for itself.
    default:
      return { source: 'local' };
  }
}

/** The project a build talks to, or null when it has no backend. */
export function backendFor(appEnv: string | null | undefined): AppBackend | null {
  const choice = resolveAppBackend(appEnv);
  return choice.source === 'environment' ? choice.backend : null;
}
