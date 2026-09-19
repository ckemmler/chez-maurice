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
gardens/gardens.json   the gardens root, exactly as on disk —
gardens/<member>/      every member garden INCLUDING its .git
images/  files/  uploads/  avatars/
config.toml
```

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
  idle timeout. Same stream at `GET /api/admin/export` with an admin bearer
  token (`application/gzip`, `Content-Disposition: attachment`).
- **Command line**, where the data is local:
  `scripts/export-household.sh [dest-dir]` (default
  `~/.maurice/backups/archive`). Inside a container:
  `scripts/container.sh shell`, then the same script.
- **A hosted household** on the fleet: the console through its tunnel
  (`ops/admin.ts <name>`, or `ssh -L <port>:localhost:<port> <host>`) and the
  button. The operator never has to touch the volume.

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
