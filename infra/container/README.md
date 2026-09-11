# Maurice on Linux

The container is the target the product ships as: one Linux image, whether it
runs on Candide's Mac through OrbStack, on a throwaway Scaleway demo instance, or
on a client's own machine. What he develops is what he delivers.

**Two targets from one Dockerfile.** `dev` is the everyday container on the Mac:
sources bind-mounted, Astro hot-reloading, Calibre, the private overlays. It is
*not deployable* — `/app` is empty in the image. `production` is the
deliverable: sources COPYed in, dependencies installed in place, no bind mount,
no private code. See **Deploying** below.

Today it runs **beside** the macOS install, not instead of it. macOS is still
production. This directory exists so the Linux port can be brought to parity
without the household losing a day's service, and it will keep existing after —
the launchd side is what eventually goes away.

```
scripts/container.sh seed      # copy the Mac's data into the volume (once)
scripts/container.sh up        # build + start
scripts/container.sh status    # both installs, side by side
```

The container answers on **http://localhost:13001**. The Mac keeps :3001.

## The two rules

**1. Offset ports outside, normal ports inside.** The container publishes 13001.
Inside, everything listens where `config.toml`,
`gardens.json` and the hardcoded `127.0.0.1:<port>` proxies in `server/index.ts`
already expect it. Nothing is reconfigured — only republished. That means a
setting that works here works unchanged on a real deployment.

Only one port is published, because there is only one ingress. Astro and the MCP
gateway bind `127.0.0.1` and are reached through the Bun server's reverse proxy,
which is where authentication happens. `scripts/container.sh shell` to get behind
them.

**2. The container never touches `~/.maurice`.** Its data lives in the `home`
named volume, filled by `seed` from a *copy*. Two independent reasons, either one
sufficient:

- `server/src/db.ts` migrates the schema at startup. Point a container at the
  live database and it rewrites production, silently, on boot.
- SQLite locking across a macOS→Linux bind mount is not reliable. The corruption
  it produces is the kind you discover much later.

`seed` reads the databases with `VACUUM INTO` over a read-only connection — a
consistent snapshot of a live WAL-mode database, the same reason
`scripts/backup-db.sh` does it that way — and copies the rest with `tar`. It
refuses to overwrite a populated volume without `--force`.

## Why one container and not four services

The Bun server reverse-proxies the MCP gateway and *every per-member Astro
instance* over `127.0.0.1`, in hard code, and starts those instances itself from
`gardens.json`. On this household that is five Astro processes on 4321–4325.
Splitting them into separate compose services would mean rewriting that whole
layer for no gain. One network namespace keeps `127.0.0.1` true and needs no
application change at all.

There is no sidecar. The vector store is **sqlite-vec** — per-member DB files, no
daemon. (Qdrant was the old backend; `corpus.yaml` has said `backend: sqlite_vec`
for a while, and the `qdrant:` block it still carries is a migration reference,
not a running dependency.)

`supervisord` runs the three services using **the same `scripts/start-*.sh` the
launchd agents run** — not container-only copies. A fix to a launch script
reaches both installs.

## What the volumes are for

`/app` is the live checkout, which is what buys the Astro hot reload. Everything
mounted *inside* it is there because the Mac's copy of that path would be wrong
or shared:

| Path | Why it cannot be the Mac's |
|---|---|
| `server/node_modules`, `web/node_modules` | darwin-arm64 binaries (sharp) that cannot load on Linux |
| `data`, `logs` | repo-relative paths both servers write to at once |
| `web/.garden-roots` | per-instance Astro roots, rebuilt per install |
| `web/public/images`, `web/public/avatars` | symlinks `download-images.ts` rewrites at every Astro start — shared, the two installs break each other's |
| `tools/corpus/data` | the sqlite-vec vector store — it lives in the *repo tree*, so the bind mount had the container and the Mac writing to one SQLite file across virtiofs |
| `/home/maurice/.maurice` | the application's own state; see rule 2 |

The node_modules volumes are seeded by the entrypoint from copies the image
built. When `server/package.json` or `web/package.json` changes, the entrypoint
says so and you rebuild — it will not silently run stale dependencies.

## Calibre, and why the base image is Ubuntu 26.04

