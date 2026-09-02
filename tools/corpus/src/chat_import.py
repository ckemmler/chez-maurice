"""Import an external chat-export archive (Anthropic / OpenAI) into Maurice.

Each external conversation becomes a real `maurice.db` conversation owned by the
member, marked `origin = '<provider>'` (so the app badges it), using the export's
own conversation/message ids as the row ids — trivial dedup (row exists → skip),
and the existing live-conversation reconcile makes them searchable. We only WRITE
conversations/participants/messages here; embedding is downstream (orchestrator).

Imports are incremental per `(member, provider)`: a run only ingests conversations
newer than that provider's last-sync watermark and records an `ImportRun`
(watermark = latest *successful* run's `range_to`; a failed run is logged but does
not advance it).

Provider differences live in the parsers:
  - Anthropic: a flat `chat_messages` list per conversation.
  - OpenAI (ChatGPT): a `mapping` tree; the active thread is the parent-chain from
    `current_node` back to the root.
Both export a `conversations.json` inside the `.zip`.
"""

from __future__ import annotations

import json
import logging
import os
import re
import sqlite3
import uuid as _uuid
import zipfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional
from pathlib import Path

_LOG = logging.getLogger(__name__)


# ── in-process import-job registry ────────────────────────────────────────────
_JOBS: Dict[str, Dict[str, Any]] = {}


def new_job(member_id: str, provider: str) -> Dict[str, Any]:
    job_id = f"job_{_uuid.uuid4().hex[:12]}"
    job = {"job_id": job_id, "member_id": member_id, "provider": provider,
           "phase": "parsing", "done": 0, "total": 0, "status": "running"}
    _JOBS[job_id] = job
    return job


def job_status(job_id: str) -> Optional[Dict[str, Any]]:
    return _JOBS.get(job_id)


# ── normalized shapes (provider-agnostic) ─────────────────────────────────────

@dataclass
class _ParsedMsg:
    id: str
    role: str            # 'user' | 'assistant'
    text: str
    created: Optional[datetime]


@dataclass
class _ParsedConvo:
    id: str
    title: str
    created: Optional[datetime]
    updated: Optional[datetime]
    messages: List[_ParsedMsg] = field(default_factory=list)


# ── timestamp helpers ─────────────────────────────────────────────────────────

def _parse_iso(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return None


def _parse_unix(value: Any) -> Optional[datetime]:
    if value is None:
        return None
    try:
        return datetime.fromtimestamp(float(value), tz=timezone.utc)
    except (ValueError, OSError, TypeError):
        return None


def _server_ts(dt: Optional[datetime]) -> Optional[str]:
    """A datetime → maurice.db's naive-UTC 'YYYY-MM-DD HH:MM:SS' format."""
    if dt is None:
        return None
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc)
    return dt.strftime("%Y-%m-%d %H:%M:%S")


# ── provider parsers ──────────────────────────────────────────────────────────

def _anthropic_text(message: Dict[str, Any]) -> str:
    # The export duplicates the body across `text` and `content[].text`; prefer blocks.
    blocks = "".join(
        b.get("text", "") or ""
        for b in (message.get("content") or [])
        if isinstance(b, dict) and b.get("type") == "text"
    ).strip()
    return blocks or (message.get("text") or "").strip()


def parse_anthropic(conversations: List[Dict[str, Any]]) -> List[_ParsedConvo]:
    out: List[_ParsedConvo] = []
    for c in conversations:
        msgs: List[_ParsedMsg] = []
        for m in (c.get("chat_messages") or []):
            sender = m.get("sender")
            if sender not in ("human", "assistant"):
                continue
            text = _anthropic_text(m)
            if not text:
                continue
            msgs.append(_ParsedMsg(
                id=m.get("uuid") or str(_uuid.uuid4()),
                role="user" if sender == "human" else "assistant",
                text=text,
                created=_parse_iso(m.get("created_at")),
            ))
        if not msgs:
            continue
        out.append(_ParsedConvo(
            id=c.get("uuid") or c.get("id") or str(_uuid.uuid4()),
            title=c.get("name") or "",
            created=_parse_iso(c.get("created_at")),
            updated=_parse_iso(c.get("updated_at")),
            messages=msgs,
        ))
    return out


def _openai_text(message: Dict[str, Any]) -> str:
    content = message.get("content") or {}
    parts = content.get("parts") or []
    # parts are usually strings; multimodal parts are dicts (image refs) — skip those.
    return "\n".join(p for p in parts if isinstance(p, str) and p).strip()


