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
  state         TEXT NOT NULL,           -- running | paused | done | failed
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
"""

JOB_STATES = ("running", "paused", "done", "failed")
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
                         updated_at = excluded.updated_at""",
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
    def create_job(self, member_id: str, kind: str, *, budget_eur: float | None = None) -> dict[str, Any]:
        at = now_iso()
        job_id = f"job_{uuid.uuid4().hex[:12]}"
        with self._transaction() as conn:
            conn.execute(
                """INSERT INTO jobs (id, member_id, kind, state, budget_eur, cursor, counts, created_at, updated_at)
                   VALUES (?, ?, ?, 'running', ?, NULL, '{}', ?, ?)""",
                (job_id, member_id, kind, budget_eur, at, at),
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

    def running_job(self, kind: str, *, fresh_within: float = STALE_AFTER) -> dict[str, Any] | None:
        """A 'running' job whose last checkpoint is recent — alive, as far as
        this file can tell, possibly in another process (the CLI beside the
        gateway). ``updated_at`` moves at every batch, so it is the
        heartbeat."""
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM jobs WHERE kind = ? AND state = 'running' ORDER BY updated_at DESC LIMIT 1", (kind,)
            ).fetchone()
        job = self._job_row(row)
        if job is None or _age_seconds(job["updated_at"]) > fresh_within:
            return None
        return job

    def orphan_running_jobs(self, kind: str, *, older_than: float = STALE_AFTER) -> int:
        """A process that died mid-scan left its job 'running' forever. Once
        its heartbeat is stale, whoever looks next marks it 'paused': the
        cursor is the truth, the job row only says what happened. A fresh
        one is left alone — it may well be another process, still walking."""
        with self._connect() as conn:
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

    # ── reading ──────────────────────────────────────────────────────────
    def totals(self) -> dict[str, int]:
        with self._connect() as conn:
            messages = conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0]
            locations = conn.execute("SELECT COUNT(*) FROM locations").fetchone()[0]
        return {"messages": int(messages), "locations": int(locations)}

    def messages(self) -> list[dict[str, Any]]:
        with self._connect() as conn:
            return [dict(r) for r in conn.execute("SELECT * FROM messages ORDER BY date, id").fetchall()]

    def locations(self, message_id: str | None = None) -> list[dict[str, Any]]:
        with self._connect() as conn:
            if message_id is None:
                rows = conn.execute("SELECT * FROM locations ORDER BY address, folder, uidvalidity, uid").fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM locations WHERE message = ? ORDER BY address, folder, uidvalidity, uid", (message_id,)
                ).fetchall()
        return [dict(r) for r in rows]
