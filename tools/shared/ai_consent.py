"""A member's answer about AI providers, read from maurice.db.

The server keeps it (server/src/services/aiConsent.ts, table `ai_consent`):
a member who said no, or whose yes does not name a provider, has nothing of
theirs sent to that provider. The corpus asks before it embeds a member's
notes and conversations with a provider outside the house. A member with no
answer on file is let through, as the server does.
"""

from __future__ import annotations

import json
import os
import sqlite3
from pathlib import Path
from typing import Optional


def _maurice_db() -> Path:
    return Path(os.environ.get("MAURICE_DATA_DIR") or (Path.home() / ".maurice")) / "maurice.db"


def allowed(member_id: Optional[str], provider: Optional[str]) -> bool:
    """May this member's data go to this provider? None provider = local."""
    if not member_id or not provider:
        return True
    db = _maurice_db()
    if not db.exists():
        return True
    try:
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        try:
            row = con.execute(
                "SELECT status, providers FROM ai_consent WHERE user_id = ?", (member_id,)
            ).fetchone()
        finally:
            con.close()
    except sqlite3.Error:
        # A database that predates the table has no answers in it.
        return True
    if not row:
        return True
    status, providers = row
    if status != "accepted":
        return False
    try:
        return provider in (json.loads(providers) or [])
    except (TypeError, ValueError):
        return False
