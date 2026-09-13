"""Resolve an invocation name (dossier_title, book_classification…) to a model.

The admin decides. Since 2026-09-13 the server keeps an `ancillary_models`
table in maurice.db — one row per invocation the admin has pinned — and a
household-level `ancillary_model` that every unpinned invocation runs on
(server/src/services/ancillary.ts is the reference). This module reads those,
read-only, the way the tools already read calibre_libraries and the API keys.

models.yml stays as the last resort for a checkout with no database at all —
a standalone script, a fresh clone — and the `fallback` argument below that.
"""
from __future__ import annotations

import os
import sqlite3
from pathlib import Path

import yaml

_CONFIG_PATH = Path(__file__).resolve().parents[2] / "models.yml"


def _maurice_db() -> Path:
    # maurice.db sits in the app dir, not under [paths] data_dir — the same
    # resolution the server's lib/appDir.ts uses.
    return Path(os.environ.get("MAURICE_DATA_DIR") or (Path.home() / ".maurice")) / "maurice.db"


def _from_admin(invocation: str) -> str | None:
    """The pinned model, else the household's ancillary model; None if the
    database is unreachable or predates the table."""
    db = _maurice_db()
    if not db.exists():
        return None
    try:
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        try:
            row = con.execute(
                "SELECT model_id FROM ancillary_models WHERE invocation = ?", (invocation,)
            ).fetchone()
            if row and row[0]:
                return row[0]
            row = con.execute(
                "SELECT ancillary_model FROM households WHERE id = 'default'"
            ).fetchone()
            return row[0] if row and row[0] else None
        finally:
            con.close()
    except sqlite3.Error:
        return None


def _from_yaml(invocation: str) -> str | None:
    if not _CONFIG_PATH.exists():
        return None
    with _CONFIG_PATH.open() as f:
        data = yaml.safe_load(f) or {}
    models = data.get("models", {})
    alias = data.get("model_assignments", {}).get(invocation)
    if alias:
        return models.get(alias, alias)
    return None


def resolve_model(invocation: str, fallback: str = "claude-sonnet-4-5-20250929") -> str:
    """Admin's choice first, then models.yml, then the caller's fallback."""
    return _from_admin(invocation) or _from_yaml(invocation) or fallback
