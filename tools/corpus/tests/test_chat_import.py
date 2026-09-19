#!/usr/bin/env python3
"""The chat-export importer writes conversations the domains' night can see.

    python tests/test_chat_import.py

Same harness as test_indexing.py: no framework, a throwaway maurice.db. What
is nailed down: an imported conversation carries the export's dates and is
stamped `imported_at` (the server's clock) when the column exists — P4 of the
domains' roadmap, 19 September 2026 — and is written without it against an
older database; a re-import of the same export adds nothing.
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
import tempfile
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
CORPUS = HERE.parent
sys.path.insert(0, str(CORPUS))


def _repo_root() -> Path:
    if env := os.environ.get("MAURICE_REPO"):
        return Path(env)
    for p in [CORPUS, *CORPUS.parents]:
        if (p / "tools" / "shared").is_dir():
            return p
    raise SystemExit("cannot find the repo root (tools/shared)")


sys.path.insert(0, str(_repo_root()))

from src.chat_import import ChatArchiveImporter, PROVIDERS  # noqa: E402

SCHEMA = """
CREATE TABLE conversations (id TEXT PRIMARY KEY, user_id TEXT, title TEXT,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
  origin TEXT, maurice_id TEXT, opened_by TEXT NOT NULL DEFAULT 'member'{extra});
CREATE TABLE conversation_participants (conversation_id TEXT, member_id TEXT, role TEXT,
  PRIMARY KEY (conversation_id, member_id));
CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT, role TEXT, content TEXT,
  model TEXT, created_at TEXT, author_id TEXT);
"""

EXPORT = [
    {
        "uuid": "conv-1", "name": "Old bread thread",
        "created_at": "2024-05-06T10:00:00Z", "updated_at": "2024-05-06T10:20:00Z",
        "chat_messages": [
            {"uuid": "m1", "sender": "human", "text": "My starter is flat.", "created_at": "2024-05-06T10:00:00Z"},
            {"uuid": "m2", "sender": "assistant", "text": "Feed it twice a day.", "created_at": "2024-05-06T10:01:00Z"},
        ],
    }
]


def _db(with_imported_at: bool) -> Path:
    d = Path(tempfile.mkdtemp(prefix="maurice-import-test-"))
    path = d / "maurice.db"
    conn = sqlite3.connect(path)
    conn.executescript(SCHEMA.format(extra=", imported_at TEXT" if with_imported_at else ""))
    conn.commit()
    conn.close()
    return path


def _zip(d: Path) -> Path:
    z = d / "export.zip"
    with zipfile.ZipFile(z, "w") as zf:
        zf.writestr("conversations.json", json.dumps(EXPORT))
    return z


def test_stamps_imported_at_and_keeps_the_export_dates() -> None:
    db = _db(with_imported_at=True)
    plan = ChatArchiveImporter(maurice_db_path=db).create_conversations(
        _zip(db.parent), member_id="theo", provider=PROVIDERS["anthropic"])
    assert plan.created == 1 and plan.messages == 2, plan
    conn = sqlite3.connect(db)
    row = conn.execute("SELECT created_at, updated_at, origin, imported_at, opened_by FROM conversations WHERE id = 'conv-1'").fetchone()
    assert row[0] == "2024-05-06 10:00:00", row
    assert row[1] == "2024-05-06 10:20:00", row
    assert row[2] == "anthropic", row
    assert row[3] is not None and row[3].startswith("20") and row[3] > row[1], row
    assert row[4] == "member", row
    # A re-import of the same export changes nothing.
    again = ChatArchiveImporter(maurice_db_path=db).create_conversations(
        _zip(db.parent), member_id="theo", provider=PROVIDERS["anthropic"])
    assert again.created == 0, again
    assert conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0] == 2
    conn.close()


def test_writes_without_the_column_on_an_older_database() -> None:
    db = _db(with_imported_at=False)
    plan = ChatArchiveImporter(maurice_db_path=db).create_conversations(
        _zip(db.parent), member_id="theo", provider=PROVIDERS["anthropic"])
    assert plan.created == 1, plan
    conn = sqlite3.connect(db)
    assert conn.execute("SELECT origin FROM conversations").fetchone()[0] == "anthropic"
    conn.close()


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok  {name}")
