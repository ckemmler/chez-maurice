# Running a fleet of Maurices

This directory is the operator's toolbox for the instances Candide runs on
behalf of friends. It is deliberately small: an inventory, a handful of short
commands over it, and a note on which off-the-shelf tools do the rest. Nothing here is a product, and
nothing here sees a household's data — the only thing an instance tells the
operator is its technical health.

## What an instance exposes

`GET /healthz` on every server has two faces:

| Face | Who | Fields |
|---|---|---|
| public | anyone (uptime probes, the apps) | `status`, `service`, `version` |
| full | `Authorization: Bearer maur_…` with scope **Health only** (or full) | + `git_sha`, `built_at`, `schema_version`, `uptime_s`, `started_at`, `db`, `disk_free_mb`, `errors_1h`, `errors_24h`, `last_error_at`, `last_error_kind`, `error_kinds`, `bun` |

The full face answers `503` when `status` is `degraded` (database check
failed, or less than 512 MB free), so a probe can alert on the status code.

The error counters tick on every `console.error` and every 5xx the server
emits. Only the `[tag]` a log line opens with is kept (`[claude]`, `[gardens]`,
`http-500`): never a message, never a name. It is a rate, not a diagnosis —
when it climbs, read the logs of that instance.

A **Health only** token cannot do anything else: it is refused as a member
credential everywhere. Mint one per instance — `ops/mint-health-token.ts
<maurice.db>` writes it straight into the file (also works with `docker exec`
inside a container), or use that instance's admin → Tokens — and keep it in
`~/.maurice/ops/fleet-tokens`, one `name=maur_…` per line, mode 600. The file
is outside the repo on purpose.

## The inventory: `fleet.yaml`

Hand-kept. One entry per instance: `name`, `url`, `owner`, `since`,
`insecure: true` for a self-signed local certificate, `deploy:` — the
shell command, run from the repo root, that puts the current checkout live
there — `restart:`, the command that bounces it on the code it already has,
and `admin:`, the door to its admin console (below). Adding an
instance to the fleet is adding a line; handing it over is removing the line
and revoking its health token in its admin. There is no discovery and there
will not be.

Three shapes exist today, one per kind of instance. `deploy:` moves an
instance onto the current checkout; `restart:` only bounces it on the code it
already has:

| Instance runs as | `deploy:` | `restart:` |
|---|---|---|
| launchd from the checkout (home) | `scripts/service.sh restart api` | the same line — deploying *is* restarting when launchd runs the checkout |
| a household on a shared host (aline, review) | `MAURICE_REGISTRY=… scripts/deploy.sh <ssh-host>` — builds here, pushes to the registry, recreates every household there on the new image | `ops/household.sh restart <ssh-host> <name>` |
| a local container started by hand | `ops/recreate-container.sh <container>` — builds the image, recreates the container with its own env, ports, volumes and log rotation, waits for `/healthz` (`--dry-run` shows the run line) | `docker restart <container>` |

The end state is one shape — the household on a shared host — which is when
the tower's `d` and `R` mean the same thing everywhere.

## The one command: `fleet-status.ts`

```
ops/fleet-status.ts             # every instance
ops/fleet-status.ts aline       # one
ops/fleet-status.ts --json      # for a cron, a notifier, a script
```

```
instance  state  version            sha           schema  up   db  disk  err/1h  err/24h  last error
────────  ─────  ─────────────────  ────────────  ──────  ───  ──  ────  ──────  ───────  ──────────
home      ok     server-v1.0.1-126  d52bbcbd495c  1       3d   ok  488G  0       2        4h ago [claude]
aline     ok     server-v1.0.1-120  9c8fcb6a1e02  1       12h  ok  31G   0       0        none
review    DOWN (ConnectionRefused)
```

Exit code 1 when anything is down or degraded, so a launchd or cron line
piped to a notifier is a pager. Without a token for an instance the row shows
reachability and the public version only.

## The tower: `tower.ts`

```
ops/tower.ts                # live, in the terminal
ops/tower.ts --every 10     # poll interval, seconds
ops/tower.ts --once         # one frame, no keys — for a pipe or a test
```

The same table, refreshed every 30 s, an error sparkline per instance over
the last 40 polls (a red dot is an unreachable poll), the selected instance's
url / owner / deploy / restart / admin lines, and a log pane. Keys: `↑/↓`
select, `r` probe now, `a` open the selected instance's admin console (below),
`d` deploy it, `R` restart it, `l` toggle the log, `q` quit.

`d` and `R` both ask `y/n`, run their line of `fleet.yaml` from the repo root
one at a time, stream the output into the log, and then **wait for that
instance to answer `/healthz` again**, saying how long it took — because a
command that exits `0` and an instance that is back are not the same claim.
Reach for `R` when an instance is wedged rather than out of date: it never
touches the code it runs, so it cannot carry a half-finished checkout onto
someone's household.