def parse_openai(conversations: List[Dict[str, Any]]) -> List[_ParsedConvo]:
    """ChatGPT export: each conversation is a `mapping` of node_id → {message, parent}.
    The active thread is the parent-chain from `current_node` back to the root."""
    out: List[_ParsedConvo] = []
    for c in conversations:
        mapping = c.get("mapping") or {}
        node_id = c.get("current_node")
        chain: List[Dict[str, Any]] = []
        seen: set = set()
        while node_id and node_id in mapping and node_id not in seen:
            seen.add(node_id)
            node = mapping[node_id]
            msg = node.get("message")
            if msg:
                chain.append(msg)
            node_id = node.get("parent")
        chain.reverse()  # root → leaf
        msgs: List[_ParsedMsg] = []
        for m in chain:
            role = (m.get("author") or {}).get("role")
            if role not in ("user", "assistant"):
                continue
            text = _openai_text(m)
            if not text:
                continue
            msgs.append(_ParsedMsg(
                id=m.get("id") or str(_uuid.uuid4()),
                role=role,
                text=text,
                created=_parse_unix(m.get("create_time")),
            ))
        if not msgs:
            continue
        out.append(_ParsedConvo(
            id=c.get("conversation_id") or c.get("id") or str(_uuid.uuid4()),
            title=c.get("title") or "",
            created=_parse_unix(c.get("create_time")),
            updated=_parse_unix(c.get("update_time")),
            messages=msgs,
        ))
    return out


@dataclass
class Provider:
    key: str                  # also the conversations.origin value
    label: str                # human name, for messages/UI
    parse: Callable[[List[Dict[str, Any]]], List[_ParsedConvo]]
    model_label: str          # messages.model tag for assistant rows


PROVIDERS: Dict[str, Provider] = {
    "anthropic": Provider("anthropic", "Anthropic", parse_anthropic, "claude"),
    "chatgpt": Provider("chatgpt", "ChatGPT", parse_openai, "gpt"),
}


def _is_conversations_member(name: str) -> bool:
    """True for the export's conversation file(s). Matches both the single-file
    `conversations.json` layout and the sharded `conversations-000.json` layout
    that large ChatGPT exports use — but NOT the decoy `shared_conversations.json`
    (a stub list of shared-link metadata with no message `mapping`)."""
    base = Path(name).name
    return base == "conversations.json" or bool(re.fullmatch(r"conversations-\d+\.json", base))


def load_conversations(export_path: Path) -> List[Dict[str, Any]]:
    """Read the conversation list from a .zip export, a bare .json, or an export dir.
    Both the Anthropic and OpenAI exports ship a `conversations.json`; large ChatGPT
    exports shard it into `conversations-000.json`, `conversations-001.json`, …, which
    are concatenated here in order."""
    path = Path(export_path)
    if path.is_dir():
        path = path / "conversations.json"
    if path.suffix == ".zip" or zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as zf:
            names = sorted(n for n in zf.namelist() if _is_conversations_member(n))
            if not names:
                raise ValueError("No conversations.json in the export — is this the right data export?")
            convos: List[Dict[str, Any]] = []
            for name in names:
                with zf.open(name) as fh:
                    convos.extend(json.load(fh))
            return convos
    with open(path) as fh:
        return json.load(fh)


# ── ImportRun history + watermark (per member + provider) ─────────────────────

@dataclass
class ImportRun:
    id: str
    member_id: str
    provider: str
    range_from: Optional[str]
    range_to: Optional[str]
    conversations: int
    messages: int
    ran_at: str
    status: str  # 'done' | 'partial' | 'failed'

    def as_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id, "provider": self.provider,
            "range_from": self.range_from, "range_to": self.range_to,
            "conversations": self.conversations, "messages": self.messages,
            "ran_at": self.ran_at, "status": self.status,
        }


