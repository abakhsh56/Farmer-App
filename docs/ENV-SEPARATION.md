# Farmer App — environment separation

Status: 2026-11-23. Read phase done (7 readers). This doc is the
decision record + the setup checklist. Nothing here changes production
until AB says so.

## The model (AB's order, 2026-11-23)

- Exactly TWO Supabase projects in the cloud for the Farmer app:
  one STAGING, one PRODUCTION.
- Development is LOCAL on AB's PC (local code + local database).
  There is no cloud dev project.
- Local code (development branch) -> AB says "push to staging" ->
  merge development -> staging -> AB tests the installed staging APK
  -> AB confirms -> merge staging -> main -> production.
- NOTHING merges to staging or main without AB's word.
- APK: generated ONCE manually when AB asks for a fresh one. No auto
  APK build on push. After that, every push flows to the installed APK
  via OTA only (ota-dev / ota-staging / ota-production releases).
- Auto-sync: migrations travel with code pushes and are applied to
  THAT environment's database by .github/workflows/db-sync.yml.
  The code's fields must align with that environment's DB fields;
  scripts/check-db-alignment.mjs enforces it on every push.

## Project mapping (decision)

- PRODUCTION keeps swmbmtvwgksicfnfsehg. It holds all existing data
  (live + test) because every environment shared it until now. Moving
  production to a new empty project would orphan live users and data.
- STAGING is ONE new Supabase project, to be created in AB's Supabase
  account (dashboard). Name suggestion: "Farmer App Staging".
- Total cloud projects after this: 2 (staging + production).
- Migration chain for the new staging project: the 72 files in
  supabase/migrations/ on development/staging/main (first
  20261003000100_foundation.sql, last
  20261122000200_shop_join_notification.sql). NOT the "76" in old
  notes, NOT the 32 in the stale local clone, NOT the 69 on
  work/phase2c-stabilization.
- Test data currently inside swmbmtvwgksicfnfsehg stays in production
  until AB decides a cleanup. Do NOT delete it as part of this setup.
- Shop side (already separated, do not touch): Farmer staging and dev
  read staging shop project bpybjrjenwccowvtrevu; Farmer production
  reads production shop project gkswcfljxlutkfdvvqng. Farmer staging
  must talk to AgriShop staging, Farmer production to AgriShop
  production, dev to dev/local.

## What the automation does

- `.github/workflows/db-sync.yml`
  - alignment job on every push to development/staging/main:
    runs scripts/check-db-alignment.mjs (read-only).
  - migrate job on staging/main pushes only: applies the repo's
    migration chain to that environment's project with the Supabase
    CLI (`supabase db push`, dry-run first). Skips loudly when the
    access token or project ref is not configured yet.
  - It never runs migration apply for development (no cloud project).
  - It never touches the AgriShop projects.
- `.github/workflows/ota.yml` (unchanged): OTA publish on push.
  Per-branch VITE_SUPABASE_URL/ANON_KEY wiring is prepared below and
  is applied AFTER the staging project exists (see "ota.yml edit").

## What AB must provide (exact names, no values here)

GitHub repo abakhsh56/Farmer-App -> Settings -> Secrets and
variables -> Actions:
- Secret SUPABASE_ACCESS_TOKEN — Supabase dashboard -> Account ->
  Access Tokens. Needed for the migrate job.
- Variable STAGING_SUPABASE_PROJECT_REF — the new staging project
  ref, after it is created.
- Variable PROD_SUPABASE_PROJECT_REF — swmbmtvwgksicfnfsehg
  (can be set now).
- Later, for the ota.yml edit: secrets STAGING_VITE_SUPABASE_URL,
  STAGING_VITE_SUPABASE_ANON_KEY, PROD_VITE_SUPABASE_URL,
  PROD_VITE_SUPABASE_ANON_KEY.
- Vercel: the Farmer App project still needs AB's re-auth (team
  scope 403); per-environment env vars go in the Vercel dashboard.
- Gemini API key (GEMINI_API_KEY) for voice, if not already set.

## Creating the new staging project (AB, Supabase dashboard)

1. Supabase dashboard -> New project -> name "Farmer App Staging",
   same region as the existing project, set a database password
   and save it.
2. Note the project ref and anon key.
3. Set the GitHub variable STAGING_SUPABASE_PROJECT_REF and the
   secret SUPABASE_ACCESS_TOKEN.
4. The migrate job applies the 72 migrations on the next push to
   staging (or run the workflow manually from the Actions tab).
   Verify the run log shows the same table/function counts as
   production.
5. Verify isolation: create a test row in staging and confirm it
   does NOT appear in production; then delete the test row.

## ota.yml edit (prepared, NOT applied yet)

Why not applied now: development's ota.yml is behind staging/main's
(staging/main deliberately removed the marketplace secrets). Editing
development's copy now would regress that on the next merge. Apply
this edit on staging after the staging project exists, and let it
flow to main with the next promotion.

Replace the two lines in the job env:
  VITE_SUPABASE_URL: ${{ github.ref_name == 'main' && secrets.PROD_VITE_SUPABASE_URL || github.ref_name == 'staging' && secrets.STAGING_VITE_SUPABASE_URL || secrets.VITE_SUPABASE_URL }}
  VITE_SUPABASE_ANON_KEY: ${{ github.ref_name == 'main' && secrets.PROD_VITE_SUPABASE_ANON_KEY || github.ref_name == 'staging' && secrets.STAGING_VITE_SUPABASE_ANON_KEY || secrets.VITE_SUPABASE_ANON_KEY }}
Until the per-branch secrets exist, the expressions fall back to the
shared secrets, so the current behavior is unchanged.

## Verification checklist

- [ ] db-sync.yml runs green on a push to development (alignment
      only; migrate job does not run for development).
- [ ] New staging project created; 72 migrations applied; table and
      function counts match production.
- [ ] Test-row isolation verified (staging row absent in production).
- [ ] ota-dev / ota-staging / ota-production latest.json track their
      branch tips.
- [ ] Installed staging APK picks up a new bundle after a push
      (no reinstall).
- [ ] APK regenerated once manually when AB asks (npm run
      apk:staging / apk:production); never auto-built on push.

## Open items (not decided here)

- Which live rows in swmbmtvwgksicfnfsehg are test data (cleanup
  decision is AB's).
- AgriShop messaging migrations 0325-0333 exist in the AgriShop repo
  (dev branch, verified 2026-11-23) but are not applied to staging or
  production shop projects; applying them needs AB's go-ahead.
- Vercel project re-auth and Gemini key (see above).
- Live database reads are currently blocked: the registered Supabase
  credential cannot satisfy PostgREST's apikey requirement. A
  Management API token or direct Postgres read access is needed to
  verify live row counts, RLS status, and applied migrations.
