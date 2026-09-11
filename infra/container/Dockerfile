# syntax=docker/dockerfile:1

# ─────────────────────────────────────────────────────────────────────────────
# Maurice, on Linux. Two targets from one file.
#
#   --target dev         the everyday container on Candide's Mac. Sources arrive
#                        through a bind mount at /app, so Astro hot-reloads and
#                        an edit is live. Carries Calibre. Sees the private
#                        overlays. NOT deployable — /app is empty in the image.
#
#   --target production  the deliverable. Sources are COPYed in, dependencies
#                        installed in place, no bind mount, no private code.
#                        This is what runs on a rented machine.
#
# ONE container holds the three application processes, in both targets. That is
# deliberate: the Bun server reverse-proxies the MCP gateway and every per-member
# Astro instance over 127.0.0.1 in hard code (server/index.ts), and it starts
# those instances itself from gardens.json. Splitting them into separate compose
# services would mean rewriting that whole layer; sharing one network namespace
# keeps 127.0.0.1 true and needs no application change at all. There is no
# sidecar: the vector store is sqlite-vec, in the same volume as everything else.
# ─────────────────────────────────────────────────────────────────────────────

FROM oven/bun:1.3-debian AS bun

# ═════════════════════════════════════════════════════════════════════════════
# base — runtimes and dependencies. No application code, no Calibre.
# ═════════════════════════════════════════════════════════════════════════════
#
# Ubuntu 26.04, and specifically 26.04, for two reasons that both matter.
#
# Calibre (added by the dev target below). The library is created by Calibre 9.5
# on the Mac (metadata.db user_version 27); Debian bookworm ships 6.13, which
# cannot open it. Trixie ships 8.5, Ubuntu 26.04 ships 9.2.1 — close enough to
# the Mac's to share a library. Upstream's own Linux binary is x86_64-only, so on
# arm64 the distro package is the only option and the distro choice IS the
# Calibre version.
#
# And it is the image running on the Scaleway host, so the OS under the app in
# development is the OS under it in production.
FROM ubuntu:26.04 AS base

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

ENV DEBIAN_FRONTEND=noninteractive

# lsof and procps are not incidental: scripts/_lib.sh resolves "is this port
# already listening" with lsof, and start-all.sh waits on it.
RUN apt-get update && apt-get install -y --no-install-recommends \
      nodejs npm \
      python3 python3-venv python3-dev \
      build-essential \
      git ca-certificates curl \
      lsof procps \
      tini supervisor \
    && rm -rf /var/lib/apt/lists/*

# ── Python ───────────────────────────────────────────────────────────────────
# A venv rather than dist-packages: Ubuntu's python3 is externally managed, and
# a venv also gives scripts/_lib.sh's find_python a single unambiguous answer
# through MAURICE_PYTHON, instead of having it probe its way there.
ENV VIRTUAL_ENV=/opt/venv
RUN python3 -m venv "$VIRTUAL_ENV"
ENV PATH="$VIRTUAL_ENV/bin:$PATH"

# Copied with the repo layout preserved, so the relative `-r ../../tools/…`
# lines in infra/container/requirements.txt resolve and the container's dep set
# cannot drift from the Mac's.
COPY tools/mcp_gateway/requirements.txt tools/mcp_gateway/requirements-tools.txt /build/tools/mcp_gateway/
COPY tools/corpus/requirements.txt /build/tools/corpus/
COPY infra/container/requirements.txt /build/infra/container/
RUN pip install --no-cache-dir --upgrade pip \
 && pip install --no-cache-dir -r /build/infra/container/requirements.txt

COPY infra/container/corpus.prod.yaml /opt/maurice/corpus.prod.yaml
COPY infra/container/supervisord.conf /etc/supervisor/conf.d/maurice.conf
COPY infra/container/entrypoint.sh /usr/local/bin/maurice-entrypoint
RUN chmod +x /usr/local/bin/maurice-entrypoint

# HOME is the application directory's parent: server/lib/appDir.ts resolves
# maurice.db, images/, files/ and uploads/ under $HOME/.maurice when
# MAURICE_DATA_DIR is unset, exactly as the Mac install does. Both targets mount
# a named volume there — never a bind mount, because SQLite locking across a
# macOS→Linux bind mount is not reliable.
ENV HOME=/home/maurice \
    MAURICE_PYTHON=/opt/venv/bin/python \
    RESEARCH_PYTHON=/opt/venv/bin/python \
    PYTHONPATH=/app \
    PYTHONUNBUFFERED=1
RUN mkdir -p /home/maurice

WORKDIR /app
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/maurice-entrypoint"]
CMD ["supervisord", "-c", "/etc/supervisor/conf.d/maurice.conf", "-n"]

# ═════════════════════════════════════════════════════════════════════════════
# dev — Candide's Mac. Bind-mounted sources, Calibre, private overlays.
# ═════════════════════════════════════════════════════════════════════════════
FROM base AS dev

# calibre pulls ~380 packages including the Qt stack, and 1.27 GB. It is needed
# for exactly ONE route — POST /api/v1/calibre/add, the only caller of the
# `calibredb` binary. Every read path (books, chapters, summaries) opens
# metadata.db as plain SQLite and splits EPUBs with the vendored
# tools/calibre/lib scripts, so those need no Calibre at all. That is why the
# production target omits it and stays under 2 GB.
RUN apt-get update && apt-get install -y --no-install-recommends \
      calibre \
      libegl1 libopengl0 libxkbcommon0 \
    && rm -rf /var/lib/apt/lists/*

# node_modules staged, not installed into /app: /app is a bind mount at runtime
# and would bury anything written here. The entrypoint copies these into the
# named volumes mounted over /app/*/node_modules.
COPY server/package.json server/bun.lock /opt/deps/server/
RUN cd /opt/deps/server && bun install --frozen-lockfile

