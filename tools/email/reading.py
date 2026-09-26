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

The word costs nothing. **The passes (lot 4)** are what the yes unlocks,
and they run in the server, which holds the models and the ledger; this
module hands them their material and keeps what they leave:

* ``next_batch`` — for the light pass, the next messages of the window not
  yet judged, each with its headers (the subject unsealed for the model, in
  transit only) and the first 600 characters of its text; for the full pass,
  the messages the light pass kept and not yet read, each with its text
  (the first 16 kB, as the calibration did). Fetched with ``BODY.PEEK``,
  nothing marked read, nothing of it stored.
* ``record`` — the light verdicts (``keep`` / ``skip``, with the reason), and
  the full readings: a JSON the server's model wrote from the body, sealed
  under the household key before it touches the disk.
* ``control`` — the job's life: ``running`` when a pass starts, ``paused``
  when a night or a limit ends it with work left, ``done`` when the window
  is read; and the measure — messages and seconds — kept in ``capacity``
  for the estimate's nights.
"""

from __future__ import annotations

import json
from collections import defaultdict
from datetime import datetime
from typing import Any

from . import sealing
from .calibrate import PREVIEW_CHARS, READ_KINDS, SLICE_BYTES, window_start
from .imap import AccountUnavailable, MailboxError, Session
from .message import body_text, parse_message
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


# ── The passes' material (lot 4) ─────────────────────────────────────────

STAGES = ("light", "full")
PREVIEW_BYTES = PREVIEW_CHARS * 4


def _years(job: dict[str, Any] | None) -> int:
    cur = job.get("cursor") if job else None
    try:
        return max(1, int((cur or {}).get("years", 3)))
    except (TypeError, ValueError):
        return 3


def _since(job: dict[str, Any] | None, now: datetime | None = None) -> str:
    return window_start(_years(job), now)


def _list(raw: str | None) -> list[str]:
    try:
        v = json.loads(raw or "[]")
    except ValueError:
        return []
    return [str(x) for x in v] if isinstance(v, list) else []


def _subject(sealed: str | None) -> str | None:
    if not sealed:
        return None
    try:
        return sealing.unseal(sealed)
    except Exception:  # a key that changed: the model reads without it
        return None


def progress(store: MailStore, job: dict[str, Any] | None, now: datetime | None = None) -> dict[str, int]:
    return store.reading_progress(READ_KINDS, _since(job, now))


def next_batch(
    store: MailStore, sessions: dict[str, Session], job: dict[str, Any], stage: str, limit: int = 20, *, now: datetime | None = None
) -> dict[str, Any]:
    """The next ``limit`` messages of a pass, with what that pass reads.
    A folder that refuses is reported and its messages wait for the next
    batch (they are still candidates); the batch is never empty for that
    reason alone unless every folder refused."""
    if stage not in STAGES:
        raise ValueError(f"not a stage: {stage!r}")
    since = _since(job, now)
    rows = store.reading_candidates(READ_KINDS, since, stage, max(1, min(int(limit), 100)))
    by_place: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for r in rows:
        by_place[(r["address"], r["folder"])].append(r)
    text_bytes = PREVIEW_BYTES if stage == "light" else SLICE_BYTES
    out: list[dict[str, Any]] = []
    errors: list[str] = []
    for (address, folder), locs in by_place.items():
        session = sessions.get(address)
        if session is None:
            errors.append(f"{address}: no session")
            continue
        by_uid = {int(l["uid"]): l for l in locs}
        try:
            with session.lock:
                slices = session.header_and_text_many(folder, list(by_uid), text_bytes)
        except (AccountUnavailable, MailboxError) as exc:
            errors.append(f"{address} {folder!r}: {exc}")
            continue
        for uid, (raw, partial) in slices.items():
            row = by_uid.get(int(uid))
            if row is None:
                continue
            text = body_text(parse_message(raw), max_bytes=text_bytes * 4)["text"]
            entry = {
                "id": row["id"],
                "from": row["sender"],
                "to": _list(row["recipients"]),
                "cc": _list(row["cc"]),
                "date": row["date"],
                "subject": _subject(row["subject_sealed"]),
                "size": row["size"],
            }
            if stage == "light":
                entry["preview"] = text[:PREVIEW_CHARS]
            else:
                entry["body"] = text
                entry["truncated"] = bool(partial)
            out.append(entry)
    # Candidates the fetch did not answer for (a folder that refused, a UID
    # gone since the walk) are named, so the caller can skip them rather
    # than ask for the same batch forever.
    answered = {e["id"] for e in out}
    missing = [r["id"] for r in rows if r["id"] not in answered]
    result = {"stage": stage, "since": since, "messages": out, "missing": missing, "progress": progress(store, job, now)}
    if errors:
        result["errors"] = errors
    return result


def record(
    store: MailStore,
    job: dict[str, Any],
    *,
    verdicts: list[dict[str, Any]] | None = None,
    readings: list[dict[str, Any]] | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Keep what a pass decided. ``verdicts``: ``{id, keep: bool, reason,
    tokens?}``. ``readings``: ``{id, reading: object, tokens?}`` — sealed
    here, before the disk. The job's counts move with them."""
    at = now_iso()
    light_rows = []
    for v in verdicts or []:
        mid = str(v.get("id") or "")
        if not mid:
            continue
        keep = bool(v.get("keep"))
        light_rows.append((mid, "keep" if keep else "skip", str(v.get("reason") or "")[:300], _int(v.get("tokens")), at))
    read_rows = []
    for r in readings or []:
        mid = str(r.get("id") or "")
        reading = r.get("reading")
        if not mid or not isinstance(reading, dict):
            continue
        read_rows.append((mid, sealing.seal(json.dumps(reading, ensure_ascii=False)), _int(r.get("tokens")), at))
    if light_rows:
        store.write_light(light_rows)
    if read_rows:
        store.write_readings(read_rows)
    counts = dict(job.get("counts") or {})
    counts["judged"] = int(counts.get("judged", 0)) + len(light_rows)
    counts["kept"] = int(counts.get("kept", 0)) + sum(1 for r in light_rows if r[1] == "keep")
    counts["skipped"] = int(counts.get("skipped", 0)) + sum(1 for r in light_rows if r[1] == "skip")
    counts["read"] = int(counts.get("read", 0)) + len(read_rows)
    store.update_job(job["id"], counts=counts)
    return {"recorded": {"verdicts": len(light_rows), "readings": len(read_rows)}, "job": store.job(job["id"]), "progress": progress(store, job, now)}


