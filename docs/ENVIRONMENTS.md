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

Configured and deployed. The chain, end to end:

  1. The owner taps *Enable notifications* on their shop card, which asks for the
     permission at the moment the reason is on screen and calls
     `register_push_token` (`src/services/push.ts`).
  2. `device_push_tokens` keeps one row per device — a counter phone and a
     personal one are two rows, and registering the same install twice updates
     its row instead of duplicating the notifications.
  3. A farmer scanning the shop's QR inserts a `dealer_farmer_links` row with
     `established_by = 'shop_qr'`, and the trigger `dealer_farmer_links_notify_shop`
     queues a `net.http_post` to the function. It is asynchronous on purpose: a
     delivery failure loses a notification, never the farmer's join.
  4. `supabase/functions/notify-shop-owner` signs a service-account JWT with
     WebCrypto, exchanges it for an FCM access token, and sends over FCM HTTP v1.
     Tokens FCM reports as gone are deleted, so an uninstalled phone is not retried
     forever.

Project state (applied, not a to-do):

- Supabase secrets `FCM_SERVICE_ACCOUNT` and `FCM_PROJECT_ID` (`farmer-app-c4590`),
  and `SHOP_PUSH_TOKEN`, the shared secret the trigger presents as its caller proof.
  It is a purpose-made token rather than the service-role key: one caller does not
  need the key that opens every table.
- The same token in Vault as `shop_push_token`, which the trigger reads. It lives in
  Vault, not in the migration, because a key in version control is a published key.
  Without it the trigger logs a warning and the join still commits.
- `supabase/config.toml` turns the gateway's JWT check off for this one function
  (`verify_jwt = false`), because a database trigger has no JWT to present; the
  function's own token check is the door, and a caller without the token gets 403.
- `android/app/google-services.json` for `pk.agrishop.farmer`, the production
  flavour. The `.dev` and `.staging` ids have no Firebase client and their services
  tasks stay switched off, so those builds register for nothing.

The service-account key itself sits in `.secrets/firebase-service-account.json`,
which is git-ignored, and is never read by the app; it is only ever uploaded as a
function secret.

What is still missing, and it is Apple's to give: iOS delivery needs an APNs
`.p8` key uploaded to the same Firebase project, which needs an Apple Developer
account. Until then the iOS build can request permission and register a token, but
FCM cannot reach it.
