#!/usr/bin/env bash
# Container entrypoint, for both image targets, then hand over to supervisord.
#
# MAURICE_CONTAINER_MODE says which world we are in:
#
#   dev         /app is the Mac's checkout, bind-mounted. Its node_modules hold
#               darwin-arm64 binaries (sharp, above all) and its .venv symlinks
#               point into /opt/homebrew, so named volumes are mounted over those
#               paths and this script fills them the first time.
#
#   production  /app came from the image. Nothing to seed — but the app writes to
#               several repo-relative paths that would then live in the container
#               layer and vanish on the next `docker compose up`, taking the
#               vector store with them. Those get redirected into the volume.
#
# Everything here is idempotent and cheap on a warm container.
set -euo pipefail

MODE="${MAURICE_CONTAINER_MODE:-dev}"
say() { echo "[entrypoint] $*"; }

if [[ "$MODE" == "dev" ]]; then
  # ── node_modules ───────────────────────────────────────────────────────────
  # Seeded from the copies the image built (/opt/deps). "Empty" is the test, not
  # "absent": the volume always exists, it just starts with nothing in it.
  seed_modules() { # <target dir> <staged dir> <label>
    local target="$1" staged="$2" label="$3"
    mkdir -p "$target"
    if [[ -n "$(ls -A "$target" 2>/dev/null)" ]]; then return 0; fi
    say "seeding $label node_modules from the image…"
    cp -a "$staged/." "$target/"
  }
  seed_modules /app/server/node_modules /opt/deps/server/node_modules server
  seed_modules /app/web/node_modules    /opt/deps/web/node_modules    web

  # A stale seed is worse than none: it fails at import time, far from the cause.
  # Compare the manifests the image installed against the ones on disk now.
  for pair in "server:/app/server/package.json:/opt/deps/server/package.json" \
              "web:/app/web/package.json:/opt/deps/web/package.json"; do
    IFS=: read -r label live staged <<<"$pair"
    if ! cmp -s "$live" "$staged"; then
      say "⚠  $label/package.json differs from the one this image installed."
      say "   Rebuild the image (scripts/container.sh build) or dependencies will be stale."
    fi
  done
fi

