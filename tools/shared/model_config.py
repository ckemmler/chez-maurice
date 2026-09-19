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


# ---------------------------------------------------------------------------
# Running a turn
# ---------------------------------------------------------------------------
# Resolving a model was only half a promise. Every tool then built its own
# `anthropic.Anthropic` client around the id it got back, so a household that
# had chosen a Scaleway or Mistral model saw that id sent to api.anthropic.com
# and refused there — and a household with no Anthropic key could not run these
# functions at all, whatever the admin had chosen for them.
#
# `complete()` hands the turn to the server instead, which knows the provider,
# the key and the base URL, and dispatches through the same backends the chat
# uses (server/src/routes/ancillary.ts). The tools keep no key and no SDK. That
# route answers loopback only, which is where these tools run: beside the
# database they already read directly.


class AncillaryUnavailable(RuntimeError):
    """The server did not run the turn. The caller decides what to do."""


def _server_bases() -> list[str]:
    """Where this household's server might be listening, best first.

    The scheme is not a constant: the Mac install serves TLS from its own
    certificate, while a container is plain HTTP behind Caddy. Rather than ask
    every caller to know which, try both on loopback and keep the one that
    answers. `MAURICE_API_BASE` settles it for an unusual install.
    """
    base = os.environ.get("MAURICE_API_BASE")
    if base:
        return [base.rstrip("/")]
    port = os.environ.get("PORT") or "3001"
    return [f"https://127.0.0.1:{port}", f"http://127.0.0.1:{port}"]


_server_base_cache: str | None = None


def complete(
    invocation: str,
    prompt: str,
    *,
    system: str | None = None,
    max_tokens: int = 1024,
    temperature: float | None = None,
    timeout: float = 120.0,
) -> str:
    """Run one ancillary turn on whatever model the admin chose for it.

    Returns the text. Raises AncillaryUnavailable when the server is not there
    or refuses — never falls back to a provider of its own, because a silent
    fallback is how these tools ended up pinned to one vendor to begin with.
    """
    return complete_full(
        invocation, prompt, system=system, max_tokens=max_tokens, temperature=temperature, timeout=timeout
    )["text"]


def complete_full(
    invocation: str,
    prompt: str,
    *,
    system: str | None = None,
    max_tokens: int = 1024,
    temperature: float | None = None,
    timeout: float = 120.0,
    model: str | None = None,
) -> dict:
    """The same turn, with everything the server said about it: `text`,
    `model`, `provider`, `stop`, and `usage` (tokens and cost in dollars, or
    None when the provider reported none). `model` runs the turn on that
    model instead of the invocation's pin — for an experiment that compares
    models, never for a tool to choose its own."""
    global _server_base_cache
    import json
    import ssl
    import urllib.error
    import urllib.request

    payload: dict[str, object] = {
        "invocation": invocation,
        "prompt": prompt,
        "max_tokens": max_tokens,
    }
    if system is not None:
        payload["system"] = system
    if temperature is not None:
        payload["temperature"] = temperature
    if model is not None:
        payload["model"] = model

    # Loopback to a server whose certificate is its own: verifying it would
    # mean trusting a name we already know is this machine.
    loopback_tls = ssl.create_default_context()
    loopback_tls.check_hostname = False
    loopback_tls.verify_mode = ssl.CERT_NONE

    bases = [_server_base_cache] if _server_base_cache else _server_bases()
    last: Exception | None = None
    for base in bases:
        req = urllib.request.Request(
            f"{base}/api/ancillary",
            data=json.dumps(payload).encode(),
            # Host says loopback because that is what this is; the server
            # refuses anything else on this route.
            headers={"Content-Type": "application/json", "Host": "localhost"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout, context=loopback_tls) as resp:
                body = json.loads(resp.read().decode())
            _server_base_cache = base
            break
        except urllib.error.HTTPError as exc:  # it answered, with a refusal
            detail = exc.read().decode(errors="replace")[:200]
            raise AncillaryUnavailable(f"{invocation}: server said {exc.code} — {detail}") from exc
        except OSError as exc:  # not there, wrong scheme, socket gone
            last = exc
    else:
        raise AncillaryUnavailable(f"{invocation}: no server on loopback ({last})")

    text = (body or {}).get("text")
    if not isinstance(text, str) or not text.strip():
        raise AncillaryUnavailable(f"{invocation}: server returned no text")
    body["text"] = text.strip()
    return body
