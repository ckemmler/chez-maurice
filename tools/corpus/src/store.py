"""Backend-neutral vector store seam.

`VectorStore` is the contract every backend implements. `make_store` picks the
backend from config. Today only Qdrant exists; the sqlite-vec backend (per-user
DB files) slots in here in Phase 2 without touching callers.

Terminology: a *unit* is the thing a set of chunks belongs to — a file path today,
a message/conversation key once conversations are indexed. The Qdrant backend maps
`unit_key`/`unit_hash` onto the historical `file_path`/`file_hash` payload keys so
existing data and filters are byte-identical.
"""

from __future__ import annotations

from typing import Any, Dict, Iterable, Iterator, List, Optional, Protocol, runtime_checkable

from .chunker import Chunk


@runtime_checkable
class VectorStore(Protocol):
    """Storage contract shared by every corpus backend."""

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
    ) -> int: ...

    def delete_unit(self, *, unit_key: str, member_id: Optional[str] = None) -> None: ...

    def delete_by_hash(self, *, unit_hash: str, member_id: Optional[str] = None) -> None: ...

    def get_chunk(self, *, chunk_id: str, member_id: Optional[str] = None) -> Optional[Dict[str, Any]]: ...

    def iter_chunks(
        self,
        *,
        where: Optional[Dict[str, Any]] = None,
        limit: int = 200,
        member_id: Optional[str] = None,
    ) -> Iterator[Dict[str, Any]]: ...

    def count(self, *, where: Optional[Dict[str, Any]] = None, member_id: Optional[str] = None) -> int: ...

    def total_count(self, *, member_id: Optional[str] = None) -> int: ...

    def search(
        self,
        *,
        vector: List[float],
        limit: int,
        filters: Optional[Dict[str, Any]] = None,
        member_id: Optional[str] = None,
    ) -> List[Dict[str, Any]]: ...


def make_store(config: Any, *, vector_size: int) -> VectorStore:
    """Build the configured vector store. Defaults to Qdrant when unspecified."""
    store_cfg = getattr(config, "store", None)
    backend = getattr(store_cfg, "backend", "qdrant")
    if backend == "qdrant":
        from .indexer import QdrantStore

        return QdrantStore(config.qdrant, vector_size=vector_size)
    if backend == "sqlite_vec":
        from pathlib import Path

        from .sqlite_vec_store import SqliteVecStore

        vectors_dir = getattr(store_cfg, "path", None) or (
            Path(__file__).resolve().parents[1] / "data" / "vectors"
        )
        model = getattr(getattr(config, "embedding", None), "model", None)
        return SqliteVecStore(vectors_dir=vectors_dir, vector_size=vector_size, embedding_model=model)
    raise NotImplementedError(f"Unknown vector store backend: {backend!r}")


__all__ = ["VectorStore", "make_store"]
