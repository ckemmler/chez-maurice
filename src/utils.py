"""Utility helpers for metadata extraction and text processing."""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Any

import frontmatter


@dataclass
class FileMetadata:
    text: str
    payload: Dict[str, Any]


def read_text_with_frontmatter(path: Path, *, extract_frontmatter: bool = False) -> FileMetadata:
    text = path.read_text(encoding="utf-8")
    payload: Dict[str, Any] = {}
    if extract_frontmatter and text.startswith("---"):
        parsed = frontmatter.loads(text)
        payload.update(parsed.metadata or {})
        text = parsed.content
    return FileMetadata(text=text.strip(), payload=payload)


# ── Frontmatter as searchable text ──────────────────────────────────────────
#
# `read_text_with_frontmatter` strips the frontmatter before the body is
# chunked, so none of it ever reached an embedding: a garden fiche was findable
# by what its body said and by nothing else. Asking for "the book by Anil Seth"
# matched only if the body happened to name him.
#
# Two changes fix that. `flatten_frontmatter` lifts the nested `meta:` block a
# fiche carries up to the top level, so every field is filterable (the store
# builds predicates over `$.<key>` and rejects dotted keys). And
# `build_metadata_preamble` renders the meaningful fields as a short line of
# prose that gets embedded alongside the body.

def flatten_frontmatter(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Lift a nested `meta:` block to the top level, without clobbering.

    A fiche stores what the provider gave us under `meta:` (author, publication,
    published_at…). Top-level keys win on a collision, since those are the ones
    the file itself asserts.
    """
    flat: Dict[str, Any] = {}
    nested = payload.get("meta")
    if isinstance(nested, dict):
        for key, value in nested.items():
            if isinstance(key, str):
                flat[key] = value
    for key, value in payload.items():
        if key == "meta":
            continue
        flat[key] = value
    return flat


_COLLECTION_WORDS = {
    "books": "book",
    "articles": "article",
    "movies": "film",
    "games": "game",
    "series": "TV series",
    "podcasts": "podcast",
    "people": "person",
}

_IDENTITY_KEYS = ("title", "name", "headline")
_FACET_KEYS = (
    "author", "director", "creator", "host", "artist",
    "publication", "source", "site_name", "publisher", "platform",
)
_WHEN_KEYS = ("year", "published_at", "date_read", "date_watched", "date")
_PROSE_KEYS = ("subtitle", "summary", "description", "excerpt", "overview", "role")

_MAX_HEAD_CHARS = 240
_MAX_PROSE_CHARS = 1200


def _scalar(value: Any) -> str:
    if value is None or isinstance(value, (dict, list, tuple, set)):
        return ""
    text = str(value).strip()
    return "" if text.lower() in {"", "none", "null"} else text


def build_metadata_head(meta: Dict[str, Any]) -> str:
    """One short line naming the thing: title, who made it, what it is, when.

    Prepended to *every* chunk at embed time, so a hit anywhere in a long
    document still carries its identity. Deliberately short: an earlier version
    also prepended the blurb, and 400 characters of Google Books marketing copy
    repeated on every chunk drowned the body — a query for "intégration de
    l'information et phi" started returning the wrong book. The prose moved to
    `build_metadata_prose`, which is indexed once.
    """
    identity = next((v for k in _IDENTITY_KEYS if (v := _scalar(meta.get(k)))), "")

    facets: list[str] = []
    for key in _FACET_KEYS:
        value = _scalar(meta.get(key))
        if value and value not in facets and value != identity:
            facets.append(value)
        if len(facets) == 3:
            break

    when = next((v for k in _WHEN_KEYS if (v := _scalar(meta.get(k)))), "")[:4]
    kind = _COLLECTION_WORDS.get(_scalar(meta.get("resource_collection"))) or _scalar(
        meta.get("source_type")
    )

    parts = [p for p in [identity, ", ".join(facets), kind, when] if p]
    head = " — ".join(parts)

    tags = meta.get("tags")
    if isinstance(tags, (list, tuple)):
        rendered = [t for t in (_scalar(t) for t in tags) if t]
        if rendered:
            head = f"{head}\ntags: {', '.join(rendered)}" if head else "tags: " + ", ".join(rendered)

    return head[:_MAX_HEAD_CHARS].strip()


def build_metadata_prose(meta: Dict[str, Any]) -> str:
    """Subtitle, summary, description — the prose a document carries *about*
    itself. Indexed once as its own chunk, not repeated on every chunk.

    For an article this is where the generated summary lands, which is often a
    better handle on the piece than any single passage of it.
    """
    lines: list[str] = []
    seen: set[str] = set()
    for key in _PROSE_KEYS:
        value = _scalar(meta.get(key))
        # excerpt and description are frequently the same sentence; say it once.
        if value and value.lower() not in seen:
            seen.add(value.lower())
            lines.append(value)
    return "\n\n".join(lines)[:_MAX_PROSE_CHARS].strip()


def _split_extractor(expr: str) -> list[str]:
    """Split on '.' but keep 're:...' as a single token."""
    parts: list[str] = []
    for token in expr.split("."):
        if parts and parts[-1].startswith("re:"):
            parts[-1] += "." + token
        else:
            parts.append(token)
    return parts


def apply_path_extractor(path: Path, expr: str) -> str:
    """Evaluate a single path-extractor expression (e.g. 'parent.parent.name')."""
    node: Any = path
    for part in _split_extractor(expr):
        if part == "name":
            node = node.name
        elif part == "stem":
            node = node.stem
        elif part == "parent":
            node = node.parent
        elif part.startswith("re:"):
            pattern = part[3:]
            match = re.search(pattern, str(node))
            node = match.group(1) if match else str(node)
        else:
            raise ValueError(f"Unsupported path extractor component: {part}")
    return str(node)


def apply_path_extractors(path: Path, extractors: Dict[str, str]) -> Dict[str, str]:
    return {key: apply_path_extractor(path, expr) for key, expr in extractors.items()}
