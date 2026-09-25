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

## Next

1. ~~Accounts per member in the server~~ (done, 25 September 2026).
2. A settings screen in the app over `/api/mail-accounts`: address, password,
   the connection test's answer.
3. OAuth (XOAUTH2) for Gmail and Outlook.
4. Optionally, indexing into the corpus, for search that IMAP does badly.