The `calibredb` binary is needed for exactly **one route** — `POST
/api/v1/calibre/add`. Every read path (books, chapters, summaries) opens
`metadata.db` as plain SQLite and splits EPUBs with the vendored
`tools/calibre/lib` scripts, so those need no Calibre at all.

But that one route decides the whole base image. The library here is written by
Calibre 9.5 (`metadata.db` `user_version` 27); Debian bookworm ships 6.13, which
cannot open it. Trixie ships 8.5. **Ubuntu 26.04 ships 9.2.1**, which opens it,
lists it, and does not migrate it — verified. Upstream's own Linux build is
x86_64-only, so on arm64 the distro package is the only option and the distro
choice *is* the Calibre version. Ubuntu 26.04 is also the image on the Scaleway
host, so the OS under the app in development is the OS under it in production.

It costs 1.27 GB (the image is 3.15 GB) and about 380 packages. Qt runs headless
via `QT_QPA_PLATFORM=offscreen`.

A side effect worth naming: Ubuntu's python3.14 has a **working pyexpat**, which
is the only reason `.venv-calibre` exists on the Mac (Homebrew's python@3.14
ships a broken one). The container needs one venv, not two.

## Still open

**TLS.** Off by default. `server/certs/server.crt` arrives through the bind mount
but is a Tailscale cert for the Mac's tailnet name, so the container ignores it:
`MAURICE_TLS_CERT`/`_KEY` point at `~/.maurice/tls/` inside the volume. Put a
cert and key there to serve HTTPS.

**Hot reload, for the server.** Astro reloads on edit. The Bun server does not —
`scripts/start-api.sh` runs `bun run index.ts`, with no `--watch`, on macOS too.
`scripts/container.sh restart api` is the equivalent of
`scripts/service.sh restart api`.

**`astro dev` in production.** Five Vite dev servers are 87 % of this
container's memory, and shipping one to a client is not tenable. The way out is
already half-built: `src/lib/notes-fs.ts` reads notes off disk at request time
(written because the content-layer store kept collapsing), so a *built* SSR
server would still show a note the moment Maurice writes it. What remains is the
other collections and an `@astrojs/node` adapter for the SSR path.

**Repo-tree state.** `tools/corpus/data`, `data/uploads` and `logs/` are
repo-relative paths the app writes to. Volumes hide the problem here; a shipped
install has no repo at all. These belong under the data dir.

## Three dev overlays

A development checkout reaches outside itself in three ways. Each gets its own
compose file, layered on by `scripts/container.sh` only when what it mounts
exists — independently, because a checkout can have one without the others. All
three mount a host directory at the **identical absolute path** inside the
container, so no path stored on the host (a symlink target, a database row) has
to be rewritten.

| file | mounts | why |
|---|---|---|
| `compose.overlay-web.yml` | the private `maurice-web` repo | `web/src/pages/books`, `web/themes/candide` … are gitignored symlinks into it; dangling, `astro dev` dies with ENOENT before it binds |
| `compose.overlay-tools.yml` | the private `maurice-tools` repo | **thirteen** entries under `tools/` symlink into it; without it the gateway comes up with 2 tools instead of 14 |
| `compose.overlay-calibre.yml` | the Calibre library | read-only, because `metadata.db` is SQLite and two Calibres across virtiofs is the hazard rule 2 exists for |

The tools mount point is not a choice: those symlinks are *relative*
(`../../maurice-tools/<tool>`), so from `/app/tools` they resolve to
`/maurice-tools`. The symlinks tell us where to mount.

**Read-only has one consequence to know about:** Calibre writes a probe file
into the library directory even for a plain `list`, so `calibredb` cannot run
against it at all. Reads work (they open `metadata.db` directly); `POST /add`
fails loudly. That is the right answer while the Mac owns the library, and a
shipped install has no such conflict — the container owns its library, in a
volume, and none of these files are used.

## How the tools' imports resolve

The Mac runs `pip install -e` on every tool with a `pyproject.toml`
(`scripts/install_repo_env.sh`). The container does not install — the sources
are bind-mounted, and an editable install would go stale on every edit — so the
entrypoint writes a `.pth` file into the venv's site-packages instead, which is
the same mechanism pip uses.

