# Releasing Chez Maurice

Three artifacts, three one-command builds. All signing/notarization is driven by
env vars; nothing secret is committed.

## Versioning

- **Marketing version** (`VERSION`, `MAURICE_VERSION`): what users see, e.g. `1.0.0`.
  Apple requires 1–3 dot-separated integers — **no `-beta` suffix**.
- **Build number**: auto-set to the git commit count (monotonic); override with
  `BUILD=<n>` for a re-upload of the same commit. Must strictly increase per upload.
- **Distribution policy (2026-09-11): external testers, version frozen at `1.0.0`.**
  Apple reviews TestFlight builds *per version string*, not per build. `1.0.0`
  is approved, so every `1.0.0 (N)` reaches external testers the moment it is
  processed — no Beta App Review, ever, as long as `app/VERSION` stays `1.0.0`.
  Testers need only the TestFlight app and their invitation code (or the public
  link, if enabled on the "Beta" group). Internal testing is NOT used: it makes
  every tester a member of the Apple developer team, and a child account cannot
  be one at all. Bump the version only when you want a review — i.e. for the
  App Store.

- **Versions are not typed by hand any more.** The marketing version lives in
  `app/VERSION` (one file, in git). The build number is asked of App Store
  Connect — `app/asc-build-info.ts` reports the highest already uploaded, and the
  build is that plus one.

  This replaced the git commit count, which lied: it read 316 in June and 128 in
  September, because the history was rewritten for the public release. The next
  1.0.x upload would have been rejected as a regression, for a reason nothing on
  this machine could have explained. `build-testflight.sh` also now refuses a
  version lower than one already uploaded (a 0.2.0 went out after a 1.0.0 before
  the check existed); `ALLOW_VERSION_DOWNGRADE=1` if you ever mean it.

  So a release is: edit `app/VERSION`, run the script. Pass `BUILD=` only when
  App Store Connect is unreachable and you know what you are doing.

- **"beta" + history**: every TestFlight build is a beta by definition. Record the
  human label and history with **git tags** after each successful build:
  ```
  git tag app-v1.0.0-beta.1 -m "macOS+iOS TestFlight build 301"   # apps
  git tag server-v1.0.1      -m "server pkg"                       # server
  git push --tags
  ```
  App Store Connect also keeps a per-platform build history under TestFlight.

## 1. The landing site

**The notarized `.pkg` is retired.** Maurice ships as a container image since
14 September 2026 — one build, one set of assumptions about the host. The
installer that used to be built here (`infra/installer/build.sh`, signed,
notarized, stapled, published at `www.chezmaurice.eu/ChezMaurice.pkg`) is no
longer produced and no longer offered: the site points at the container guide in
`design/landing/docs.html` instead, and the old download URL is left to 404.

### Publish the site
```
scripts/deploy-landing.sh          # wrangler pages deploy design/landing/
```
Needs a Cloudflare API token with **`Account → Cloudflare Pages → Edit`** (the
zone-scoped `server/.secrets/cloudflare-token` used for tunnels will NOT work — it
has no account-level access), plus the account id:
```
CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… scripts/deploy-landing.sh
```
The edge may serve the previous object for a few seconds after the deploy; re-check
before concluding anything went wrong.

## 2 & 3. macOS + iOS apps → TestFlight

```
# macOS
PROVISIONING_PROFILE_MACOS="Maurice macOS App Store" PLATFORMS=macos \
ASC_KEY_ID=2MFNJ8HD9A ASC_ISSUER_ID=81a9b8ba-55cc-43cb-bc93-00e73c673425 \
./app/build-testflight.sh

# iOS (iPhone + iPad, universal) — version from app/VERSION, build from ASC
PROVISIONING_PROFILE_IOS="Maurice iOS App Store" PLATFORMS=ios \
ASC_KEY_ID=2MFNJ8HD9A ASC_ISSUER_ID=81a9b8ba-55cc-43cb-bc93-00e73c673425 \
./app/build-testflight.sh

# both at once: PLATFORMS="macos ios" and set both PROVISIONING_PROFILE_* vars
```
Builds appear under TestFlight in App Store Connect after a few minutes' processing.

## Signing assets (in the login Keychain / Provisioning Profiles dir — not in git)

| Asset | Identifier | Used by |
|---|---|---|
| Apple Developer Team | `33DB976938` (Individual) | everything |
| Developer ID Application | `Developer ID Application: Candide Kemmler (33DB976938)` | server bun/binaries |
| Developer ID Installer | `Developer ID Installer: Candide Kemmler (33DB976938)` | server `.pkg` |
| Apple Distribution | `Apple Distribution: Candide Kemmler (33DB976938)` | app (macOS+iOS) |
| Mac Installer Distribution | `3rd Party Mac Developer Installer: Candide Kemmler (33DB976938)` | macOS App Store `.pkg` |
| Profile — macOS App Store | `Maurice macOS App Store` (UUID `793e8ceb-94af-4fdb-8296-8fae1d969052`) | macOS app export |
| Profile — iOS App Store | `Maurice iOS App Store` (UUID `04e0882d-1e14-49a4-9961-069525d47def`) | iOS app export |
| API key — notarization | `TJBDUXNG6C` (Developer role) | `notarytool` (`maurice-notary` profile) |
| API key — signing/upload | `2MFNJ8HD9A` (App Manager role) | `xcodebuild` cloud signing + TestFlight upload |
| API key Issuer ID | `81a9b8ba-55cc-43cb-bc93-00e73c673425` | both keys |

`.p8` keys live in `~/.appstoreconnect/private_keys/`. To rebuild this Mac (or set
up CI), re-create/import these. Provisioning profiles install to
`~/Library/MobileDevice/Provisioning Profiles/<UUID>.{provisionprofile,mobileprovision}`.

## Download links (landing page)

`design/landing/index.html` hardcodes them in the markup (no JS wiring):
- **server** → `/docs#start`, the container install guide. There is no binary to
  download any more; see §1.
- **mac** and **ios** → the **same TestFlight public link** (see below).

## TestFlight: one link for all platforms

It's **one app record** (bundle id `eu.chezmaurice.app`, both platforms), so a
**single TestFlight public link covers iPhone, iPad, and Mac** — the TestFlight
app on each device serves the right build (iOS build is universal iPhone/iPad).
Create it in App Store Connect → your app → **TestFlight → (external group) →
Enable Public Link**, then paste that URL into both the `mac` and `ios` cards.

## CI (future)

`release-server.yml` / `release-*.yml` aren't set up. The repo is now public at
`github.com/ckemmler/chez-maurice`, so nothing blocks it: export the certs above
into a single `.p12`, add the `.p12` + the App Manager `.p8` + key-id/issuer +
`CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` as Actions secrets, and the workflow
runs these same scripts on a tag.
