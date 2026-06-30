#!/usr/bin/env python3
"""Backfill short titles for existing deep_research dossiers using Haiku."""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

# Add project root to path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools" / "pipelines" / "research_tracks"))

from research_tracks.config import load_config
from research_tracks.providers import create_provider
from research_tracks.providers.base import LLMMessage
from research_tracks.store import AkitaStore

LOGGER = logging.getLogger(__name__)


def generate_title(provider, command_text: str, *, model: str | None = None) -> str:
    messages = [
        LLMMessage(
            role="system",
            content=(
                "You are a title generator. Given a research query, output a short title "
                "(max 8 words). Output ONLY the title on a single line. No markdown, no "
                "headers, no explanation, no punctuation except what's in the title itself."
            ),
        ),
        LLMMessage(role="user", content=command_text[:300]),
    ]
    raw = provider.complete(messages, max_tokens=30, temperature=0.0, model=model)
    title = raw.strip().strip("\"'#").strip()
    title = title.split("\n")[0].strip().strip("\"'#").strip()
    if title and len(title.split()) <= 12:
        return title[:120]
    return command_text[:80]


def main() -> None:
    parser = argparse.ArgumentParser(description="Backfill dossier titles via Haiku")
    parser.add_argument("--dry-run", action="store_true", help="Preview without writing")
    parser.add_argument("--config", type=str, default=None, help="Path to akita config")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(message)s")

    config = load_config(args.config)
    provider = create_provider(config.llm)
    if not provider.available:
        LOGGER.error("LLM provider not available")
        sys.exit(1)

    title_model = config.resolve_model("dossier_title")
    store = AkitaStore(Path(config.database.path).expanduser())
    dossiers = store.list_dossiers(dossier_type="deep_research", limit=500)
    LOGGER.info("Found %d deep_research dossiers", len(dossiers))

    for d in dossiers:
        old_title = d["title"]
        try:
            new_title = generate_title(provider, old_title, model=title_model)
        except Exception as exc:
            LOGGER.warning("  SKIP %s: %s", d["id"], exc)
            continue

        if args.dry_run:
            LOGGER.info("  [DRY] %s: %s -> %s", d["id"], old_title[:60], new_title)
        else:
            store.update_dossier_title(d["id"], new_title)
            LOGGER.info("  OK %s: %s -> %s", d["id"], old_title[:60], new_title)

    store.close()
    LOGGER.info("Done.")


if __name__ == "__main__":
    main()
