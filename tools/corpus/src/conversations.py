"""Index live Maurice conversations (from the server's maurice.db) into the corpus.

A conversation is a non-file source: its unit is a *message* (`unit_key = msg:<id>`,
`unit_hash = sha256(content)`). Reconciliation is idempotent and per
`(conversation, member)` — it diffs the DB against what each participant's vector
DB already holds, then adds/updates/removes. That covers the whole lifecycle:

  - new message      → embed once, fan out to every participant's DB
  - edited message   → hash changes → re-embed + replace
  - deleted message  → removed from each participant's DB
  - new participant  → their DB has nothing for the convo → full backfill
  - departed member  → no longer a participant → their copies are simply left as-is

Embedding (the only costly step) happens once per message and the resulting vectors
are reused across all participants.
"""

from __future__ import annotations

import hashlib
import logging
import os
from pathlib import Path
from typing import Any, Dict, List, Optional

import sqlite3

from .chunker import paragraph_chunks
from .embedder import Embedder
from .store import VectorStore

_LOG = logging.getLogger(__name__)

_SOURCE = "maurice-conversations"
_MAX_CHARS = 256 * 4  # ~256 tokens, thought-sized chunks
_INDEXED_ROLES = ("user", "assistant")


def default_db_path() -> Path:
    data_dir = os.environ.get("MAURICE_DATA_DIR") or str(Path.home() / ".maurice")
    return Path(data_dir).expanduser() / "maurice.db"


def _unit_key(message_id: str) -> str:
    return f"msg:{message_id}"


def _hash(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


class MauriceConversations:
    """Reads conversations from maurice.db and reconciles them into the store."""

    def __init__(self, db_path: Optional[Path] = None) -> None:
        self.db_path = Path(db_path) if db_path else default_db_path()

    def available(self) -> bool:
        return self.db_path.exists()

    def _connect(self) -> sqlite3.Connection:
        # read-only; never mutate the server's DB
        conn = sqlite3.connect(f"file:{self.db_path}?mode=ro", uri=True)
        conn.row_factory = sqlite3.Row
        return conn

    def _conversation_ids(self, conn: sqlite3.Connection) -> List[str]:
        return [r[0] for r in conn.execute("SELECT id FROM conversations").fetchall()]

    def _participants(self, conn: sqlite3.Connection, conversation_id: str) -> List[str]:
        rows = conn.execute(
            "SELECT member_id FROM conversation_participants WHERE conversation_id = ?",
            (conversation_id,),
        ).fetchall()
        return [r[0] for r in rows]

    def _messages(self, conn: sqlite3.Connection, conversation_id: str) -> List[sqlite3.Row]:
        placeholders = ",".join("?" * len(_INDEXED_ROLES))
        return conn.execute(
            f"SELECT id, role, content, author_id, created_at FROM messages "
            f"WHERE conversation_id = ? AND role IN ({placeholders}) "
            f"ORDER BY created_at",
            (conversation_id, *_INDEXED_ROLES),
        ).fetchall()

    def _title(self, conn: sqlite3.Connection, conversation_id: str) -> Optional[str]:
        row = conn.execute("SELECT title FROM conversations WHERE id = ?", (conversation_id,)).fetchone()
        return row[0] if row else None

    # ── reconciliation ───────────────────────────────────────────────────

    def _indexed_units(self, store: VectorStore, member_id: str, conversation_id: str) -> Dict[str, str]:
        """Return {message_id: unit_hash} already indexed for this convo in member's DB."""
        seen: Dict[str, str] = {}
        for p in store.iter_chunks(where={"conversation_id": conversation_id}, member_id=member_id):
            mid = p.get("message_id")
            if mid is not None:
                seen[mid] = p.get("file_hash")
        return seen

    def _metadata(self, conversation_id: str, title: Optional[str], row: sqlite3.Row) -> Dict[str, Any]:
        meta = {
            "source": _SOURCE,
            "source_type": "conversation",
            "conversation_id": conversation_id,
            "message_id": row["id"],
            "role": row["role"],
            "date": row["created_at"],
        }
        if row["author_id"]:
            meta["author_id"] = row["author_id"]
        if title:
            meta["conversation_title"] = title
        return meta

    async def reconcile_conversation(
        self, conversation_id: str, *, store: VectorStore, embedder: Embedder
    ) -> int:
        """Reconcile one conversation across all its participants. Returns chunks written."""
        with self._connect() as conn:
            participants = self._participants(conn, conversation_id)
            if not participants:
                return 0
            title = self._title(conn, conversation_id)
            rows = [r for r in self._messages(conn, conversation_id) if (r["content"] or "").strip()]

        current = {r["id"]: r for r in rows}
        hashes = {r["id"]: _hash(r["content"]) for r in rows}
        embed_cache: Dict[str, tuple] = {}  # message_id -> (chunks, embed_result)

        async def embedded(message_id: str):
            if message_id not in embed_cache:
                content = current[message_id]["content"]
                chunks = paragraph_chunks(content, max_chars=_MAX_CHARS)
                vecs = await embedder.embed_batch(c.text for c in chunks) if chunks else None
                embed_cache[message_id] = (chunks, vecs)
            return embed_cache[message_id]

        written = 0
        for member in participants:
            indexed = self._indexed_units(store, member, conversation_id)
            # deletions: indexed but no longer present
            for stale in set(indexed) - set(current):
                store.delete_unit(unit_key=_unit_key(stale), member_id=member)
            # additions + edits
            for mid, row in current.items():
                if indexed.get(mid) == hashes[mid]:
                    continue  # up to date
                chunks, vecs = await embedded(mid)
                if not chunks or vecs is None or not vecs.vectors:
                    continue
                store.delete_unit(unit_key=_unit_key(mid), member_id=member)
                written += store.upsert(
                    member_id=member,
                    unit_key=_unit_key(mid),
                    unit_hash=hashes[mid],
                    chunks=chunks,
                    vectors=vecs.vectors,
                    base_metadata=self._metadata(conversation_id, title, row),
                    embedding_model=vecs.model,
                )
        return written

    async def reconcile_all(self, *, store: VectorStore, embedder: Embedder) -> Dict[str, int]:
        """Reconcile every conversation. Returns {conversations, chunks_written}."""
        with self._connect() as conn:
            ids = self._conversation_ids(conn)
        total = 0
        for cid in ids:
            total += await self.reconcile_conversation(cid, store=store, embedder=embedder)
        return {"conversations": len(ids), "chunks_written": total}


__all__ = ["MauriceConversations", "default_db_path"]
