# The household archive (`maurice-archive` v1)

Everything a household is, as one file it can take elsewhere: the databases,
the gardens with their history, the images, files and avatars. A household
produces it itself — from the admin console, or from the command line where
its data lives — and a fresh Maurice starts from it. Three things run on it: a
demo household becoming someone's own on another machine, handing a hosted
household over without the operator opening its data, and the portability
the GDPR promises.

**It holds the provider API keys** (they live in `maurice.db`) with the
rest. Treat the file as you would a password.

## The file

`<household>-<YYYYMMDD-HHMMSS>.maurice.tar.gz` — a gzipped tar:

```
manifest.json          what this is, who is in it, which server made it
maurice.db             the application database, a consistent snapshot
data/life.db           the data-api databases (compte.db, recommendations.db,
data/…                 signals.db — whichever exist), same treatment
mail/<member id>.db    each member's mail store, same treatment
gardens/gardens.json   the gardens root, exactly as on disk —
gardens/<member>/      every member garden INCLUDING its .git
images/  files/  uploads/  avatars/
config.toml  secret.key
```

`secret.key` opens the sealed subjects and readings of the mail stores;
without it a moved household would lose them, and the readings cost money
to make again. It no longer opens any password: since 27 October 2026 the
mail and address-book passwords are emptied in the archive's copy of
`maurice.db` (`secret = ''`, `state = 'error'`, `last_error` = *moved with
the household archive: enter the password again*). The archive is the
admin's to carry; a member's password is not. A member's Cloudflare token
(`users.cloudflare_token`, their own domain) is emptied too. After a move,
each member reconnects their mailbox and address book in the app. The live
database is untouched.

**The admin's archive** (`scripts/export-household.ts`, `forAdmin`) leaves out
`secret.key` and the mail stores (`mail/`) as well, since 28 October 2026:
with the key, whoever holds the file could open every member's sealed subjects
and readings offline. After a move by that archive each member, the admin
included, reconnects their mailbox, and the mail is scanned and read again —
at the household's cost. The console's archive (`/admin/export`) and the CLI's
keep both: they are the machine owner's, made to move the household as it is.

The archive an **admin** takes away (`scripts/export-household.ts`, below)
leaves more behind, so that nothing in it opens anything on the live
household or elsewhere: every session (`sessions.id` is the bearer token
itself, and sessions do not expire), the API tokens in clear
(`api_tokens.token_plain`), the pairing tokens, the device codes, the PIN
hashes (a 4–6 digit PIN falls to an offline search in seconds), and the
provider keys in `households`. On a hosted household those keys are the
operator's: the tower writes the Scaleway key that the trial households
share. In the new home each member joins again with a code and sets a PIN,
and the admin enters their own keys. The console's and the CLI's archives
keep all of these: they belong to the machine's owner, and are made to move
the household as it is. They are secrets (`services/archive.ts`,
`withoutPasswords`, `withoutCredentials`).

One member's data, asked for by that member, is another file:
[member-data.md](member-data.md).

`manifest.json`:

| field            | meaning                                                              |
|------------------|----------------------------------------------------------------------|
| `format`         | `"maurice-archive"`                                                  |
| `version`        | `1` — an importer refuses any other                                  |
| `created_at`     | ISO 8601, UTC                                                        |
| `household`      | `{ id, name }`                                                       |
| `members`        | `[{ id, username, display_name, role }]`                             |
| `schema_version` | `PRAGMA user_version` of `maurice.db` when it was exported           |
| `server_version` | the exporting server's version, as `/healthz` reports it             |
| `contents`       | the top-level entries actually in the tar, directories with a `/`    |

The databases are copied with `VACUUM INTO` over a read-only connection —
the same reason `scripts/backup-db.sh` does: a plain copy of a WAL database
under a live server can catch a half-written page. Each copy passes
`PRAGMA integrity_check` before it goes in, and again when it comes out.
No `-wal`/`-shm` sidecars travel; the snapshots are whole on their own.

### Left out, and why

- `backups/`, `logs/`, `run/` — per-install; `data/qdrant/` — dead since the
  corpus moved to sqlite-vec.
