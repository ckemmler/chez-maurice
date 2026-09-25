"""One IMAP session per account, read-only by construction.

Three things this layer guarantees, whatever the caller asks:

* **Nothing is marked read.** Every folder is opened with EXAMINE (read-only
  SELECT) and every fetch is a ``BODY.PEEK``: looking at a message through
  Maurice leaves it exactly as unread as it was in the member's own client.
* **Folders are found by role, not by name.** Gmail calls its archive
  ``[Gmail]/All Mail`` in English and ``[Gmail]/Tous les messages`` in French;
  iCloud's sent folder is ``Sent Messages``. The SPECIAL-USE flags (RFC 6154)
  say which is which, and a short list of usual names covers a server without
  them.
* **Non-ASCII works.** Folder names travel in modified UTF-7 (``imapclient``
  handles it; bare ``imaplib`` does not) and a search for ``école`` is sent with
  ``CHARSET UTF-8``.
"""

from __future__ import annotations

import logging
import ssl
import threading
from dataclasses import dataclass
from datetime import date
from typing import Any, Callable, Sequence

from .accounts import Account, CredentialError, password_for
from .message import envelope_summary, parse_message

log = logging.getLogger("maurice.email")

HEADER_FETCH = "BODY.PEEK[HEADER]"
HEADER_KEY = b"BODY[HEADER]"
FULL_FETCH = "BODY.PEEK[]"
FULL_KEY = b"BODY[]"

ROLES = ("inbox", "all", "archive", "sent", "drafts", "flagged", "junk", "trash")
_ROLE_FLAGS = {
    b"\\All": "all",
    b"\\Archive": "archive",
    b"\\Sent": "sent",
    b"\\Drafts": "drafts",
    b"\\Flagged": "flagged",
    b"\\Junk": "junk",
    b"\\Trash": "trash",
}
# When a server has no SPECIAL-USE flags. Lowercased, compared to the last
# path segment of the folder name.
_ROLE_NAMES = {
    "archive": "archive",
    "archives": "archive",
    "sent": "sent",
    "sent messages": "sent",
    "sent items": "sent",
    "envoyés": "sent",
    "messages envoyés": "sent",
    "drafts": "drafts",
    "brouillons": "drafts",
    "junk": "junk",
    "spam": "junk",
    "courrier indésirable": "junk",
    "trash": "trash",
    "deleted messages": "trash",
    "deleted items": "trash",
    "corbeille": "trash",
}
# Where "search everywhere" never looks unless asked by name.
SKIPPED_BY_DEFAULT = {"junk", "trash", "drafts"}


class MailboxError(RuntimeError):
    """An IMAP-level problem the caller should see verbatim."""


class AccountUnavailable(MailboxError):
    """The account cannot serve requests right now (down, refused, no password)."""


def _ssl_context(account: Account) -> ssl.SSLContext:
    context = ssl.create_default_context()
    if not account.tls_verify:
        # accounts.py only allows this for a loopback host (Proton Bridge).
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
    return context


def default_client_factory(account: Account) -> Any:
    from imapclient import IMAPClient  # late, so tests need no network stack

    client = IMAPClient(
        host=account.host,
        port=account.port,
        ssl=account.security == "tls",
        ssl_context=_ssl_context(account) if account.security == "tls" else None,
        timeout=account.timeout_seconds,
    )
    if account.security == "starttls":
        _starttls(client, _ssl_context(account))
    client.login(account.username, password_for(account))
    return client


def _starttls(client: Any, context: ssl.SSLContext) -> None:
    """``IMAPClient.starttls`` with the Python 3.14 rename worked around.

    3.14 made ``imaplib.IMAP4.file`` a read-only property backed by ``_file``;
    imapclient 4.0.1 still assigns to ``file`` after wrapping the socket, so
    STARTTLS raises *after* the handshake. We finish the job on whichever
    attribute the interpreter has. Drop this once imapclient ships the fix.
    """
    try:
        client.starttls(context)
        return
    except AttributeError as exc:  # pragma: no cover - interpreter-specific
        if "file" not in str(exc):
            raise
    imap = client._imap
    if not isinstance(imap.sock, ssl.SSLSocket):
        raise MailboxError("STARTTLS failed before the TLS handshake")
    imap._file = imap.sock.makefile("rb")


