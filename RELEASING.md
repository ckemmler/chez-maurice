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
  git tag server-v1.0.1      -m "server pkg"                       # server
  git push --tags
  ```
  App Store Connect also keeps a per-platform build history under TestFlight.

## 1. Server `.pkg` (notarized, direct download)

```
MAURICE_VERSION=1.0.1 \
MAURICE_SIGN_IDENTITY="Developer ID Application: Candide Kemmler (33DB976938)" \
MAURICE_INSTALLER_IDENTITY="Developer ID Installer: Candide Kemmler (33DB976938)" \
MAURICE_NOTARY_PROFILE="maurice-notary" \
./infra/installer/build.sh --public
```
Output: `infra/installer/ChezMaurice.pkg` (signed + notarized + stapled; gitignored).
Unset the `MAURICE_*` vars for a plain unsigned local build — useless as a public
download, since Gatekeeper blocks it on any Mac but this one.

**`--public` is required for the hosted download.** It ships only the note tools of
the MCP gateway; a full build hands every internal tool (coaching, calibre, akita
pipelines) to anyone who downloads the installer.

Signing needs the login keychain **unlocked in the same session** as the build —
`codesign` reads the Developer ID private key from it, and `notarytool` reads the
`maurice-notary` credentials. Over SSH each login gets its own keychain session, so
unlocking in another terminal does not carry:
```
security unlock-keychain ~/Library/Keychains/login.keychain-db
```

### Publish it
```
scripts/deploy-landing.sh          # copies the .pkg into design/landing/, wrangler pages deploy
```
Needs a Cloudflare API token with **`Account → Cloudflare Pages → Edit`** (the
zone-scoped `server/.secrets/cloudflare-token` used for tunnels will NOT work — it
has no account-level access), plus the account id:
```
CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… scripts/deploy-landing.sh
```
The edge may serve the previous object for a few seconds after the deploy; re-check
before concluding anything went wrong. Verify what users actually get:
```
curl -sLO https://www.chezmaurice.eu/ChezMaurice.pkg
spctl -a -vvv -t install ChezMaurice.pkg     # expect: accepted / Notarized Developer ID
xcrun stapler validate ChezMaurice.pkg
```

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

`design/landing/index.html` hardcodes all three in the markup (no JS wiring):
- **server** → `https://www.chezmaurice.eu/ChezMaurice.pkg`, published by
  `scripts/deploy-landing.sh` alongside the site itself.
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