- `ops/` and `.env` — the operator's secrets, never the household's.
- The corpus vector index — regenerable, and it lives outside the data dir
  (`tools/corpus/data/vectors` on a Mac, `~/.maurice/app/corpus/vectors` in a
  container). Re-index after an import.
- The bare git remotes under `~/.maurice/git/` — each garden's own `.git`
  holds the full history; the bare is a mirror of it. After an import a
  garden's `origin` still names the old path: recreate the bare
  (`git init --bare`, push) or drop the remote.
- `*.db-wal`, `*.db-shm`, `._*`, `.DS_Store`.

Everything not listed above (`mail.toml`, `mail-proposals/`…) stays behind
too: the archive is an allow-list, not the data dir minus exclusions.

## Exporting

- **Admin console**: `/admin`, section 07 · Archive, "Export this household".
  The download is produced as it streams — the first bytes leave before the
  uploads are read, so a big household never sits silent past the server's
  idle timeout. The console answers from the machine alone. There is no
  API route any more: `GET /api/admin/export` took an admin's app session
  and was reachable from the internet, and the archive carries every
  member's notes and conversations (removed 27 October 2026).
- **Command line**, where the data is local:
  `scripts/export-household.sh [dest-dir]` (default
  `~/.maurice/backups/archive`). Inside a container:
  `scripts/container.sh shell`, then the same script.
- **A hosted household, asked for by its admin**: on their Chez Maurice
  account page, after giving their password again. The tower runs
  `bun run /app/scripts/export-household.ts --ttl 6h` in the container
  (`docker exec`). The script writes the archive into the household's own
  volume (`<app dir>/household-exports/`, left out of the backups) and prints
  one JSON line: `{ ok, url, expires_at, bytes }`, or `{ ok: false, error }`
  with a non-zero exit. The tower mails the link to the admin. The household
  serves it once at `/export/<token>`; the token is 32 random bytes, kept
  only as its SHA-256. The file is deleted when sent, or at expiry by the
  hourly sweep. A new export replaces the one waiting. The archive never
  passes through the tower. `--ttl` takes `90m`, `6h` or `1d`, from 10 minutes
  to 2 days.
- **A hosted household, by the operator**: the console through its tunnel
  (`ops/admin.ts <name>`, or `ssh -L <port>:localhost:<port> <host>`) and the
  button.

**Every export is told to every member**, whichever way it was made: the
console, `scripts/export-household.ts`, or `server/scripts/archive.ts export`
(the CLI behind `scripts/export-household.sh`). The app shows *The admin exported the whole household* on
the date, once in an alert and then under Settings → My data, with a push
when one can be sent (`account_events`, `server/src/services/accountEvents.ts`).

## Importing

Always into a **fresh** directory. Every importer refuses one that already
holds a `maurice.db` — the guard that stops an archive landing on top of a
real household. The server's own migrations bring the schema forward on its
first boot; nothing in the importer knows the schema.

- **A machine** (the Mac, a dev checkout):
  `scripts/import-household.sh <archive> [data-dir]` (default `~/.maurice`).
  It extracts, checks every database, and repoints `config.toml`'s
  `[paths] data_dir` at `<data-dir>/data`, since the one in the archive names
  the machine it came from. The gardens land in `<data-dir>/gardens` — set
  `MAURICE_GARDENS_DIR` there unless that is already the answer.
- **The local container**: `scripts/container.sh import <archive>`, then
  `up`. Same rule (`nuke` first if the volume holds a household); the
  entrypoint repoints a `/Users` `data_dir` itself.
- **The fleet**: `ops/household.sh add <host> <name> <domain> --from <archive>`
  creates the volume, pours the archive in over ssh (no copy is left on the
  host), and starts the household. Its admin and members come with it.

The service behind all of these is `server/src/services/archive.ts`
(`exportHousehold`, `exportHouseholdStream`, `importHousehold`); the CLI
entry is `server/scripts/archive.ts`. `tar` and `gzip` are what every target
has — macOS (bsdtar) and the Ubuntu image (GNU tar) both — so no dependency
was added.
