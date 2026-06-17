"""Chunking strategies for the corpus indexer."""

from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Iterable, List


@dataclass
class Chunk:
    text: str
    index: int


def paragraph_chunks(text: str, max_chars: int = 1500) -> List[Chunk]:
    paragraphs = [p.strip() for p in text.split("\n\n") if p.strip()]
    chunks: List[Chunk] = []
    buffer: List[str] = []
    buffer_len = 0
    idx = 0
    for para in paragraphs:
        if buffer_len + len(para) + 2 > max_chars and buffer:
            chunks.append(Chunk(text="\n\n".join(buffer), index=idx))
            idx += 1
            buffer = []
            buffer_len = 0
        buffer.append(para)
        buffer_len += len(para) + 2
    if buffer:
        chunks.append(Chunk(text="\n\n".join(buffer), index=idx))
    if not chunks:
        chunks.append(Chunk(text=text.strip(), index=0))
    return chunks


def fixed_chunks(text: str, max_chars: int = 2000, overlap_chars: int = 200) -> List[Chunk]:
    chunks: List[Chunk] = []
    start = 0
    idx = 0
    while start < len(text):
        end = min(len(text), start + max_chars)
        chunk_text = text[start:end].strip()
        if chunk_text:
            chunks.append(Chunk(text=chunk_text, index=idx))
            idx += 1
        start += max_chars - overlap_chars
    if not chunks:
        chunks.append(Chunk(text=text.strip(), index=0))
    return chunks


HEADING_RE = re.compile(r"^#{1,6}\s+.+", re.MULTILINE)


def semantic_chunks(text: str, max_chars: int = 1800) -> List[Chunk]:
    """Greedy paragraph grouping that approximates semantic sections."""

    paragraphs = [p.strip() for p in text.split("\n\n") if p.strip()]
    if not paragraphs:
        cleaned = text.strip()
        return [Chunk(text=cleaned, index=0)] if cleaned else []

    chunks: List[Chunk] = []
    buffer: List[str] = []
    buffer_len = 0
    idx = 0

    for para in paragraphs:
        para_len = len(para)

        if para_len >= max_chars:
            if buffer:
                chunks.append(Chunk(text="\n\n".join(buffer), index=idx))
                idx += 1
                buffer = []
                buffer_len = 0
            for fixed in fixed_chunks(para, max_chars=max_chars, overlap_chars=int(max_chars * 0.1)):
                chunks.append(Chunk(text=fixed.text, index=idx))
                idx += 1
            continue

        if buffer_len + para_len + 2 > max_chars and buffer:
            chunks.append(Chunk(text="\n\n".join(buffer), index=idx))
            idx += 1
            buffer = []
            buffer_len = 0

        buffer.append(para)
        buffer_len += para_len + 2

    if buffer:
        chunks.append(Chunk(text="\n\n".join(buffer), index=idx))

    return chunks or [Chunk(text=text.strip(), index=0)]


def heading_chunks(text: str, max_chars: int = 2000) -> List[Chunk]:
    """Group content by markdown headings while respecting max size."""

    if not HEADING_RE.search(text):
        return paragraph_chunks(text, max_chars=max_chars)

    sections: List[str] = []
    current: List[str] = []
    for line in text.splitlines():
        stripped = line.strip()
        if HEADING_RE.match(stripped):
            if current:
                section = "\n".join(current).strip()
                if section:
                    sections.append(section)
            current = [line]
        else:
            current.append(line)
    if current:
        section = "\n".join(current).strip()
        if section:
            sections.append(section)

    chunks: List[Chunk] = []
    buffer: List[str] = []
    buffer_len = 0
    idx = 0
    for section in sections:
        sec_len = len(section)
        if sec_len >= max_chars:
            if buffer:
                chunks.append(Chunk(text="\n\n".join(buffer), index=idx))
                idx += 1
                buffer = []
                buffer_len = 0
            for fixed in fixed_chunks(section, max_chars=max_chars, overlap_chars=int(max_chars * 0.1)):
                chunks.append(Chunk(text=fixed.text, index=idx))
                idx += 1
            continue

        if buffer_len + sec_len + 2 > max_chars and buffer:
            chunks.append(Chunk(text="\n\n".join(buffer), index=idx))
            idx += 1
            buffer = []
            buffer_len = 0

        buffer.append(section)
        buffer_len += sec_len + 2

    if buffer:
        chunks.append(Chunk(text="\n\n".join(buffer), index=idx))

    if not chunks:
        return paragraph_chunks(text, max_chars=max_chars)

    return chunks


__all__ = ["Chunk", "paragraph_chunks", "fixed_chunks", "heading_chunks", "semantic_chunks"]
