#!/usr/bin/env python3
"""One-shot backfill: embed all existing garden notes into the per-member
sqlite-vec DBs via the normal corpus pipeline.

Why this exists: in production the corpus tool runs in-process in the MCP
gateway with the file watcher OFF and no startup `initial_index`, so embedding
is push-driven (garden re-indexes a note on write/delete). New notes are handled
automatically, but notes that already existed before the push hook was added are
never embedded. This script does that initial sweep.

Idempotent: unchanged notes are skipped via the corpus hash store, so it is safe
to re-run. It mutates the LIVE vector DBs under tools/corpus/data/vectors/ —
prefer running it while the gateway is idle to avoid sqlite write contention.

Usage (via the repo wrapper, which sets PYTHONPATH):
    scripts/backfill_garden_notes.sh [--dry-run]

Or directly:
    PYTHONPATH=<maurice-repo-root> python tools/corpus/scripts/backfill_garden_notes.py [--dry-run]
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import sys
import urllib.request
from collections import Counter
from pathlib import Path

CORPUS_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(CORPUS_DIR))  # resolve `src.*` imports

from src.config import load_config  # noqa: E402
from src.orchestrator import CorpusOrchestrator  # noqa: E402

SOURCE = "garden-notes"


def _ollama_up(base_url: str) -> bool:
    # base_url is the OpenAI-compatible endpoint (…/v1); probe the host root.
    root = base_url.split("/v1")[0].rstrip("/")
    try:
        with urllib.request.urlopen(f"{root}/api/tags", timeout=4):
            return True
    except Exception:
        return False


async def main() -> int:
    ap = argparse.ArgumentParser(description="Backfill garden notes into the corpus vector DBs")
    ap.add_argument("--config", type=Path, default=CORPUS_DIR / "config/corpus.yaml")
    ap.add_argument("--dry-run", action="store_true", help="report the plan; embed nothing")
    ap.add_argument("--verbose", action="store_true", help="log each file's index status")
    args = ap.parse_args()

    logging.basicConfig(
        level=logging.INFO if args.verbose else logging.WARNING,
        format="[%(levelname)s] %(message)s",
    )

    cfg = load_config(args.config)
    src = cfg.sources.get(SOURCE)
    if src is None:
        print(f"error: source {SOURCE!r} is not defined in {args.config}", file=sys.stderr)
        return 2

    orch = CorpusOrchestrator(cfg, vector_size=cfg.embedding.vector_size)

    # Plan: discover files and resolve each to its owning member, mirroring the
    # exact routing index_file() will use.
    files = list(orch._iter_source_files(src))
    by_member: Counter[str] = Counter()
    plan: list[Path] = []
    skipped: list[Path] = []
    for p in files:
        mid = orch._member_for(src, p)
        if src.member_from_path and not mid:
            skipped.append(p)
            continue
        by_member[mid] += 1
        plan.append(p)

    print(f"Discovered {len(files)} note file(s): {len(plan)} indexable, {len(skipped)} skipped (no member).")
    for mid, n in sorted(by_member.items(), key=lambda kv: -kv[1]):
        print(f"  • {mid}: {n}")
    if skipped:
        print(f"  skipped {len(skipped)} file(s) whose garden user has no maurice.db account:")
        for p in skipped[:10]:
            print(f"    - {p}")
        if len(skipped) > 10:
            print(f"    … and {len(skipped) - 10} more")

    if args.dry_run:
        print("\nDry run — nothing embedded.")
        return 0

    if not _ollama_up(cfg.embedding.base_url or ""):
        print(
            f"\nerror: embedding backend not reachable at {cfg.embedding.base_url} "
            f"(model {cfg.embedding.model}). Start Ollama and retry.",
            file=sys.stderr,
        )
        return 3

    print(f"\nEmbedding via {cfg.embedding.model} @ {cfg.embedding.base_url} …")
    total = len(plan)
    for i, p in enumerate(plan, start=1):
        await orch.index_file(p, SOURCE, src)  # idempotent; logs/skips internally
        if i % 20 == 0 or i == total:
            print(f"  {i}/{total}")

    # Report resulting note-chunk counts per member.
    print("\nNote chunks now indexed per member:")
    for mid in sorted(by_member):
        try:
            n = orch.indexer.count(where={"source_type": "note"}, member_id=mid)
        except Exception as exc:  # noqa: BLE001
            n = f"(count failed: {exc})"
        print(f"  • {mid}: {n}")

    print("\nBackfill complete.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(asyncio.run(main()))
    except KeyboardInterrupt:
        print("\nInterrupted — partial progress is saved; re-run to resume.", file=sys.stderr)
        raise SystemExit(130)
