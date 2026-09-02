"""Entry point for the Akita corpus watcher and CLI."""

from __future__ import annotations

import argparse
import asyncio
import logging
import json
from pathlib import Path
from typing import List

from .config import load_config
from .orchestrator import CorpusOrchestrator
from .mcp_server import CorpusMCPServer
from .search import semantic_search, corpus_stats

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Akita corpus indexer")
    parser.add_argument(
        "command",
        choices={"serve", "index", "stats", "search", "validate"},
        help="Command to execute",
    )
    parser.add_argument("query", nargs="?", help="Query string for search command")
    parser.add_argument("--config", default=Path("config/corpus.yaml"), type=Path)
    parser.add_argument("--source", action="append", help="Specific source(s) to target for indexing")
    parser.add_argument("--limit", type=int, default=10, help="Result limit for search command")
    return parser


async def serve(config_path: Path) -> None:
    config = load_config(config_path)
    orchestrator = CorpusOrchestrator(config, vector_size=config.embedding.vector_size)
    await orchestrator.initial_index()
    orchestrator.start_watching()
    server = CorpusMCPServer(orchestrator=orchestrator)
    try:
        await server.run()
    except KeyboardInterrupt:
        logging.info("Shutting down corpus server...")
    finally:
        orchestrator.stop_watching()


async def run_index(config_path: Path, sources: List[str] | None = None) -> None:
    config = load_config(config_path)
    orchestrator = CorpusOrchestrator(config, vector_size=config.embedding.vector_size)
    # `conversations` is a DB-backed pseudo-source reconciled from maurice.db, not a
    # file glob; split it out from the file sources.
    if sources and "conversations" in sources:
        sources = [s for s in sources if s != "conversations"]
        stats = await orchestrator.index_conversations()
        logging.info("Conversations reconciled: %s", stats)
    if sources is None or sources:
        await orchestrator.initial_index(sources)


async def run_search(config_path: Path, query: str, limit: int) -> None:
    if not query:
        raise ValueError("Query is required for search command")
    config = load_config(config_path)
    orchestrator = CorpusOrchestrator(config, vector_size=config.embedding.vector_size)
    results = await semantic_search(
        query,
        embedder=orchestrator.embedder,
        indexer=orchestrator.indexer,
        limit=limit,
    )
    for idx, item in enumerate(results, start=1):
        print(f"[{idx}] score={item.get('score'):.3f} path={item.get('file_path')}")
        snippet = (item.get("text") or "")
        print(snippet[:400])
        print("-")


async def run_stats(config_path: Path) -> None:
    config = load_config(config_path)
    orchestrator = CorpusOrchestrator(config, vector_size=config.embedding.vector_size)
    stats = await corpus_stats(indexer=orchestrator.indexer)
    print(json.dumps(stats, indent=2))


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="[%(levelname)s] %(message)s")
    parser = build_parser()
    args = parser.parse_args()

    if args.command == "validate":
        config = load_config(args.config)
        print("Configuration OK for sources:", ", ".join(config.source_names))
        return

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        if args.command == "serve":
            loop.run_until_complete(serve(args.config))
        elif args.command == "index":
            loop.run_until_complete(run_index(args.config, args.source))
        elif args.command == "search":
            loop.run_until_complete(run_search(args.config, args.query, args.limit))
        elif args.command == "stats":
            loop.run_until_complete(run_stats(args.config))
        else:
            parser.error(f"Unknown command: {args.command}")
    finally:
        loop.close()


if __name__ == "__main__":
    main()
