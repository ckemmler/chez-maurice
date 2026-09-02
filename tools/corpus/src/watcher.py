"""Filesystem watcher for akita-corpus."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Dict

from watchdog.events import FileSystemEventHandler, FileCreatedEvent, FileModifiedEvent, FileDeletedEvent
from watchdog.observers import Observer


@dataclass
class SourceContext:
    name: str
    root: Path
    recursive: bool
    debounce: float


class DebouncedHandler(FileSystemEventHandler):
    def __init__(
        self,
        callback: Callable[[str, Path], None],
        context: SourceContext,
        loop: asyncio.AbstractEventLoop,
    ) -> None:
        self.callback = callback
        self.context = context
        self.loop = loop
        self._tasks: Dict[Path, asyncio.Task] = {}

    def on_created(self, event):
        if isinstance(event, FileCreatedEvent) and not event.is_directory:
            self._schedule("created", Path(event.src_path))

    def on_modified(self, event):
        if isinstance(event, FileModifiedEvent) and not event.is_directory:
            self._schedule("modified", Path(event.src_path))

    def on_deleted(self, event):
        if isinstance(event, FileDeletedEvent) and not event.is_directory:
            self._invoke("deleted", Path(event.src_path))

    def _schedule(self, event_type: str, path: Path) -> None:
        def start_task() -> None:
            existing = self._tasks.get(path)
            if existing:
                existing.cancel()

            async def debounce() -> None:
                try:
                    await asyncio.sleep(self.context.debounce)
                    self.callback(event_type, path)
                finally:
                    self._tasks.pop(path, None)

            self._tasks[path] = self.loop.create_task(debounce())

        self.loop.call_soon_threadsafe(start_task)

    def _invoke(self, event_type: str, path: Path) -> None:
        def runner() -> None:
            self.callback(event_type, path)

        self.loop.call_soon_threadsafe(runner)


class Watcher:
    def __init__(self, loop: asyncio.AbstractEventLoop) -> None:
        self.observer = Observer()
        self.loop = loop
        self._started = False

    def add_watch(self, source: SourceContext, callback: Callable[[str, Path], None]) -> None:
        handler = DebouncedHandler(callback, source, self.loop)
        self.observer.schedule(handler, str(source.root), recursive=source.recursive)

    def start(self) -> None:
        if not self._started:
            self.observer.start()
            self._started = True

    def stop(self) -> None:
        if self._started:
            self.observer.stop()
            self.observer.join()
            self._started = False
