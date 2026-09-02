"""Persistent hash cache for corpus indexing."""

from __future__ import annotations

import sqlite3
from datetime import datetime
from pathlib import Path
from typing import Optional


class HashStore:
    """Tracks per-file hashes so unchanged files can be skipped."""

    def __init__(self, db_path: Path) -> None:
        self.db_path = db_path
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(self.db_path)
        self._conn.execute("PRAGMA journal_mode=WAL;")
        self._conn.execute("PRAGMA synchronous=NORMAL;")
        self._init_schema()

    def close(self) -> None:
        if self._conn:
            self._conn.close()

    def _init_schema(self) -> None:
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS file_hashes (
                path TEXT PRIMARY KEY,
                hash TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        self._conn.commit()

    def get(self, path: Path) -> Optional[str]:
        cursor = self._conn.execute(
            "SELECT hash FROM file_hashes WHERE path = ?",
            (str(path),),
        )
        row = cursor.fetchone()
        return row[0] if row else None

    def set(self, path: Path, file_hash: str) -> None:
        timestamp = datetime.utcnow().isoformat()
        self._conn.execute(
            """
            INSERT INTO file_hashes(path, hash, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(path) DO UPDATE SET
                hash = excluded.hash,
                updated_at = excluded.updated_at
            """,
            (str(path), file_hash, timestamp),
        )
        self._conn.commit()

    def delete(self, path: Path) -> None:
        self._conn.execute("DELETE FROM file_hashes WHERE path = ?", (str(path),))
        self._conn.commit()


__all__ = ["HashStore"]
