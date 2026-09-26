# email — read your own mail, and nothing else

An MCP tool that lets Maurice search and read a member's own mailboxes over
IMAP. Public, meant for anyone: an account is an address and a password, and it
works the same on Gmail, iCloud, Fastmail, Yahoo, Proton (via Bridge), the
French ISPs and any IMAP server named by hand.

It is the access layer only. Sorting, labelling and the nightly triage stay in
the private `mail` tool, which is one person's method; this one assumes none.

## Tools (`email__…`)

| tool | what it returns |
|---|---|
| `list_accounts` | your accounts, whether each is reachable, its main folders by role |
| `list_folders` | every folder of one account, with its role; `counts` adds totals and unread |
| `search` | envelopes only — date, sender, recipients, subject, flags, uid, folder — newest first |
| `get_message` | headers, the body as text, the list of attachments |
| `get_attachment` | the text of one attachment: text, HTML, PDF (text layer), forwarded message |
| `stats` | counts per main folder and who writes most, from headers alone |
| `scan_mailbox` | walk one account (or all) into the member's header store, in the background; joins a walk already running |
| `scan_status` | the current or last scan: state, counts, where it is, what the store holds |
| `scan_stop` | pause the running scan at its next checkpoint |

`search` takes structured fields (`from`, `to`, `subject`, `text`, `since`,
`before`, `unread`, `flagged`), never raw IMAP: a model writing IMAP syntax
gets the quoting wrong in ways that fail silently. Without `account` it
searches all of the member's accounts; `folder: "*"` searches every folder but
junk, trash and drafts. On Gmail the same fields become Gmail's own search
syntax (`X-GM-RAW`), which also allows `has_attachment` and a free
`gmail_query` (`category:purchases`, `label:school`).

## What it guarantees

- **Only the member's own mail.** The gateway names the caller on every request;
  the tool opens that member's accounts and no one else's. No member on the
  request, no mail. There is no owner or admin path into another member's box.
  The server also withholds the family from any conversation with a second
  participant (`PRIVATE_ONLY` in `server/src/services/toolFamilies.ts`): the
  tool sees who asked, not who else is listening.
- **Read-only, and invisible.** Folders are opened with EXAMINE and every fetch
  is a `BODY.PEEK`: reading through Maurice leaves a message exactly as unread
  as it was. There is no send, move, flag or delete — not disabled, absent.
- **Every message is hostile input.** Bodies and attachments come back inside
  `UNTRUSTED` markers a message cannot forge; HTML is stripped; nothing a
  message references is ever fetched. Subjects and sender names are flagged as
  third-party text too.
- **Folders by role, not by name.** Gmail's archive is `[Gmail]/All Mail` in
  English and `[Gmail]/Tous les messages` in French; the SPECIAL-USE flags say
  which folder is which, with usual names as a fallback.
- **One account down is one account down.** The others keep answering; the
  failure is named in the result.
- **Big messages are not downloaded whole.** Above `max_message_bytes` (10 MB)
  only the headers and the start of the text are read.

## The header store (`specs/mail-import.md`, lot 1)

`scan_mailbox` walks a mailbox into `<app dir>/mail/<member id>.db` — one
SQLite file per member, written by this tool only, never `maurice.db`:

- `messages`, keyed by a **folder-independent identity** (`identity.py`):
  `X-GM-MSGID` on Gmail, `EMAILID` where OBJECTID is announced, else a
  fingerprint of Message-ID + From + Date (or Date + From + To + Subject when
  there is no Message-ID, marked weak). A message moved or a folder renamed is
  the same row with one more `locations` entry (account, folder, uidvalidity,
  uid).
- **The subject is sealed** (`sealing.py`) with exactly the mechanism of
  `server/src/services/mailAccounts.ts` — the household key
  (`MAURICE_SECRET_KEY`, else `secret.key` in the app dir), AES-256-GCM,
  `v1:` + base64(iv ‖ tag ‖ body) — so either side opens the other's seals.
  From, to, cc, date, message-id, list-id, references, list-unsubscribe and
  precedence stay in clear and indexed. No body is kept.
- `cursors` holds `{uidvalidity, highest_uid_done}` per (account, folder). A
  changed UIDVALIDITY resets the cursor and purges that folder's old-generation
  locations in one transaction, then the folder is rescanned.
- **Batches of 500 UIDs, one transaction each** (rows + locations + cursor),
  every write idempotent. UIDs are searched in windows of 10 000 up to the
  folder's UIDNEXT: `UID 1:*` on a large archive is more than the megabyte
  imaplib accepts on one line. A dropped connection mid-FETCH is retried once;
  a failed write fails the job and the next start resumes from the cursor.