def _int(v: Any) -> int | None:
    try:
        return int(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def control(
    store: MailStore,
    job: dict[str, Any],
    state: str,
    *,
    error: str | None = None,
    measured: dict[str, Any] | None = None,
    seconds: float | None = None,
) -> dict[str, Any]:
    """Move the job: ``running`` at the start of a pass (from approved,
    paused, or a run that died), ``paused`` with work left, ``done`` when
    the window is read; ``failed`` with the reason. ``measured``
    (``{messages, seconds}``) is kept in ``capacity``."""
    if state not in ("running", "paused", "done", "failed"):
        raise ValueError(f"not a state the reading takes: {state!r}")
    fields: dict[str, Any] = {"state": state, "last_error": error}
    if seconds is not None:
        fields["seconds_spent"] = float(job.get("seconds_spent") or 0) + float(seconds)
    store.update_job(job["id"], **fields)
    if measured and int(measured.get("messages") or 0) > 0:
        store.add_capacity(job["id"], int(measured["messages"]), float(measured.get("seconds") or 0))
    return {"job": store.job(job["id"]), "capacity": store.capacity()}


__all__ = ["KIND", "SETTLED_BY_WORD", "STAGES", "approve", "control", "decline", "next_batch", "progress", "record", "status", "now_iso"]