@dataclass
class Folder:
    name: str
    role: str | None
    selectable: bool

    def as_dict(self) -> dict[str, Any]:
        return {"folder": self.name, "role": self.role}


def _decode(value: Any) -> str:
    return value.decode() if isinstance(value, bytes) else str(value)


def _imap_date(value: str) -> date:
    try:
        return date.fromisoformat(value[:10])
    except ValueError as exc:
        raise MailboxError(f"dates are ISO (2026-09-01), not {value!r}") from exc


def build_criteria(
    *,
    sender: str | None = None,
    to: str | None = None,
    subject: str | None = None,
    text: str | None = None,
    since: str | None = None,
    before: str | None = None,
    unread: bool | None = None,
    flagged: bool | None = None,
) -> list[Any]:
    """Structured fields → IMAP SEARCH keys. No raw criteria from the caller:
    a model writing IMAP syntax gets quoting wrong in ways that fail silently."""
    criteria: list[Any] = []
    if sender:
        criteria += ["FROM", sender]
    if to:
        criteria += ["TO", to]
    if subject:
        criteria += ["SUBJECT", subject]
    if text:
        criteria += ["TEXT", text]
    if since:
        criteria += ["SINCE", _imap_date(since)]
    if before:
        criteria += ["BEFORE", _imap_date(before)]
    if unread is True:
        criteria.append("UNSEEN")
    elif unread is False:
        criteria.append("SEEN")
    if flagged is True:
        criteria.append("FLAGGED")
    elif flagged is False:
        criteria.append("UNFLAGGED")
    return criteria or ["ALL"]


def gmail_query(
    *,
    sender: str | None = None,
    to: str | None = None,
    subject: str | None = None,
    text: str | None = None,
    since: str | None = None,
    before: str | None = None,
    unread: bool | None = None,
    flagged: bool | None = None,
    has_attachment: bool | None = None,
    raw: str | None = None,
) -> str:
    """The same fields in Gmail's own search syntax, which X-GM-RAW accepts —
    word-based, accent-aware, and able to say has:attachment."""

    def quoted(value: str) -> str:
        value = value.replace('"', " ")
        return f'"{value}"' if " " in value else value

    parts = []
    if sender:
        parts.append(f"from:{quoted(sender)}")
    if to:
        parts.append(f"to:{quoted(to)}")
    if subject:
        parts.append(f"subject:({subject.replace(')', ' ')})")
    if since:
        parts.append(f"after:{_imap_date(since).strftime('%Y/%m/%d')}")
    if before:
        parts.append(f"before:{_imap_date(before).strftime('%Y/%m/%d')}")
    if unread is True:
        parts.append("is:unread")
    elif unread is False:
        parts.append("-is:unread")
    if flagged is True:
        parts.append("is:starred")
    elif flagged is False:
        parts.append("-is:starred")
    if has_attachment:
        parts.append("has:attachment")
    if text:
        parts.append(text)
    if raw:
        parts.append(raw)
    return " ".join(parts)


def _needs_utf8(criteria: Sequence[Any]) -> bool:
    return any(isinstance(c, str) and not c.isascii() for c in criteria)


