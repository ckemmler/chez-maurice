"""Walking a mailbox into the header store — lot 1 of ``specs/mail-import.md``.

Free, and meant to be interrupted. For each account, for each folder that
"everywhere" means (``Session.searchable_folders``: \\All on Gmail, every
folder but junk, trash and drafts elsewhere):

1. EXAMINE the folder and read its UIDVALIDITY. If it differs from the one
   the cursor remembers, the folder was renumbered: cursor back to zero and
   the old generation's locations purged, in one transaction. Skipping this
   is how mail gets dropped in silence.
2. ``UID SEARCH`` from the cursor in windows of ten thousand UIDs up to the
   folder's UIDNEXT (a mailbox of 150 000 messages does not fit in the one
   line imaplib accepts), then ``UID FETCH`` the headers by batches of 500 —
   on the FETCH the tool already knows, with the server's own stable id
   (X-GM-MSGID, EMAILID) and the triage headers riding along.
3. Each batch is written with its locations and the moved cursor in ONE
   transaction. A crash between two batches loses nothing; a crash inside
   one replays exactly that batch, and every write is idempotent.

The unit of identity is the message, never the folder (identity.py): a
message met again in another folder gains a location, not a row.

The walk runs in a thread — imapclient is blocking — on sessions of its own,
so a search answered meanwhile does not fight it for the connection. One job
per member is enough: a second start while one runs joins it, and a
``running`` job whose checkpoint is fresh is taken for alive even when this
process did not start it (the CLI beside the gateway). ``stop()`` asks the
walk to pause at the next batch boundary; the cursor makes the next start a
continuation, not a repeat.
"""

from __future__ import annotations

import json
import logging
import re
import threading
import time
from typing import Any, Callable, Sequence

from .accounts import Account
from .identity import message_identity
from .imap import AccountUnavailable, MailboxError, Session
from .sealing import seal
from .store import MailStore

log = logging.getLogger("maurice.email")

KIND = "headers"
BATCH = 500
# UIDs per UID SEARCH. A window of ten thousand answers in ~70 kB, well under
# the megabyte imaplib accepts on one line; the whole list of a large mailbox
# does not fit.
WINDOW = 10_000
_ADDRESS = re.compile(r"[\w.+\-']+@[\w\-]+(?:\.[\w\-]+)+", re.UNICODE)


def bare_address(value: str | None) -> str | None:
    """``Jean Dupont <jean@example.org>`` → ``jean@example.org``."""
    if not value:
        return None
    match = _ADDRESS.search(value)
    return match.group(0).lower() if match else value.strip().lower() or None


def row_from_envelope(envelope: dict[str, Any], sealer: Callable[[str], str] = seal) -> dict[str, Any]:
    """One ``messages`` row (plus ``uid`` for its location) from what
    ``Session.envelopes(identity=True)`` returned. The subject leaves here
    sealed; nothing else about it is kept."""
    identity, kind = message_identity(envelope)
    sender = (envelope.get("from") or [None])[0]
    subject = envelope.get("subject") or ""
    return {
        "id": identity,
        "identity": kind,
        "uid": int(envelope["uid"]),
        "message_id": envelope.get("message_id"),
        "sender": sender,
        "sender_address": bare_address(sender),
        "recipients": json.dumps(envelope.get("to") or [], ensure_ascii=False),
        "cc": json.dumps(envelope.get("cc") or [], ensure_ascii=False),
        "reply_to": json.dumps(envelope.get("reply_to") or [], ensure_ascii=False),
        "date": envelope.get("date"),
        "subject_sealed": sealer(subject) if subject else None,
        "list_id": envelope.get("list_id"),
        "list_unsubscribe": 1 if envelope.get("list_unsubscribe") else 0,
        "precedence": envelope.get("precedence"),
        "refs": envelope.get("references"),
        "size": envelope.get("size"),
    }


def _chunks(items: Sequence[int], size: int) -> list[list[int]]:
    return [list(items[i : i + size]) for i in range(0, len(items), size)]


