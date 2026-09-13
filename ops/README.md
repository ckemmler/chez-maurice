# Running a fleet of Maurices

This directory is the operator's toolbox for the instances Candide runs on
behalf of friends. It is deliberately small: an inventory, one script, and a
note on which off-the-shelf tools do the rest. Nothing here is a product, and
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
credential everywhere. Mint one per instance in that instance's admin →
Tokens, and keep it in `~/.maurice/ops/fleet-tokens`, one `name=maur_…` per
line. The file is outside the repo on purpose.

## The inventory: `fleet.yaml`

Hand-kept. One entry per instance: `name`, `url`, `owner`, `since`, and
`insecure: true` for a self-signed local certificate. Adding an instance to
the fleet is adding a line; handing it over is removing the line and revoking
its health token in its admin. There is no discovery and there will not be.

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

## Versions

`version` is `git describe` against the `*v[0-9]*` tags (`server-v1.0.1-126-g…`
means 126 commits past that tag). The Mac install runs from the checkout and
reads git itself. The container image does not: `scripts/build-info.sh`
writes `server/build-info.json` (git-ignored) and `scripts/deploy.sh` and
`scripts/container.sh build|up` call it, so an image always knows its commit.
`MAURICE_VERSION`, `MAURICE_GIT_SHA`, `MAURICE_BUILT_AT` override everything.

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