class Session:
    """A connection to one account, reopened when the server has dropped it.

    imapclient is blocking and not thread-safe; the service calls in from
    worker threads, so every use goes through ``lock``.
    """

    def __init__(self, account: Account, client_factory: Callable[[Account], Any] = default_client_factory) -> None:
        self.account = account
        self.client_factory = client_factory
        self.lock = threading.RLock()
        self.state = "unknown"  # unknown | ok | unreachable | no_credentials
        self.error: str | None = None
        self._client: Any = None
        self._selected: str | None = None
        self._folders: list[Folder] | None = None

    # ── connection ───────────────────────────────────────────────────────
    def client(self) -> Any:
        if self._client is not None:
            try:
                self._client.noop()
                return self._client
            except Exception:  # dropped — reconnect once
                self._drop()
        try:
            self._client = self.client_factory(self.account)
        except CredentialError as exc:
            self.state, self.error = "no_credentials", str(exc)
            raise AccountUnavailable(str(exc)) from exc
        except Exception as exc:
            self.state, self.error = "unreachable", f"{type(exc).__name__}: {exc}"
            raise AccountUnavailable(
                f"{self.account.address} could not be reached: {type(exc).__name__}: {exc}"
            ) from exc
        self.state, self.error = "ok", None
        self._selected = None
        return self._client

    def _drop(self) -> None:
        client, self._client, self._selected = self._client, None, None
        if client is not None:
            try:
                client.logout()
            except Exception:
                pass

    def close(self) -> None:
        with self.lock:
            self._drop()

    # ── folders ──────────────────────────────────────────────────────────
    def folders(self, refresh: bool = False) -> list[Folder]:
        if self._folders is not None and not refresh:
            return self._folders
        try:
            entries = self.client().list_folders()
        except AccountUnavailable:
            raise
        except Exception as exc:
            raise MailboxError(f"cannot list folders of {self.account.address}: {exc}") from exc
        folders = []
        taken: set[str] = set()
        for flags, _delim, name in entries:
            name = _decode(name)
            flags = {f if isinstance(f, bytes) else str(f).encode() for f in flags}
            role = "inbox" if name.upper() == "INBOX" else None
            for flag, flag_role in _ROLE_FLAGS.items():
                if flag in flags:
                    role = flag_role
            selectable = b"\\Noselect" not in flags and b"\\NonExistent" not in flags
            folders.append(Folder(name, role, selectable))
            if role:
                taken.add(role)
        # Fill in by name only the roles no flag claimed.
        for folder in folders:
            if folder.role is None:
                leaf = folder.name.replace("\\", "/").rsplit("/", 1)[-1].lower()
                guess = _ROLE_NAMES.get(leaf)
                if guess and guess not in taken:
                    folder.role = guess
                    taken.add(guess)
        self._folders = sorted(folders, key=lambda f: (ROLES.index(f.role) if f.role else len(ROLES), f.name))
        return self._folders

    def resolve_folder(self, folder: str | None) -> str:
        """A role ("sent", "archive"…) or a folder's exact name → the name.
        None means where people look: \\All on Gmail (every message, one
        place), the inbox elsewhere."""
        folders = self.folders()
        if folder is None:
            for f in folders:
                if f.role == "all":
                    return f.name
            return "INBOX"
        for f in folders:
            if f.name == folder:
                return f.name
        for f in folders:
            if f.role == folder.lower():
                return f.name
        names = ", ".join(f.name for f in folders if f.selectable)
        raise MailboxError(f"{self.account.address} has no folder or role {folder!r}; it has: {names}")

    def searchable_folders(self) -> list[str]:
        """Every folder "everywhere" means: all selectable ones but junk,
        trash and drafts. On Gmail the \\All folder already holds everything
        else, so it is the only one."""
        folders = [f for f in self.folders() if f.selectable]
        for f in folders:
            if f.role == "all":
                return [f.name]
        return [f.name for f in folders if f.role not in SKIPPED_BY_DEFAULT]

    def counts(self, folder: str) -> dict[str, int]:
        try:
            status = self.client().folder_status(folder, [b"MESSAGES", b"UNSEEN"])
        except AccountUnavailable:
            raise
        except Exception as exc:
            raise MailboxError(f"cannot read the status of {folder!r}: {exc}") from exc
        return {"messages": int(status.get(b"MESSAGES", 0)), "unread": int(status.get(b"UNSEEN", 0))}

    def examine(self, folder: str) -> None:
        """Open a folder read-only (EXAMINE). There is no read-write path."""
        if self._selected == folder:
            return
        try:
            self.client().select_folder(folder, readonly=True)
        except AccountUnavailable:
            raise
        except Exception as exc:
            raise MailboxError(f"cannot open {folder!r} on {self.account.address}: {exc}") from exc
        self._selected = folder

    # ── reading ──────────────────────────────────────────────────────────
    def search(self, folder: str, criteria: list[Any] | None = None, gmail_raw: str | None = None) -> list[int]:
        """All matching UIDs, ascending (so the newest arrivals are last)."""
        self.examine(folder)
        client = self.client()
        try:
            if gmail_raw is not None:
                uids = client.gmail_search(gmail_raw, charset="UTF-8")
            else:
                criteria = criteria or ["ALL"]
                uids = client.search(criteria, charset="UTF-8" if _needs_utf8(criteria) else None)
        except Exception as exc:
            raise MailboxError(f"search failed in {folder!r}: {exc}") from exc
        return sorted(int(u) for u in uids)

    def envelopes(self, folder: str, uids: Sequence[int]) -> list[dict[str, Any]]:
        """Header metadata only. Never a body."""
        if not uids:
            return []
        self.examine(folder)
        try:
            fetched = self.client().fetch(list(uids), [HEADER_FETCH, "FLAGS", "RFC822.SIZE"])
        except Exception as exc:
            raise MailboxError(f"fetch failed in {folder!r}: {exc}") from exc
        out = []
        for uid, data in fetched.items():
            summary = envelope_summary(parse_message(data.get(HEADER_KEY) or b""))
            flags = [_decode(f) for f in data.get(b"FLAGS", ())]
            out.append(
                {
                    "account": self.account.name,
                    "folder": folder,
                    "uid": int(uid),
                    "size": int(data.get(b"RFC822.SIZE", 0) or 0),
                    "unread": "\\Seen" not in flags,
                    "flagged": "\\Flagged" in flags,
                    **summary,
                }
            )
        return out

    def size(self, folder: str, uid: int) -> int:
        self.examine(folder)
        try:
            fetched = self.client().fetch([uid], ["RFC822.SIZE"])
        except Exception as exc:
            raise MailboxError(f"fetch of uid {uid} failed in {folder!r}: {exc}") from exc
        data = fetched.get(uid) or fetched.get(int(uid))
        if not data:
            raise MailboxError(f"no message with uid {uid} in {folder!r} (UIDs are per folder)")
        return int(data.get(b"RFC822.SIZE", 0) or 0)

    def raw(self, folder: str, uid: int) -> bytes:
        """The whole message, peeked (it stays unread)."""
        self.examine(folder)
        try:
            fetched = self.client().fetch([uid], [FULL_FETCH])
        except Exception as exc:
            raise MailboxError(f"fetch of uid {uid} failed in {folder!r}: {exc}") from exc
        data = fetched.get(uid) or fetched.get(int(uid))
        if not data:
            raise MailboxError(f"no message with uid {uid} in {folder!r} (UIDs are per folder)")
        return data.get(FULL_KEY) or b""

    def header_and_text(self, folder: str, uid: int, text_bytes: int) -> bytes:
        """Headers plus the first slice of the text, for a message too large to
        fetch whole: a 40 MB video never crosses the wire to yield 4 kB."""
        self.examine(folder)
        text_fetch = f"BODY.PEEK[TEXT]<0.{max(text_bytes, 1)}>"
        try:
            fetched = self.client().fetch([uid], [HEADER_FETCH, text_fetch])
        except Exception as exc:
            raise MailboxError(f"fetch of uid {uid} failed in {folder!r}: {exc}") from exc
        data = fetched.get(uid) or fetched.get(int(uid)) or {}
        text = b""
        for key, value in data.items():
            if isinstance(key, bytes) and key.startswith(b"BODY[TEXT]") and isinstance(value, bytes):
                text = value
                break
        return (data.get(HEADER_KEY) or b"") + b"\r\n" + text
