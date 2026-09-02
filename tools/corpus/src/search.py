"""Search helpers over a VectorStore backend."""

from __future__ import annotations

import asyncio
from typing import List, Dict, Any, Optional

from .embedder import Embedder
from .store import VectorStore


async def semantic_search(
    query: str,
    *,
    embedder: Embedder,
    indexer: VectorStore,
    limit: int = 10,
    filters: Dict[str, Any] | None = None,
    member_id: Optional[str] = None,
) -> List[Dict[str, Any]]:
    vector_result = await embedder.embed_batch([query])
    if not vector_result.vectors:
        return []
    vector = vector_result.vectors[0]

    # member_id scoping + backend-specific filtering live in the store.
    return await asyncio.to_thread(
        indexer.search,
        vector=vector,
        limit=limit,
        filters=filters,
        member_id=member_id,
    )


async def search_in_book(query: str, book_title: str, *, embedder: Embedder, indexer: VectorStore, limit: int = 10) -> List[Dict[str, Any]]:
    return await semantic_search(
        query,
        embedder=embedder,
        indexer=indexer,
        limit=limit,
        filters={"book_title": book_title},
    )


async def search_by_author(query: str, author: str, *, embedder: Embedder, indexer: VectorStore, limit: int = 10) -> List[Dict[str, Any]]:
    return await semantic_search(
        query,
        embedder=embedder,
        indexer=indexer,
        limit=limit,
        filters={"author": author},
    )


async def search_by_tags(
    query: str,
    tags: List[str],
    *,
    embedder: Embedder,
    indexer: VectorStore,
    limit: int = 10,
    match_all_tags: bool = False,
) -> List[Dict[str, Any]]:
    from tools.calibre.book_data import get_book_ids_by_tags

    book_ids = get_book_ids_by_tags(tags, match_all=match_all_tags)
    if not book_ids:
        return []
    return await semantic_search(
        query,
        embedder=embedder,
        indexer=indexer,
        limit=limit,
        filters={"book_id": [str(bid) for bid in book_ids]},
    )


async def get_file_chunks(file_path: str, *, indexer: VectorStore) -> List[Dict[str, Any]]:
    return list(indexer.iter_chunks(where={"file_path": file_path}, limit=500))


async def get_chunk_context(chunk_id: str, window: int, *, indexer: VectorStore) -> List[Dict[str, Any]]:
    target = indexer.get_chunk(chunk_id=chunk_id)
    if not target:
        return []
    file_path = target.get("file_path")
    chunk_index = int(target.get("chunk_index", 0))
    neighbors = [
        p for p in indexer.iter_chunks(where={"file_path": file_path}, limit=500)
        if abs(int(p.get("chunk_index", 0)) - chunk_index) <= window
    ]
    neighbors.sort(key=lambda p: int(p.get("chunk_index", 0)))
    for entry in neighbors:
        entry["is_target"] = entry.get("chunk_id") == chunk_id
    return neighbors


async def corpus_stats(*, indexer: VectorStore) -> Dict[str, Any]:
    payload_counts: Dict[str, Dict[str, int]] = {}
    file_seen: Dict[str, set] = {}
    for payload in indexer.iter_chunks(limit=1000):
        source_type = payload.get("source_type", "unknown")
        payload_counts.setdefault(source_type, {"chunks": 0, "files": 0})
        payload_counts[source_type]["chunks"] += 1
        file_path = payload.get("file_path")
        if file_path:
            file_seen.setdefault(source_type, set())
            if file_path not in file_seen[source_type]:
                file_seen[source_type].add(file_path)
                payload_counts[source_type]["files"] += 1
    total_chunks = indexer.total_count()
    return {
        "total_chunks": total_chunks,
        "by_source_type": payload_counts,
    }


__all__ = [
    "semantic_search",
    "search_in_book",
    "search_by_author",
    "get_chunk_context",
    "get_file_chunks",
    "search_by_tags",
    "corpus_stats",
]
