"""MCP server exposing corpus search tools."""

from __future__ import annotations

import json
from typing import Any

import asyncio
import os
import sys
from pathlib import Path
from datetime import datetime
from typing import Optional

if __package__ in {None, ""}:  # Allow running via ``python src/mcp_server.py``
    PROJECT_ROOT = Path(__file__).resolve().parents[1]
    if str(PROJECT_ROOT) not in sys.path:
        sys.path.insert(0, str(PROJECT_ROOT))

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import Tool, TextContent

try:
    from .config import load_config
    from .orchestrator import CorpusOrchestrator
    from .search import (
        semantic_search,
        search_in_book,
        search_by_author,
        search_by_tags,
        get_chunk_context,
        get_file_chunks,
        corpus_stats,
    )
except ImportError:  # pragma: no cover - script fallback
    from src.config import load_config
    from src.orchestrator import CorpusOrchestrator
    from src.search import (
        semantic_search,
        search_in_book,
        search_by_author,
        search_by_tags,
        get_chunk_context,
        get_file_chunks,
        corpus_stats,
    )


class CorpusMCPServer:
    def __init__(self, *, orchestrator) -> None:
        self.app = Server("akita-corpus")
        self.orchestrator = orchestrator
        self.dossier_dir = Path(
            os.environ.get(
                "AKITA_DOSSIER_DIR",
                Path(__file__).resolve().parents[3] / "research/dossiers",
            )
        ).expanduser()
        self._register()

    def _register(self) -> None:
        @self.app.list_tools()
        async def list_tools() -> list[Tool]:
            return [
                Tool(
                    name="search",
                    description=(
                        "Semantic search across the indexed corpus: garden notes, fiches "
                        "(books, films, series, podcasts, articles, people) and the long "
                        "text hanging off them, book chapters, thoughts, dossiers.\n\n"
                        "`filters` narrows by any metadata field a document carries, which "
                        "for a fiche is its whole frontmatter — flattened, so the nested "
                        "`meta:` block is reachable at the top level. A string matches as a "
                        "substring (case-insensitive), a list matches any of its values, a "
                        "number or boolean matches exactly.\n\n"
                        "Useful keys: source_type (note | fiche | fragment | book | thought | "
                        "dossier), collection (books | articles | movies | games | series | "
                        "podcasts | people), author, publication, title, tags, year, "
                        "published_at, status, locale.\n\n"
                        'Examples: {"source_type": "fiche", "collection": "books"} — only book '
                        'fiches. {"author": "Seth"} — anything by an author whose name contains '
                        'Seth. {"collection": ["articles", "podcasts"], "publication": "Monde"}.'
                    ),
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "query": {"type": "string"},
                            "limit": {"type": "integer", "default": 10},
                            "filters": {
                                "type": "object",
                                "description": (
                                    "Metadata constraints, ANDed together. Keys must be plain "
                                    "identifiers; values are a string (substring match), a list "
                                    "(match any), or a number/boolean (exact)."
                                ),
                                "additionalProperties": True,
                            },
                        },
                        "required": ["query"],
                    },
                ),
                Tool(
                    name="search_in_book",
                    description="Search within a specific book title",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "query": {"type": "string"},
                            "book_title": {"type": "string"},
                            "limit": {"type": "integer", "default": 10},
                        },
                        "required": ["query", "book_title"],
                    },
                ),
                Tool(
                    name="search_by_author",
                    description="Search across content by author",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "query": {"type": "string"},
                            "author": {"type": "string"},
                            "limit": {"type": "integer", "default": 10},
                        },
                        "required": ["query", "author"],
                    },
                ),
                Tool(
                    name="search_by_tags",
                    description="Semantic search filtered by Calibre book tags (e.g. non-fiction, philosophy)",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "query": {"type": "string"},
                            "tags": {
                                "type": "array",
                                "items": {"type": "string"},
                                "description": "Calibre tags to filter by",
                            },
                            "match_all_tags": {
                                "type": "boolean",
                                "default": False,
                                "description": "If true, only include books matching ALL tags; otherwise ANY",
                            },
                            "limit": {"type": "integer", "default": 10},
                        },
                        "required": ["query", "tags"],
                    },
                ),
                Tool(
                    name="get_chunk_context",
                    description="Return a chunk and surrounding context",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "chunk_id": {"type": "string"},
                            "window": {"type": "integer", "default": 2},
                        },
                        "required": ["chunk_id"],
                    },
                ),
                Tool(
                    name="get_file_chunks",
                    description="List all chunks from a file path",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "file_path": {"type": "string"},
                        },
                        "required": ["file_path"],
                    },
                ),
                Tool(
                    name="corpus_stats",
                    description="Get corpus statistics",
                    inputSchema={"type": "object", "properties": {}},
                ),
                Tool(
                    name="index_path",
                    description=(
                        "Index one file into a named source, now. The push hook for writers "
                        "that live outside this process — the Bun server writes article "
                        "fiches straight to disk, and the gateway runs the corpus with its "
                        "file watcher off, so nothing would otherwise pick them up.\n\n"
                        "The path must sit under that source's root and match its glob; "
                        "anything else is a no-op, never an error."
                    ),
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "source": {
                                "type": "string",
                                "description": "Source name, e.g. garden-fiches, garden-fragments, garden-notes",
                            },
                            "path": {"type": "string", "description": "Absolute path of the file"},
                            "deleted": {
                                "type": "boolean",
                                "default": False,
                                "description": "Drop the file's chunks instead of indexing it",
                            },
                        },
                        "required": ["source", "path"],
                    },
                ),
                Tool(
                    name="prune",
                    description=(
                        "Drop index entries whose file no longer exists on disk. The watcher "
                        "handles deletions it sees; this cleans up the ones that happened while "
                        "nothing was watching — a tree moved, a git rm — whose chunks would "
                        "otherwise answer searches forever with content that is gone."
                    ),
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "sources": {
                                "type": "array",
                                "items": {"type": "string"},
                                "description": "Limit to these sources; omit to scan all file-backed ones",
                            },
                        },
                    },
                ),
                Tool(
                    name="reindex",
                    description="Re-index sources (optionally limited)",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "sources": {
                                "type": "array",
                                "items": {"type": "string"},
                                "description": "Specific sources to reindex",
                            },
                            "force": {
                                "type": "boolean",
                                "default": False,
                                "description": (
                                    "Re-embed files whose bytes have not changed. Needed when what "
                                    "changed is how metadata is rendered into the index rather than "
                                    "the documents themselves — otherwise every existing file keeps "
                                    "the old shape."
                                ),
                            },
                        },
                    },
                ),
                Tool(
                    name="index_conversation",
                    description=(
                        "Index/refresh Maurice conversations into per-member search. "
                        "Pass a conversation_id to reconcile one room (call after a turn); "
                        "omit it to backfill every conversation."
                    ),
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "conversation_id": {
                                "type": "string",
                                "description": "Conversation to reconcile; omit to reconcile all",
                            },
                        },
                    },
                ),
                Tool(
                    name="import_chat_export",
                    description=(
                        "Start importing a member's chat data export .zip (provider: anthropic|chatgpt) — "
                        "each external conversation becomes a real maurice.db conversation and is indexed "
                        "for search (runs in the background). Incremental from the member+provider watermark; "
                        "re-imports dedupe. Returns a job_id — poll import_status for progress."
                    ),
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "path": {"type": "string", "description": "Server-side path to the export .zip"},
                            "provider": {"type": "string", "enum": ["anthropic", "chatgpt"], "default": "anthropic"},
                            "member_id": {"type": "string", "description": "Owner; defaults to the caller"},
                            "since": {"type": "string", "description": "ISO lower bound; defaults to the watermark"},
                        },
                        "required": ["path"],
                    },
                ),
                Tool(
                    name="import_status",
                    description="Poll an import job by job_id: { phase, done, total, status, result|error }.",
                    inputSchema={
                        "type": "object",
                        "properties": {"job_id": {"type": "string"}},
                        "required": ["job_id"],
                    },
                ),
                Tool(
                    name="import_history",
                    description="Return a member+provider import run log (newest first) and sync watermark.",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "member_id": {"type": "string", "description": "Defaults to the caller"},
                            "provider": {"type": "string", "enum": ["anthropic", "chatgpt"], "default": "anthropic"},
                        },
                    },
                ),
                Tool(
                    name="list_dossiers",
                    description="List research dossiers stored on disk, optionally filtered by creation time",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "start": {
                                "type": "string",
                                "description": "ISO timestamp; only dossiers created on/after this",
                            },
                            "end": {
                                "type": "string",
                                "description": "ISO timestamp; only dossiers created on/before this",
                            },
                            "limit": {
                                "type": "integer",
                                "default": 20,
                                "minimum": 1,
                                "maximum": 200,
                            },
                            "include_summary": {
                                "type": "boolean",
                                "default": False,
                                "description": "Whether to include the top-level summary paragraph",
                            },
                        },
                    },
                ),
                Tool(
                    name="get_dossier",
                    description="Return the full contents and metadata for a single dossier by ID",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "dossier_id": {
                                "type": "string",
                                "description": "Stem of the dossier file (e.g. dossier-2026-02-07T08:04:38.932975)",
                            }
                        },
                        "required": ["dossier_id"],
                    },
                ),
                Tool(
                    name="search_book_summaries",
                    description="Semantic search within Calibre chapter summaries (optional book filter)",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "query": {"type": "string"},
                            "book_title": {"type": "string"},
                            "limit": {"type": "integer", "default": 10},
                        },
                        "required": ["query"],
                    },
                ),
                Tool(
                    name="get_chapter_summary",
                    description="Return the raw summary text for a chapter summary file",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "summary_path": {"type": "string"},
                        },
                        "required": ["summary_path"],
                    },
                ),
                Tool(
                    name="get_chapter_text",
                    description="Return the chapter plaintext corresponding to a summary or explicit path. Provide either summary_path or chapter_path.",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "summary_path": {"type": "string", "description": "Path to a summary file (will resolve to its chapter)"},
                            "chapter_path": {"type": "string", "description": "Direct path to a chapter file"},
                        },
                    },
                ),
            ]

        @self.app.call_tool()
        async def call_tool(name: str, arguments: Any) -> list[TextContent]:
            if name == "search":
                query = arguments.get("query")
                limit = arguments.get("limit", 10)
                filters = arguments.get("filters") or None
                if filters is not None and not isinstance(filters, dict):
                    raise ValueError("filters must be an object")
                results = await semantic_search(
                    query,
                    embedder=self.orchestrator.embedder,
                    indexer=self.orchestrator.indexer,
                    limit=limit,
                    filters=filters,
                )
                payload = {"results": results}
            elif name == "search_in_book":
                results = await search_in_book(
                    arguments.get("query"),
                    arguments.get("book_title"),
                    embedder=self.orchestrator.embedder,
                    indexer=self.orchestrator.indexer,
                    limit=arguments.get("limit", 10),
                )
                payload = {"results": results}
            elif name == "search_by_author":
                results = await search_by_author(
                    arguments.get("query"),
                    arguments.get("author"),
                    embedder=self.orchestrator.embedder,
                    indexer=self.orchestrator.indexer,
                    limit=arguments.get("limit", 10),
                )
                payload = {"results": results}
            elif name == "search_by_tags":
                results = await search_by_tags(
                    arguments.get("query"),
                    arguments.get("tags", []),
                    embedder=self.orchestrator.embedder,
                    indexer=self.orchestrator.indexer,
                    limit=arguments.get("limit", 10),
                    match_all_tags=arguments.get("match_all_tags", False),
                )
                payload = {"results": results}
            elif name == "get_chunk_context":
                chunks = await get_chunk_context(
                    arguments.get("chunk_id"),
                    arguments.get("window", 2),
                    indexer=self.orchestrator.indexer,
                )
                payload = {"chunks": chunks}
            elif name == "get_file_chunks":
                chunks = await get_file_chunks(
                    arguments.get("file_path"),
                    indexer=self.orchestrator.indexer,
                )
                payload = {"chunks": chunks}
            elif name == "corpus_stats":
                stats = await corpus_stats(indexer=self.orchestrator.indexer)
                payload = stats
            elif name == "index_path":
                source = arguments.get("source")
                target = Path(str(arguments.get("path")))
                if arguments.get("deleted"):
                    self.orchestrator.remove_single(source, target)
                else:
                    await self.orchestrator.index_single(source, target)
                payload = {"source": source, "path": str(target)}
            elif name == "prune":
                payload = self.orchestrator.prune_missing(arguments.get("sources"))
            elif name == "reindex":
                await self.orchestrator.initial_index(
                    arguments.get("sources"), force=bool(arguments.get("force"))
                )
                payload = {"status": "reindex started"}
            elif name == "index_conversation":
                payload = await self.orchestrator.index_conversations(arguments.get("conversation_id"))
            elif name == "import_chat_export":
                payload = self.orchestrator.start_import(
                    arguments.get("path"),
                    provider=arguments.get("provider", "anthropic"),
                    member_id=arguments.get("member_id"),
                    since=arguments.get("since"),
                )
            elif name == "import_status":
                payload = self.orchestrator.import_status(arguments.get("job_id"))
            elif name == "import_history":
                payload = self.orchestrator.get_import_history(
                    arguments.get("member_id"), provider=arguments.get("provider", "anthropic")
                )
            elif name == "list_dossiers":
                payload = self._list_dossiers(
                    start=arguments.get("start"),
                    end=arguments.get("end"),
                    limit=int(arguments.get("limit", 20) or 20),
                    include_summary=bool(arguments.get("include_summary", False)),
                )
            elif name == "get_dossier":
                dossier_id = arguments.get("dossier_id")
                try:
                    payload = self._load_dossier(dossier_id)
                except FileNotFoundError as exc:
                    payload = {"error": str(exc)}
            elif name == "search_book_summaries":
                payload = await self._search_book_summaries(arguments or {})
            elif name == "get_chapter_summary":
                payload = self._read_summary(arguments.get("summary_path"))
            elif name == "get_chapter_text":
                payload = self._read_chapter_text(arguments or {})
            else:
                return [TextContent(type="text", text=f"Unknown tool: {name}")]
            return [TextContent(type="text", text=json.dumps(payload, ensure_ascii=False, indent=2))]

    async def run(self) -> None:
        async with stdio_server() as (read_stream, write_stream):
            await self.app.run(read_stream, write_stream, self.app.create_initialization_options())

    def _parse_iso(self, value: Optional[str]) -> Optional[datetime]:
        if not value:
            return None
        try:
            return datetime.fromisoformat(value)
        except ValueError:
            return None

    def _list_dossiers(self, *, start: Optional[str], end: Optional[str], limit: int, include_summary: bool) -> dict:
        dir_path = self.dossier_dir
        start_dt = self._parse_iso(start)
        end_dt = self._parse_iso(end)
        entries: list[dict] = []
        if not dir_path.exists():
            return {"directory": str(dir_path), "count": 0, "dossiers": entries}
        files = sorted(dir_path.glob("*.md"), key=lambda p: p.stat().st_mtime, reverse=True)
        for path in files:
            meta = self._extract_dossier_metadata(path)
            if not meta:
                continue
            created_dt = meta.get("created_at_dt")
            if start_dt and created_dt and created_dt < start_dt:
                continue
            if end_dt and created_dt and created_dt > end_dt:
                continue
            record = {
                "id": meta.get("id"),
                "query": meta.get("query"),
                "created": meta.get("created"),
                "confidence": meta.get("confidence"),
                "path": str(path),
            }
            if include_summary:
                record["summary"] = meta.get("summary")
            entries.append(record)
            if len(entries) >= limit:
                break
        return {"directory": str(dir_path), "count": len(entries), "dossiers": entries}

    def _extract_dossier_metadata(self, path: Path) -> Optional[dict]:
        try:
            text = path.read_text(encoding="utf-8")
        except Exception:
            return None
        lines = [line.strip() for line in text.splitlines()]
        query = None
        dossier_id = path.stem
        created = None
        confidence = None
        summary = None
        capture_summary = False
        summary_lines: list[str] = []
        def _extract_field(line: str, field: str) -> Optional[str]:
            prefix = f"- **{field}:**"
            if line.startswith(prefix):
                return line[len(prefix):].strip()
            return None

        for line in lines:
            if not query and line.startswith("# "):
                query = line[2:].strip()
                continue
            value = _extract_field(line, "Dossier ID")
            if value:
                dossier_id = value
                continue
            value = _extract_field(line, "Created")
            if value:
                created = value
                continue
            value = _extract_field(line, "Confidence")
            if value:
                confidence = value
                continue
            if line.startswith("## Summary"):
                capture_summary = True
                summary_lines = []
                continue
            if capture_summary:
                if line.startswith("## ") and summary_lines:
                    break
                summary_lines.append(line)
        if capture_summary and summary_lines:
            summary = "\n".join(l for l in summary_lines if l).strip()
        created_dt = None
        if created:
            try:
                created_dt = datetime.fromisoformat(created)
            except ValueError:
                created_dt = None
        return {
            "id": dossier_id,
            "query": query,
            "created": created,
            "created_at_dt": created_dt,
            "confidence": confidence,
            "summary": summary,
        }

    def _load_dossier(self, dossier_id: str) -> dict:
        dir_path = self.dossier_dir
        if not dir_path.exists():
            raise FileNotFoundError(f"Dossier directory not found: {dir_path}")
        matches = list(dir_path.glob(f"{dossier_id}.md"))
        if not matches:
            raise FileNotFoundError(f"Dossier '{dossier_id}' not found in {dir_path}")
        path = matches[0]
        meta = self._extract_dossier_metadata(path) or {}
        content = path.read_text(encoding="utf-8")
        return {
            "path": str(path),
            "id": meta.get("id", dossier_id),
            "query": meta.get("query"),
            "created": meta.get("created"),
            "confidence": meta.get("confidence"),
            "content": content,
        }

    async def _search_book_summaries(self, args: dict[str, Any]) -> dict[str, Any]:
        query = args.get("query")
        if not query:
            raise ValueError("query is required")
        limit = int(args.get("limit", 10) or 10)
        filters: dict[str, Any] = {"source_type": "book"}
        book_title = args.get("book_title")
        if book_title:
            filters["book_title"] = book_title

        results = await semantic_search(
            query,
            embedder=self.orchestrator.embedder,
            indexer=self.orchestrator.indexer,
            limit=limit,
            filters=filters,
        )

        hits = []
        for hit in results:
            summary_path = hit.get("file_path")
            chapter_path = self._derive_chapter_path(summary_path) if summary_path else None
            hits.append(
                {
                    "book_title": hit.get("book_title"),
                    "author": hit.get("author"),
                    "chapter": hit.get("chapter"),
                    "chunk_id": hit.get("chunk_id"),
                    "score": hit.get("score"),
                    "summary_path": summary_path,
                    "chapter_path": str(chapter_path) if chapter_path else None,
                    "text": hit.get("text"),
                }
            )

        return {
            "tool": "search_book_summaries",
            "query": {"query": query, "book_title": book_title, "limit": limit},
            "count": len(hits),
            "results": hits,
        }

    def _read_summary(self, summary_path: str | None) -> dict[str, Any]:
        if not summary_path:
            raise ValueError("summary_path is required")
        path = Path(summary_path)
        text = self._read_text_file(path)
        chapter_path = self._derive_chapter_path(path)
        return {
            "summary_path": str(path),
            "chapter_path": str(chapter_path) if chapter_path else None,
            "summary": text,
        }

    def _read_chapter_text(self, args: dict[str, Any]) -> dict[str, Any]:
        chapter_path = args.get("chapter_path")
        summary_path = args.get("summary_path")
        resolved = Path(chapter_path) if chapter_path else None
        if not resolved and summary_path:
            resolved = self._derive_chapter_path(summary_path)
        if not resolved:
            raise ValueError("Provide chapter_path or summary_path")
        text = self._read_text_file(resolved)
        return {"chapter_path": str(resolved), "content": text}

    def _derive_chapter_path(self, summary_path: str | Path | None) -> Path | None:
        if not summary_path:
            return None
        path = Path(summary_path)
        parts = list(path.parts)
        try:
            idx = parts.index("chapter_summaries")
        except ValueError:
            return None
        parts[idx] = "chapters"
        chapter_path = Path(*parts)
        name = chapter_path.name
        if name.endswith(".summary.txt"):
            chapter_path = chapter_path.with_name(name.replace(".summary", ""))
        elif name.endswith(".summary"):
            chapter_path = chapter_path.with_name(name.replace(".summary", ""))
        return chapter_path

    def _read_text_file(self, path: Path) -> str:
        if not path.exists():
            raise FileNotFoundError(f"File not found: {path}")
        return path.read_text(encoding="utf-8")
