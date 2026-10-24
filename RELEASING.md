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

The site at `www.chezmaurice.eu` — the landing, the pricing, the legal pages the
apps link to, the self-host guide at `/docs` — is not in this repository. It lives
with the tower (sign-up, trial, accounts) in the private `chezmaurice-tower`
repository, under `site/`, and is published from there (`./deploy-site.sh`). It
was `design/landing/` here until 24 October 2026. What this repository keeps is
the generic publisher it uses, `ops/static-site.sh`.

**The notarized `.pkg` is retired.** Maurice ships as a container image since
14 September 2026; the old `www.chezmaurice.eu/ChezMaurice.pkg` URL redirects to
the container guide.

## 2 & 3. macOS + iOS apps → TestFlight

```
# macOS
PROVISIONING_PROFILE_MACOS="Maurice macOS App Store" PLATFORMS=macos \
ASC_KEY_ID=<key id> ASC_ISSUER_ID=<issuer id> \
./app/build-testflight.sh

# iOS (iPhone + iPad, universal) — version from app/VERSION, build from ASC
PROVISIONING_PROFILE_IOS="Maurice iOS App Store" PLATFORMS=ios \
ASC_KEY_ID=<key id> ASC_ISSUER_ID=<issuer id> \
./app/build-testflight.sh

# both at once: PLATFORMS="macos ios" and set both PROVISIONING_PROFILE_* vars
```
Builds appear under TestFlight in App Store Connect after a few minutes' processing.

The key and the issuer are those of the company team (see below): the app's
record lives there, and a key of the individual team cannot see it.

## Signing assets (in the login Keychain / Provisioning Profiles dir — not in git)

Two developer teams since October 2026. The app (macOS + iOS, bundle id
`eu.chezmaurice.maurice`, App Store Connect app `6822024416`) belongs to the
company, **Palacehotel Software sprl** (`F5B4ZC8LEU`), and so does Carnet
(bundle id `eu.chezmaurice.carnet.app`, share extension `….app.share`, App Group
`group.eu.chezmaurice.carnet.app`). The server's Developer ID signing stays on
the individual team, **Candide Kemmler** (`33DB976938`).

| Asset | Identifier | Used by |
|---|---|---|
| Team — apps | `F5B4ZC8LEU` (Palacehotel Software sprl) | app (macOS+iOS), Carnet |
| Team — server | `33DB976938` (Individual) | server `.pkg` |
| Developer ID Application | `Developer ID Application: Candide Kemmler (33DB976938)` | server bun/binaries |
| Developer ID Installer | `Developer ID Installer: Candide Kemmler (33DB976938)` | server `.pkg` |
| Apple Distribution | `Apple Distribution: Palacehotel Software sprl (F5B4ZC8LEU)` | app (macOS+iOS), Carnet |
| Mac Installer Distribution | `3rd Party Mac Developer Installer: Palacehotel Software sprl (F5B4ZC8LEU)` | macOS App Store `.pkg` |
| Profile — macOS App Store | `Maurice macOS App Store` (on `F5B4ZC8LEU`, expires 13 Oct 2027) | macOS app export |
| Profile — iOS App Store | `Maurice iOS App Store` (on `F5B4ZC8LEU`, expires 13 Oct 2027) | iOS app export |
| API key — notarization | `TJBDUXNG6C` (Developer role, individual team) | `notarytool` (`maurice-notary` profile) |
| API key — signing/upload | `LJ382ZY7ZA` (App Manager role, company team) | `xcodebuild` cloud signing + TestFlight upload, Carnet's `build-testflight.sh` |
| API key Issuer ID — individual team | `81a9b8ba-55cc-43cb-bc93-00e73c673425` | the individual team's keys |
| API key Issuer ID — company team | `69a6de7a-d21a-47e3-e053-5b8c7c11a4d1` | the company team's key |
| APNs key | `B42HPU8U77` (company team, all topics), named to the server with `APNS_KEY_ID` | push to the app and to Carnet |

The server signs every push with that one key (`apns.ts`): the key file is
`server/.secrets/AuthKey_<key id>.p8`, or the path in `APNS_KEY_PATH`.

`.p8` keys live in `~/.appstoreconnect/private_keys/`. To rebuild this Mac (or set
up CI), re-create/import these. Provisioning profiles install to
`~/Library/MobileDevice/Provisioning Profiles/<UUID>.{provisionprofile,mobileprovision}`.

## TestFlight: one link for all platforms

It's **one app record** (bundle id `eu.chezmaurice.maurice`, both platforms), so a
**single TestFlight public link covers iPhone, iPad, and Mac** — the TestFlight
app on each device serves the right build (iOS build is universal iPhone/iPad).
Create it in App Store Connect → your app → **TestFlight → (external group) →
Enable Public Link**, then paste that URL into both the `mac` and `ios` cards.

## CI (future)

`release-server.yml` / `release-*.yml` aren't set up. The repo is now public at
`github.com/ckemmler/chez-maurice`, so nothing blocks it: export the certs above
into a single `.p12`, add the `.p12` + the App Manager `.p8` + key-id/issuer +
an ssh key for the fleet's host as Actions secrets, and the workflow
runs these same scripts on a tag.
