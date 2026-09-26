"""Reconciling the header store with the mailbox — lot 2 of
``specs/mail-import.md``, settled 26 September 2026.

The walk (scan.py) only ever adds: a message expunged, moved away or whose
folder was deleted keeps its location in the store, and the cursor never
looks back. Once a week, this pass looks back — cheaply:

1. LIST the account's folders. A folder the store knows that LIST no longer
   names is dropped: its locations and its cursor go.
2. For each folder still there, EXAMINE it and compare the UIDVALIDITY with
   the cursor's. A change means the folder was renumbered: cursor to zero,
   the old generation purged, and the next walk redoes it.
3. Otherwise ``UID SEARCH`` in windows of ten thousand up to UIDNEXT — the
   list of UIDs the folder holds now — and **no FETCH at all**: a folder of
   164 000 messages answers in a few seconds. Every stored location whose UID
   is not in that list is removed.
4. A message left with no location at all keeps its row and is marked "no
   longer seen" (``messages.gone_at``); one met again is unmarked.

It is a job like the walk (kind ``reconcile``): a row with a heartbeat, a
stop that takes effect at the next folder, and never at the same time as a
walk on the same store — the walk adds locations the listing would not
know, and the listing would remove them.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any

from .accounts import Account
from .imap import AccountUnavailable, MailboxError, Session
from .scan import WINDOW
from .store import MailStore

log = logging.getLogger("maurice.email")

KIND = "reconcile"


class _Stopped(Exception):
    """The member said stop while a folder was being listed."""


class Reconciler:
    """One pass over one member's accounts, trimming their store."""

    def __init__(self, store: MailStore, member_id: str, targets: list[tuple[Account, Session]], *, window: int = WINDOW) -> None:
        self.store = store
        self.member_id = member_id
        self.targets = targets
        self.window = max(1, int(window))
        self.stopping = threading.Event()
        self.job_id: str | None = None
        self.counts: dict[str, Any] = {
            "folders": 0, "dropped_folders": 0, "renumbered": 0, "removed": 0, "gone": 0, "reappeared": 0, "accounts": {},
        }
        self.errors: list[str] = []
        self.started = 0.0

    def stop(self) -> None:
        self.stopping.set()

    def run(self) -> dict[str, Any] | None:
        """Reconcile everything, or until stopped. Never raises."""
        self.started = time.monotonic()
        state = "done"
        try:
            self.store.orphan_running_jobs()
            self.job_id = self.store.create_job(self.member_id, KIND)["id"]
            for account, session in self.targets:
                if self.stopping.is_set():
                    break
                self._reconcile_account(account, session)
            if not self.stopping.is_set():
                marked = self.store.mark_unlocated()
                self.counts["gone"] = marked["gone"]
                self.counts["reappeared"] = marked["reappeared"]
        except Exception as exc:  # noqa: BLE001 — the job row carries it
            log.exception("mail reconcile for %s failed", self.member_id)
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
        except Exception:  # noqa: BLE001
            log.exception("mail reconcile for %s: the final checkpoint could not be written", self.member_id)
            return None

    def _checkpoint(self, *, state: str = "running", cursor: dict[str, Any] | None = None) -> None:
        fields: dict[str, Any] = {
            "state": state,
            "counts": self.counts,
            "seconds_spent": round(time.monotonic() - self.started, 1),
            "last_error": "; ".join(self.errors[-3:]) or None,
        }
        if cursor is not None:
            fields["cursor"] = cursor
        self.store.update_job(self.job_id, **fields)  # type: ignore[arg-type]

    def _reconcile_account(self, account: Account, session: Session) -> None:
        address = account.address.lower()
        summary = self.counts["accounts"].setdefault(address, {"folders": 0, "removed": 0})
        try:
            with session.lock:
                live = set(session.searchable_folders(refresh=True))
        except (AccountUnavailable, MailboxError) as exc:
            summary["error"] = str(exc)
            self.errors.append(f"{address}: {exc}")
            return
        for folder, remembered in self.store.known_folders(address):
            if self.stopping.is_set():
                return
            if folder not in live:
                removed = self.store.drop_folder(address, folder)
                self.counts["dropped_folders"] += 1
                self.counts["removed"] += removed
                summary["removed"] += removed
                log.info("mail reconcile: %s %r no longer listed, %d location(s) dropped", address, folder, removed)
                continue
            try:
                removed = self._reconcile_folder(address, session, folder, remembered)
            except _Stopped:
                return
            except AccountUnavailable as exc:
                summary["error"] = str(exc)
                self.errors.append(f"{address}: {exc}")
                return
            except MailboxError as exc:
                summary.setdefault("folder_errors", {})[folder] = str(exc)
                self.errors.append(f"{address} {folder!r}: {exc}")
                log.warning("mail reconcile: %s %r skipped: %s", address, folder, exc)
                continue
            self.counts["folders"] += 1
            self.counts["removed"] += removed
            summary["folders"] += 1
            summary["removed"] += removed
            self._checkpoint(cursor={"account": address, "folder": folder})

    def _reconcile_folder(self, address: str, session: Session, folder: str, remembered: int) -> int:
        with session.lock:
            uidvalidity = session.examine(folder, refresh=True)
            uidnext = session.uidnext(folder)
        if uidvalidity != remembered:
            # Renumbered: nothing stored for it means anything any more. The
            # reset purges the old generation; the next walk redoes the folder.
            purged = self.store.reset_folder(address, folder, uidvalidity)
            self.counts["renumbered"] += 1
            log.info("mail reconcile: %s %r renumbered (UIDVALIDITY %s → %s), %d location(s) purged",
                     address, folder, remembered, uidvalidity, purged)
            return purged
        live: set[int] = set()
        low, end = 0, uidnext - 1
        while low < end:
            if self.stopping.is_set():
                raise _Stopped()  # nothing is removed on a partial list
            upto = min(low + self.window, end)
            with session.lock:
                live.update(session.uids_after(folder, low, upto))
            low = upto
        return self.store.reconcile_folder(address, folder, uidvalidity, live)