**A `.pth` and not `PYTHONPATH`, and the distinction is load-bearing.**
`PYTHONPATH` is searched *before* the standard library, so `tools/calendar`
shadows stdlib `calendar` → `http.cookiejar` breaks → `httpx` breaks → the
gateway reports "no Python with the deps" and dies, ten minutes from anything
that looks like the cause. Paths from a `.pth` are appended *after* the stdlib.
That is why the Mac never hit this, and why the fix is not "add another
directory to PYTHONPATH".

## Deploying

```
scripts/deploy.sh <ssh-host> [tag]
```

Three things travel: the image, `compose.prod.yml` and `Caddyfile`. The `.env`
stays on the host — it holds the keys, and the deploy script refuses to write it.

**The machine is prepared by `infra/cloud-init/maurice.yaml`**, which installs
Docker and a user and nothing else. It is plain cloud-init with no provider
metadata, so it runs the same on Scaleway, Hetzner, OVH, a client's own server,
or a Linux VM on a Mac mini — which is what keeps that last option open for free.
It is deliberately not a deployer: the image lives in a private registry it has
no business holding credentials for, and doing the deploy by hand a couple of
times is how you find out what the automation should say.

**The image is built on the Mac**, arm64 → arm64, and pushed. A 2 vCPU instance
would spend a long time on `bun install` and `npm ci`, and there is no
cross-compilation to get wrong.

### Reaching /admin on a deployed instance

You cannot, through the public name — and that is deliberate.
`server/src/routes/web-admin.ts` refuses any request whose `Host` is not
localhost, and separately refuses anything carrying Cloudflare's edge headers.
The admin console has no business being on the public internet.

So the application is also published on the host's **loopback** (127.0.0.1:3001,
never 0.0.0.0), and you reach it the way you reach any private service:

```
ssh -L 3001:localhost:3001 <host>
# then open http://localhost:3001/admin
```

The Host header is then `localhost:3001`, which is what the check wants. Without
this you could not run `/admin/setup` at all — the instance would come up and be
unconfigurable.

### What is different in production

| | dev | production |
|---|---|---|
| sources | bind-mounted | in the image |
| MCP tools | 14 (via the overlays) | **2** — `garden`, `corpus` |
| Calibre | yes (1.27 GB) | no |
| image | 3.15 GB | 2.03 GB |
| TLS | off | Caddy + Let's Encrypt |
| published ports | 13001 | 80, 443 (Caddy only) |

The two-tool roster is the point, not a limitation: it is the same public
surface `infra/installer/build.sh --public` ships, and the build **fails** on a
dangling symlink rather than quietly including a private repo.

### Two things production had to fix that dev never noticed

**Repo-relative state.** `data/`, `logs/` and `tools/corpus/data` are paths the
app writes to inside the repo. In dev they are volumes. In production there is no
repo, and a directory in the image layer is not storage — it is discarded when
the container is replaced. The entrypoint symlinks all three into the data
volume. Without that, every deploy would silently drop the vector index.

**The corpus config.** `tools/corpus/config/corpus.yaml` is gitignored (it names
absolute paths on the machine that wrote it), so it is not in the image — and
corpus does not merely fail to load without it, it takes the whole MCP gateway
down at startup, `garden` included. The entrypoint installs
`corpus.prod.yaml`, whose every path comes from the environment. The same
fragility is why a missing `CORPUS_EMBEDDING_API_KEY` makes the container refuse
to start with one line instead of a crash-loop: a missing *search* key silently
costing you the ability to *write a note* is not a diagnosis anyone reaches
unaided.

## Giving a member a garden

`createUser` creates a row in `maurice.db` and stops there. It does not create
the garden directory, and it does not add the member to `gardens.json` — which
nothing in the repo writes. So on a fresh install a member exists, can log in,
and `/g/<them>` answers "Garden not available".

```
bun run scripts/provision-member.ts <username>
```

is the missing half: the garden skeleton, and the manifest entry on the next free
port. Idempotent, and it refuses a username that is not in the database.

## Known, and the same on macOS

*(The `demo` garden used to be here: no port in `gardens.json`, so the
member-garden loop tried to start it and failed after 30s, on both installs.
Fixed on 10 September by skipping manifest entries with no port.)*
