"""Centralized config loader for Maurice Python tools.

Resolution order:
  1. Environment variables (MAURICE_DATA_DIR, AKITA_TIMEZONE)
  2. ~/.maurice/config.toml

No repo-relative fallback — always requires config.toml or env vars.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

_config: dict[str, Any] | None = None


def _load_toml(path: Path) -> dict[str, Any]:
    """Load TOML using stdlib tomllib (3.11+), fall back to tomli."""
    try:
        import tomllib
    except ModuleNotFoundError:
        import tomli as tomllib  # type: ignore[no-redef]
    with open(path, "rb") as f:
        return tomllib.load(f)


def get_config() -> dict[str, Any]:
    """Return the parsed config (cached)."""
    global _config
    if _config is not None:
        return _config

    config_path = Path(
        os.environ.get("MAURICE_CONFIG", Path.home() / ".maurice" / "config.toml")
    )
    if config_path.exists():
        _config = _load_toml(config_path)
    else:
        _config = {}
    return _config


def get_data_dir() -> Path:
    """Return the data directory path."""
    if os.environ.get("MAURICE_DATA_DIR"):
        return Path(os.environ["MAURICE_DATA_DIR"])
    cfg = get_config()
    paths = cfg.get("paths", {})
    if paths.get("data_dir"):
        return Path(paths["data_dir"])
    raise RuntimeError(
        "Maurice data_dir not configured. "
        "Set MAURICE_DATA_DIR or create ~/.maurice/config.toml with [paths] data_dir."
    )


def get_db_path(name: str) -> Path:
    """Return full path to a database file inside data_dir."""
    return get_data_dir() / name


def get_gardens_dir() -> Path:
    """Return the gardens content root (layout: <root>/<member>/notes/<locale>/…).

    Resolution order:
      1. MAURICE_GARDENS_DIR env
      2. config.toml [paths] gardens_dir
      3. dev fallback: the repo's web/gardens, if present (keeps a source checkout
         and the multi-instance test setup working with no config)
      4. ~/.maurice/gardens (the production default; provisioned by postinstall)
    """
    if os.environ.get("MAURICE_GARDENS_DIR"):
        return Path(os.environ["MAURICE_GARDENS_DIR"])
    paths = get_config().get("paths", {})
    if paths.get("gardens_dir"):
        return Path(paths["gardens_dir"])
    repo_gardens = Path(__file__).resolve().parents[2] / "web" / "gardens"
    if repo_gardens.is_dir():
        return repo_gardens
    return Path.home() / ".maurice" / "gardens"


def get_secret(name: str, *, env: str | None = None) -> str | None:
    """Resolve a secret: the env var (explicit `env`, else NAME.upper()) first,
    then config.toml [secrets].<name>. Returns None when unset. Keeps secrets out
    of launchd plists — set them in config.toml's [secrets] table or the env."""
    env_key = env or name.upper()
    if os.environ.get(env_key):
        return os.environ[env_key]
    val = get_config().get("secrets", {}).get(name)
    return str(val) if val else None


def get_timezone() -> str:
    """Return configured timezone."""
    if os.environ.get("AKITA_TIMEZONE"):
        return os.environ["AKITA_TIMEZONE"]
    cfg = get_config()
    general = cfg.get("general", {})
    return general.get("timezone", "Europe/Paris")
