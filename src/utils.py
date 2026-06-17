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


def _split_extractor(expr: str) -> list[str]:
    """Split on '.' but keep 're:...' as a single token."""
    parts: list[str] = []
    for token in expr.split("."):
        if parts and parts[-1].startswith("re:"):
            parts[-1] += "." + token
        else:
            parts.append(token)
    return parts


def apply_path_extractors(path: Path, extractors: Dict[str, str]) -> Dict[str, str]:
    payload: Dict[str, str] = {}
    current = path
    for key, expr in extractors.items():
        parts = _split_extractor(expr)
        node: Any = current
        for part in parts:
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
        payload[key] = str(node)
    return payload
