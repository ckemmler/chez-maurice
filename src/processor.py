"""File processing pipeline: read, chunk, embed, index."""

from __future__ import annotations

import hashlib
import asyncio
from pathlib import Path
from typing import Dict, List

from .chunker import Chunk, paragraph_chunks, fixed_chunks, heading_chunks, semantic_chunks
from .config import SourceConfig
from .embedder import Embedder
from .store import VectorStore
from .utils import read_text_with_frontmatter, apply_path_extractors
from .hash_store import HashStore


def _hash_file(path: Path) -> str:
    sha = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(8192), b""):
            sha.update(chunk)
    return sha.hexdigest()


def _chunk_text(text: str, config: SourceConfig) -> List[Chunk]:
    method = config.chunking.method.lower()
    max_chars = config.chunking.max_tokens * 4  # rough token->char estimate
    overlap = config.chunking.overlap_tokens * 4
    if method == "paragraph":
        return paragraph_chunks(text, max_chars=max_chars)
    if method == "fixed":
        return fixed_chunks(text, max_chars=max_chars, overlap_chars=overlap)
    if method == "heading":
        return heading_chunks(text, max_chars=max_chars)
    if method == "semantic":
        return semantic_chunks(text, max_chars=max_chars)
    raise NotImplementedError(f"Chunking method '{method}' not implemented yet")


async def process_file(
    file_path: Path,
    source_name: str,
    source_config: SourceConfig,
    embedder: Embedder,
    indexer: VectorStore,
    hash_store: HashStore | None = None,
) -> int:
    if not file_path.exists() or not file_path.is_file():
        raise FileNotFoundError(file_path)

    metadata_cfg = source_config.metadata
    file_hash = _hash_file(file_path)

    previous_hash = hash_store.get(file_path) if hash_store else None

    if previous_hash and previous_hash == file_hash:
        return 0

    text_meta = read_text_with_frontmatter(
        file_path,
        extract_frontmatter=metadata_cfg.extract_from_frontmatter,
    )
    text = text_meta.text

    base_metadata: Dict[str, str] = {
        "source": source_name,
        "source_type": metadata_cfg.source_type,
    }
    base_metadata.update(text_meta.payload)
    if metadata_cfg.extract_from_path:
        base_metadata.update(apply_path_extractors(file_path, metadata_cfg.extract_from_path))

    chunks = _chunk_text(text, source_config)
    if not chunks:
        return 0

    vectors = await embedder.embed_batch(chunk.text for chunk in chunks)

    await asyncio.to_thread(indexer.delete_unit, unit_key=str(file_path))

    def _upsert() -> int:
        return indexer.upsert(
            unit_key=str(file_path),
            unit_hash=file_hash,
            chunks=chunks,
            vectors=vectors.vectors,
            base_metadata=base_metadata,
            embedding_model=vectors.model,
        )

    written = await asyncio.to_thread(_upsert)
    if hash_store and written:
        hash_store.set(file_path, file_hash)
    return written


def remove_file(file_path: Path, indexer: VectorStore, hash_store: HashStore | None = None) -> None:
    indexer.delete_unit(unit_key=str(file_path))
    if hash_store:
        hash_store.delete(file_path)


__all__ = ["process_file", "remove_file"]
