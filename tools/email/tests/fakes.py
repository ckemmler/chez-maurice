"""A fake IMAP server speaking the slice of ``imapclient`` the tool uses.

It refuses any read-write SELECT and any fetch that is not a PEEK, so a test
that passes is also a proof that looking never marks anything read.
"""

from __future__ import annotations

import re
from email.message import EmailMessage
from typing import Any


def build_raw(
    subject: str,
    sender: str,
    body: str,
    *,
    date: str = "Tue, 15 Sep 2026 09:12:00 +0200",
    html: bool = False,
    attachments: list[tuple[str, str, bytes]] | None = None,
) -> bytes:
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = sender
    msg["To"] = "alex@example.org"
    msg["Message-ID"] = f"<{abs(hash((subject, date)))}@example.org>"
    msg["Date"] = date
    if html:
        msg.set_content("plain fallback")
        msg.add_alternative(body, subtype="html")
    else:
        msg.set_content(body)
    for filename, ctype, data in attachments or []:
        maintype, subtype = ctype.split("/")
        msg.add_attachment(data, maintype=maintype, subtype=subtype, filename=filename)
    return msg.as_bytes()


class FakeIMAPClient:
    def __init__(
        self,
        folders: dict[str, dict[int, bytes]],
        flags: dict[str, tuple[bytes, ...]] | None = None,
        seen: set[tuple[str, int]] | None = None,
    ) -> None:
        self.folders = folders
        self.folder_flags = flags or {}
        self.seen = seen or set()
        self.selected: str | None = None
        self.calls: list[tuple[str, Any]] = []
        self.logged_out = False

    def noop(self) -> None:
        if self.logged_out:
            raise OSError("connection closed")

    def logout(self) -> None:
        self.logged_out = True

    def list_folders(self):
        return [(self.folder_flags.get(name, ()), "/", name) for name in self.folders]

    def select_folder(self, folder: str, readonly: bool = False):
        if not readonly:
            raise AssertionError("read-write SELECT: the tool must only ever EXAMINE")
        if folder not in self.folders:
            raise ValueError(f"no such folder: {folder}")
        self.selected = folder
        self.calls.append(("examine", folder))
        return {b"EXISTS": len(self.folders[folder])}

    def folder_status(self, folder, keys):
        messages = self.folders.get(folder, {})
        unseen = sum(1 for uid in messages if (folder, uid) not in self.seen)
        return {b"MESSAGES": len(messages), b"UNSEEN": unseen}

    def search(self, criteria, charset=None):
        self.calls.append(("search", (list(criteria), charset)))
        return self._match(criteria)

    def gmail_search(self, query, charset="UTF-8"):
        self.calls.append(("gmail_search", query))
        return sorted(self.folders.get(self.selected or "", {}))

    def _match(self, criteria):
        uids = sorted(self.folders.get(self.selected or "", {}))
        crit = list(criteria)
        if "FROM" in crit:
            needle = crit[crit.index("FROM") + 1].lower()
            uids = [u for u in uids if needle in self._header(u, "From").lower()]
        if "SUBJECT" in crit:
            needle = crit[crit.index("SUBJECT") + 1].lower()
            uids = [u for u in uids if needle in self._header(u, "Subject").lower()]
        if "UNSEEN" in crit:
            uids = [u for u in uids if (self.selected, u) not in self.seen]
        return uids

    def _header(self, uid: int, name: str) -> str:
        from email import policy
        from email.parser import BytesParser

        msg = BytesParser(policy=policy.default).parsebytes(self.folders[self.selected][uid])
        return str(msg.get(name) or "")

    def fetch(self, uids, parts):
        for part in parts:
            if str(part).startswith("BODY[") or str(part) in {"RFC822", "BODY"}:
                raise AssertionError(f"non-PEEK fetch {part!r} would mark the message read")
        self.calls.append(("fetch", (list(uids), list(parts))))
        out: dict[int, dict[bytes, Any]] = {}
        for uid in uids:
            raw = self.folders.get(self.selected or "", {}).get(int(uid))
            if raw is None:
                continue
            header, _, body = raw.partition(b"\n\n")
            entry: dict[bytes, Any] = {
                b"FLAGS": (b"\\Seen",) if (self.selected, int(uid)) in self.seen else (),
                b"RFC822.SIZE": len(raw),
            }
            for part in parts:
                if part == "BODY.PEEK[HEADER]":
                    entry[b"BODY[HEADER]"] = header + b"\n"
                elif part == "BODY.PEEK[]":
                    entry[b"BODY[]"] = raw
                elif str(part).startswith("BODY.PEEK[TEXT]"):
                    # BODY.PEEK[TEXT]<0.n> — hand back n octets, as a server does.
                    count = re.search(r"<0\.(\d+)>", str(part))
                    entry[b"BODY[TEXT]<0>"] = body[: int(count.group(1))] if count else body
            out[int(uid)] = entry
        return out
