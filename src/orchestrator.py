"""Orchestrates sources, watcher, processor, embeddings, and indexing."""

from __future__ import annotations

import asyncio
import fnmatch
import logging
from pathlib import Path
from typing import Dict, Iterable, List, Optional

from .config import CorpusConfig, SourceConfig
from .embedder import Embedder
from .store import make_store
from .processor import process_file, remove_file
from .hash_store import HashStore
from datetime import datetime, timezone

from .conversations import MauriceConversations
from .chat_import import ChatArchiveImporter, ImportHistoryStore, ImportRun, PROVIDERS, new_job, job_status
from .watcher import SourceContext, Watcher

import sys as _sys
_repo_root = str(Path(__file__).resolve().parents[3])
if _repo_root not in _sys.path:
    _sys.path.insert(0, _repo_root)
from tools.shared.context import member_id_var


class CorpusOrchestrator:
    def __init__(self, config: CorpusConfig, vector_size: int) -> None:
        self.config = config
        self.embedder = Embedder(config.embedding)
        # `indexer` holds a VectorStore (Qdrant today; sqlite-vec in Phase 2).
        self.indexer = make_store(config, vector_size=vector_size)
        state_path = Path(__file__).resolve().parents[1] / "data" / "index_state.db"
        self.hash_store = HashStore(state_path)
        self.watcher: Watcher | None = None
        self.tasks: Dict[Path, asyncio.Task] = {}
        self.logger = logging.getLogger(__name__)
        self.ignore_patterns = config.watcher.ignore_patterns
        self.conversations = MauriceConversations()
        data_dir = Path(__file__).resolve().parents[1] / "data"
        self.import_history = ImportHistoryStore(data_dir / "import_history.db")
        self.archive_importer = ChatArchiveImporter()  # writes maurice.db conversations

    def start_import(
        self,
        path: str,
        *,
        provider: str = "anthropic",
        member_id: Optional[str] = None,
        since: Optional[str] = None,
    ) -> Dict[str, object]:
        """Start a chat-export import (provider: anthropic|chatgpt) in the background.

        Creates a real maurice.db conversation per external conversation (incremental
        from the member+provider watermark), then search-indexes each via the Phase 4
        reconcile. Progress is polled via import_status."""
        mid = member_id or member_id_var.get()
        if not mid:
            raise ValueError("member_id is required to import a chat export")
        prov = PROVIDERS.get(provider)
        if prov is None:
            raise ValueError(f"unknown provider: {provider!r}")
        eff_since = since if since is not None else self.import_history.watermark(mid, provider)
        job = new_job(mid, provider)
        run_id = f"imp_{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S')}_{job['job_id'][-6:]}"
        ran_at = datetime.now(timezone.utc).isoformat()

        async def run() -> None:
            try:
                plan = await asyncio.to_thread(
                    self.archive_importer.create_conversations,
                    Path(path), member_id=mid, provider=prov, since=eff_since,
                )
                job.update(phase="indexing", total=len(plan.window_ids), done=0)
                for i, cid in enumerate(plan.window_ids):
                    try:
                        await self.conversations.reconcile_conversation(
                            cid, store=self.indexer, embedder=self.embedder
                        )
                    except Exception:  # noqa: BLE001 — index failure shouldn't lose the conversation
                        self.logger.exception("search-indexing failed for conversation %s", cid)
                    job.update(done=i + 1)
                self.import_history.record(ImportRun(
                    id=run_id, member_id=mid, provider=provider,
                    range_from=plan.range_from, range_to=plan.range_to,
                    conversations=plan.created, messages=plan.messages, ran_at=ran_at, status="done",
                ))
                job.update(phase="done", status="done", result={
                    "conversations": plan.created, "messages": plan.messages,
                    "range_from": plan.range_from, "range_to": plan.range_to,
                })
            except Exception as exc:  # noqa: BLE001
                self.logger.exception("%s import job %s failed", provider, job["job_id"])
                # range_to=None → watermark stays put; the run is logged as failed.
                self.import_history.record(ImportRun(
                    id=run_id, member_id=mid, provider=provider, range_from=eff_since, range_to=None,
                    conversations=0, messages=0, ran_at=ran_at, status="failed",
                ))
                job.update(phase="error", status="failed", error=str(exc))

        asyncio.create_task(run())
        return {"job_id": job["job_id"], "provider": provider}

    def import_status(self, job_id: str) -> Dict[str, object]:
        """Poll an import job's progress (phase, done, total, result/error)."""
        return job_status(job_id) or {"error": "unknown job", "job_id": job_id}

    def get_import_history(self, member_id: Optional[str] = None, provider: str = "anthropic") -> Dict[str, object]:
        """Return a member+provider import run log (newest first) + the sync watermark."""
        mid = member_id or member_id_var.get()
        if not mid:
            raise ValueError("member_id is required to read import history")
        return {
            "member_id": mid,
            "provider": provider,
            "watermark": self.import_history.watermark(mid, provider),
            "history": self.import_history.history(mid, provider),
        }

    async def index_conversations(self, conversation_id: Optional[str] = None) -> Dict[str, int]:
        """Reconcile Maurice conversations into the per-member vector DBs.

        With a conversation_id, reconciles just that room (the post-turn hot path);
        otherwise reconciles every conversation (backfill)."""
        if not self.conversations.available():
            self.logger.warning("maurice.db not found at %s — skipping conversations", self.conversations.db_path)
            return {"conversations": 0, "chunks_written": 0}
        if conversation_id:
            written = await self.conversations.reconcile_conversation(
                conversation_id, store=self.indexer, embedder=self.embedder
            )
            return {"conversations": 1, "chunks_written": written}
        return await self.conversations.reconcile_all(store=self.indexer, embedder=self.embedder)

    async def index_file(self, path: Path, source_name: str, source_config: SourceConfig) -> None:
        if self._should_ignore(path) or not self._matches_source(source_config, path):
            return
        try:
            written = await process_file(
                path,
                source_name,
                source_config,
                self.embedder,
                self.indexer,
                self.hash_store,
            )
            if written:
                self.logger.info("Indexed %s (%s)", path, source_name)
            else:
                self.logger.debug("Up-to-date %s (%s)", path, source_name)
        except FileNotFoundError:
            self.logger.warning("File disappeared before indexing: %s", path)
        except Exception as exc:  # noqa: BLE001
            self.logger.error("Failed to index %s: %s", path, exc)

    async def initial_index(self, sources: Optional[List[str]] = None) -> None:
        names = sources or list(self.config.sources.keys())
        for name in names:
            if name not in self.config.sources:
                self.logger.warning("Unknown source '%s' skipped", name)
                continue
            source = self.config.sources[name]
            files = self._iter_source_files(source)
            for path in files:
                await self.index_file(path, name, source)

    def start_watching(self) -> None:
        if self.watcher is None:
            loop = asyncio.get_running_loop()
            self.watcher = Watcher(loop)
            for name, source in self.config.sources.items():
                ctx = SourceContext(
                    name=name,
                    root=source.path,
                    recursive=source.recursive,
                    debounce=self.config.watcher.debounce_seconds,
                )

                def callback(event_type: str, path: Path, *, source_name=name, cfg=source) -> None:
                    if self._should_ignore(path) or not self._matches_source(cfg, path):
                        return
                    if event_type == "deleted":
                        remove_file(path, self.indexer, self.hash_store)
                        return

                    async def run() -> None:
                        await self.index_file(path, source_name, cfg)

                    asyncio.create_task(run())

                self.watcher.add_watch(ctx, callback)
        self.watcher.start()

    def stop_watching(self) -> None:
        if self.watcher:
            self.watcher.stop()

    def _should_ignore(self, path: Path) -> bool:
        for pattern in self.ignore_patterns:
            if fnmatch.fnmatch(path.name, pattern) or fnmatch.fnmatch(str(path), pattern):
                return True
        return False

    def _matches_source(self, cfg: SourceConfig, path: Path) -> bool:
        try:
            rel = path.relative_to(cfg.path)
        except ValueError:
            return False
        pattern = cfg.pattern or "**/*"

        # pathlib.Path.match("**/*.ext") does not match files that live directly under
        # the watched root (it expects at least one directory). That breaks sources
        # whose files sit at the root, such as research dossiers. To keep the glob
        # semantics consistent with Path.glob (which *does* return those files), we
        # try both the original pattern and, when it starts with "**/", a version
        # without that prefix so "*.md" also matches root-level files.
        if rel.match(pattern):
            return True
        if pattern.startswith("**/"):
            return rel.match(pattern[3:])
        return False

    def _iter_source_files(self, cfg: SourceConfig) -> Iterable[Path]:
        iterator: Iterable[Path]
        pattern = cfg.pattern or "**/*"
        iterator = (cfg.path.glob(pattern))
        for path in iterator:
            if not path.is_file():
                continue
            if self._should_ignore(path) or not self._matches_source(cfg, path):
                continue
            yield path
