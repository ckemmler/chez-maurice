"""The same reads as the MCP tools, from a terminal — to set an account up and
check it before Maurice uses it.

    .venv/bin/python -m tools.email.cli --member candide accounts
    .venv/bin/python -m tools.email.cli --member candide folders --account icloud --counts
    .venv/bin/python -m tools.email.cli --member candide search --from impots --since 2026-01-01
    .venv/bin/python -m tools.email.cli --member candide read 1841 --folder inbox
    .venv/bin/python -m tools.email.cli --member candide attachment 1841 0
    .venv/bin/python -m tools.email.cli --member candide stats --since 2026-09-01
    .venv/bin/python -m tools.email.cli --member candide scan --account gmail
    .venv/bin/python -m tools.email.cli --member candide scan-status

Run from the repo root. ``--member`` is a username: the CLI acts for one member
exactly as the gateway does, it is not a way to see everyone's mail.
"""

from __future__ import annotations

import argparse
import json
import sys

from .accounts import ConfigError, load_config
from .imap import AccountUnavailable, MailboxError
from .service import AccessDenied, EmailService


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="email")
    parser.add_argument("--member", required=True, help="username whose accounts to use")
    parser.add_argument("--config", help="accounts file (default: email.toml beside maurice.db)")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("accounts")

    p = sub.add_parser("folders")
    p.add_argument("--account")
    p.add_argument("--counts", action="store_true")

    p = sub.add_parser("search")
    p.add_argument("--account")
    p.add_argument("--folder")
    p.add_argument("--from", dest="sender")
    p.add_argument("--to")
    p.add_argument("--subject")
    p.add_argument("--text")
    p.add_argument("--since")
    p.add_argument("--before")
    p.add_argument("--unread", action="store_true", default=None)
    p.add_argument("--has-attachment", action="store_true", default=None)
    p.add_argument("--gmail-query")
    p.add_argument("--limit", type=int, default=20)
    p.add_argument("--no-preview", dest="preview", action="store_false", default=None)

    p = sub.add_parser("read")
    p.add_argument("uid", type=int)
    p.add_argument("--account")
    p.add_argument("--folder")
    p.add_argument("--max-bytes", type=int, default=8000)

    p = sub.add_parser("attachment")
    p.add_argument("uid", type=int)
    p.add_argument("index", type=int)
    p.add_argument("--account")
    p.add_argument("--folder")

    p = sub.add_parser("stats")
    p.add_argument("--account")
    p.add_argument("--since")
    p.add_argument("--before")
    p.add_argument("--folder")

    p = sub.add_parser("scan", help="walk the headers into the member's store, in the foreground, resumable")
    p.add_argument("--account")
    p.add_argument("--batch", type=int, default=None)

    sub.add_parser("scan-status")

    args = parser.parse_args(argv)
    service: EmailService | None = None
    try:
        service = EmailService(load_config(args.config))
        accounts = service.accounts(username=args.member)
        if args.command == "accounts":
            out = service.list_accounts(accounts)
        elif args.command == "folders":
            out = service.list_folders(accounts, args.account, counts=args.counts)
        elif args.command == "search":
            out = service.search(
                accounts,
                account=args.account,
                folder=args.folder,
                limit=args.limit,
                gmail_raw=args.gmail_query,
                has_attachment=args.has_attachment,
                sender=args.sender,
                to=args.to,
                subject=args.subject,
                text=args.text,
                since=args.since,
                before=args.before,
                unread=args.unread,
                preview=args.preview,
            )
        elif args.command == "read":
            out = service.get_message(
                accounts, uid=args.uid, account=args.account, folder=args.folder, max_bytes=args.max_bytes
            )
        elif args.command == "attachment":
            out = service.get_attachment(
                accounts, uid=args.uid, index=args.index, account=args.account, folder=args.folder
            )
        elif args.command == "scan":
            out = service.scan_start(accounts, account=args.account, background=False, batch=args.batch)
        elif args.command == "scan-status":
            out = service.scan_status(accounts)
        else:
            out = service.stats(accounts, account=args.account, since=args.since, before=args.before, folder=args.folder)
    except (ConfigError, AccessDenied, AccountUnavailable, MailboxError) as exc:
        print(f"{type(exc).__name__}: {exc}", file=sys.stderr)
        return 1
    finally:
        if service is not None:
            service.close()
    print(json.dumps(out, indent=2, ensure_ascii=False, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
