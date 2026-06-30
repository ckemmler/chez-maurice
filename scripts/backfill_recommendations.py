#!/usr/bin/env python3
"""Backfill recommendation database from existing report JSON files."""

import importlib
import importlib.util
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]

# Import recommendation_store directly to avoid the package __init__.py
# which pulls in dotenv and other heavy dependencies.
_mod_path = REPO_ROOT / "tools/pipelines/research_tracks/research_tracks/recommendation_store.py"
spec = importlib.util.spec_from_file_location("recommendation_store", _mod_path)
_mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
spec.loader.exec_module(_mod)  # type: ignore[union-attr]
RecommendationStore = _mod.RecommendationStore


def main():
    db_path = REPO_ROOT / "data" / "recommendations.db"
    store = RecommendationStore(db_path)
    tracks_root = REPO_ROOT / "tracks"

    count = 0
    for json_file in sorted(tracks_root.glob("*/reports/*.json")):
        track_id = json_file.parent.parent.name
        plan_id = json_file.stem
        try:
            data = json.loads(json_file.read_text())
        except (json.JSONDecodeError, OSError):
            continue
        for art in data.get("articles", []):
            if art.get("type") in ("recommendation", "curated-list"):
                url = art.get("url")
                if url:
                    store.insert_article(
                        url=url,
                        title=art.get("title", ""),
                        summary=art.get("summary"),
                        track_id=track_id,
                        plan_id=plan_id,
                        og_image=art.get("og_image"),
                        og_title=art.get("og_title"),
                        og_description=art.get("og_description"),
                        og_site_name=art.get("og_site_name"),
                    )
                    count += 1
    print(f"Backfilled {count} article recommendations into {db_path}")


if __name__ == "__main__":
    main()
