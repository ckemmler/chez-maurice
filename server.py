#!/usr/bin/env python3
"""Standalone MCP server launcher for the corpus tools."""

from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager
from pathlib import Path

try:
    from .src.config import load_config
    from .src.orchestrator import CorpusOrchestrator
    from .src.mcp_server import CorpusMCPServer
except ImportError:  # pragma: no cover - fallback when run as script
    from src.config import load_config
    from src.orchestrator import CorpusOrchestrator
    from src.mcp_server import CorpusMCPServer

DEFAULT_CONFIG = Path(__file__).resolve().parent / "config/corpus.yaml"


def _config_path() -> Path:
    override = os.environ.get("MAURICE_CORPUS_CONFIG") or os.environ.get("AKITA_CORPUS_CONFIG")
    return Path(override) if override else DEFAULT_CONFIG


_shared_orchestrator: "CorpusOrchestrator | None" = None


def get_shared_orchestrator(config_path: Path | None = None) -> "CorpusOrchestrator":
    """Process-wide CorpusOrchestrator, so the in-process MCP tool and any
    push callers (e.g. the garden tool re-indexing a note) share one store and
    embedder handle rather than opening duplicate sqlite connections."""
    global _shared_orchestrator
    if _shared_orchestrator is None:
        config = load_config(config_path or _config_path())
        _shared_orchestrator = CorpusOrchestrator(config, vector_size=config.embedding.vector_size)
    return _shared_orchestrator


async def index_path(source_name: str, path: "str | Path") -> None:
    """Push-index a single file under a named source. Safe to call for any path:
    non-matching paths (wrong source/glob) are filtered out and become a no-op."""
    await get_shared_orchestrator().index_single(source_name, Path(path))


def remove_path(source_name: str, path: "str | Path") -> None:
    """Drop a single file's chunks under a named source (push hook for deletes)."""
    get_shared_orchestrator().remove_single(source_name, Path(path))


@asynccontextmanager
async def corpus_server_context(config_path: Path | None = None, *, watch: bool = True):
    orchestrator = get_shared_orchestrator(config_path)
    if watch:
        orchestrator.start_watching()
    server = CorpusMCPServer(orchestrator=orchestrator)
    try:
        yield server
    finally:
        if watch:
            orchestrator.stop_watching()


@asynccontextmanager
async def gateway_context():
    """MCP-gateway entrypoint: yields the low-level Server, config self-resolved
    (MAURICE_CORPUS_CONFIG / AKITA_CORPUS_CONFIG / default), no file watcher."""
    async with corpus_server_context(watch=False) as server:
        yield server.app


async def main() -> None:
    async with corpus_server_context() as server:
        await server.run()


if __name__ == "__main__":
    asyncio.run(main())
