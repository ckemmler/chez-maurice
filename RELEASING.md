# Releasing Chez Maurice

Three artifacts, three one-command builds. All signing/notarization is driven by
env vars; nothing secret is committed.

## Versioning

- **Marketing version** (`VERSION`, `MAURICE_VERSION`): what users see, e.g. `1.0.0`.
  Apple requires 1–3 dot-separated integers — **no `-beta` suffix**.
- **Build number**: auto-set to the git commit count (monotonic); override with
  `BUILD=<n>` for a re-upload of the same commit. Must strictly increase per upload.
- **"beta" + history**: every TestFlight build is a beta by definition. Record the
  human label and history with **git tags** after each successful build:
  ```
  git tag app-v1.0.0-beta.1 -m "macOS+iOS TestFlight build 301"   # apps
  git tag server-v1.0.0      -m "server pkg"                       # server
  git push --tags            # once a remote exists
  ```
  App Store Connect also keeps a per-platform build history under TestFlight.

## 1. Server `.pkg` (notarized, direct download)

```
MAURICE_VERSION=1.0.0 \
MAURICE_SIGN_IDENTITY="Developer ID Application: Candide Kemmler (33DB976938)" \
MAURICE_INSTALLER_IDENTITY="Developer ID Installer: Candide Kemmler (33DB976938)" \
MAURICE_NOTARY_PROFILE="maurice-notary" \
./infra/installer/build.sh            # add --public for the public (note-tools-only) build
```
Output: `infra/installer/ChezMaurice.pkg` (signed + notarized + stapled; gitignored).
Unset the `MAURICE_*` vars for a plain unsigned local build.

## 2 & 3. macOS + iOS apps → TestFlight

```
# macOS
PROVISIONING_PROFILE_MACOS="Maurice macOS App Store" PLATFORMS=macos \
VERSION=1.0.0 ASC_KEY_ID=2MFNJ8HD9A ASC_ISSUER_ID=81a9b8ba-55cc-43cb-bc93-00e73c673425 \
./app/build-testflight.sh

# iOS (iPhone + iPad, universal)
PROVISIONING_PROFILE_IOS="Maurice iOS App Store" PLATFORMS=ios \
VERSION=1.0.0 ASC_KEY_ID=2MFNJ8HD9A ASC_ISSUER_ID=81a9b8ba-55cc-43cb-bc93-00e73c673425 \
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

`design/landing/index.html` has three cards with `href="#"` placeholders
(`data-dl="server|mac|ios"`):
- **server** → the hosted `.pkg` URL (needs a host: a GitHub Release asset, or
  upload to chezmaurice.eu / object storage). No stable URL exists yet.
- **mac** and **ios** → the **same TestFlight public link** (see below).

## TestFlight: one link for all platforms

It's **one app record** (bundle id `eu.chezmaurice.app`, both platforms), so a
**single TestFlight public link covers iPhone, iPad, and Mac** — the TestFlight
app on each device serves the right build (iOS build is universal iPhone/iPad).
Create it in App Store Connect → your app → **TestFlight → (external group) →
Enable Public Link**, then paste that URL into both the `mac` and `ios` cards.

## CI (future)

`release-server.yml` / `release-*.yml` aren't set up — blocked on putting the
repos on GitHub (no remote yet). When ready: export the certs above into a single
`.p12`, add the `.p12` + the App Manager `.p8` + key-id/issuer as Actions secrets,
and the workflow runs these same scripts on a tag.
