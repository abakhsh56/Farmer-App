/**
 * The AgriShop project each environment talks to.
 *
 * Two projects, one per side of the same product: `staging` is where the shop app
 * and this app are developed and tested together, `production` is the live shop
 * network. A build has to point at exactly one of them, and the choice is made by
 * `VITE_APP_ENV` — the same value that names the OTA channel and the APK flavour —
 * rather than by whoever happens to be building.
 *
 * Why the values are here and not only in `.env.local`:
 *
 *   · The shop project is a *different* Supabase project from this app's own
 *     backend, so there is no single `VITE_SUPABASE_URL` that could serve both.
 *   · Every build path this repository has — `npm run dev`, `npm run apk:*`,
 *     `npm run ota:publish`, a by-hand site build — sets `VITE_APP_ENV` and knows
 *     nothing about shop credentials. A table keyed by that value is the one place
 *     that can give all of them the right answer, and the one place to change when
 *     a key rotates.
 *
 * Why a key may be committed at all: these are the shops' *anonymous* keys. They
 * are published inside every installed app by design, and they grant nothing on
 * their own — every table behind them is guarded by row level security. The
 * service_role key never belongs in this file, in `.env`, or anywhere a phone can
 * read it.
 *
 * Precedence, deliberately: an explicitly set `VITE_SHOP_API_*` or
 * `VITE_MARKETPLACE_*` wins over the table below. That is what makes a one-off
 * test build against another project possible without editing source.
 */

export type ShopEndpoint = { url: string; key: string };

export type ShopEnvironment = {
  /** What the Shop tab reads: shops and what they have listed. Read-only. */
  marketplace: ShopEndpoint;
  /** What the Chat tab writes: the `farmer_api_*` contract. */
  shopApi: ShopEndpoint;
};

/** The AgriShop staging project: where the shop app ships first. */
const STAGING_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJweWJqcmplbndjY293dnRyZXZ1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwMjY1NzIsImV4cCI6MjEwNDYwMjU3Mn0.nHzYWdjmZ_TEp_2mzqeinCNoXeLvVdvOETgvJXxldS0';

/** The AgriShop production project: the live shop network. */
const PRODUCTION_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdrc3djZmxqeGx1dGtmZHZ2cW5nIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc2MDAyNzUsImV4cCI6MjEwMzE3NjI3NX0.fEq7Ghk1yhfWe-JqYJpxHGJKYDDEh9FI0ss6aHqFUxA';

const STAGING: ShopEnvironment = {
  marketplace: { url: 'https://bpybjrjenwccowvtrevu.supabase.co', key: STAGING_KEY },
  shopApi: { url: 'https://bpybjrjenwccowvtrevu.supabase.co', key: STAGING_KEY },
};

const PRODUCTION: ShopEnvironment = {
  marketplace: { url: 'https://gkswcfljxlutkfdvvqng.supabase.co', key: PRODUCTION_KEY },
  shopApi: { url: 'https://gkswcfljxlutkfdvvqng.supabase.co', key: PRODUCTION_KEY },
};

/**
 * The project for an environment name.
 *
 * `test` resolves to nothing, and that is on purpose: the suite pins every
 * endpoint empty so no test ever reads a real shop's listings or writes into a
 * real shop's conversation. A default here would undo that pinning one test at a
 * time, silently.
 *
 * An unnamed environment — `npm run build` with no `VITE_APP_ENV`, which is what
 * CI does — resolves to staging for the same reason `dev` does: work that has not
 * been promoted must never reach a live shop's thread.
 */
export function resolveShopEnvironment(appEnv: string | null | undefined): ShopEnvironment | null {
  if (appEnv === 'test') return null;
  if (appEnv === 'production') return PRODUCTION;
  return STAGING;
}
