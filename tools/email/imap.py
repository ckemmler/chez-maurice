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
from .message import envelope_summary, parse_message, triage_fields

log = logging.getLogger("maurice.email")

HEADER_FETCH = "BODY.PEEK[HEADER]"
HEADER_KEY = b"BODY[HEADER]"
GM_MSGID_KEY = b"X-GM-MSGID"  # Gmail: one number per message, whatever its labels
EMAILID_KEY = b"EMAILID"  # RFC 8474, when the server announces OBJECTID
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


def _text_slice(data: dict[Any, Any]) -> bytes:
    """The ``BODY[TEXT]<0.n>`` value of a fetch, whatever offset key the server
    echoed back (Gmail answers ``BODY[TEXT]<0>``)."""
    for key, value in data.items():
        if isinstance(key, bytes) and key.startswith(b"BODY[TEXT]") and isinstance(value, bytes):
            return value
    return b""


def _objectid(value: Any) -> str | None:
    """``EMAILID (Mabcd…)`` comes back parenthesised; imapclient hands it over
    as a tuple, or as bytes on a server that skips the parentheses."""
    while isinstance(value, (tuple, list)):
        value = value[0] if value else None
    return _decode(value) if value else None


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
        self.state = "unknown"  # unknown | ok | refused | unreachable | no_credentials
        self.error: str | None = None
        self._client: Any = None
        self._selected: str | None = None
        self._uidvalidity: int | None = None
        self._uidnext: int | None = None
        self._folders: list[Folder] | None = None
        self._capabilities: set[bytes] | None = None

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
            # The server answered, and said no: a wrong or revoked password,
            # not a network problem. Saying "unreachable" sent people looking
            # at their connection.
            if type(exc).__name__ == "LoginError":
                self.state, self.error = "refused", f"the mailbox refused the login: {exc}"
                raise AccountUnavailable(f"{self.account.address}: {self.error}") from exc
            self.state, self.error = "unreachable", f"{type(exc).__name__}: {exc}"
            raise AccountUnavailable(
                f"{self.account.address} could not be reached: {type(exc).__name__}: {exc}"
            ) from exc
        self.state, self.error = "ok", None
        self._selected, self._uidvalidity, self._capabilities = None, None, None
        return self._client

    def _drop(self) -> None:
        client, self._client, self._selected, self._uidvalidity = self._client, None, None, None
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

    def searchable_folders(self, refresh: bool = False) -> list[str]:
        """Every folder "everywhere" means: all selectable ones but junk,
        trash and drafts. On Gmail the \\All folder already holds everything
        else, so it is the only one."""
        folders = [f for f in self.folders(refresh=refresh) if f.selectable]
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

    def examine(self, folder: str, refresh: bool = False) -> int:
        """Open a folder read-only (EXAMINE) and return its UIDVALIDITY. There
        is no read-write path.

        The UIDVALIDITY is what makes a stored UID meaningful: when it changes
        the folder was renumbered and every UID remembered for it is void.
        ``refresh`` re-issues the EXAMINE even when the folder is already
        selected — a scan starting a folder wants the value as of now, not as
        of the last search. The connection is checked first: a session that
        reconnected has nothing selected, whatever it remembers.
        """
        client = self.client()
        if self._selected == folder and self._uidvalidity is not None and not refresh:
            return self._uidvalidity
        try:
            info = client.select_folder(folder, readonly=True)
        except AccountUnavailable:
            raise
        except Exception as exc:
            raise MailboxError(f"cannot open {folder!r} on {self.account.address}: {exc}") from exc
        self._selected = folder
        self._uidvalidity = int((info or {}).get(b"UIDVALIDITY", 0) or 0)
        self._uidnext = int((info or {}).get(b"UIDNEXT", 0) or 0) or None
        return self._uidvalidity

    def uidnext(self, folder: str) -> int:
        """The folder's UIDNEXT as of its last EXAMINE: every UID in it is
        below this, so a walk knows where it ends without asking for the
        whole list. UIDNEXT is a SHOULD in RFC 3501; a server that does not
        say is asked for its highest UID instead (``UID SEARCH UID *``, one
        number back), never for the whole list."""
        self.examine(folder)
        if self._uidnext:
            return self._uidnext
        try:
            found = [int(u) for u in self.client().search(["UID", "*"])]
        except Exception as exc:
            raise MailboxError(f"cannot find the last UID of {folder!r}: {exc}") from exc
        self._uidnext = (max(found) + 1) if found else 1
        return self._uidnext

    def capabilities(self) -> set[bytes]:
        if self._capabilities is None:
            try:
                self._capabilities = {c if isinstance(c, bytes) else str(c).encode() for c in self.client().capabilities()}
            except AccountUnavailable:
                raise
            except Exception:
                self._capabilities = set()
        return self._capabilities

    def has_objectid(self) -> bool:
        return b"OBJECTID" in self.capabilities()

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

    def uids_after(self, folder: str, uid: int, upto: int | None = None) -> list[int]:
        """Every UID strictly above ``uid`` — and at most ``upto`` — ascending:
        ``UID SEARCH UID n+1:m``.

        A walk asks in windows rather than ``n+1:*``: on a mailbox of a few
        hundred thousand messages the full list is over a megabyte, which
        imaplib refuses as one line (``got more than 1000000 bytes``, met on
        26 September 2026 against a real Gmail archive). And ``*`` is the
        highest UID in the folder, so a range whose low end is above it still
        matches that one message: anything at or below ``uid`` is dropped
        here rather than walked again.
        """
        self.examine(folder)
        high = "*" if upto is None else str(int(upto))
        try:
            found = self.client().search(["UID", f"{int(uid) + 1}:{high}"])
        except Exception as exc:
            raise MailboxError(f"UID search failed in {folder!r}: {exc}") from exc
        return sorted(int(u) for u in found if int(u) > uid)

    def envelopes(
        self, folder: str, uids: Sequence[int], text_bytes: int = 0, *, identity: bool = False
    ) -> list[dict[str, Any]]:
        """Header metadata. A body only if ``text_bytes`` asks for one.

        The slice of text rides on the FETCH the headers already need, so it
        costs no extra round trip; it comes back under ``_message`` as the
        headers and that slice reassembled, for the caller to parse and — this
        is a body — wrap as untrusted before anyone reads it.

        ``identity`` adds what the header store needs, on the same FETCH: the
        server's stable id (``X-GM-MSGID`` on Gmail, ``EMAILID`` where OBJECTID
        is announced) and the triage headers (References, List-Unsubscribe,
        Precedence) parsed from the header block already in hand.
        """
        if not uids:
            return []
        self.examine(folder)
        parts: list[str] = [HEADER_FETCH, "FLAGS", "RFC822.SIZE"]
        if identity:
            if self.account.gmail:
                parts.append("X-GM-MSGID")
            elif self.has_objectid():
                parts.append("EMAILID")
        if text_bytes > 0:
            parts.append(f"BODY.PEEK[TEXT]<0.{text_bytes}>")
        try:
            fetched = self.client().fetch(list(uids), parts)
        except Exception as exc:
            raise MailboxError(f"fetch failed in {folder!r}: {exc}") from exc
        out = []
        for uid, data in fetched.items():
            header = data.get(HEADER_KEY) or b""
            message = parse_message(header)
            summary = envelope_summary(message)
            flags = [_decode(f) for f in data.get(b"FLAGS", ())]
            entry = {
                "account": self.account.name,
                "folder": folder,
                "uid": int(uid),
                "size": int(data.get(b"RFC822.SIZE", 0) or 0),
                "unread": "\\Seen" not in flags,
                "flagged": "\\Flagged" in flags,
                **summary,
            }
            if identity:
                entry.update(triage_fields(message))
                entry["header_bytes"] = len(header)  # what actually crossed the wire
                gm = data.get(GM_MSGID_KEY)
                entry["gm_msgid"] = int(gm) if gm else None
                entry["emailid"] = _objectid(data.get(EMAILID_KEY))
            if text_bytes > 0:
                text = _text_slice(data)
                entry["_message"] = header + b"\r\n" + text
                entry["_message_partial"] = len(text) >= text_bytes
            out.append(entry)
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

    def header_and_text_many(self, folder: str, uids: Sequence[int], text_bytes: int) -> dict[int, tuple[bytes, bool]]:
        """Headers plus the first slice of the text, for several messages in
        one FETCH: ``{uid: (raw, partial)}``, ``partial`` when the slice
        came back full and the text may go on. For the calibration, which
        counts and keeps nothing."""
        if not uids:
            return {}
        self.examine(folder)
        text_fetch = f"BODY.PEEK[TEXT]<0.{max(int(text_bytes), 1)}>"
        try:
            fetched = self.client().fetch(list(uids), [HEADER_FETCH, text_fetch])
        except Exception as exc:
            raise MailboxError(f"fetch of {len(uids)} uid(s) failed in {folder!r}: {exc}") from exc
        out: dict[int, tuple[bytes, bool]] = {}
        for uid, data in fetched.items():
            text = _text_slice(data)
            out[int(uid)] = ((data.get(HEADER_KEY) or b"") + b"\r\n" + text, len(text) >= int(text_bytes))
        return out

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
        return (data.get(HEADER_KEY) or b"") + b"\r\n" + _text_slice(data)