# ── Writable directories the app assumes ─────────────────────────────────────
# data/, logs/ and tools/corpus/data are repo-relative paths the app writes to
# (data-api/routes/uploads.ts, bank-transactions.ts, dossiers.ts, and the corpus
# vector store). In dev they are volumes, so the container and the macOS install
# never write to the same files.
#
# In production there is no repo, and a directory in the image layer is not
# storage: it is discarded when the container is replaced. Redirect all three
# into the data volume, which is the only thing that survives. Losing this
# redirect would mean losing the vector index on every deploy, silently.
if [[ "$MODE" == "production" ]]; then
  for pair in "data:/app/data" "logs:/app/logs" "corpus:/app/tools/corpus/data"; do
    name="${pair%%:*}"; path="${pair#*:}"
    target="$HOME/.maurice/app/$name"
    mkdir -p "$target" "$(dirname "$path")"
    [[ -L "$path" ]] || { rm -rf "$path"; ln -s "$target" "$path"; }
  done
  say "repo-relative state redirected into $HOME/.maurice/app"

  # The corpus config. It is gitignored (it names absolute paths on the machine
  # that wrote it), so it is not in the image — and without it the gateway does
  # not merely lose a tool, it dies at startup: corpus raises FileNotFoundError
  # before uvicorn finishes booting, and the whole MCP surface goes with it.
  # /opt/maurice/corpus.prod.yaml takes every path from the environment instead.
  CORPUS_CONFIG=/app/tools/corpus/config/corpus.yaml
  if [[ ! -f "$CORPUS_CONFIG" ]]; then
    mkdir -p "$(dirname "$CORPUS_CONFIG")"
    cp /opt/maurice/corpus.prod.yaml "$CORPUS_CONFIG"
    say "installed the production corpus config"
  fi

  # ── Preflight ──────────────────────────────────────────────────────────────
  # Two secrets are load-bearing, and both fail late and badly without this.
  #
  # The embedding key is the worse one: tools/corpus/src/embedder.py builds its
  # OpenAI client at construction, so a missing key raises inside the gateway's
  # lifespan — and the gateway dies whole. Losing semantic search would be a
  # nuisance; losing the gateway also loses the `garden` tool, so Maurice can no
  # longer write a note. A missing search key silently costing you the ability to
  # keep a garden is not a diagnosis anyone would reach unaided.
  #
  # Refusing to start, naming the variable, costs one line and one restart.
  # Only when we are about to start the services. `docker run <image> python3 -c
  # …` is a legitimate thing to do to an image, and refusing it would break the
  # one-off inspection you reach for precisely when something is wrong.
  if [[ "${1:-}" == supervisord ]]; then
    # Only the embedding key. The MODEL key is deliberately not checked here:
    # it does not live in the environment at all — it is a column on the
    # households row (`api_key`), set from /admin after setup, and neither
    # claude.ts nor openaiChat.ts reads a single env var. Demanding one here
    # would refuse to start a perfectly correct fresh install, and send the
    # operator looking for a variable that nothing reads.
    missing=()
    [[ -n "${CORPUS_EMBEDDING_API_KEY:-}" ]] \
      || missing+=("CORPUS_EMBEDDING_API_KEY (embeddings; without it the whole MCP gateway dies, garden included)")
    if (( ${#missing[@]} )); then
      say "✗ refusing to start — required configuration is missing:"
      printf '    - %s\n' "${missing[@]}"
      say "  Set them in the .env beside compose.prod.yml (see .env.prod.example)."
      exit 1
    fi
  fi
fi

mkdir -p /app/data /app/data/tmp /app/logs /app/web/.garden-roots
mkdir -p /app/tools/corpus/data/vectors
mkdir -p /app/web/public/images /app/web/public/avatars

# public/images and public/avatars are volumes (the two installs would otherwise
# fight over the symlinks Astro rewrites there on every start), so the one link
# that IS tracked in git — the bundled demo garden's — has to be put back.
[[ -e /app/web/public/images/demo ]] \
  || ln -s ../../gardens/demo/images /app/web/public/images/demo
mkdir -p "$HOME/.maurice"/{logs,run,gardens,images,files,uploads,avatars,data}

# ── config.toml ──────────────────────────────────────────────────────────────
# data-api/lib/config.ts throws without one (or without MAURICE_DATA_DIR). A
# seeded volume brings the Mac's copy, whose [paths] data_dir is a /Users path
# that does not exist here — so rewrite that one key, and leave everything else
# the seed brought.
CONFIG="$HOME/.maurice/config.toml"
if [[ ! -f "$CONFIG" ]]; then
  say "writing a fresh $CONFIG"
  cat >"$CONFIG" <<EOF
[general]
timezone = "${MAURICE_TIMEZONE:-Europe/Paris}"

[paths]
data_dir = "$HOME/.maurice/data"

[ports]
api = 3001
mcp-gateway = 8710
EOF
elif grep -qE '^\s*data_dir\s*=\s*"?/Users/' "$CONFIG"; then
  say "config.toml carries a macOS data_dir — repointing it at $HOME/.maurice/data"
  sed -i -E "s#^([[:space:]]*data_dir[[:space:]]*=[[:space:]]*).*#\\1\"$HOME/.maurice/data\"#" "$CONFIG"
fi

# ── Python import path ───────────────────────────────────────────────────────
# The Mac resolves the tools' imports through `pip install -e` on every tool
# that ships a pyproject.toml (scripts/install_repo_env.sh). The container does
# not install — the sources are bind-mounted and an editable install would go
# stale on every edit — so it reproduces the *effect* with a .pth file, which is
# the same mechanism pip uses.
#
# A .pth and not PYTHONPATH, and that distinction is load-bearing: PYTHONPATH is
# searched BEFORE the standard library, and tools/calendar then shadows stdlib
# `calendar`, which breaks `http.cookiejar`, which breaks httpx, which makes the
# gateway report "no Python with the deps" and die. Paths from a .pth are
# appended AFTER the stdlib, so tools/calendar stays reachable as a tool without
# displacing the module of the same name. That is why the Mac never hit this.
#
# -L follows the symlinks into the private maurice-tools repo; .venv is pruned
# because it holds a macOS virtualenv that has no business on our path.
SITE_PACKAGES="$(/opt/venv/bin/python -c 'import site; print(site.getsitepackages()[0])')"
{
  echo /app/tools
  find -L /app/tools -maxdepth 3 -name pyproject.toml -not -path '*/.venv/*' 2>/dev/null \
    | while IFS= read -r pyproject; do dirname "$pyproject"; done
} | sort -u >"$SITE_PACKAGES/maurice-tools.pth"
say "$(wc -l <"$SITE_PACKAGES/maurice-tools.pth" | tr -d ' ') tool paths on sys.path (via .pth, after the stdlib)"

# ── Gardens ──────────────────────────────────────────────────────────────────
if [[ ! -f "$HOME/.maurice/gardens/gardens.json" ]]; then
  say "⚠  no gardens.json — no member garden will serve."
  if [[ "$MODE" == "production" ]]; then
    say "   A fresh install: create the admin at /admin, add members at"
    say "   /admin/users/new, then give each one a garden —"
    say "   bun run /app/scripts/provision-member.ts <username>"
  else
    say "   Run scripts/container.sh seed from the host to copy your data in."
  fi
fi

say "ready — $(bun --version) / $(node --version) / $(python3 --version)"
exec "$@"
