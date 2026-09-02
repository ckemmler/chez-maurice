"""sqlite-vec implementation of the VectorStore contract.

One DB file per member (`<vectors_dir>/<member>.db`), so every query is an
unfiltered scan of exactly one user's data — isolation is the filesystem, not a
`member_id` filter. `member_id` (explicit or from `member_id_var`) only selects
the file; it is never stored as a search constraint.

Layout per file:
  - vec_chunks  : vec0 virtual table, cosine distance (matches the old Qdrant config)
  - chunks      : one row per chunk, full Qdrant-equivalent payload as JSON
  - corpus_meta : pinned embedding_model + vector_size (mixed models are refused)

Filtering reproduces Qdrant semantics over the JSON payload: substring/`LIKE` for
strings (≈ MatchText), `IN` for lists, equality for other scalars — applied as a
`rowid IN (subquery)` pre-filter on the KNN.
"""

from __future__ import annotations

import json
import re
import sqlite3
import threading
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Iterable, Iterator, List, Optional

import sqlite_vec

from .chunker import Chunk

import sys as _sys
_repo_root = str(Path(__file__).resolve().parents[3])
if _repo_root not in _sys.path:
    _sys.path.insert(0, _repo_root)
from tools.shared.context import member_id_var

_DEFAULT_MEMBER = "_default"
_SAFE_KEY = re.compile(r"[^A-Za-z0-9_-]")
_IDENTIFIER = re.compile(r"^[A-Za-z0-9_]+$")


def _db_filename(member_id: Optional[str]) -> str:
    key = member_id or _DEFAULT_MEMBER
    return _SAFE_KEY.sub("_", key) + ".db"


def _build_where(filters: Optional[Dict[str, Any]]) -> tuple[str, list]:
    """Translate a Qdrant-style filter dict into a SQL predicate over payload JSON."""
    if not filters:
        return "1", []
    clauses: list[str] = []
    params: list = []
    for key, value in filters.items():
        if not _IDENTIFIER.match(key):
            raise ValueError(f"Unsupported filter key: {key!r}")
        col = f"json_extract(payload, '$.{key}')"
        if isinstance(value, list):
            if not value:
                continue  # Qdrant treats an empty OR-set as no constraint
            placeholders = ",".join("?" * len(value))
            clauses.append(f"{col} IN ({placeholders})")
            params.extend(str(v) for v in value)
        elif isinstance(value, str):
            # substring match ≈ Qdrant MatchText (token/substring)
            clauses.append(f"LOWER({col}) LIKE '%' || LOWER(?) || '%'")
            params.append(value)
        else:
            clauses.append(f"{col} = ?")
            params.append(value)
    if not clauses:
        return "1", []
    return " AND ".join(clauses), params