class Scanner:
    """One walk over one member's accounts, writing to their store."""

    def __init__(
        self,
        store: MailStore,
        member_id: str,
        targets: list[tuple[Account, Session]],
        *,
        batch: int = BATCH,
        window: int = WINDOW,
        sealer: Callable[[str], str] = seal,
    ) -> None:
        self.store = store
        self.member_id = member_id
        self.targets = targets
        self.batch = max(1, int(batch))
        self.window = max(self.batch, int(window))
        self.sealer = sealer
        self.stopping = threading.Event()
        self.job_id: str | None = None
        self.counts: dict[str, Any] = {"seen": 0, "written": 0, "folders": 0, "purged": 0, "accounts": {}}
        self.bytes_fetched = 0
        self.errors: list[str] = []
        self.started = 0.0

    def stop(self) -> None:
        self.stopping.set()

    # ── the job ──────────────────────────────────────────────────────────
    def run(self) -> dict[str, Any] | None:
        """Walk everything, or until stopped. Returns the finished job row —
        or None when the store itself could not be written, which is logged
        and is all a caller gets. Never raises: this is a thread's body."""
        self.started = time.monotonic()
        state = "done"
        try:
            self.store.orphan_running_jobs(KIND)
            self.job_id = self.store.create_job(self.member_id, KIND)["id"]
            for account, session in self.targets:
                if self.stopping.is_set():
                    break
                self._walk_account(account, session)
        except Exception as exc:  # noqa: BLE001 — the job row carries it
            log.exception("mail scan for %s failed", self.member_id)
            self.errors.append(f"{type(exc).__name__}: {exc}")
        finally:
            for _account, session in self.targets:
                session.close()
        if self.stopping.is_set():
            state = "paused"
        elif self.errors:
            state = "failed"
        if self.job_id is None:
            return None
        try:
            self._checkpoint(state=state)
            return self.store.job(self.job_id)
        except Exception:  # noqa: BLE001 — a store that cannot be written; the log has it
            log.exception("mail scan for %s: the final checkpoint could not be written", self.member_id)
            return None

    def _job_fields(self, *, state: str = "running", cursor: dict[str, Any] | None = None) -> dict[str, Any]:
        fields: dict[str, Any] = {
            "state": state,
            "counts": self.counts,
            "bytes_fetched": self.bytes_fetched,
            "seconds_spent": round(time.monotonic() - self.started, 1),
            "last_error": "; ".join(self.errors[-3:]) or None,
        }
        if cursor is not None:
            fields["cursor"] = cursor
        return fields

    def _checkpoint(self, *, state: str = "running") -> None:
        self.store.update_job(self.job_id, **self._job_fields(state=state))  # type: ignore[arg-type]

    # ── accounts and folders ─────────────────────────────────────────────
    def _walk_account(self, account: Account, session: Session) -> None:
        address = account.address.lower()
        summary = self.counts["accounts"].setdefault(address, {"folders": 0, "messages": 0})
        try:
            with session.lock:
                folders = session.searchable_folders(refresh=True)  # renamed since the last walk, perhaps
        except (AccountUnavailable, MailboxError) as exc:
            summary["error"] = str(exc)
            self.errors.append(f"{address}: {exc}")
            return
        for folder in folders:
            if self.stopping.is_set():
                return
            try:
                written = self._walk_folder(address, session, folder)
            except AccountUnavailable as exc:
                # The account itself is gone (password, network): nothing
                # more to do here today.
                summary["error"] = str(exc)
                self.errors.append(f"{address}: {exc}")
                return
            except MailboxError as exc:
                # One folder the server would not open or serve — renamed
                # between LIST and EXAMINE, a virtual folder that refuses
                # EXAMINE — must not cost the forty after it. It is named in
                # the job, and the next walk tries it again.
                summary.setdefault("folder_errors", {})[folder] = str(exc)
                self.errors.append(f"{address} {folder!r}: {exc}")
                log.warning("mail scan: %s %r skipped: %s", address, folder, exc)
                continue
            summary["folders"] += 1
            summary["messages"] += written
            self.counts["folders"] += 1

    def _walk_folder(self, address: str, session: Session, folder: str) -> int:
        """Walk one folder from its cursor to the end. Returns rows written.
        Restarts itself when the UIDVALIDITY moves under it."""
        written = 0
        while True:
            with session.lock:
                uidvalidity = session.examine(folder, refresh=True)
                uidnext = session.uidnext(folder)
            cursor = self.store.cursor(address, folder)
            if cursor is None or cursor[0] != uidvalidity:
                purged = self.store.reset_folder(address, folder, uidvalidity)
                self.counts["purged"] += purged
                if cursor is not None:
                    log.info("mail scan: %s %r renumbered (UIDVALIDITY %s → %s), %d location(s) purged",
                             address, folder, cursor[0], uidvalidity, purged)
                highest = 0
            else:
                highest = cursor[1]
            # Every UID in the folder is below UIDNEXT: that is where the walk
            # ends, window by window.
            end = uidnext - 1
            if highest >= end:
                return written
            renumbered = False
            while highest < end:
                if self.stopping.is_set():
                    return written
                upto = min(highest + self.window, end)
                with session.lock:
                    pending = session.uids_after(folder, highest, upto)
                for uids in _chunks(pending, self.batch):
                    if self.stopping.is_set():
                        return written
                    envelopes = self._fetch(session, folder, uids)
                    with session.lock:
                        now_valid = session.examine(folder)
                    if now_valid != uidvalidity:
                        renumbered = True  # the folder moved under us: start it over
                        break
                    rows = [row_from_envelope(e, self.sealer) for e in envelopes]
                    top = max(uids)
                    self.counts["seen"] += len(uids)
                    self.counts["written"] += len(rows)
                    # Rows, locations, cursor and the job's checkpoint: one
                    # transaction, so what the job says it did is what is there.
                    self.store.write_batch(
                        address, folder, uidvalidity, rows, top,
                        job=(self.job_id, self._job_fields(cursor={"account": address, "folder": folder, "uid": top})),
                    )
                    highest = top
                    written += len(rows)
                if renumbered:
                    break
                if highest < upto:
                    # The window's tail was a gap (expunged mail): move the
                    # cursor past it so it is not searched again.
                    self.store.write_batch(address, folder, uidvalidity, [], upto)
                    highest = upto
            if renumbered:
                continue
            # New mail may have arrived during the walk: EXAMINE again and
            # go on if UIDNEXT moved; the loop ends when it did not.
            with session.lock:
                session.examine(folder, refresh=True)
                grown = session.uidnext(folder)
            if grown - 1 <= highest:
                return written

    def _fetch(self, session: Session, folder: str, uids: list[int]) -> list[dict[str, Any]]:
        """One batch, with one retry: a connection dropped mid-FETCH is an
        ordinary event on a long walk, and the session reconnects by itself.
        A second failure is the mailbox's to explain."""
        for attempt in (1, 2):
            try:
                with session.lock:
                    envelopes = session.envelopes(folder, uids, identity=True)
                break
            except MailboxError as exc:
                if attempt == 2:
                    raise
                log.warning("mail scan: fetch of %d uid(s) in %r failed, retrying once: %s", len(uids), folder, exc)
        self.bytes_fetched += sum(int(e.get("header_bytes") or 0) for e in envelopes)
        return envelopes
