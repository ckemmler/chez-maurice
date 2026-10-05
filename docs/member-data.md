# A member's own data

What the GDPR gives a person over what a household's server holds of them —
access and portability (art. 15 and 20), erasure (art. 17) — as four gestures
that are the member's own: **export**, **import**, **erase my data**,
**delete my account**. They live in the app under Settings → My data, and
behind `/api/me`. An admin has no route to someone else's conversations: the
household archive ([household-archive.md](household-archive.md)) is the only
thing that carries every member, and it is for moving a household, not for
reading one.

| | route | service |
|---|---|---|
| Export | `GET /api/me/export` | `server/src/services/memberArchive.ts` |
| Import | `POST /api/me/import` (multipart, field `file`) | same |
| Erase / delete | `POST /api/me/erase` `{ scope, confirm, password \| pin }` | `server/src/services/memberErase.ts` |
| An admin removes a member | `DELETE /api/users/:id`, console "Delete" | same, `scope: account` |

Import and erase need a session opened in the app: an API token (`maur_…`,
what a connected tool holds) is refused with `session_required`. Erase asks
for the username, typed, and the password again (the PIN for a member who
signs in with one); five wrong answers close it for a quarter of an hour.

## The member archive (`maurice-member-archive` v1)

`<username>-<YYYYMMDD-HHMMSS>.maurice-member.tar.gz`, made to be read as much
as imported — JSON, not a database:

```
manifest.json            format, version, archive_id, member, counts
account.json             the profile, without credentials
conversations/<id>.json  one conversation, its messages inside
maurice/<table>.json     the member's rows of maurice.db, table by table
data/<db>/<table>.json   the same for life.db, compte.db … (every table with a member_id)
mail/<table>.json        the mail store, opened: subjects and readings in clear
garden/                  the garden as on disk, .git included
files/  images/  avatars/
```

Left out on purpose: **credentials** (password and PIN hashes, sessions,
tokens, the mail and address-book passwords, the publishing token); **other
people's words** (in a room shared with other members only the member's own
messages travel); **what can be rebuilt** (the semantic index, conversation
summaries); and the household's own rows of the data-api (`scope = 'tenant'`).

## Import

Into an existing account — the member's own here, or the one they were given
in another household. It **adds and never overwrites**, and a given archive
goes into a given account once (`member_imports`).

An archive is a file someone uploaded; nothing in it is trusted. Columns are
checked against the schema; a conversation, a folder or a file never lands
under another member's; library files get new names on disk; a path that
climbs out of the archive refuses the whole import. Three things are **not**
brought in:

- the garden's `.git` — a repository's config and hooks run commands. The
  notes are committed afresh; the history stays in the archive;
- rooms — the other voices are not in the archive;
- what names the old machine or the old household: mail and address-book
  accounts (they come without their password — connect them again and the
  store rebuilds), Calibre libraries, shares, blocks, reports, the ledger.

## Erasure

`data` empties the account and keeps it (name, sign-in, devices, settings,
what the admin granted). `account` does the same, then removes the account.
The walk, in order:

1. the semantic index — the corpus tool's `forget_member` (index file, hashes
   of the garden's files, import runs). If the gateway is down the step is
   recorded in `erasures.pending` and tried again at boot;
2. `maurice.db` — conversations, messages, files, facts, briefs, mail and
   contact accounts, proposals… with `secure_delete` on, the full-text index
   merged and the write-ahead log folded back, so the file itself no longer
   spells what was deleted;
3. the data-api databases — every table with a `member_id`, and the rows
   that pointed at those;
4. the disk — library files, conversation images no remaining message shows,
   uploaded chat exports, the mail store, the garden with its history and its
   bare remote on this machine, the avatar (on `account`);
5. the night's local snapshots (`backups/db`) — each one opened, purged with
   the same functions, compacted and put back; the member's mail snapshots
   removed;
6. the logs — lines that carry the member's id or a path of their garden.

**What is not theirs alone stays.** A room they opened and others still sit
in goes to the longest-standing of those, without the member's messages. A
domain they created that other members were given stays, without its author.
A data-api row marked `scope = 'tenant'` is the household's.

**The ledger.** What a turn cost was spent. On `data` the rows stay as they
are — the member is still there and their budget still counts; on `account`
the amounts stay and `user_id` is emptied.

**The register.** `erasures` keeps one row per erasure: the member's opaque
id, the scope, the date. Nothing in it says who it was.

### What the server cannot reach

Returned in `residual`, and shown to the member:

- **a remote of the garden** on someone else's machine (GitHub…) — listed by
  URL; the member deletes it there;
- **a site published** from the garden (Cloudflare Pages) — still online
  until removed at its host;
- **household archives** an admin exported into `backups/archive` — counted;
  the admin deletes them;
- **off-site backups** of a hosted household (restic, `infra/host/backup.sh`:
  14 daily, 8 weekly, 12 monthly) — encrypted, never read, and gone when the
  last snapshot holding the member expires, twelve months at most. A restore
  from one of them brings an erased member back: after a restore, replay the
  erasures made since that snapshot;
- **Time Machine**, on a Mac, by its own schedule;
- **what already left**: turns sent to the inference provider, mail still in
  the member's mailbox, a clone of the garden someone fetched.

## Backups

- **Mac** — `scripts/backup-db.sh` (launchd `com.maurice.backup`), nightly:
  `maurice.db`, every data-api database, every member's mail store, each
  `VACUUM INTO` + integrity check, 14 kept. Gardens are git repositories;
  files, images and avatars rely on Time Machine.
- **Hosted** — the whole volume, nightly, restic to Object Storage
  (`ops/backup.sh`).
- **By hand** — the household archive, which since 3 October 2026 carries
  the mail stores too.