class ImportHistoryStore:
    """Per-(member, provider) log of import runs; the watermark is derived."""

    def __init__(self, db_path: Path) -> None:
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(self.db_path, check_same_thread=False)
        self._conn.execute("PRAGMA journal_mode=WAL;")
        self._conn.execute(
            """CREATE TABLE IF NOT EXISTS import_runs (
                   id TEXT PRIMARY KEY, member_id TEXT NOT NULL,
                   range_from TEXT, range_to TEXT,
                   conversations INTEGER NOT NULL DEFAULT 0,
                   messages INTEGER NOT NULL DEFAULT 0,
                   ran_at TEXT NOT NULL, status TEXT NOT NULL )"""
        )
        # provider column added for multi-provider imports (default 'anthropic'
        # for any rows predating it).
        try:
            self._conn.execute("ALTER TABLE import_runs ADD COLUMN provider TEXT NOT NULL DEFAULT 'anthropic'")
        except sqlite3.OperationalError:
            pass
        self._conn.execute("CREATE INDEX IF NOT EXISTS idx_runs_member ON import_runs(member_id, provider, ran_at DESC)")
        self._conn.commit()

    def record(self, run: ImportRun) -> None:
        self._conn.execute(
            "INSERT OR REPLACE INTO import_runs "
            "(id, member_id, provider, range_from, range_to, conversations, messages, ran_at, status) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (run.id, run.member_id, run.provider, run.range_from, run.range_to,
             run.conversations, run.messages, run.ran_at, run.status),
        )
        self._conn.commit()

    def history(self, member_id: str, provider: str) -> List[Dict[str, Any]]:
        rows = self._conn.execute(
            "SELECT id, member_id, provider, range_from, range_to, conversations, messages, ran_at, status "
            "FROM import_runs WHERE member_id = ? AND provider = ? ORDER BY ran_at DESC",
            (member_id, provider),
        ).fetchall()
        return [ImportRun(*r).as_dict() for r in rows]

    def watermark(self, member_id: str, provider: str) -> Optional[str]:
        row = self._conn.execute(
            "SELECT range_to FROM import_runs WHERE member_id = ? AND provider = ? "
            "AND status = 'done' AND range_to IS NOT NULL ORDER BY range_to DESC LIMIT 1",
            (member_id, provider),
        ).fetchone()
        return row[0] if row else None

    def close(self) -> None:
        self._conn.close()


# ── the importer: creates maurice.db conversations ────────────────────────────

@dataclass
class ImportPlan:
    window_ids: List[str]
    created: int
    messages: int
    range_from: Optional[str]
    range_to: Optional[str]


def default_maurice_db_path() -> Path:
    data_dir = os.environ.get("MAURICE_DATA_DIR") or str(Path.home() / ".maurice")
    return Path(data_dir).expanduser() / "maurice.db"


class ChatArchiveImporter:
    def __init__(self, *, maurice_db_path: Optional[Path] = None) -> None:
        self.db_path = Path(maurice_db_path) if maurice_db_path else default_maurice_db_path()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=15)
        conn.execute("PRAGMA busy_timeout=15000;")
        conn.execute("PRAGMA foreign_keys=ON;")
        return conn

    def create_conversations(
        self, export_path: Path, *, member_id: str, provider: Provider,
        since: Optional[str] = None, limit: Optional[int] = None,
    ) -> ImportPlan:
        since_dt = _parse_iso(since)
        convos = provider.parse(load_conversations(export_path))
        if since_dt is not None:
            convos = [c for c in convos if (c.updated or c.created) and (c.updated or c.created) > since_dt]
        convos.sort(key=lambda c: (c.updated or c.created or datetime.min.replace(tzinfo=timezone.utc)))
        if limit is not None:
            convos = convos[:limit]

        window_ids: List[str] = []
        created = 0
        messages = 0
        range_to_dt: Optional[datetime] = None
        conn = self._connect()
        try:
            for c in convos:
                window_ids.append(c.id)
                cdt = c.updated or c.created
                if cdt and (range_to_dt is None or cdt > range_to_dt):
                    range_to_dt = cdt
                if conn.execute("SELECT 1 FROM conversations WHERE id = ?", (c.id,)).fetchone():
                    continue
                created += 1
                messages += self._insert_conversation(conn, member_id, c, provider)
            conn.commit()
        finally:
            conn.close()

        return ImportPlan(
            window_ids=window_ids, created=created, messages=messages,
            range_from=since, range_to=(range_to_dt.isoformat() if range_to_dt else since),
        )

    def _insert_conversation(self, conn: sqlite3.Connection, member_id: str,
                             c: _ParsedConvo, provider: Provider) -> int:
        created_ts = _server_ts(c.created) or _server_ts(c.updated)
        updated_ts = _server_ts(c.updated) or created_ts
        conn.execute(
            "INSERT INTO conversations (id, user_id, title, created_at, updated_at, origin) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (c.id, member_id, c.title or None, created_ts, updated_ts, provider.key),
        )
        conn.execute(
            "INSERT OR IGNORE INTO conversation_participants (conversation_id, member_id, role) "
            "VALUES (?, ?, 'owner')",
            (c.id, member_id),
        )
        n = 0
        for m in c.messages:
            author = member_id if m.role == "user" else None
            model = provider.model_label if m.role == "assistant" else None
            conn.execute(
                "INSERT OR IGNORE INTO messages (id, conversation_id, role, content, model, created_at, author_id) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (m.id, c.id, m.role, m.text, model, _server_ts(m.created) or updated_ts, author),
            )
            n += 1
        return n


__all__ = [
    "ChatArchiveImporter", "ImportHistoryStore", "ImportRun", "ImportPlan",
    "Provider", "PROVIDERS", "load_conversations", "default_maurice_db_path",
    "new_job", "job_status",
]
