# Environments

Three branches, three sites, three update channels. A farmer installs one build;
it listens to exactly one channel for the rest of its life.

| | Branch | Site | OTA channel | App |
|---|---|---|---|---|
| **Development** | `development` | https://farmer-app-dev-97xtwn.freebuff.site | `ota-dev` | Farmer Dev (`pk.agrishop.farmer.dev`) |
| **Staging** | `staging` | https://farmer-app-staging-i1iih6.freebuff.site | `ota-staging` | Farmer Staging (`pk.agrishop.farmer.staging`) |
| **Production** | `main` | https://farmer-app-production-8sc6a2.freebuff.site | `ota-production` | Farmer (`pk.agrishop.farmer`) |

The three Android packages are separate ids, so all three install side by side on
one phone and a tester never has to uninstall the app to try the next one.

## What happens on a push

Pushing to any of the three branches starts two workflows:

- **CI** (`.github/workflows/ci.yml`) — type check, design conformance, migration
  chain, Edge Function contracts, the full test suite, a production build, the
  backup/restore drill and the bounded-load check. It runs on `main` and on pull
  requests; the scheduled run additionally asks the live vendors.
- **OTA bundle** (`.github/workflows/ota.yml`) — builds the web layer for that
  branch's environment, packs it, and publishes it to the matching release tag.
  An installed app on that channel picks it up on its next launch. The bundle is
  ~0.9 MB because it is the web layer only, not the model or the shell.

Client values (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`,
`VITE_MARKETPLACE_URL`, `VITE_MARKETPLACE_KEY`) live in repository secrets, so a
workflow run never needs a developer's machine. Without them the publish step
refuses to run and says so, rather than shipping a bundle with an empty backend.

## What is *not* automatic yet

- **Site deploys.** The three site URLs are built and published by hand today
  (`VITE_APP_ENV=<env> VITE_OTA_BASE=<channel> npx vite build --outDir dist-<env>`,
  then the deploy manifest in `web/`). Automating this in CI needs a deploy token
  for the hosting account as a fourth secret; until then a site is one command
  behind the branch.
- **One backend.** All three environments point at the same Supabase project and
  the same marketplace, because there is one set of credentials. Separating them
  is a Supabase project per environment and one more secret each — the code
  already reads them per environment, so it is configuration, not a code change.

## iOS

The iOS project exists (`ios/`, Capacitor 8, purpose strings in `Info.plist`) and
builds the same web assets as Android, but it can only be compiled on macOS with
Xcode, and an App Store or TestFlight build needs an Apple Developer account and a
provisioning profile. Until then the installable iOS path is the PWA: open the
environment URL in Safari and *Share → Add to Home Screen*.

## Push notifications

`device_push_tokens` holds one row per device, written by the app through
`register_push_token`. `supabase/functions/notify-shop-owner` sends to those
devices over FCM HTTP v1 and answers `503 not-configured` until these are set:

- `FCM_SERVICE_ACCOUNT` — the Firebase service-account JSON, as one line
- `FCM_PROJECT_ID` — the Firebase project id

Android needs the `google-services.json` for the production flavour (already wired
in `android/app/build.gradle`); iOS needs the APNs key uploaded to the same
Firebase project.