COPY web/package.json web/package-lock.json /opt/deps/web/
RUN cd /opt/deps/web && npm ci

ENV CALIBRE_PYTHON=/opt/venv/bin/python \
    QT_QPA_PLATFORM=offscreen \
    NODE_ENV=development \
    MAURICE_CONTAINER_MODE=dev

# ═════════════════════════════════════════════════════════════════════════════
# production — the deliverable.
# ═════════════════════════════════════════════════════════════════════════════
FROM base AS production

# The sources, for real this time. Dockerfile.dockerignore is an allowlist
# that keeps every private symlink out — the thirteen tools/ entries that point
# into maurice-tools, and web/'s private pages and theme. What lands here is the
# public surface and nothing else; `garden, corpus` is the whole MCP roster, and
# the build fails loudly rather than quietly shipping someone's private repo.
COPY . /app

# Fail the build rather than ship a broken link. Every private tool and every
# private web page is a symlink on the developer's machine; the dockerignore
# keeps the known ones out, but a new one added later would arrive here as a
# dangling symlink and only show up as a mysterious 404 or a missing MCP tool on
# someone else's server. `find -xtype l` is the cheapest possible tripwire.
RUN dangling="$(find /app -xtype l -not -path '*/node_modules/*')"; \
    if [ -n "$dangling" ]; then \
      echo "✗ dangling symlinks in the production image — these point at private"; \
      echo "  repos that are not in the build context. Add them to"; \
      echo "  infra/container/Dockerfile.dockerignore, or make them public:"; \
      echo "$dangling" | sed 's/^/    /'; \
      exit 1; \
    fi

RUN cd /app/server && bun install --frozen-lockfile \
 && cd /app/web && npm ci

# MAURICE_GARDEN_PROFILE=public mirrors what infra/installer/build.sh does for a
# public .pkg: the garden tool exposes its note tools only.
#
# No Calibre in this image, so the routes say so instead of failing at spawn.
ENV NODE_ENV=production \
    MAURICE_CONTAINER_MODE=production \
    MAURICE_GARDEN_PROFILE=public \
    MAURICE_CALIBRE_DISABLED=1
