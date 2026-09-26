"""The per-member header store: ``<app dir>/mail/<member id>.db``.

One SQLite file per member, written by the ``email`` tool and by nothing else
— never ``maurice.db``. It holds what lot 1 of ``specs/mail-import.md``
produces: the jobs, the cursor per (account, folder), every parsed header with
its subject sealed, and where each message was seen.

Shape of the thing:

* ``messages`` is keyed by the message's stable identity (identity.py), which
  never depends on a folder. Structural fields — from, to, cc, date,
  message-id, list-id, references — stay in clear and indexed: everything
  relational and statistical reads only those. The subject is sealed under
  the household key (sealing.py); it is the table of contents of someone's
  life and it does not sit in clear on a disk.
* ``locations`` says where a message was found: (account, folder, uidvalidity,
  uid). A message moved, or a folder renamed, is the same row in ``messages``
  with one location more.
* ``cursors`` is ``{uidvalidity, highest_uid_done}`` per (account, folder).
  When a folder's UIDVALIDITY changes its numbering is void: the cursor goes
  back to zero and the locations of the old generation are purged, in the
  same transaction.
* ``jobs`` is the import as an object — state, counts, bytes, seconds, the
  last error — so a restart, a sleeping machine or the member saying stop all
  leave something to read.
* ``triage`` (lot 2) is the verdict on each message from its headers alone —
  bulk, correspondence, or neither — with the reason, recomputable at will.
* ``calibration`` (lot 2) is the one row that says how many tokens a
  kilobyte of this member's mail turns out to be, measured on a sample.
* ``messages.gone_at`` (lot 2) marks a message that no longer has a location
  after a reconciliation: the row is kept, the message is "no longer seen".
* ``readings`` (lot 4) is what the two reading passes leave per message: the
  light pass's verdict (``keep`` or ``skip``, with its reason) and, for the
  kept ones, the full reading — a structured summary the server's model
  wrote, **sealed** under the household key like the subject: derived from
  the body, never the body, and not in clear on the disk either.
* ``capacity`` (lot 4) is what a night's reading actually got through —
  messages and seconds per run — measured, beside the calibration, and never
  derived from a spend cap: the estimate's "nights" rest on it once it
  exists.

Every batch writes its rows, its locations and its cursor in ONE transaction,
and every write is idempotent (``INSERT … ON CONFLICT DO UPDATE``, which is
``INSERT OR REPLACE`` that keeps ``first_seen_at``), so replaying a batch after
a crash is harmless. Idempotence, not exactly-once.

A connection is opened per operation: the scan writes from its own thread
while a status request reads from another, and sqlite3 connections are not
shared across threads.
"""

from __future__ import annotations

import json
import random
import re
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from .accounts import maurice_db_path

SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
  id            TEXT PRIMARY KEY,
  member_id     TEXT NOT NULL,
  kind          TEXT NOT NULL,
  state         TEXT NOT NULL,           -- JOB_STATES below
  budget_eur    REAL,
  spent_eur     REAL NOT NULL DEFAULT 0,
  cursor        TEXT,                    -- JSON: where it is (account, folder, uid)
  counts        TEXT NOT NULL DEFAULT '{}',
  bytes_fetched INTEGER NOT NULL DEFAULT 0,
  seconds_spent REAL NOT NULL DEFAULT 0,
  last_error    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cursors (
  address          TEXT NOT NULL,
  folder           TEXT NOT NULL,
  uidvalidity      INTEGER NOT NULL,
  highest_uid_done INTEGER NOT NULL DEFAULT 0,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (address, folder)
);
CREATE TABLE IF NOT EXISTS messages (
  id               TEXT PRIMARY KEY,     -- identity.py
  identity         TEXT NOT NULL,        -- gm_msgid | emailid | message_id | weak
  message_id       TEXT,
  sender           TEXT,                 -- the From header, first address, as written
  sender_address   TEXT,                 -- its bare address, lowercased
  recipients       TEXT NOT NULL DEFAULT '[]',   -- JSON, To
  cc               TEXT NOT NULL DEFAULT '[]',   -- JSON
  reply_to         TEXT NOT NULL DEFAULT '[]',   -- JSON
  date             TEXT,                 -- ISO 8601 with offset, as the header said
  subject_sealed   TEXT,                 -- sealing.py; never in clear
  list_id          TEXT,
  list_unsubscribe INTEGER NOT NULL DEFAULT 0,
  precedence       TEXT,
  refs             TEXT,                 -- References, whitespace-normalised
  size             INTEGER,
  first_seen_at    TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS readings (
  message        TEXT PRIMARY KEY REFERENCES messages (id),
  light          TEXT,                  -- keep | skip
  light_reason   TEXT,
  light_at       TEXT,
  reading_sealed TEXT,                  -- sealing.py: the full reading, JSON
  read_at        TEXT,
  tokens_light   INTEGER,
  tokens_full    INTEGER
);
CREATE INDEX IF NOT EXISTS readings_light ON readings (light);
CREATE TABLE IF NOT EXISTS capacity (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  job         TEXT,
  messages    INTEGER NOT NULL,
  seconds     REAL NOT NULL,
  measured_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_sender ON messages (sender_address);
CREATE INDEX IF NOT EXISTS messages_date ON messages (date);
CREATE INDEX IF NOT EXISTS messages_list ON messages (list_id);
CREATE INDEX IF NOT EXISTS messages_message_id ON messages (message_id);
CREATE TABLE IF NOT EXISTS locations (
  address     TEXT NOT NULL,
  folder      TEXT NOT NULL,
  uidvalidity INTEGER NOT NULL,
  uid         INTEGER NOT NULL,
  message     TEXT NOT NULL REFERENCES messages (id),
  seen_at     TEXT NOT NULL,
  PRIMARY KEY (address, folder, uidvalidity, uid)
);
CREATE INDEX IF NOT EXISTS locations_message ON locations (message);
CREATE TABLE IF NOT EXISTS triage (
  message     TEXT PRIMARY KEY REFERENCES messages (id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,           -- bulk | correspondence | other
  reason      TEXT NOT NULL,           -- what decided it (triage.py)
  computed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS triage_kind ON triage (kind);
CREATE TABLE IF NOT EXISTS calibration (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  sampled         INTEGER NOT NULL,
  complete        INTEGER NOT NULL,    -- bodies read whole, the ratio's basis
  bytes           INTEGER NOT NULL,    -- RFC822.SIZE of those, added up
  tokens          INTEGER NOT NULL,
  preview_tokens  REAL NOT NULL,       -- tokens in the first PREVIEW_CHARS, on average
  tokenizer       TEXT NOT NULL,
  computed_at     TEXT NOT NULL
);
"""

# Columns added after the first schema shipped: (table, column, type).
MIGRATIONS = (
    ("messages", "gone_at", "TEXT"),
)

# The walk and the reconciliation move through the first four. The reading
# (lot 3) adds two that are the member's word, not the machine's: ``approved``
# is a consent given and not yet acted on, ``declined`` a refusal that is
# never asked about again. Lot 4 will take an approved job through
# ``running`` and ``done`` like the others.
JOB_STATES = ("running", "paused", "done", "failed", "approved", "declined")
# A running job whose checkpoint is older than this is taken for dead. A batch
# of 500 takes a few seconds; a connection that hangs times out in 30.
STALE_AFTER = 10 * 60
_SAFE = re.compile(r"[^A-Za-z0-9._-]")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _age_seconds(stamp: str | None) -> float:
    try:
        then = datetime.fromisoformat(stamp or "")
    except ValueError:
        return float("inf")
    if then.tzinfo is None:
        then = then.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - then).total_seconds()


def mail_dir() -> Path:
    return maurice_db_path().parent / "mail"


def store_path(member_id: str) -> Path:
    """One file per member. The id is a UUID in practice; anything else is
    made filename-safe rather than trusted."""
    return mail_dir() / f"{_SAFE.sub('_', member_id)}.db"


class MailStore:
    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as conn:
            conn.executescript(SCHEMA)
            for table, column, kind in MIGRATIONS:
                present = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}
                if column not in present:
                    conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {kind}")

    @classmethod
    def for_member(cls, member_id: str) -> "MailStore":
        return cls(store_path(member_id))

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self.path, timeout=30, isolation_level=None)
        try:
            conn.execute("PRAGMA journal_mode = WAL")
            conn.execute("PRAGMA foreign_keys = ON")
            conn.row_factory = sqlite3.Row
            yield conn
        finally:
            conn.close()

    @contextmanager
    def _transaction(self) -> Iterator[sqlite3.Connection]:
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                yield conn
            except BaseException:
                conn.execute("ROLLBACK")
                raise
            conn.execute("COMMIT")

    # ── cursors ──────────────────────────────────────────────────────────
    def cursor(self, address: str, folder: str) -> tuple[int, int] | None:
        """``(uidvalidity, highest_uid_done)`` or None when never walked."""
        with self._connect() as conn:
            row = conn.execute(
                "SELECT uidvalidity, highest_uid_done FROM cursors WHERE address = ? AND folder = ?",
                (address, folder),
            ).fetchone()
        return (int(row["uidvalidity"]), int(row["highest_uid_done"])) if row else None

    def cursors(self, address: str | None = None) -> list[dict[str, Any]]:
        with self._connect() as conn:
            if address is None:
                rows = conn.execute("SELECT * FROM cursors ORDER BY address, folder").fetchall()
            else:
                rows = conn.execute("SELECT * FROM cursors WHERE address = ? ORDER BY folder", (address,)).fetchall()
        return [dict(r) for r in rows]

    def reset_folder(self, address: str, folder: str, uidvalidity: int) -> int:
        """The folder was renumbered (or is new): cursor to zero under the new
        UIDVALIDITY, and every location of another generation purged, in one
        transaction. Returns how many locations went."""
        with self._transaction() as conn:
            gone = conn.execute(
                "DELETE FROM locations WHERE address = ? AND folder = ? AND uidvalidity != ?",
                (address, folder, uidvalidity),
            ).rowcount
            conn.execute(
                """INSERT INTO cursors (address, folder, uidvalidity, highest_uid_done, updated_at)
                   VALUES (?, ?, ?, 0, ?)
                   ON CONFLICT (address, folder) DO UPDATE SET
                     uidvalidity = excluded.uidvalidity, highest_uid_done = 0, updated_at = excluded.updated_at""",
                (address, folder, uidvalidity, now_iso()),
            )
        return int(gone)

    # ── the batch ────────────────────────────────────────────────────────
    def write_batch(
        self,
        address: str,
        folder: str,
        uidvalidity: int,
        rows: list[dict[str, Any]],
        highest_uid: int,
        *,
        job: tuple[str, dict[str, Any]] | None = None,
    ) -> None:
        """The rows of one batch, their locations, the cursor moved to
        ``highest_uid`` — and the job's checkpoint, when given — in one
        transaction. Each row is what ``scan.row_from_envelope`` builds: the
        message's fields plus ``uid``."""
        at = now_iso()
        with self._transaction() as conn:
            if job is not None:
                self._update_job(conn, job[0], dict(job[1]))
            for row in rows:
                conn.execute(
                    """INSERT INTO messages (id, identity, message_id, sender, sender_address, recipients, cc,
                         reply_to, date, subject_sealed, list_id, list_unsubscribe, precedence, refs, size,
                         first_seen_at, updated_at)
                       VALUES (:id, :identity, :message_id, :sender, :sender_address, :recipients, :cc,
                         :reply_to, :date, :subject_sealed, :list_id, :list_unsubscribe, :precedence, :refs, :size,
                         :at, :at)
                       ON CONFLICT (id) DO UPDATE SET
                         identity = excluded.identity, message_id = excluded.message_id,
                         sender = excluded.sender, sender_address = excluded.sender_address,
                         recipients = excluded.recipients, cc = excluded.cc, reply_to = excluded.reply_to,
                         date = excluded.date, subject_sealed = excluded.subject_sealed,
                         list_id = excluded.list_id, list_unsubscribe = excluded.list_unsubscribe,
                         precedence = excluded.precedence, refs = excluded.refs, size = excluded.size,
                         updated_at = excluded.updated_at, gone_at = NULL""",
                    {**row, "at": at},
                )
                conn.execute(
                    """INSERT OR REPLACE INTO locations (address, folder, uidvalidity, uid, message, seen_at)
                       VALUES (?, ?, ?, ?, ?, ?)""",
                    (address, folder, uidvalidity, int(row["uid"]), row["id"], at),
                )
            conn.execute(
                """INSERT INTO cursors (address, folder, uidvalidity, highest_uid_done, updated_at)
                   VALUES (?, ?, ?, ?, ?)
                   ON CONFLICT (address, folder) DO UPDATE SET
                     uidvalidity = excluded.uidvalidity,
                     highest_uid_done = MAX(highest_uid_done, excluded.highest_uid_done),
                     updated_at = excluded.updated_at""",
                (address, folder, uidvalidity, int(highest_uid), at),
            )

    # ── jobs ─────────────────────────────────────────────────────────────
    def create_job(
        self, member_id: str, kind: str, *, budget_eur: float | None = None, state: str = "running", cursor: Any = None
    ) -> dict[str, Any]:
        if state not in JOB_STATES:
            raise ValueError(f"not a job state: {state!r}")
        if cursor is not None and not isinstance(cursor, str):
            cursor = json.dumps(cursor, ensure_ascii=False)
        at = now_iso()
        job_id = f"job_{uuid.uuid4().hex[:12]}"
        with self._transaction() as conn:
            conn.execute(
                """INSERT INTO jobs (id, member_id, kind, state, budget_eur, cursor, counts, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?)""",
                (job_id, member_id, kind, state, budget_eur, cursor, at, at),
            )
        return self.job(job_id)  # type: ignore[return-value]

    def update_job(self, job_id: str, **fields: Any) -> None:
        with self._transaction() as conn:
            self._update_job(conn, job_id, fields)

    @staticmethod
    def _update_job(conn: sqlite3.Connection, job_id: str, fields: dict[str, Any]) -> None:
        allowed = {"state", "spent_eur", "cursor", "counts", "bytes_fetched", "seconds_spent", "last_error"}
        unknown = set(fields) - allowed
        if unknown:
            raise ValueError(f"not a job field: {sorted(unknown)}")
        if "state" in fields and fields["state"] not in JOB_STATES:
            raise ValueError(f"not a job state: {fields['state']!r}")
        for key in ("cursor", "counts"):
            if key in fields and not isinstance(fields[key], (str, type(None))):
                fields[key] = json.dumps(fields[key], ensure_ascii=False)
        fields["updated_at"] = now_iso()
        sets = ", ".join(f"{k} = :{k}" for k in fields)
        conn.execute(f"UPDATE jobs SET {sets} WHERE id = :id", {**fields, "id": job_id})

    def _job_row(self, row: sqlite3.Row | None) -> dict[str, Any] | None:
        if row is None:
            return None
        out = dict(row)
        for key in ("cursor", "counts"):
            try:
                out[key] = json.loads(out[key]) if out[key] else ({} if key == "counts" else None)
            except ValueError:
                pass
        return out

    def job(self, job_id: str) -> dict[str, Any] | None:
        with self._connect() as conn:
            return self._job_row(conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone())

    def latest_job(self, kind: str) -> dict[str, Any] | None:
        with self._connect() as conn:
            return self._job_row(
                conn.execute(
                    "SELECT * FROM jobs WHERE kind = ? ORDER BY created_at DESC, rowid DESC LIMIT 1", (kind,)
                ).fetchone()
            )

    def running_job(self, kind: str | None = None, *, fresh_within: float = STALE_AFTER) -> dict[str, Any] | None:
        """A 'running' job whose last checkpoint is recent — alive, as far as
        this file can tell, possibly in another process (the CLI beside the
        gateway). ``updated_at`` moves at every batch, so it is the
        heartbeat. Without a kind: any job at all, since a walk and a
        reconciliation must not share the file."""
        with self._connect() as conn:
            if kind is None:
                row = conn.execute("SELECT * FROM jobs WHERE state = 'running' ORDER BY updated_at DESC LIMIT 1").fetchone()
            else:
                row = conn.execute(
                    "SELECT * FROM jobs WHERE kind = ? AND state = 'running' ORDER BY updated_at DESC LIMIT 1", (kind,)
                ).fetchone()
        job = self._job_row(row)
        if job is None or _age_seconds(job["updated_at"]) > fresh_within:
            return None
        return job

    def orphan_running_jobs(self, kind: str | None = None, *, older_than: float = STALE_AFTER) -> int:
        """A process that died mid-scan left its job 'running' forever. Once
        its heartbeat is stale, whoever looks next marks it 'paused': the
        cursor is the truth, the job row only says what happened. A fresh
        one is left alone — it may well be another process, still walking."""
        with self._connect() as conn:
            if kind is None:
                rows = conn.execute("SELECT id, updated_at FROM jobs WHERE state = 'running'").fetchall()
            else:
                rows = conn.execute("SELECT id, updated_at FROM jobs WHERE kind = ? AND state = 'running'", (kind,)).fetchall()
        stale = [r["id"] for r in rows if _age_seconds(r["updated_at"]) > older_than]
        if not stale:
            return 0
        with self._transaction() as conn:
            conn.execute(
                f"UPDATE jobs SET state = 'paused', updated_at = ? WHERE id IN ({','.join('?' * len(stale))})",
                (now_iso(), *stale),
            )
        return len(stale)

    # ── reconciliation (lot 2) ───────────────────────────────────────────
    def known_folders(self, address: str) -> list[tuple[str, int]]:
        """The folders ever walked for this account, with the UIDVALIDITY the
        cursor remembers: what a reconciliation has to check."""
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT folder, uidvalidity FROM cursors WHERE address = ? ORDER BY folder", (address,)
            ).fetchall()
        return [(r["folder"], int(r["uidvalidity"])) for r in rows]

    def reconcile_folder(self, address: str, folder: str, uidvalidity: int, live_uids: set[int]) -> int:
        """Drop every location of this folder that the server no longer
        lists: a UID gone (expunged, moved away) or a generation other than
        the current one. Returns how many went. The messages keep their rows."""
        with self._connect() as conn:
            stored = [int(r["uid"]) for r in conn.execute(
                "SELECT uid FROM locations WHERE address = ? AND folder = ? AND uidvalidity = ?",
                (address, folder, uidvalidity),
            ).fetchall()]
        gone = [uid for uid in stored if uid not in live_uids]
        removed = 0
        with self._transaction() as conn:
            removed += conn.execute(
                "DELETE FROM locations WHERE address = ? AND folder = ? AND uidvalidity != ?",
                (address, folder, uidvalidity),
            ).rowcount
            for i in range(0, len(gone), 500):
                chunk = gone[i : i + 500]
                removed += conn.execute(
                    f"DELETE FROM locations WHERE address = ? AND folder = ? AND uidvalidity = ? AND uid IN ({','.join('?' * len(chunk))})",
                    (address, folder, uidvalidity, *chunk),
                ).rowcount
        return int(removed)

    def drop_folder(self, address: str, folder: str) -> int:
        """The folder left LIST: its locations and its cursor go. Should it
        come back under the same name, it is walked afresh."""
        with self._transaction() as conn:
            removed = conn.execute("DELETE FROM locations WHERE address = ? AND folder = ?", (address, folder)).rowcount
            conn.execute("DELETE FROM cursors WHERE address = ? AND folder = ?", (address, folder))
        return int(removed)

    def mark_unlocated(self) -> dict[str, int]:
        """After a reconciliation: a message without any location is marked
        gone (its row stays — the triage, the threads, the history it is part
        of are still true); one seen again is unmarked. Returns both counts."""
        at = now_iso()
        with self._transaction() as conn:
            gone = conn.execute(
                "UPDATE messages SET gone_at = ? WHERE gone_at IS NULL AND id NOT IN (SELECT message FROM locations)", (at,)
            ).rowcount
            back = conn.execute(
                "UPDATE messages SET gone_at = NULL WHERE gone_at IS NOT NULL AND id IN (SELECT message FROM locations)"
            ).rowcount
        return {"gone": int(gone), "reappeared": int(back)}

    # ── reading ──────────────────────────────────────────────────────────
    def totals(self) -> dict[str, int]:
        with self._connect() as conn:
            messages = conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0]
            locations = conn.execute("SELECT COUNT(*) FROM locations").fetchone()[0]
            gone = conn.execute("SELECT COUNT(*) FROM messages WHERE gone_at IS NOT NULL").fetchone()[0]
        return {"messages": int(messages), "locations": int(locations), "gone": int(gone)}

    def messages(self) -> list[dict[str, Any]]:
        with self._connect() as conn:
            return [dict(r) for r in conn.execute("SELECT * FROM messages ORDER BY date, id").fetchall()]

    def headers(self) -> Iterator[dict[str, Any]]:
        """Every row's structural fields, streamed — what the triage and the
        report read. The sealed subject rides along, unopened."""
        with self._connect() as conn:
            for r in conn.execute(
                """SELECT id, message_id, sender, sender_address, recipients, cc, date, subject_sealed,
                          list_id, list_unsubscribe, precedence, refs, size, gone_at FROM messages"""
            ):
                yield dict(r)

    # ── triage (lot 2) ───────────────────────────────────────────────────
    def write_triage(self, verdicts: list[tuple[str, str, str, str]]) -> None:
        """``(message, kind, reason, computed_at)`` for every message, in one
        transaction; a message not in the list keeps its old verdict."""
        with self._transaction() as conn:
            conn.executemany(
                """INSERT INTO triage (message, kind, reason, computed_at) VALUES (?, ?, ?, ?)
                   ON CONFLICT (message) DO UPDATE SET kind = excluded.kind, reason = excluded.reason,
                     computed_at = excluded.computed_at""",
                verdicts,
            )

    def triage_kinds(self) -> dict[str, str]:
        with self._connect() as conn:
            return {r["message"]: r["kind"] for r in conn.execute("SELECT message, kind FROM triage")}

    def triage_counts(self) -> dict[str, Any]:
        with self._connect() as conn:
            rows = conn.execute("SELECT kind, COUNT(*) AS n, MAX(computed_at) AS at FROM triage GROUP BY kind").fetchall()
        return {"counts": {r["kind"]: int(r["n"]) for r in rows}, "computed_at": max((r["at"] for r in rows), default=None)}

    def window_counts(self, since: str) -> dict[str, int]:
        """Messages dated from ``since`` on, still seen, by kind — and the
        bytes of those a reading would open (correspondence and other)."""
        with self._connect() as conn:
            rows = conn.execute(
                """SELECT COALESCE(t.kind, 'untriaged') AS kind, COUNT(*) AS n, COALESCE(SUM(m.size), 0) AS bytes
                   FROM messages m LEFT JOIN triage t ON t.message = m.id
                   WHERE m.date >= ? AND m.date < '3000' AND m.gone_at IS NULL GROUP BY 1""",
                (since,),
            ).fetchall()
        out = {"messages": 0, "bulk": 0, "correspondence": 0, "other": 0, "untriaged": 0, "bytes_to_read": 0}
        for r in rows:
            out[r["kind"]] = int(r["n"])
            out["messages"] += int(r["n"])
            if r["kind"] in ("correspondence", "other"):
                out["bytes_to_read"] += int(r["bytes"])
        return out

    # ── calibration (lot 2) ──────────────────────────────────────────────
    def sample_locations(self, kinds: tuple[str, ...], since: str, n: int, *, rng: random.Random | None = None) -> list[dict[str, Any]]:
        """Up to ``n`` messages of those kinds dated from ``since``, still
        seen, one location each, drawn at random."""
        with self._connect() as conn:
            rows = conn.execute(
                f"""SELECT m.id, m.size, l.address, l.folder, l.uid
                    FROM messages m JOIN triage t ON t.message = m.id JOIN locations l ON l.message = m.id
                    WHERE t.kind IN ({','.join('?' * len(kinds))}) AND m.date >= ? AND m.gone_at IS NULL
                    GROUP BY m.id""",
                (*kinds, since),
            ).fetchall()
        picked = [dict(r) for r in rows]
        (rng or random).shuffle(picked)
        return picked[:n]

    def set_calibration(self, row: dict[str, Any]) -> None:
        with self._transaction() as conn:
            conn.execute(
                """INSERT INTO calibration (id, sampled, complete, bytes, tokens, preview_tokens, tokenizer, computed_at)
                   VALUES (1, :sampled, :complete, :bytes, :tokens, :preview_tokens, :tokenizer, :computed_at)
                   ON CONFLICT (id) DO UPDATE SET sampled = excluded.sampled, complete = excluded.complete,
                     bytes = excluded.bytes, tokens = excluded.tokens, preview_tokens = excluded.preview_tokens,
                     tokenizer = excluded.tokenizer, computed_at = excluded.computed_at""",
                row,
            )

    def calibration(self) -> dict[str, Any] | None:
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM calibration WHERE id = 1").fetchone()
        if row is None:
            return None
        out = dict(row)
        out.pop("id", None)
        return out

    # ── the reading (lot 4) ──────────────────────────────────────────────
    def reading_candidates(self, kinds: tuple[str, ...], since: str, stage: str, limit: int) -> list[dict[str, Any]]:
        """What the next batch of a pass is made of, newest first, one
        location each: for ``light``, the messages of the window not yet
        judged; for ``full``, those the light pass kept and not yet read."""
        where = (
            "r.message IS NULL OR r.light IS NULL" if stage == "light"
            else "r.light = 'keep' AND r.reading_sealed IS NULL"
        )
        with self._connect() as conn:
            rows = conn.execute(
                f"""SELECT m.id, m.size, m.sender, m.recipients, m.cc, m.date, m.subject_sealed, m.message_id,
                           l.address, l.folder, l.uid
                    FROM messages m JOIN triage t ON t.message = m.id JOIN locations l ON l.message = m.id
                    LEFT JOIN readings r ON r.message = m.id
                    WHERE t.kind IN ({','.join('?' * len(kinds))}) AND m.date >= ? AND m.date < '3000'
                      AND m.gone_at IS NULL AND ({where})
                    GROUP BY m.id ORDER BY m.date DESC LIMIT ?""",
                (*kinds, since, max(1, int(limit))),
            ).fetchall()
        return [dict(r) for r in rows]

    def reading_progress(self, kinds: tuple[str, ...], since: str) -> dict[str, int]:
        """Where the passes are over the window: still to judge, kept,
        skipped, still to read, read."""
        with self._connect() as conn:
            row = conn.execute(
                f"""SELECT
                      SUM(CASE WHEN r.light IS NULL THEN 1 ELSE 0 END) AS to_light,
                      SUM(CASE WHEN r.light = 'keep' THEN 1 ELSE 0 END) AS kept,
                      SUM(CASE WHEN r.light = 'skip' THEN 1 ELSE 0 END) AS skipped,
                      SUM(CASE WHEN r.light = 'keep' AND r.reading_sealed IS NULL THEN 1 ELSE 0 END) AS to_read,
                      SUM(CASE WHEN r.reading_sealed IS NOT NULL THEN 1 ELSE 0 END) AS read,
                      COUNT(*) AS messages
                    FROM messages m JOIN triage t ON t.message = m.id LEFT JOIN readings r ON r.message = m.id
                    WHERE t.kind IN ({','.join('?' * len(kinds))}) AND m.date >= ? AND m.date < '3000' AND m.gone_at IS NULL""",
                (*kinds, since),
            ).fetchone()
        return {k: int(row[k] or 0) for k in ("messages", "to_light", "kept", "skipped", "to_read", "read")}

    def write_light(self, verdicts: list[tuple[str, str, str, int | None, str]]) -> None:
        """``(message, keep|skip, reason, tokens, at)`` per message judged."""
        with self._transaction() as conn:
            conn.executemany(
                """INSERT INTO readings (message, light, light_reason, tokens_light, light_at) VALUES (?, ?, ?, ?, ?)
                   ON CONFLICT (message) DO UPDATE SET light = excluded.light, light_reason = excluded.light_reason,
                     tokens_light = excluded.tokens_light, light_at = excluded.light_at""",
                verdicts,
            )

    def write_readings(self, rows: list[tuple[str, str, int | None, str]]) -> None:
        """``(message, reading_sealed, tokens, at)`` per message read whole."""
        with self._transaction() as conn:
            conn.executemany(
                """INSERT INTO readings (message, light, reading_sealed, tokens_full, read_at) VALUES (?, 'keep', ?, ?, ?)
                   ON CONFLICT (message) DO UPDATE SET reading_sealed = excluded.reading_sealed,
                     tokens_full = excluded.tokens_full, read_at = excluded.read_at""",
                rows,
            )

    def readings(self, *, kept_only: bool = True) -> list[dict[str, Any]]:
        """The rows the passes left, sealed as they are; lot 5 unseals."""
        with self._connect() as conn:
            q = "SELECT * FROM readings" + (" WHERE reading_sealed IS NOT NULL" if kept_only else "") + " ORDER BY read_at, message"
            return [dict(r) for r in conn.execute(q).fetchall()]

    def add_capacity(self, job: str | None, messages: int, seconds: float) -> None:
        with self._transaction() as conn:
            conn.execute(
                "INSERT INTO capacity (job, messages, seconds, measured_at) VALUES (?, ?, ?, ?)",
                (job, int(messages), float(seconds), now_iso()),
            )

    def capacity(self) -> dict[str, Any] | None:
        """The measured nightly capacity: the last runs' messages per hour,
        as the estimate's messages per night. None until a run measured
        something worth the name (a hundred messages at least)."""
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT messages, seconds, measured_at FROM capacity WHERE messages >= 100 ORDER BY id DESC LIMIT 5"
            ).fetchall()
        if not rows:
            return None
        messages = sum(int(r["messages"]) for r in rows)
        seconds = sum(float(r["seconds"]) for r in rows)
        if seconds <= 0:
            return None
        return {"messages": messages, "seconds": seconds, "per_hour": round(messages / (seconds / 3600)), "measured_at": rows[0]["measured_at"], "runs": len(rows)}

    def locations(self, message_id: str | None = None) -> list[dict[str, Any]]:
        with self._connect() as conn:
            if message_id is None:
                rows = conn.execute("SELECT * FROM locations ORDER BY address, folder, uidvalidity, uid").fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM locations WHERE message = ? ORDER BY address, folder, uidvalidity, uid", (message_id,)
                ).fetchall()
        return [dict(r) for r in rows]
