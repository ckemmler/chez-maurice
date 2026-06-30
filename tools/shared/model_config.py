"""Thin helper to resolve model aliases from akita.yml.

Used by standalone scripts that don't load the full AkitaConfig.
"""
from __future__ import annotations

from pathlib import Path

import yaml

_CONFIG_PATH = Path(__file__).resolve().parents[2] / "models.yml"


def resolve_model(invocation: str, fallback: str = "claude-sonnet-4-5-20250929") -> str:
    """Resolve an invocation name to a concrete model ID via akita.yml."""
    if not _CONFIG_PATH.exists():
        return fallback
    with _CONFIG_PATH.open() as f:
        data = yaml.safe_load(f) or {}
    models = data.get("models", {})
    assignments = data.get("model_assignments", {})
    alias = assignments.get(invocation)
    if alias:
        return models.get(alias, alias)
    return fallback
