#!/usr/bin/env python3
"""One-off migration: copy every Qdrant point into per-member sqlite-vec DBs.

Vectors and payloads are moved verbatim (no re-embedding, no drift), so orphaned
content with no live source — e.g. the historical `report` chunks — survives.
Points are routed to `<vectors_dir>/<member>.db` by their payload `member_id`
(absent → `_default.db`). Qdrant is read-only here; nothing is deleted.

Usage:
    AKITA_CORPUS_CONFIG=.../corpus.yaml python migrate_qdrant_to_sqlite.py [--batch 1000]
"""

from __future__ import annotations

import argparse
import logging
from collections import defaultdict
from pathlib import Path

from src.config import load_config
from src.indexer import QdrantStore
from src.sqlite_vec_store import SqliteVecStore

_LOG = logging.getLogger("migrate")


def _record(point) -> dict:
    payload = dict(point.payload or {})
    return {
        "member_id": payload.get("member_id"),
        "chunk_id": str(point.id),
        "unit_key": payload.get("file_path"),
        "unit_hash": payload.get("file_hash"),
        "source_type": payload.get("source_type"),
        "payload": payload,
        "vector": point.vector,
    }


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="[%(levelname)s] %(message)s")
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=Path("config/corpus.yaml"), type=Path)
    ap.add_argument("--batch", type=int, default=1000)
    args = ap.parse_args()

    cfg = load_config(args.config)
    vector_size = cfg.embedding.vector_size
    vectors_dir = cfg.store.path or (Path(__file__).resolve().parent / "data" / "vectors")

    qd = QdrantStore(cfg.qdrant, vector_size=vector_size)
    dest = SqliteVecStore(vectors_dir=vectors_dir, vector_size=vector_size, embedding_model=cfg.embedding.model)
    _LOG.info("Migrating Qdrant collection %r → %s", qd.collection, vectors_dir)

    total = 0
    by_member: dict = defaultdict(int)
    next_page = None
    while True:
        points, next_page = qd.client.scroll(
            collection_name=qd.collection,
            limit=args.batch,
            with_vectors=True,
            with_payload=True,
            offset=next_page,
        )
        if not points:
            break
        grouped: dict = defaultdict(list)
        for p in points:
            rec = _record(p)
            grouped[rec["member_id"]].append(rec)
        for member, recs in grouped.items():
            n = dest.bulk_load(recs, member_id=member)
            by_member[member or "_default"] += n
            total += n
        _LOG.info("… %d migrated", total)
        if next_page is None:
            break

    dest.close()
    _LOG.info("Done: %d chunks across %d member DB(s)", total, len(by_member))
    for member, n in sorted(by_member.items()):
        _LOG.info("  %s: %d", member, n)


if __name__ == "__main__":
    main()