class SqliteVecStore:
    """Per-member sqlite-vec backend implementing VectorStore."""

    def __init__(
        self,
        *,
        vectors_dir: Path,
        vector_size: int,
        embedding_model: Optional[str] = None,
        shared_default: bool = True,
    ) -> None:
        self.vectors_dir = Path(vectors_dir)
        self.vectors_dir.mkdir(parents=True, exist_ok=True)
        self.vector_size = vector_size
        self.embedding_model = embedding_model
        # When True, a member's search also scans the shared `_default.db` pool
        # (household knowledge base — books/dossiers) on top of their own file
        # (private conversations). Writes/reconcile always target the member file.
        self.shared_default = shared_default
        self._lock = threading.RLock()
        self._conns: Dict[str, sqlite3.Connection] = {}

    # ── connection / schema ──────────────────────────────────────────────

    def _resolve(self, member_id: Optional[str]) -> str:
        return member_id or member_id_var.get() or _DEFAULT_MEMBER

    def _conn_for_key(self, key: str) -> sqlite3.Connection:
        with self._lock:
            conn = self._conns.get(key)
            if conn is not None:
                return conn
            path = self.vectors_dir / _db_filename(key)
            conn = sqlite3.connect(path, check_same_thread=False)
            conn.enable_load_extension(True)
            sqlite_vec.load(conn)
            conn.enable_load_extension(False)
            conn.execute("PRAGMA journal_mode=WAL;")
            conn.execute("PRAGMA synchronous=NORMAL;")
            self._ensure_schema(conn)
            self._conns[key] = conn
            return conn

    def _conn(self, member_id: Optional[str]) -> sqlite3.Connection:
        return self._conn_for_key(self._resolve(member_id))

    def _ensure_schema(self, conn: sqlite3.Connection) -> None:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS chunks ("
            "  id integer primary key,"
            "  chunk_id text unique,"
            "  unit_key text,"
            "  unit_hash text,"
            "  source_type text,"
            "  payload text"
            ")"
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_chunks_unit ON chunks(unit_key)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_chunks_hash ON chunks(unit_hash)")
        conn.execute("CREATE TABLE IF NOT EXISTS corpus_meta (key text primary key, value text)")
        conn.execute(
            f"CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0("
            f"embedding float[{self.vector_size}] distance_metric=cosine)"
        )
        conn.commit()

    def _meta_get(self, conn: sqlite3.Connection, key: str) -> Optional[str]:
        row = conn.execute("SELECT value FROM corpus_meta WHERE key = ?", (key,)).fetchone()
        return row[0] if row else None

    def _pin_model(self, conn: sqlite3.Connection, embedding_model: str) -> None:
        """Record the embedding model on first write; refuse a different one later."""
        stored = self._meta_get(conn, "embedding_model")
        if stored is None:
            conn.execute(
                "INSERT OR REPLACE INTO corpus_meta(key, value) VALUES ('embedding_model', ?), ('vector_size', ?)",
                (embedding_model, str(self.vector_size)),
            )
        elif stored != embedding_model:
            raise RuntimeError(
                f"Embedding model mismatch: index built with {stored!r}, "
                f"got {embedding_model!r}. Re-index after a model change."
            )

    # ── VectorStore surface ──────────────────────────────────────────────

    def upsert(
        self,
        *,
        unit_key: str,
        unit_hash: str,
        chunks: Iterable[Chunk],
        vectors: List[List[float]],
        base_metadata: Dict[str, Any],
        embedding_model: str,
        member_id: Optional[str] = None,
    ) -> int:
        chunk_list = list(chunks)
        if len(chunk_list) != len(vectors):
            raise ValueError("Number of chunks and embeddings must match")
        if not chunk_list:
            return 0
        mid = member_id or member_id_var.get()
        conn = self._conn(member_id)
        timestamp = datetime.utcnow().isoformat()
        total = len(chunk_list)
        with self._lock:
            self._pin_model(conn, embedding_model)
            written = 0
            for idx, (chunk, vector) in enumerate(zip(chunk_list, vectors)):
                chunk_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"{unit_key}:{idx}"))
                payload = {
                    "chunk_id": chunk_id,
                    "file_path": unit_key,
                    "file_hash": unit_hash,
                    "chunk_index": idx,
                    "total_chunks": total,
                    "text": chunk.text,
                    "source_type": base_metadata.get("source_type"),
                    "indexed_at": timestamp,
                    "embedding_model": embedding_model,
                }
                if mid:
                    payload["member_id"] = mid
                payload.update(base_metadata)
                cur = conn.execute(
                    "INSERT OR REPLACE INTO chunks(chunk_id, unit_key, unit_hash, source_type, payload) "
                    "VALUES (?, ?, ?, ?, ?)",
                    (chunk_id, unit_key, unit_hash, payload.get("source_type"), json.dumps(payload, ensure_ascii=False, default=str)),
                )
                rowid = cur.lastrowid
                conn.execute(
                    "INSERT OR REPLACE INTO vec_chunks(rowid, embedding) VALUES (?, ?)",
                    (rowid, sqlite_vec.serialize_float32(list(vector))),
                )
                written += 1
            conn.commit()
        return written

    def bulk_load(self, records: Iterable[Dict[str, Any]], *, member_id: Optional[str] = None) -> int:
        """Insert pre-computed chunks verbatim (vectors + payload) — used by the
        Qdrant→sqlite migration. Each record: {chunk_id, unit_key, unit_hash,
        source_type, payload (dict), vector (list[float])}. Payloads are preserved
        exactly (no regeneration), so historical/orphaned chunks survive the move."""
        conn = self._conn(member_id)
        written = 0
        with self._lock:
            # Pin the configured model without strict validation (trusted migration).
            if self._meta_get(conn, "embedding_model") is None and self.embedding_model:
                conn.execute(
                    "INSERT OR REPLACE INTO corpus_meta(key, value) VALUES ('embedding_model', ?), ('vector_size', ?)",
                    (self.embedding_model, str(self.vector_size)),
                )
            for rec in records:
                payload = rec["payload"]
                cur = conn.execute(
                    "INSERT OR REPLACE INTO chunks(chunk_id, unit_key, unit_hash, source_type, payload) "
                    "VALUES (?, ?, ?, ?, ?)",
                    (
                        rec["chunk_id"],
                        rec.get("unit_key"),
                        rec.get("unit_hash"),
                        rec.get("source_type") or payload.get("source_type"),
                        json.dumps(payload, ensure_ascii=False),
                    ),
                )
                conn.execute(
                    "INSERT OR REPLACE INTO vec_chunks(rowid, embedding) VALUES (?, ?)",
                    (cur.lastrowid, sqlite_vec.serialize_float32(list(rec["vector"]))),
                )
                written += 1
            conn.commit()
        return written

    def _delete_rows(self, conn: sqlite3.Connection, where_sql: str, params: list) -> None:
        with self._lock:
            ids = [r[0] for r in conn.execute(f"SELECT id FROM chunks WHERE {where_sql}", params).fetchall()]
            if ids:
                placeholders = ",".join("?" * len(ids))
                conn.execute(f"DELETE FROM vec_chunks WHERE rowid IN ({placeholders})", ids)
                conn.execute(f"DELETE FROM chunks WHERE id IN ({placeholders})", ids)
                conn.commit()

    def delete_unit(self, *, unit_key: str, member_id: Optional[str] = None) -> None:
        self._delete_rows(self._conn(member_id), "unit_key = ?", [unit_key])

    def delete_by_hash(self, *, unit_hash: str, member_id: Optional[str] = None) -> None:
        self._delete_rows(self._conn(member_id), "unit_hash = ?", [unit_hash])

    def get_chunk(self, *, chunk_id: str, member_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
        conn = self._conn(member_id)
        with self._lock:
            row = conn.execute("SELECT payload FROM chunks WHERE chunk_id = ?", (chunk_id,)).fetchone()
        if not row:
            return None
        payload = json.loads(row[0])
        payload["chunk_id"] = chunk_id
        return payload

    def iter_chunks(
        self,
        *,
        where: Optional[Dict[str, Any]] = None,
        limit: int = 200,
        member_id: Optional[str] = None,
    ) -> Iterator[Dict[str, Any]]:
        conn = self._conn(member_id)
        where_sql, params = _build_where(where)
        with self._lock:
            rows = conn.execute(f"SELECT payload FROM chunks WHERE {where_sql}", params).fetchall()
        for (payload_json,) in rows:
            yield json.loads(payload_json)

    def count(self, *, where: Optional[Dict[str, Any]] = None, member_id: Optional[str] = None) -> int:
        conn = self._conn(member_id)
        where_sql, params = _build_where(where)
        with self._lock:
            (n,) = conn.execute(f"SELECT COUNT(*) FROM chunks WHERE {where_sql}", params).fetchone()
        return int(n)

    def total_count(self, *, member_id: Optional[str] = None) -> int:
        conn = self._conn(member_id)
        with self._lock:
            (n,) = conn.execute("SELECT COUNT(*) FROM chunks").fetchone()
        return int(n)

    def _search_conn(
        self, conn: sqlite3.Connection, qvec: bytes, k: int, filters: Optional[Dict[str, Any]]
    ) -> List[Dict[str, Any]]:
        sql = f"SELECT rowid, distance FROM vec_chunks WHERE embedding MATCH ? AND k = {k}"
        params: list = [qvec]
        if filters:
            frag, fparams = _build_where(filters)
            sql += f" AND rowid IN (SELECT id FROM chunks WHERE {frag})"
            params.extend(fparams)
        sql += " ORDER BY distance"
        with self._lock:
            hits = conn.execute(sql, params).fetchall()
            if not hits:
                return []
            placeholders = ",".join("?" * len(hits))
            payloads = conn.execute(
                f"SELECT id, payload FROM chunks WHERE id IN ({placeholders})", [r[0] for r in hits]
            ).fetchall()
        payload_map = {rid: pj for rid, pj in payloads}
        results: List[Dict[str, Any]] = []
        for rowid, dist in hits:
            pj = payload_map.get(rowid)
            if pj is None:
                continue
            payload = json.loads(pj)
            payload["score"] = 1.0 - float(dist)  # cosine distance → similarity (Qdrant parity)
            results.append(payload)
        return results

    def search(
        self,
        *,
        vector: List[float],
        limit: int,
        filters: Optional[Dict[str, Any]] = None,
        member_id: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        qvec = sqlite_vec.serialize_float32(list(vector))
        k = max(1, int(limit))
        mid_key = self._resolve(member_id)
        keys = [mid_key]
        if self.shared_default and mid_key != _DEFAULT_MEMBER:
            keys.append(_DEFAULT_MEMBER)  # union private file with the shared pool
        results: List[Dict[str, Any]] = []
        for key in keys:
            results.extend(self._search_conn(self._conn_for_key(key), qvec, k, filters))
        if len(keys) > 1:
            results.sort(key=lambda r: -r["score"])  # merge-sort across files
            results = results[:limit]
        return results

    def close(self) -> None:
        with self._lock:
            for conn in self._conns.values():
                conn.close()
            self._conns.clear()


__all__ = ["SqliteVecStore"]
