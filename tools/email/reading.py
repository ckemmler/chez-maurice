"""The member's word on the reading (specs/mail-import.md, lot 3).

Once the free work of lot 2 is done, Maurice opens a conversation with the
numbers and asks whether he may read the real exchanges of the last years.
The answer lands here, as a job of kind ``reading`` in the member's store:

* ``approved`` — the member said yes. A consent to read the bodies, nothing
  more: no ceiling of its own (``budget_eur`` stays NULL — the household's
  cap is the only one, and it is not this tool's business), no reading yet.
  Lot 4 will pick the job up at night, take it through ``running`` to
  ``done``, and spend under its id.
* ``declined`` — the member said no. Kept so that nobody asks again; the
  member can come back on it from the app, or in the conversation, and the
  same row turns ``approved``.

One row per member for as long as it is only a word: a second yes marks the
same job again rather than opening another. The window the consent covers
is kept in ``cursor`` (``{"years": 3}``) — that is where the reading starts,
and lot 4 will add where it has got to beside it.

Nothing here reads a message, opens a connection or costs anything.
"""

from __future__ import annotations

from typing import Any

from .store import MailStore, now_iso

KIND = "reading"

#: A job in one of these is a word, not a run: the next word marks it again.
SETTLED_BY_WORD = ("approved", "declined")


def status(store: MailStore) -> dict[str, Any] | None:
    """The member's latest reading job, or None when they were never asked."""
    return store.latest_job(KIND)


def _window(job: dict[str, Any] | None, years: int | None) -> dict[str, Any]:
    cur = job.get("cursor") if job else None
    cur = dict(cur) if isinstance(cur, dict) else {}
    if years:
        cur["years"] = max(1, int(years))
    cur.setdefault("years", 3)
    return cur


def approve(store: MailStore, member_id: str, years: int | None = None) -> dict[str, Any]:
    """Record the yes. Idempotent: an approved job is answered as it is; a
    declined one turns approved; a job already running or finished (lot 4)
    is left alone and reported, and a new one opens only after that."""
    job = status(store)
    if job is not None and job["state"] == "approved":
        return {"status": "approved", "job": job, "already": True}
    if job is not None and job["state"] in SETTLED_BY_WORD:
        store.update_job(job["id"], state="approved", cursor=_window(job, years))
        return {"status": "approved", "job": store.job(job["id"]), "already": False}
    if job is not None and job["state"] in ("running", "paused"):
        return {"status": job["state"], "job": job, "already": True,
                "note": "a reading is already under way; it goes on"}
    created = store.create_job(member_id, KIND, state="approved", cursor=_window(None, years))
    return {"status": "approved", "job": created, "already": False}


def decline(store: MailStore, member_id: str) -> dict[str, Any]:
    """Record the no. A job already running (lot 4) is not stopped here —
    that is ``scan_stop``'s — but the word is kept for the next one."""
    job = status(store)
    if job is not None and job["state"] == "declined":
        return {"status": "declined", "job": job, "already": True}
    if job is not None and job["state"] in SETTLED_BY_WORD:
        store.update_job(job["id"], state="declined")
        return {"status": "declined", "job": store.job(job["id"]), "already": False}
    if job is not None and job["state"] in ("running", "paused"):
        return {"status": job["state"], "job": job, "already": False,
                "note": "a reading is under way; stop it with scan_stop if the member wants it stopped"}
    created = store.create_job(member_id, KIND, state="declined", cursor=_window(None, None))
    return {"status": "declined", "job": created, "already": False}


__all__ = ["KIND", "SETTLED_BY_WORD", "approve", "decline", "status", "now_iso"]
