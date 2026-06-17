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


@asynccontextmanager
async def corpus_server_context(config_path: Path | None = None, *, watch: bool = True):
    config = load_config(config_path or _config_path())
    orchestrator = CorpusOrchestrator(config, vector_size=config.embedding.vector_size)
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
