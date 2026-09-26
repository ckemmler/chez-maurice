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
    message_id: str | None = None,
    headers: dict[str, str] | None = None,
) -> bytes:
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = sender
    msg["To"] = "alex@example.org"
    if message_id is not False:
        msg["Message-ID"] = message_id or f"<{abs(hash((subject, date)))}@example.org>"
    msg["Date"] = date
    for name, value in (headers or {}).items():
        msg[name] = value
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
    """State that a reconnection must survive — the folders, the flags, the
    UIDVALIDITY per folder, the Gmail ids, the call journal and the faults to
    inject — is shared between an instance and its ``clone()``, so a factory
    that answers a dropped connection with ``client.clone()`` behaves like a
    server that is still there."""

    def __init__(
        self,
        folders: dict[str, dict[int, bytes]],
        flags: dict[str, tuple[bytes, ...]] | None = None,
        seen: set[tuple[str, int]] | None = None,
        *,
        uidvalidity: dict[str, int] | None = None,
        gm_msgids: dict[tuple[str, int], int] | None = None,
        capabilities: tuple[bytes, ...] = (b"IMAP4rev1",),
        emailids: dict[tuple[str, int], str] | None = None,
    ) -> None:
        self.folders = folders
        self.folder_flags = flags or {}
        self.seen = seen or set()
        self.uidvalidity = uidvalidity if uidvalidity is not None else {}
        self.gm_msgids = gm_msgids if gm_msgids is not None else {}
        self.emailids = emailids if emailids is not None else {}
        self.caps = capabilities
        self.omit_uidnext = False  # a server that skips the SHOULD of RFC 3501
        self.selected: str | None = None
        self.calls: list[tuple[str, Any]] = []
        self.logged_out = False
        # {"drop_on_fetch": n} — the n-th FETCH from now dies with the connection.
        self.faults: dict[str, int] = {}
        self.connections = [self]

    def clone(self) -> "FakeIMAPClient":
        other = FakeIMAPClient.__new__(FakeIMAPClient)
        other.__dict__.update(self.__dict__)
        other.selected = None
        other.logged_out = False
        self.connections.append(other)
        return other

    def capabilities(self):
        return self.caps

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
        uids = self.folders[folder]
        info = {b"EXISTS": len(uids), b"UIDVALIDITY": self.uidvalidity.get(folder, 1)}
        if not self.omit_uidnext:
            info[b"UIDNEXT"] = (max(uids) + 1) if uids else 1
        return info

    def folder_status(self, folder, keys):
        messages = self.folders.get(folder, {})
        unseen = sum(1 for uid in messages if (folder, uid) not in self.seen)
        return {b"MESSAGES": len(messages), b"UNSEEN": unseen}

    def search(self, criteria, charset=None):
        if self.selected is None:
            raise ValueError("SEARCH with no mailbox selected")
        self.calls.append(("search", (list(criteria), charset)))
        return self._match(criteria)

    def gmail_search(self, query, charset="UTF-8"):
        self.calls.append(("gmail_search", query))
        return sorted(self.folders.get(self.selected or "", {}))

    def _match(self, criteria):
        uids = sorted(self.folders.get(self.selected or "", {}))
        crit = list(criteria)
        if "UID" in crit:
            # `UID n:m` or `UID n:*` — and `*` is the last message even when n
            # is past it, as RFC 3501 says and every server does. Bare `*`
            # is that last message alone.
            spec = str(crit[crit.index("UID") + 1])
            if spec == "*":
                return uids[-1:]
            low, _, high = spec.partition(":")
            low = int(low)
            if high == "*":
                if uids and low > uids[-1]:
                    return uids[-1:]
                uids = [u for u in uids if u >= low]
            else:
                uids = [u for u in uids if low <= u <= int(high)]
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
        if self.selected is None:
            raise ValueError("FETCH with no mailbox selected")
        self.calls.append(("fetch", (list(uids), list(parts))))
        if self.faults.get("drop_on_fetch"):
            self.faults["drop_on_fetch"] -= 1
            if self.faults["drop_on_fetch"] == 0:
                self.logged_out = True
                raise OSError("connection reset by peer")
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
                elif part == "X-GM-MSGID":
                    gm = self.gm_msgids.get((self.selected, int(uid)))
                    if gm is not None:
                        entry[b"X-GM-MSGID"] = gm
                elif part == "EMAILID":
                    oid = self.emailids.get((self.selected, int(uid)))
                    if oid is not None:
                        entry[b"EMAILID"] = (oid.encode(),)
                elif str(part).startswith("BODY.PEEK[TEXT]"):
                    # BODY.PEEK[TEXT]<0.n> — hand back n octets, as a server does.
                    count = re.search(r"<0\.(\d+)>", str(part))
                    entry[b"BODY[TEXT]<0>"] = body[: int(count.group(1))] if count else body
            out[int(uid)] = entry
        return out
