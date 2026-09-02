"""File processing pipeline: read, chunk, embed, index."""

from __future__ import annotations

import hashlib
import asyncio
from pathlib import Path
from typing import Any, Dict, List, Optional

from .chunker import Chunk, paragraph_chunks, fixed_chunks, heading_chunks, semantic_chunks
from .config import SourceConfig
from .embedder import Embedder
from .store import VectorStore
from .utils import (
    apply_path_extractors,
    build_metadata_head,
    build_metadata_prose,
    flatten_frontmatter,
    read_text_with_frontmatter,
)
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
    member_id: Optional[str] = None,
    force: bool = False,
) -> int:
    if not file_path.exists() or not file_path.is_file():
        raise FileNotFoundError(file_path)

    metadata_cfg = source_config.metadata
    file_hash = _hash_file(file_path)

    previous_hash = hash_store.get(file_path) if hash_store else None

    # `force` re-embeds a file whose bytes have not changed — which is the only
    # way to pick up a change in how metadata is *rendered* rather than in the
    # document itself. Without it, improving the payload or the preamble left
    # every existing document on the old shape.
    if not force and previous_hash and previous_hash == file_hash:
        return 0

    text_meta = read_text_with_frontmatter(
        file_path,
        extract_frontmatter=metadata_cfg.extract_from_frontmatter,
    )
    text = text_meta.text

    # Flattened, so a fiche's `meta:` fields become filterable payload keys —
    # the store builds predicates over `$.<key>` and rejects dotted ones.
    base_metadata: Dict[str, Any] = dict(flatten_frontmatter(text_meta.payload))
    if metadata_cfg.extract_from_path:
        base_metadata.update(apply_path_extractors(file_path, metadata_cfg.extract_from_path))

    # The corpus's own vocabulary is written last, so a document cannot overwrite
    # it: an article card's `source:` names its publication, and it was silently
    # replacing which source had indexed the file — the payload said
    # "the Guardian" where it meant "garden-cards".
    base_metadata["source"] = source_name
    base_metadata["source_type"] = metadata_cfg.source_type

    from_frontmatter = metadata_cfg.extract_from_frontmatter
    head = build_metadata_head(base_metadata) if from_frontmatter else ""
    prose = build_metadata_prose(base_metadata) if from_frontmatter else ""

    # A blank chunk is never useful and is actively harmful: the embedder drops
    # blank strings, so one would leave the vectors shorter than the chunks and
    # every payload after it carrying someone else's vector. Chunking an empty
    # body returns exactly that — one empty chunk — which also masked the
    # empty-body fallback below.
    chunks = [c for c in _chunk_text(text, source_config) if c.text.strip()]

    # The document's own prose about itself — subtitle, summary, blurb — as one
    # chunk. Stored, so a hit on it can be quoted; separate, so it is not
    # repeated on top of every body chunk.
    if prose:
        chunks.append(Chunk(text=prose, index=len(chunks)))

    if not chunks:
        # A fiche can legitimately have an empty body — capture first, verdict
        # later. Its identity is still worth finding, so index that alone rather
        # than dropping the document.
        if not head:
            return 0
        chunks = [Chunk(text=head, index=0)]
        head = ""

    # The head rides along with every chunk at embed time but is never stored:
    # search matches on title/author/publication/year wherever the hit lands in
    # a long document, while quoted results stay the real text.
    vectors = await embedder.embed_batch(
        (f"{head}\n\n{chunk.text}" if head else chunk.text) for chunk in chunks
    )

    await asyncio.to_thread(indexer.delete_unit, unit_key=str(file_path), member_id=member_id)

    def _upsert() -> int:
        return indexer.upsert(
            unit_key=str(file_path),
            unit_hash=file_hash,
            chunks=chunks,
            vectors=vectors.vectors,
            base_metadata=base_metadata,
            embedding_model=vectors.model,
            member_id=member_id,
        )

    written = await asyncio.to_thread(_upsert)
    if hash_store and written:
        hash_store.set(file_path, file_hash)
    return written


def remove_file(
    file_path: Path,
    indexer: VectorStore,
    hash_store: HashStore | None = None,
    member_id: Optional[str] = None,
) -> None:
    indexer.delete_unit(unit_key=str(file_path), member_id=member_id)
    if hash_store:
        hash_store.delete(file_path)


__all__ = ["process_file", "remove_file"]