- `jobs` records each walk: state (`running`, `paused`, `done`, `failed`),
  counts, bytes fetched, seconds, last error — checkpointed in the batch's own
  transaction. The row is a lease: a `running` job with a fresh `updated_at`
  is another walker (this gateway's thread, or the CLI beside it) and is
  joined rather than doubled; one ten minutes stale is a process that died,
  and is marked `paused`. One folder the server refuses is skipped and named;
  an account that refuses the login ends that account's walk.

Folders walked: the `\All` folder on Gmail, every selectable folder but junk,
trash and drafts elsewhere. From a terminal, in the foreground and resumable:

```sh
.venv/bin/python -m tools.email.cli --member alex scan --account gmail
.venv/bin/python -m tools.email.cli --member alex scan-status
```

## Setting an account up

**The ordinary way: the member adds it themselves** through the server,
`POST /api/mail-accounts` with `{ address, password }` (plus `provider:
"gmail"` for a Workspace domain, or `host`/`port`/`security`/`username` for a
server the domain does not name). The server logs in through this tool before
answering: a password the mailbox refuses is not kept, and the reason comes
back (422). The password is encrypted at rest with the household's key
(`MAURICE_SECRET_KEY`, else `secret.key` in the app dir) and never returned.
`GET /api/mail-accounts` lists them with their last state, `PUT
/:id/password` replaces a revoked app password (kept only if it works), `POST
/:id/check` logs in again, `DELETE /:id` forgets it. See
`server/src/services/mailAccounts.ts`.

The tool reads them, password included, from
`/api/local/mail-accounts/<member id>` — loopback only, and only with the
gateway's own `MAURICE_MCP_TOKEN` in `X-Maurice-Tool-Token`; a gateway started
without that key sees only the file's accounts, and says why. They are read
afresh on every call, so an account removed is gone from the next one, and a
new password opens a new session.

**The admin's way**, for what the API cannot describe (Proton through Bridge
with an existing Keychain entry, say): accounts live in `email.toml` beside `maurice.db` — `~/.maurice/email.toml` on a Mac, the data volume in the container — or wherever `MAURICE_EMAIL_CONFIG` points;
see `email.example.toml`. The smallest account is two lines:

```toml
[[accounts]]
member = "alex"            # the Maurice username
address = "alex@gmail.com"
```

The host, port and transport come from the domain (`providers.py`). A Google
Workspace address says `provider = "gmail"`; any other server names `host`.

The password goes in the Keychain — service `maurice-email`, the address as
account — or in `MAURICE_EMAIL_<NAME>_PASSWORD`:

```sh
security add-generic-password -s maurice-email -a alex@gmail.com -w
```

What each provider wants:

- **Gmail**: an app password (2-Step Verification on, then
  myaccount.google.com/apppasswords).
- **iCloud**: an app-specific password (account.apple.com).
- **Fastmail, Yahoo**: an app password.
- **Proton**: the password Bridge shows, not the Proton login.
- **Outlook.com / Hotmail**: Microsoft takes only OAuth over IMAP; the account is
  recognised and refused with that reason. Not supported yet.

Then check it from the repo root:

```sh
.venv/bin/python -m tools.email.cli --member alex accounts
.venv/bin/python -m tools.email.cli --member alex search --from impots --since 2026-01-01
```

## Tests

```sh
.venv/bin/python -m pytest tools/email/tests -q
```

A fake IMAP server that raises on any read-write SELECT and any non-PEEK fetch,
so every passing test is also a proof that nothing was marked read. Covered:
the two-line config and the refusals (unknown domain, TLS checks off away from
loopback, duplicate names, Outlook), member isolation down to the MCP handler,
roles from flags and from names, Gmail search syntax, accents, one account down,
the body that tries to close its own quotation, attachments and PDFs, signature
images that are not attachments, large messages, stats.

For the header scan (`test_scan.py`): a walk in batches, an exception while
writing and a connection lost mid-FETCH (after resumption the store is exactly
the mailbox and the FETCH journal shows only the interrupted batch replayed),
a stop and a continuation, a changed UIDVALIDITY (rescanned, nothing skipped,
no ghost row), a moved message and a renamed folder (one message, one more
location), Gmail's X-GM-MSGID surviving a UID change, a sparse large folder
searched in windows, and the subject absent in clear from the file.
`test_sealing.py` runs `bun` against `mailAccounts.ts` to check that a seal
crosses both ways (skipped without bun or the server's `node_modules`).

## Next

1. ~~Accounts per member in the server~~ (done, 25 September 2026).
2. A settings screen in the app over `/api/mail-accounts`: address, password,
   the connection test's answer.
3. OAuth (XOAUTH2) for Gmail and Outlook.
4. ~~The header store~~ (lot 1 of `specs/mail-import.md`, 26 September 2026);
   next the triage and the free report (lot 2), then the quote (lot 3).
