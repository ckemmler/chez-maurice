"""Qdrant implementation of the VectorStore contract.

Generic method names (`upsert`, `delete_unit`, `search`, …) satisfy
`store.VectorStore`; internally everything still maps onto the historical Qdrant
payload keys (`file_path`, `file_hash`) and filter semantics, so existing
collections and queries are unchanged.
"""

from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Iterable, Iterator, List, Optional
import uuid

from qdrant_client import QdrantClient
from qdrant_client.http import models as qmodels

from .chunker import Chunk
from .config import QdrantConfig

import sys as _sys
_repo_root = str(Path(__file__).resolve().parents[3])
if _repo_root not in _sys.path:
    _sys.path.insert(0, _repo_root)
from tools.shared.context import member_id_var


def _match_for(value: Any) -> qmodels.MatchValue | qmodels.MatchText:
    """MatchText for strings (substring/token match), MatchValue for exact types."""
    if isinstance(value, str):
        return qmodels.MatchText(text=value)
    return qmodels.MatchValue(value=value)


def _build_filter(filters: Optional[Dict[str, Any]]) -> Optional[qmodels.Filter]:
    if not filters:
        return None
    must = []
    for key, value in filters.items():
        if isinstance(value, list):
            # OR within the same key (e.g. multiple book_ids)
            should = [qmodels.FieldCondition(key=key, match=_match_for(item)) for item in value]
            if should:
                must.append(qmodels.Filter(should=should))
        else:
            must.append(qmodels.FieldCondition(key=key, match=_match_for(value)))
    if not must:
        return None
    return qmodels.Filter(must=must)


class QdrantStore:
    """Handles all Qdrant operations for the corpus (a VectorStore backend)."""

    def __init__(self, config: QdrantConfig, *, vector_size: int, ensure_collection: bool = True) -> None:
        self.config = config
        self.collection = config.collection
        if config.url:
            self.client = QdrantClient(url=config.url, api_key=config.api_key)
        else:
            self.client = QdrantClient(host=config.host, port=config.port, api_key=config.api_key)
        self.vector_size = vector_size
        if ensure_collection:
            self._ensure_collection()

    def _ensure_collection(self) -> None:
        try:
            exists = self.client.collection_exists(self.collection)
        except Exception:
            exists = False
        if exists:
            info = self.client.get_collection(self.collection)
            current_size = info.config.params.vectors.size
            if current_size != self.vector_size:
                import logging
                logging.getLogger(__name__).warning(
                    "Collection '%s' has vector_size=%d but config expects %d — recreating",
                    self.collection, current_size, self.vector_size,
                )
                self.client.delete_collection(self.collection)
                exists = False
        if not exists:
            self.client.recreate_collection(
                collection_name=self.collection,
                vectors_config=qmodels.VectorParams(
                    size=self.vector_size,
                    distance=qmodels.Distance.COSINE,
                ),
            )
        self._ensure_text_indexes()

    def _ensure_text_indexes(self) -> None:
        """Create full-text indexes on string fields used with MatchText."""
        text_schema = qmodels.TextIndexParams(
            type="text",
            tokenizer=qmodels.TokenizerType.WORD,
            lowercase=True,
        )
        for field in ("book_title", "author"):
            try:
                self.client.create_payload_index(
                    collection_name=self.collection,
                    field_name=field,
                    field_schema=text_schema,
                )
            except Exception:
                # Index already exists — ignore
                pass

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
        timestamp = datetime.utcnow().isoformat()
        total = len(chunk_list)
        points: List[qmodels.PointStruct] = []
        for idx, (chunk, vector) in enumerate(zip(chunk_list, vectors)):
            chunk_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"{unit_key}:{idx}"))
            mid = member_id or member_id_var.get()
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
            points.append(
                qmodels.PointStruct(
                    id=chunk_id,
                    vector=vector,
                    payload=payload,
                )
            )
        if points:
            self.client.upsert(collection_name=self.collection, points=points)
        return len(points)

    def delete_unit(self, *, unit_key: str, member_id: Optional[str] = None) -> None:
        flt = qmodels.Filter(should=[qmodels.FieldCondition(key="file_path", match=qmodels.MatchValue(value=unit_key))])
        self.client.delete(collection_name=self.collection, points_selector=qmodels.FilterSelector(filter=flt))

    def delete_by_hash(self, *, unit_hash: str, member_id: Optional[str] = None) -> None:
        flt = qmodels.Filter(should=[qmodels.FieldCondition(key="file_hash", match=qmodels.MatchValue(value=unit_hash))])
        self.client.delete(collection_name=self.collection, points_selector=qmodels.FilterSelector(filter=flt))

    def get_chunk(self, *, chunk_id: str, member_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
        records = self.client.retrieve(collection_name=self.collection, ids=[chunk_id], with_vectors=False)
        if not records:
            return None
        payload = records[0].payload or {}
        payload["chunk_id"] = chunk_id
        return payload

    def iter_chunks(
        self,
        *,
        where: Optional[Dict[str, Any]] = None,
        limit: int = 200,
        member_id: Optional[str] = None,
    ) -> Iterator[Dict[str, Any]]:
        flt = _build_filter(where)
        next_page = None
        while True:
            kwargs = dict(
                collection_name=self.collection,
                limit=limit,
                with_vectors=False,
                with_payload=True,
                offset=next_page,
            )
            if flt is not None:
                kwargs["scroll_filter"] = flt
            points, next_page = self.client.scroll(**kwargs)
            for point in points:
                payload = point.payload or {}
                payload["chunk_id"] = point.id
                yield payload
            if next_page is None:
                break

    def count(self, *, where: Optional[Dict[str, Any]] = None, member_id: Optional[str] = None) -> int:
        return sum(1 for _ in self.iter_chunks(where=where, limit=500))

    def total_count(self, *, member_id: Optional[str] = None) -> int:
        try:
            info = self.client.get_collection(self.collection)
        except Exception:
            return 0
        return getattr(info, "vectors_count", 0) or 0

    def search(
        self,
        *,
        vector: List[float],
        limit: int,
        filters: Optional[Dict[str, Any]] = None,
        member_id: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        mid = member_id or member_id_var.get()
        effective_filters = dict(filters or {})
        if mid:
            effective_filters["member_id"] = mid
        qp_filter = _build_filter(effective_filters) if effective_filters else None
        response = self.client.query_points(
            collection_name=self.collection,
            query=vector,
            limit=limit,
            query_filter=qp_filter,
            with_payload=True,
        )
        results: List[Dict[str, Any]] = []
        for hit in response.points or []:
            payload = hit.payload or {}
            payload["score"] = hit.score
            results.append(payload)
        return results


# Backwards-compatible alias: the class was historically named CorpusIndexer.
CorpusIndexer = QdrantStore


__all__ = ["QdrantStore", "CorpusIndexer"]
