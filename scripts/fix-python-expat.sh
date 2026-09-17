#!/usr/bin/env bash
# Repair Homebrew's python@3.14 against macOS 26's older system libexpat.
#
# The bottle's pyexpat is built against a recent expat (2.7.2+, which is what
# Homebrew has) but linked against /usr/lib/libexpat.1.dylib, which macOS 26
# ships at an older version. Loading the module then fails on a missing symbol:
#
#   Symbol not found: _XML_SetAllocTrackerActivationThreshold
#
# That breaks far more than XML parsing: plistlib imports pyexpat, and
# platform.mac_ver() reads a plist, so `pip install` dies on startup and `uv`
# rejects the interpreter outright ("Broken Python installation"). Every tool
# in the repo venv is unable to install anything until this is fixed.
#
# The repair points the module at Homebrew's own libexpat, which does have the
# symbol, and re-signs it (install_name_tool invalidates the ad-hoc signature).
#
# It lives in the Cellar, so **a `brew upgrade python@3.14` undoes it**. Both
# 3.14.5 and 3.14.7 shipped broken; re-run this after any Python upgrade, and
# drop the script once a bottle links expat correctly.
set -euo pipefail

PYTHON_FORMULA="${PYTHON_FORMULA:-python@3.14}"
BREW_PREFIX="$(brew --prefix)"
EXPAT_LIB="$BREW_PREFIX/opt/expat/lib/libexpat.1.dylib"
SYSTEM_LIB="/usr/lib/libexpat.1.dylib"
SYMBOL="_XML_SetAllocTrackerActivationThreshold"

if [[ ! -f "$EXPAT_LIB" ]]; then
  echo "[expat] Homebrew expat missing — installing"
  brew install expat
fi

if ! nm -gU "$EXPAT_LIB" 2>/dev/null | grep -q "${SYMBOL#_}"; then
  echo "[expat] ERROR: $EXPAT_LIB does not export $SYMBOL either." >&2
  echo "[expat] Nothing to point the module at; not touching anything." >&2
  exit 1
fi

PREFIX="$(brew --prefix "$PYTHON_FORMULA")"
# Versions/ carries both the real "3.14" and a "Current" symlink to it; taking
# the glob wholesale would hand us the same directory twice.
DYNLOAD=""
for candidate in "$PREFIX"/Frameworks/Python.framework/Versions/*/lib/python*/lib-dynload; do
  [[ -d "$candidate" && "$candidate" != */Versions/Current/* ]] || continue
  DYNLOAD="$candidate"
  break
done
if [[ -z "$DYNLOAD" ]]; then
  echo "[expat] ERROR: no lib-dynload under $PREFIX" >&2
  exit 1
fi

patched=0
for module in "$DYNLOAD"/*.so; do
  otool -L "$module" 2>/dev/null | grep -q "$SYSTEM_LIB" || continue
  name="$(basename "$module")"
  echo "[expat] Repointing $name at Homebrew expat"
  # The Cellar is read-only for the group; restore the mode afterwards.
  mode="$(stat -f '%Lp' "$module")"
  chmod u+w "$module"
  install_name_tool -change "$SYSTEM_LIB" "$EXPAT_LIB" "$module"
  # install_name_tool invalidates the signature, and an unsigned .so will not
  # load at all on Apple silicon. Ad-hoc is what the bottle itself uses.
  codesign --force --sign - "$module" 2>/dev/null
  chmod "$mode" "$module"
  patched=$((patched + 1))
done

if (( patched == 0 )); then
  echo "[expat] Nothing linked against $SYSTEM_LIB — already repaired, or fixed upstream."
  exit 0
fi

echo "[expat] Verifying"
"$PREFIX/bin/python3" - <<'PY'
import platform, plistlib, pyexpat  # noqa: F401  — the three that were failing
assert platform.mac_ver()[0], "platform.mac_ver() still empty"
print(f"[expat] OK — python {platform.python_version()} on macOS {platform.mac_ver()[0]}")
PY