It is a terminal program on purpose: no daemon, no port, no tunnel, no login
page. Its access control is the shell it runs in — the Mac mini's, or an ssh
session into it (Tailscale from the phone works). A web face on the same
`fleet.ts` core is a later option if the terminal ever falls short; it would
need Cloudflare Access in front of it before it gets a deploy button.

## The admin console of an instance: `admin.ts`

```
ops/admin.ts                 where each console is, and how it is reached
ops/admin.ts aline           forward the port, open the console, hold it open
ops/admin.ts aline --print   the ssh line and the url, open nothing
```

The console hands out every provider API key, so the server refuses any
request whose `Host` is not loopback and any request carrying a Cloudflare
header (`server/src/routes/web-admin.ts`). `https://aline.chezmaurice.eu/admin`
answers `403`, by design and for good. The way in is the loopback port that
household publishes on its host — `ops/household.sh` allots one per household
from 3101 up, and `ops/household.sh list <host>` prints them — reached by an
ssh forward.

`admin:` in the inventory is that door, one line:

| The instance is | `admin:` | What happens |
|---|---|---|
| this very machine | nothing to write — its `url` is already `localhost` | the browser opens `<url>/admin` |
| a household on a host you can ssh into | `ssh://<ssh-host>:<port>` | the port is forwarded, then `http://localhost:<port>/admin` opens |
| reachable at some other local address | an `http(s)://…` url | that url opens |

The forward belongs to whatever opened it: `ops/admin.ts` holds it until `^C`,
the tower's `a` until you quit it (the header shows `⇄ aline:3101` while one
is open). It is made with `ControlPath=none` on purpose — a forward asked of
the multiplexed connection the deploys share would outlive the process that
asked for it, and a console left open on a loopback port is exactly what this
should not do. If a port already answers, that forward is reused rather than
doubled.

Over ssh into the mac mini there is no browser to hand the url to, so both
faces print it and keep the forward: chain your own `-L` if you want it on the
machine in your hands.

## Versions

`version` is `git describe` against the `*v[0-9]*` tags (`server-v1.0.1-126-g…`
means 126 commits past that tag). The Mac install runs from the checkout and
reads git itself. The container image cannot: `scripts/build-info.sh` writes
`server/build-info.json` (git-ignored) and `scripts/deploy.sh` and
`scripts/container.sh build|up` call it, so an image always knows its commit.

The precedence is **env → git → the file**, and git comes first for a reason
the home row taught twice on 18 September 2026. `build-info.json` is written
into the **checkout**, not into the image it is preparing, and nothing removes
it afterwards — so a `scripts/deploy.sh` or `scripts/container.sh build` run
on the mac leaves a stamp behind. While the file outranked git, every launchd
restart after such a build reported the commit of that image rather than the
one the service was running, which is the single question this table exists to
answer. A checkout that answers `git rev-parse` knows what it runs; an image
ships without a `.git`, so there the stamp is still the only answer, and the
three `MAURICE_*` variables still win over both.

`schema_version` is the `PRAGMA user_version` stamped by `server/src/db.ts`
(`SCHEMA_VERSION`). Bump it by hand with any migration that changes the
schema; the fleet table then shows at a glance which instances still need to
be restarted onto the new code.

## What the rest of the stack is — off the shelf, outside the repo

- **Availability + paging: Uptime Kuma.** One HTTP monitor per instance on the
  public `/healthz`, or on the full face with the token in the header and
  "expected status 200" so a `degraded` instance pages too. Telegram
  notification. Runs on the Mac mini or on the Scaleway instance.
- **Errors with context: Sentry / GlitchTip.** *Not wired yet.* The server has
  no error SDK; adding one is a small change in `server/index.ts` (`onError`
  is already the single point), but it means each friend's instance ships
  stack traces to the operator's collector. Decide that flow first; when it
  comes, `send_default_pii=false`, no request bodies, tags `release` and
  `server_name` only.
- **Logs: Dozzle** for the containers; `scripts/service.sh logs` for launchd.

## Handing an instance over

The point of running someone's Maurice for a while is to hand it to them. The
data is already theirs: one `MAURICE_DATA_DIR` (database, files, avatars) and
one gardens directory, both plain files. The path, in order:

1. They install Maurice where it will live (the Mac installer or the container
   from `infra/`). Same version as the one they leave, or the migrations run
   on first start.
2. Stop their instance here, copy `MAURICE_DATA_DIR` and the gardens directory
   over, start theirs. Their `maurice.db` carries every session and token, so
   devices stay paired if the hostname follows.
3. Point the name at the new place: for a `*.chezmaurice.eu` name, swap the
   Cloudflare ingress or the A record; their devices never notice. A name they
   own instead means re-pairing every device once.
4. Revoke the operator's health token in their admin, remove their line from
   `fleet.yaml`, run `infra/deprovision-household.sh` here.

Until steps 1–3 are scripted, this list is the procedure.
