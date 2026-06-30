"""MCP server for managing garden notes and resource content (Astro content collections)."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Any

import yaml
from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import TextContent, Tool

LOGGER = logging.getLogger(__name__)

REPO_ROOT = Path(__file__).resolve().parents[2]
# GARDENS_ROOT is resolved below, once tools/ is on sys.path — it is configurable
# (MAURICE_GARDENS_DIR / config.toml) so a production install can persist gardens
# in a writable data dir rather than inside the read-only install tree.

# Notes are per-member gardens (gardens/<member>/notes). Which member depends on
# who is calling: the MCP gateway sets the member id via a contextvar per
# request; we map it to the member's username (the garden slug). Falls back to
# GARDEN_MEMBER env / candide for local or context-less use.
_MAURICE_DB = Path(os.environ.get("MAURICE_DATA_DIR") or (Path.home() / ".maurice")) / "maurice.db"
_member_slug_cache: dict[str, str] = {}


def _garden_member() -> str:
    from tools.shared.context import get_member_id

    # In production the gateway sets the member contextvar per request, so the
    # default below is only a context-less / dev fallback. No personal name in a
    # public build; the full build keeps "candide". GARDEN_MEMBER overrides both.
    default = os.environ.get("GARDEN_MEMBER") or ("default" if _GARDEN_PROFILE == "public" else "candide")
    mid = get_member_id()
    if not mid:
        return default
    cached = _member_slug_cache.get(mid)
    if cached:
        return cached
    slug = default
    try:
        import sqlite3

        con = sqlite3.connect(f"file:{_MAURICE_DB}?mode=ro", uri=True)
        row = con.execute("SELECT username FROM users WHERE id = ?", (mid,)).fetchone()
        con.close()
        if row and row[0]:
            slug = row[0]
    except Exception:
        pass
    _member_slug_cache[mid] = slug
    return slug


def member_root() -> Path:
    """Root of the calling member's garden (gardens/<member>/).

    All content collections (books, articles, blog, notes, …) and their images
    live under here, per member.
    """
    return GARDENS_ROOT / _garden_member()


def content_root() -> Path:
    """Notes root for the calling member's garden (gardens/<member>/notes)."""
    return member_root() / "notes"


# Path-component validation for values that arrive as tool arguments. Without
# this, a crafted note_id/locale/resource_id like "../../<other>/notes/en/x"
# escapes the per-member garden into another member's tree (read/write/unlink).
_SLUG_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
_LOCALE_RE = re.compile(r"^[a-z]{2}$")
_RESOURCE_COLLECTIONS = {"books", "articles", "movies", "series", "podcasts", "people"}


def _safe_slug(value: str, kind: str = "id") -> str:
    if not isinstance(value, str) or ".." in value or not _SLUG_RE.match(value):
        raise ValueError(f"invalid {kind}: {value!r}")
    return value


def _safe_locale(value: str) -> str:
    if not isinstance(value, str) or not _LOCALE_RE.match(value):
        raise ValueError(f"invalid locale: {value!r}")
    return value


def _assert_within(path: Path, base: Path) -> Path:
    """Resolve `path` and assert it stays inside `base` — last-line defense so a
    component that slipped past validation still cannot escape the garden."""
    rp, rb = path.resolve(), base.resolve()
    if rp != rb and rb not in rp.parents:
        raise ValueError(f"path escapes garden: {path}")
    return rp

sys.path.insert(0, str(REPO_ROOT / "tools"))
from shared.model_config import resolve_model as _resolve_model  # noqa: E402
from shared.config_loader import get_config, get_gardens_dir, get_secret  # noqa: E402


def _anthropic_key() -> str:
    key = get_secret("anthropic_api_key", env="ANTHROPIC_API_KEY")
    if not key:
        raise ValueError(
            "ANTHROPIC_API_KEY is not set. Set the env var or add "
            "[secrets] anthropic_api_key to ~/.maurice/config.toml."
        )
    return key


# Tool profile. The public .pkg sets MAURICE_GARDEN_PROFILE=public, which exposes
# only the core note tools below; the specialized tools (fiches, media/resource
# entries, journals/dreams, fragments, people/contacts, coaching, hero images,
# publishing/deploy) ship only in the full/private build. Default is "full".
_GARDEN_PROFILE = os.environ.get("MAURICE_GARDEN_PROFILE", "full").strip().lower()
_PUBLIC_NOTE_TOOLS = frozenset({
    "create_note", "update_note", "delete_note", "get_note", "list_notes",
    "toggle_public", "toggle_private", "set_image", "list_backlog",
    "get_user_guide",
})


def _tool_allowed(name: str) -> bool:
    """True unless this is a public build and the tool isn't a core note tool."""
    return _GARDEN_PROFILE != "public" or name in _PUBLIC_NOTE_TOOLS

GARDENS_ROOT = get_gardens_dir()

HERO_STYLES: dict[str, dict[str, str]] = yaml.safe_load(
    (Path(__file__).parent / "hero-styles.yaml").read_text(encoding="utf-8")
)["styles"]

app = Server("akita-garden")


# ---------------------------------------------------------------------------
# Journal type config (dream / daily note share the same infrastructure)
# ---------------------------------------------------------------------------

@dataclass
class _JournalType:
    prefix: str           # "reve" or "journal"
    tag: str              # "rêve" or "journal"
    icon: str             # "moon" or "pen-line"
    label_fr: str         # "Rêves" or "Journal"
    backlink_heading: str # "## Rêves" or "## Journal"
    model_key: str        # "dream_analysis" or "journal_analysis"
    moc_slug: str         # "reves" or "journal"

DREAM = _JournalType("reve", "rêve", "moon", "Rêves", "## Rêves", "dream_analysis", "reves")
DAILY = _JournalType("journal", "journal", "pen-line", "Journal", "## Journal", "journal_analysis", "journal")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_FM_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n?(.*)", re.DOTALL)


def _resolve_note_path(note_id: str, locale: str = "en") -> Path:
    note_id = _safe_slug(note_id, "note_id")
    locale = _safe_locale(locale)
    return _assert_within(content_root() / locale / f"{note_id}.md", member_root())


def _parse_note(path: Path) -> tuple[dict[str, Any], str]:
    """Return (frontmatter_dict, body_str) from a markdown file."""
    text = path.read_text(encoding="utf-8")
    m = _FM_RE.match(text)
    if not m:
        raise ValueError(f"Cannot parse frontmatter in {path}")
    fm = yaml.safe_load(m.group(1)) or {}
    body = m.group(2)
    return fm, body


def _activity_file(member: str) -> Path:
    """Activity-signal path for a member's garden. A FIXED shared path under
    /tmp — NEVER under gardens/, because a content loader (fiches) watches the
    whole garden root and writing here on every edit would retrigger Astro's
    content reload and wedge the dev server ("collection is empty" → 404s). Fixed
    (not tempfile.gettempdir()) so the gateway writer and the web reader agree
    even if their $TMPDIR differs."""
    return Path("/tmp/maurice-garden-activity") / f"{member}.json"


def _mark_activity(note_id: str) -> None:
    """Record that a page is being edited, for the garden's live activity
    indicator. Writes {slug: unix_ts} (web endpoint windows recent entries).
    Best-effort, and out of the content tree — never breaks or wedges an edit."""
    try:
        f = _activity_file(_garden_member())
        f.parent.mkdir(parents=True, exist_ok=True)
        now = int(time.time())
        data: dict[str, int] = {}
        if f.exists():
            try:
                data = json.loads(f.read_text(encoding="utf-8")) or {}
            except Exception:
                data = {}
        data[note_id] = now
        data = {k: v for k, v in data.items() if now - int(v) < 120}  # prune > 2 min
        f.write_text(json.dumps(data), encoding="utf-8")
    except Exception:
        pass


def _atomic_write(path: Path, content: str) -> None:
    """Write a content file atomically: write a temp sibling, then os.replace it
    into place. The dev content watcher then sees ONE complete change (a rename)
    instead of a truncate+write — which fires two reload events, makes the
    glob-loader double-add the entry (duplicate id), and collapses the whole
    collection to "does not exist or is empty" → 404s across the garden. The
    temp is a dotfile so the loader's *.md glob never matches it mid-write."""
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(content, encoding="utf-8")
    os.replace(tmp, path)


_corpus_bg_tasks: set = set()


def _push_note_to_corpus(path: Path, *, deleted: bool = False) -> None:
    """Best-effort: keep the corpus vector index in sync with a note write/delete.

    The corpus tool runs in-process in the same MCP gateway but with its file
    watcher off, so note edits must be pushed explicitly (mirrors how live
    conversations are re-indexed post-turn). No-op when the corpus tool isn't
    present (public-repo build). The corpus 'garden-notes' source filters
    non-note paths, so passing any content path here is safe."""
    try:
        # Prefer the gateway's module name ("tools.corpus.server") so we share its
        # already-loaded orchestrator instance; fall back to the top-level name for
        # garden's standalone/dev path (where only tools/ is on sys.path).
        try:
            from tools.corpus.server import index_path, remove_path
        except ModuleNotFoundError:
            from corpus.server import index_path, remove_path
    except Exception:
        return
    try:
        if deleted:
            remove_path("garden-notes", path)
            return
        loop = asyncio.get_running_loop()
        task = loop.create_task(index_path("garden-notes", path))
        _corpus_bg_tasks.add(task)
        task.add_done_callback(_corpus_bg_tasks.discard)
    except RuntimeError:
        # No running loop (a to_thread worker or CLI). Non-note paths no-op
        # before touching the store; index synchronously so we never lose a note.
        try:
            asyncio.run(index_path("garden-notes", path))
        except Exception:
            LOGGER.exception("corpus index failed for %s", path)
    except Exception:
        LOGGER.exception("corpus index scheduling failed for %s", path)


def _write_note(path: Path, fm: dict[str, Any], body: str) -> None:
    """Serialize frontmatter + body back to a markdown file (atomically)."""
    dumped = yaml.dump(fm, default_flow_style=False, allow_unicode=True, sort_keys=False)
    _atomic_write(path, f"---\n{dumped}---\n{body}")
    _mark_activity(path.stem)
    _push_note_to_corpus(path)


def _gardens_git_root() -> Path | None:
    """Git work-tree top-level containing GARDENS_ROOT, or None if the gardens
    dir isn't version-controlled (the normal case for a production data dir —
    notes are persisted as plain files; git is only a dev/source-repo nicety)."""
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            cwd=GARDENS_ROOT, capture_output=True, text=True,
        )
        if out.returncode == 0 and out.stdout.strip():
            return Path(out.stdout.strip())
    except Exception:
        pass
    return None


def _git_has_remote(root: Path) -> bool:
    try:
        out = subprocess.run(["git", "remote"], cwd=root, capture_output=True, text=True)
        return out.returncode == 0 and bool(out.stdout.strip())
    except Exception:
        return False


def _auto_commit(paths: list[Path], message: str) -> None:
    """Commit (and push, if a remote exists) garden changes — only when the
    gardens dir lives in a git repo. Outside a repo this is a no-op: the files
    are already written to disk."""
    root = _gardens_git_root()
    if root is None:
        return
    try:
        rel_paths = [str(p.relative_to(root)) for p in paths]
        subprocess.run(["git", "add"] + rel_paths, cwd=root, check=True)
        result = subprocess.run(["git", "diff", "--cached", "--quiet"], cwd=root)
        if result.returncode != 0:  # there are staged changes
            subprocess.run(["git", "commit", "-m", message], cwd=root, check=True)
            if _git_has_remote(root):
                subprocess.run(["git", "push"], cwd=root, check=False)
    except Exception as exc:
        LOGGER.warning("auto-commit failed: %s", exc)


def _rel(path: Path) -> str:
    """Display path: relative to the gardens root (or its git root) when the file
    lives there, falling back to the source repo, then the absolute path. Keeps
    return values stable whether gardens are inside the repo (dev) or in a separate
    data dir (production)."""
    for base in (_gardens_git_root() or GARDENS_ROOT, REPO_ROOT):
        try:
            return str(path.relative_to(base))
        except ValueError:
            continue
    return str(path)


def _remove_paths(paths: list[Path], message: str) -> bool:
    """Git-rm + commit (and push if a remote exists) the given paths from the
    gardens repo. Returns True if removed via git, False if the gardens dir isn't
    a repo (or git failed) — the caller should then unlink the files directly."""
    root = _gardens_git_root()
    if root is None:
        return False
    try:
        rel = [str(p.relative_to(root)) for p in paths]
        subprocess.run(["git", "rm", "-r"] + rel, cwd=root, check=True)
        subprocess.run(["git", "commit", "-m", message], cwd=root, check=True)
        if _git_has_remote(root):
            subprocess.run(["git", "push"], cwd=root, check=False)
        return True
    except Exception as exc:
        LOGGER.warning("git rm/commit failed (%s); caller will delete directly", exc)
        return False


def _resolve_fiche_path(resource_collection: str, resource_id: str, locale: str = "en") -> Path:
    if resource_collection not in _RESOURCE_COLLECTIONS:
        raise ValueError(f"invalid resource_collection: {resource_collection!r}")
    resource_id = _safe_slug(resource_id, "resource_id")
    locale = _safe_locale(locale)
    return _assert_within(
        member_root() / resource_collection / locale / f"{resource_id}-fiche.md",
        member_root(),
    )


def _fragments_dir(parent_path: Path) -> Path:
    """Return the _fragments/ directory for a given parent content file."""
    return parent_path.parent / parent_path.stem / "_fragments"


def _next_fragment_num(fdir: Path) -> int:
    """Return the next sequential fragment number."""
    if not fdir.exists():
        return 1
    nums = [int(f.stem) for f in fdir.glob("*.frag") if f.stem.isdigit()]
    return (max(nums) + 1) if nums else 1


_FRAGMENT_FM_RE = re.compile(r"^---\n(.*?)\n---\n?(.*)", re.DOTALL)


def _parse_fragment(path: Path) -> tuple[str, str]:
    """Return (summary, body) from a fragment file."""
    text = path.read_text(encoding="utf-8")
    m = _FRAGMENT_FM_RE.match(text)
    if m:
        fm = yaml.safe_load(m.group(1)) or {}
        return fm.get("summary", ""), m.group(2)
    return "", text


def _write_fragment(path: Path, summary: str, body: str) -> None:
    escaped = summary.replace('"', '\\"')
    _atomic_write(path, f'---\nsummary: "{escaped}"\n---\n{body}')


def _resolve_fragment_parent(args: dict[str, Any]) -> Path:
    """Resolve the parent file path from fragment tool arguments."""
    collection = args.get("collection", "books")
    locale = args.get("locale", "en")
    pid = args["parent_id"]
    if collection == "notes":
        return _resolve_note_path(pid, locale)
    # For fiches, parent_id is the resource_id (the fiche slug without -fiche suffix)
    return _resolve_fiche_path(collection, pid, locale)


def _fiche_summary(fm: dict[str, Any]) -> dict[str, Any]:
    """Build a summary dict for fiche list output."""
    return {
        "resource_collection": fm.get("resource_collection", ""),
        "resource_id": fm.get("resource_id", ""),
        "title": fm.get("title", ""),
        "date": str(fm.get("date", "")),
        "tags": fm.get("tags", []),
        "locale": fm.get("locale", "en"),
    }


def _note_summary(note_id: str, fm: dict[str, Any]) -> dict[str, Any]:
    """Build a summary dict for list output."""
    summary: dict[str, Any] = {
        "id": note_id,
        "title": fm.get("title", ""),
        "date": str(fm.get("date", "")),
        "tags": fm.get("tags", []),
        "flags": fm.get("flags", []),
    }
    if fm.get("status"):
        summary["status"] = fm["status"]
    if fm.get("order") is not None:
        summary["order"] = fm["order"]
    return summary


def _json_default(obj: Any) -> Any:
    if isinstance(obj, (date, datetime)):
        return obj.isoformat()
    raise TypeError(f"Object of type {type(obj).__name__} is not JSON serializable")


# ---------------------------------------------------------------------------
# Tool definitions
# ---------------------------------------------------------------------------

@app.list_tools()
async def list_tools() -> list[Tool]:
    tools = [
        Tool(
            name="create_note",
            description="Create a new garden note markdown file.",
            inputSchema={
                "type": "object",
                "required": ["id", "title"],
                "properties": {
                    "id": {"type": "string", "description": "Filename slug (no extension)."},
                    "title": {"type": "string", "description": "Note title."},
                    "locale": {"type": "string", "enum": ["en", "fr"], "default": "en"},
                    "body": {"type": "string", "description": "Markdown body.", "default": ""},
                    "description": {"type": "string", "description": "Short description."},
                    "tags": {"type": "array", "items": {"type": "string"}, "default": []},
                    "flags": {"type": "array", "items": {"type": "string", "enum": ["public", "encrypted", "moc", "translation", "archived"]}, "default": [], "description": "Flags: public, encrypted, moc, translation, archived"},
                    "image": {"type": "string", "description": "Image path or URL."},
                    "icon": {"type": "string", "description": "Lucide icon name (kebab-case, e.g. 'wifi')."},
                    "parent": {"type": "string", "description": "Parent note slug for hierarchy."},
                    "category": {"type": "string", "description": "Category slug (e.g. 'health')."},
                    "active_from": {"type": "string", "description": "ISO date (YYYY-MM-DD) when this plan becomes active."},
                    "active_until": {"type": "string", "description": "ISO date (YYYY-MM-DD) when this plan expires."},
                    "coaching_metrics": {
                        "type": "array",
                        "description": "Coaching metric definitions (pillar, signal_category, match, frequency, etc.).",
                        "items": {
                            "type": "object",
                            "required": ["pillar", "signal_category"],
                            "properties": {
                                "pillar": {"type": "string"},
                                "signal_category": {"type": "string"},
                                "match": {"type": "object", "description": "Match criteria (e.g. {activity: [...]})."},
                                "frequency": {"type": "string", "description": "e.g. '3/week'."},
                                "duration_min": {"type": "integer"},
                                "enumerate": {"type": "boolean"},
                                "max_per_day": {"type": "integer"},
                            },
                        },
                    },
                    "extra_frontmatter": {
                        "type": "object",
                        "description": "Additional frontmatter fields to set. Keys must not collide with known fields (title, date, flags, locale, description, tags, image, icon, parent, category, active_from, active_until, coaching_metrics). Pass null value to remove a key.",
                    },
                },
            },
        ),
        Tool(
            name="delete_note",
            description="Delete a garden note and its associated image if any.",
            inputSchema={
                "type": "object",
                "required": ["id", "confirm"],
                "properties": {
                    "id": {"type": "string", "description": "Filename slug (no extension)."},
                    "confirm": {"type": "boolean", "description": "Must be true to confirm deletion."},
                    "locale": {"type": "string", "enum": ["en", "fr"], "default": "en"},
                },
            },
        ),
        Tool(
            name="toggle_public",
            description="Toggle the public status of a note.",
            inputSchema={
                "type": "object",
                "required": ["id"],
                "properties": {
                    "id": {"type": "string"},
                    "locale": {"type": "string", "enum": ["en", "fr"], "default": "en"},
                },
            },
        ),
        Tool(
            name="toggle_private",
            description="Toggle the private status of a note.",
            inputSchema={
                "type": "object",
                "required": ["id"],
                "properties": {
                    "id": {"type": "string"},
                    "locale": {"type": "string", "enum": ["en", "fr"], "default": "en"},
                },
            },
        ),
        Tool(
            name="get_note",
            description="Get a note's frontmatter and markdown body.",
            inputSchema={
                "type": "object",
                "required": ["id"],
                "properties": {
                    "id": {"type": "string", "description": "Filename slug (no extension)."},
                    "locale": {"type": "string", "enum": ["en", "fr"], "default": "en"},
                },
            },
        ),
        Tool(
            name="update_note",
            description="Update an existing note's frontmatter fields and/or body. Only provided fields are changed.",
            inputSchema={
                "type": "object",
                "required": ["id"],
                "properties": {
                    "id": {"type": "string", "description": "Filename slug (no extension)."},
                    "locale": {"type": "string", "enum": ["en", "fr"], "default": "en"},
                    "title": {"type": "string"},
                    "body": {"type": "string", "description": "Replace markdown body."},
                    "description": {"type": ["string", "null"]},
                    "tags": {"type": "array", "items": {"type": "string"}},
                    "flags": {"type": "array", "items": {"type": "string", "enum": ["public", "encrypted", "moc", "translation", "archived"]}, "description": "Replace flags array"},
                    "image": {"type": ["string", "null"]},
                    "icon": {"type": ["string", "null"], "description": "Lucide icon name (kebab-case)."},
                    "status": {
                        "type": "string",
                        "enum": ["proposed", "ready", "in_progress", "review", "done"],
                        "description": "Backlog status.",
                    },
                    "order": {"type": "integer", "description": "Sort order (lower = higher priority)."},
                    "parent": {"type": ["string", "null"], "description": "Parent note slug for hierarchy. Null to remove."},
                    "category": {"type": ["string", "null"], "description": "Category slug (e.g. 'health'). Null to remove."},
                    "active_from": {"type": ["string", "null"], "description": "ISO date (YYYY-MM-DD) when this plan becomes active. Null to remove."},
                    "active_until": {"type": ["string", "null"], "description": "ISO date (YYYY-MM-DD) when this plan expires. Null to remove."},
                    "coaching_metrics": {
                        "type": ["array", "null"],
                        "description": "Coaching metric definitions. Null to remove.",
                        "items": {
                            "type": "object",
                            "required": ["pillar", "signal_category"],
                            "properties": {
                                "pillar": {"type": "string"},
                                "signal_category": {"type": "string"},
                                "match": {"type": "object", "description": "Match criteria (e.g. {activity: [...]})."},
                                "frequency": {"type": "string", "description": "e.g. '3/week'."},
                                "duration_min": {"type": "integer"},
                                "enumerate": {"type": "boolean"},
                                "max_per_day": {"type": "integer"},
                            },
                        },
                    },
                    "extra_frontmatter": {
                        "type": "object",
                        "description": "Additional frontmatter fields to merge. Keys must not collide with known fields. Null values remove keys.",
                    },
                },
            },
        ),
        Tool(
            name="set_image",
            description="Set or remove the cover image for a note.",
            inputSchema={
                "type": "object",
                "required": ["id"],
                "properties": {
                    "id": {"type": "string"},
                    "locale": {"type": "string", "enum": ["en", "fr"], "default": "en"},
                    "image": {"type": ["string", "null"], "description": "Image path or URL. Pass null to remove."},
                },
            },
        ),
        Tool(
            name="list_notes",
            description="List garden notes with optional filters.",
            inputSchema={
                "type": "object",
                "properties": {
                    "locale": {"type": "string", "enum": ["en", "fr"], "default": "en"},
                    "flag": {"type": "string", "description": "Filter: only notes with this flag (e.g. 'public', 'encrypted')."},
                    "exclude_flag": {"type": "string", "description": "Filter: exclude notes with this flag."},
                    "tag": {"type": "string", "description": "Filter by tag (case-insensitive)."},
                },
            },
        ),
        # ── Dream tools ──
        Tool(
            name="write_dream",
            description="Create a dream journal entry. Shortcut for create_note with dream defaults (private, tagged rêve, moon icon, fr locale). ID is auto-generated as reve-YYYY-MM-DD-<slug>.",
            inputSchema={
                "type": "object",
                "required": ["title", "body"],
                "properties": {
                    "title": {"type": "string", "description": "Dream title."},
                    "body": {"type": "string", "description": "Dream narrative (markdown)."},
                    "slug": {"type": "string", "description": "Short slug for the ID (appended to reve-YYYY-MM-DD-). Auto-derived from title if omitted."},
                    "description": {"type": "string", "description": "Short description / one-line summary."},
                    "date": {"type": "string", "description": "Date in YYYY-MM-DD format (defaults to today)."},
                    "tags": {"type": "array", "items": {"type": "string"}, "description": "Additional tags (rêve is always included).", "default": []},
                },
            },
        ),
        Tool(
            name="search_dreams",
            description="Search dream journal entries by keyword and/or date range. Searches in title, description, and body.",
            inputSchema={
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Search keyword (matched in title, description, body)."},
                    "start_date": {"type": "string", "description": "Start date (YYYY-MM-DD, inclusive)."},
                    "end_date": {"type": "string", "description": "End date (YYYY-MM-DD, inclusive)."},
                    "limit": {"type": "integer", "default": 20, "description": "Max results."},
                },
            },
        ),
        Tool(
            name="get_dream",
            description="Get the full content of a dream journal entry by ID or by date. Returns frontmatter and complete body.",
            inputSchema={
                "type": "object",
                "properties": {
                    "id": {"type": "string", "description": "Dream note ID (e.g. reve-2026-04-05-maison)."},
                    "date": {"type": "string", "description": "Date (YYYY-MM-DD) — returns the first dream matching that date. Ignored if id is provided."},
                },
            },
        ),
        Tool(
            name="link_dream_entities",
            description=(
                "Link people mentioned in a dream to their person fiches. "
                "Extracts character names via LLM, matches them against existing fiches (by name), "
                "rewrites the dream body with correct markdown links, adds back-links on person fiches, "
                "and cleans up person-name tags. Returns linked/unmatched lists. "
                "For unmatched characters, call contacts__search_contacts then call this again with the 'people' param."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "id": {"type": "string", "description": "Dream note ID."},
                    "date": {"type": "string", "description": "Date (YYYY-MM-DD) — returns the first dream matching that date. Ignored if id is provided."},
                    "people": {
                        "type": "array",
                        "description": "Explicit matches: pre-resolved person mappings. Use this to provide matches found via contacts__search_contacts.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "name": {"type": "string", "description": "Character name as it appears in the dream text."},
                                "person_id": {"type": "string", "description": "Person fiche slug (without -fiche suffix)."},
                                "carddav_uid": {"type": "string", "description": "CardDAV UID — used to create the fiche if it doesn't exist."},
                            },
                            "required": ["name", "person_id"],
                        },
                    },
                },
            },
        ),
        # ── Daily note tools ──
        Tool(
            name="write_daily_note",
            description="Create a daily note / journal entry. Shortcut for create_note with journal defaults (private, tagged journal, pen-line icon, fr locale). ID is auto-generated as journal-YYYY-MM-DD-<slug>.",
            inputSchema={
                "type": "object",
                "required": ["title", "body"],
                "properties": {
                    "title": {"type": "string", "description": "Note title."},
                    "body": {"type": "string", "description": "Note body (markdown)."},
                    "slug": {"type": "string", "description": "Short slug for the ID (appended to journal-YYYY-MM-DD-). Auto-derived from title if omitted."},
                    "description": {"type": "string", "description": "Short description / one-line summary."},
                    "date": {"type": "string", "description": "Date in YYYY-MM-DD format (defaults to today)."},
                    "tags": {"type": "array", "items": {"type": "string"}, "description": "Additional tags (journal is always included).", "default": []},
                },
            },
        ),
        Tool(
            name="search_daily_notes",
            description="Search daily note / journal entries by keyword and/or date range. Searches in title, description, and body.",
            inputSchema={
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Search keyword (matched in title, description, body)."},
                    "start_date": {"type": "string", "description": "Start date (YYYY-MM-DD, inclusive)."},
                    "end_date": {"type": "string", "description": "End date (YYYY-MM-DD, inclusive)."},
                    "limit": {"type": "integer", "default": 20, "description": "Max results."},
                },
            },
        ),
        Tool(
            name="get_daily_note",
            description="Get the full content of a daily note / journal entry by ID or by date. Returns frontmatter and complete body.",
            inputSchema={
                "type": "object",
                "properties": {
                    "id": {"type": "string", "description": "Note ID (e.g. journal-2026-04-16-marche)."},
                    "date": {"type": "string", "description": "Date (YYYY-MM-DD) — returns the first daily note matching that date. Ignored if id is provided."},
                },
            },
        ),
        Tool(
            name="link_daily_note_entities",
            description=(
                "Link people mentioned in a daily note to their person fiches. "
                "Extracts character names via LLM, matches them against existing fiches (by name), "
                "rewrites the note body with correct markdown links, adds back-links on person fiches, "
                "and cleans up person-name tags. Returns linked/unmatched lists. "
                "For unmatched characters, call contacts__search_contacts then call this again with the 'people' param."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "id": {"type": "string", "description": "Daily note ID."},
                    "date": {"type": "string", "description": "Date (YYYY-MM-DD) — returns the first daily note matching that date. Ignored if id is provided."},
                    "people": {
                        "type": "array",
                        "description": "Explicit matches: pre-resolved person mappings. Use this to provide matches found via contacts__search_contacts.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "name": {"type": "string", "description": "Person name as it appears in the note text."},
                                "person_id": {"type": "string", "description": "Person fiche slug (without -fiche suffix)."},
                                "carddav_uid": {"type": "string", "description": "CardDAV UID — used to create the fiche if it doesn't exist."},
                            },
                            "required": ["name", "person_id"],
                        },
                    },
                },
            },
        ),
        # ── Coaching plan tools ──
        Tool(
            name="list_coaching_plans",
            description="List coaching plans (notes with coaching_metrics). Returns id, title, icon, date interval, currently_active status, and metric count. Optionally filter to plans active on a specific date.",
            inputSchema={
                "type": "object",
                "properties": {
                    "date": {
                        "type": "string",
                        "description": "Optional YYYY-MM-DD — only return plans active on this date.",
                    },
                },
            },
        ),
        # ── Contact-person linking tools ──
        Tool(
            name="link_contact_to_person",
            description="Link a CardDAV contact to a person fiche or resource entry by storing the contact's carddav_uid in the person's frontmatter. Creates a durable link for future lookups.",
            inputSchema={
                "type": "object",
                "required": ["carddav_uid", "person_id"],
                "properties": {
                    "carddav_uid": {"type": "string", "description": "The CardDAV vCard UID of the contact."},
                    "person_id": {"type": "string", "description": "The person fiche or resource entry slug."},
                    "locale": {"type": "string", "enum": ["en", "fr"], "default": "fr"},
                },
            },
        ),
        Tool(
            name="find_person_by_contact",
            description="Find a person fiche or resource entry linked to a CardDAV contact UID. Returns the person's frontmatter if found.",
            inputSchema={
                "type": "object",
                "required": ["carddav_uid"],
                "properties": {
                    "carddav_uid": {"type": "string", "description": "The CardDAV vCard UID to look up."},
                },
            },
        ),
        Tool(
            name="create_contact_fiche",
            description="Create a contact fiche (sidecar note) for a person. Lightweight alternative to create_fiche for people — no external API lookup, just creates the file with optional CardDAV UID.",
            inputSchema={
                "type": "object",
                "required": ["name", "person_id"],
                "properties": {
                    "name": {"type": "string", "description": "Display name for the contact."},
                    "person_id": {"type": "string", "description": "Person slug (e.g. 'xavier-lepoivre')."},
                    "carddav_uid": {"type": "string", "description": "CardDAV vCard UID to link to a contact."},
                    "locale": {"type": "string", "enum": ["en", "fr"], "default": "fr"},
                    "tags": {"type": "array", "items": {"type": "string"}, "default": []},
                    "body": {"type": "string", "description": "Markdown body.", "default": "\n"},
                },
            },
        ),
        # ── Fiche tools ──
        Tool(
            name="create_fiche",
            description="Create a personal fiche (sidecar note) for a resource. Pre-fetches metadata from external APIs (Google Books, TMDB, Podcast Index, OG tags, Wikidata) and stores it in the fiche for later promotion to a full resource entry. Call get_user_guide for link syntax and conventions.",
            inputSchema={
                "type": "object",
                "required": ["resource_collection", "resource_id"],
                "properties": {
                    "resource_collection": {"type": "string", "enum": ["books", "articles", "movies", "series", "podcasts", "people"]},
                    "resource_id": {"type": "string", "description": "Resource slug matching the sibling file stem."},
                    "title": {"type": "string", "description": "Fiche title (defaults to resource_id). Also used as the search query for metadata APIs."},
                    "locale": {"type": "string", "enum": ["en", "fr"], "default": "en"},
                    "body": {"type": "string", "description": "Markdown body.", "default": ""},
                    "tags": {"type": "array", "items": {"type": "string"}, "default": []},
                    "url": {"type": "string", "description": "URL for articles (OG metadata extraction)."},
                    "author": {"type": "string", "description": "Author hint for books (improves Google Books search)."},
                    "year": {"type": "integer", "description": "Year hint for movies/series (improves TMDB search)."},
                    "skip_metadata": {"type": "boolean", "default": False, "description": "Skip external API calls; create fiche with empty meta."},
                },
            },
        ),
        Tool(
            name="get_fiche",
            description="Get a fiche's frontmatter and markdown body.",
            inputSchema={
                "type": "object",
                "required": ["resource_collection", "resource_id"],
                "properties": {
                    "resource_collection": {"type": "string", "enum": ["books", "articles", "movies", "series", "podcasts", "people"]},
                    "resource_id": {"type": "string"},
                    "locale": {"type": "string", "enum": ["en", "fr"], "default": "en"},
                },
            },
        ),
        Tool(
            name="update_fiche",
            description="Update an existing fiche's frontmatter and/or body. Call get_user_guide for link syntax and conventions.",
            inputSchema={
                "type": "object",
                "required": ["resource_collection", "resource_id"],
                "properties": {
                    "resource_collection": {"type": "string", "enum": ["books", "articles", "movies", "series", "podcasts", "people"]},
                    "resource_id": {"type": "string"},
                    "locale": {"type": "string", "enum": ["en", "fr"], "default": "en"},
                    "title": {"type": "string"},
                    "body": {"type": "string", "description": "Replace markdown body."},
                    "tags": {"type": "array", "items": {"type": "string"}},
                },
            },
        ),
        Tool(
            name="list_fiches",
            description="List fiches with optional filters.",
            inputSchema={
                "type": "object",
                "properties": {
                    "resource_collection": {"type": "string", "enum": ["books", "articles", "movies", "series", "podcasts", "people"]},
                    "locale": {"type": "string", "enum": ["en", "fr"], "default": "en"},
                },
            },
        ),
        Tool(
            name="delete_fiche",
            description="Delete a fiche.",
            inputSchema={
                "type": "object",
                "required": ["resource_collection", "resource_id"],
                "properties": {
                    "resource_collection": {"type": "string", "enum": ["books", "articles", "movies", "series", "podcasts", "people"]},
                    "resource_id": {"type": "string"},
                    "locale": {"type": "string", "enum": ["en", "fr"], "default": "en"},
                },
            },
        ),
        Tool(
            name="promote_fiche",
            description="Promote a fiche to a full resource entry using its pre-fetched metadata. Downloads cover images and creates the resource file. The fiche body becomes the resource content.",
            inputSchema={
                "type": "object",
                "required": ["resource_collection", "resource_id"],
                "properties": {
                    "resource_collection": {"type": "string", "enum": ["books", "articles", "movies", "series", "podcasts", "people"]},
                    "resource_id": {"type": "string"},
                    "locale": {"type": "string", "enum": ["en", "fr"], "default": "en"},
                    "rating": {"type": "integer", "minimum": 1, "maximum": 5},
                    "tags": {"type": "array", "items": {"type": "string"}},
                    "flags": {"type": "array", "items": {"type": "string"}, "default": [], "description": "Flags array (e.g. ['public'])"},
                    "delete_fiche": {"type": "boolean", "default": False, "description": "Delete the fiche after successful promotion."},
                },
            },
        ),
        # ── Fragment tools ──
        Tool(
            name="append_fragment",
            description="Append a new fragment to a fiche or note. Fragments are stored as numbered markdown files in a _fragments/ directory and render after the parent body.",
            inputSchema={
                "type": "object",
                "required": ["parent_id", "content", "summary"],
                "properties": {
                    "parent_id": {"type": "string", "description": "Resource ID (for fiches) or note slug (for notes)."},
                    "content": {"type": "string", "description": "Markdown content for the fragment."},
                    "summary": {"type": "string", "description": "Short summary displayed as the collapsible header."},
                    "collection": {"type": "string", "enum": ["books", "articles", "movies", "series", "podcasts", "people", "notes"], "default": "books"},
                    "locale": {"type": "string", "enum": ["en", "fr"], "default": "en"},
                },
            },
        ),
        Tool(
            name="list_fragments",
            description="List all fragments for a fiche or note.",
            inputSchema={
                "type": "object",
                "required": ["parent_id"],
                "properties": {
                    "parent_id": {"type": "string"},
                    "collection": {"type": "string", "enum": ["books", "articles", "movies", "series", "podcasts", "people", "notes"], "default": "books"},
                    "locale": {"type": "string", "enum": ["en", "fr"], "default": "en"},
                },
            },
        ),
        Tool(
            name="get_fragment",
            description="Get the content of a single fragment.",
            inputSchema={
                "type": "object",
                "required": ["parent_id", "fragment_id"],
                "properties": {
                    "parent_id": {"type": "string"},
                    "fragment_id": {"type": "string", "description": "Fragment number as zero-padded string (e.g. '001')."},
                    "collection": {"type": "string", "enum": ["books", "articles", "movies", "series", "podcasts", "people", "notes"], "default": "books"},
                    "locale": {"type": "string", "enum": ["en", "fr"], "default": "en"},
                },
            },
        ),
        Tool(
            name="update_fragment",
            description="Update the content of an existing fragment.",
            inputSchema={
                "type": "object",
                "required": ["parent_id", "fragment_id", "content"],
                "properties": {
                    "parent_id": {"type": "string"},
                    "fragment_id": {"type": "string", "description": "Fragment number as zero-padded string (e.g. '001')."},
                    "content": {"type": "string", "description": "New markdown content."},
                    "collection": {"type": "string", "enum": ["books", "articles", "movies", "series", "podcasts", "people", "notes"], "default": "books"},
                    "locale": {"type": "string", "enum": ["en", "fr"], "default": "en"},
                },
            },
        ),
        Tool(
            name="delete_fragment",
            description="Delete a fragment.",
            inputSchema={
                "type": "object",
                "required": ["parent_id", "fragment_id"],
                "properties": {
                    "parent_id": {"type": "string"},
                    "fragment_id": {"type": "string", "description": "Fragment number as zero-padded string (e.g. '001')."},
                    "collection": {"type": "string", "enum": ["books", "articles", "movies", "series", "podcasts", "people", "notes"], "default": "books"},
                    "locale": {"type": "string", "enum": ["en", "fr"], "default": "en"},
                },
            },
        ),
        Tool(
            name="update_fragment_summary",
            description="Update only the summary (collapsible header) of an existing fragment, preserving its content.",
            inputSchema={
                "type": "object",
                "required": ["parent_id", "fragment_id", "summary"],
                "properties": {
                    "parent_id": {"type": "string"},
                    "fragment_id": {"type": "string", "description": "Fragment number as zero-padded string (e.g. '001')."},
                    "summary": {"type": "string", "description": "New summary text."},
                    "collection": {"type": "string", "enum": ["books", "articles", "movies", "series", "podcasts", "people", "notes"], "default": "books"},
                    "locale": {"type": "string", "enum": ["en", "fr"], "default": "en"},
                },
            },
        ),
        # ── Resource publishing & management tools ──
        Tool(
            name="publish_content",
            description=(
                "Publish content to the website (web Astro site). "
                "Writes a markdown file with proper frontmatter. Supports all content types: "
                "blog, essay, book, article, movie, series, podcast, people. "
                "Content body can come from 'content' param or from a dossier via 'dossierId'."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "collection": {
                        "type": "string",
                        "enum": ["blog", "essays", "books", "articles", "movies", "series", "podcasts", "people"],
                        "description": "Content collection to publish to",
                    },
                    "content": {"type": "string", "description": "Markdown body"},
                    "dossierId": {"type": "string", "description": "Use content from this dossier instead of 'content'"},
                    "slug": {"type": "string", "description": "URL slug (auto-generated from title if omitted)"},
                    "locale": {"type": "string", "enum": ["en", "fr"], "default": "en"},
                    "translationKey": {"type": "string", "description": "Key to link translations together"},
                    "isTranslation": {"type": "boolean", "default": False},
                    "title": {"type": "string"},
                    "tags": {"type": "array", "items": {"type": "string"}, "default": []},
                    "date": {"type": "string", "description": "ISO date (defaults to today)"},
                    "flags": {"type": "array", "items": {"type": "string"}, "default": [], "description": "Flags array (e.g. ['public'])"},
                    "description": {"type": "string"},
                    "section": {"type": "string", "description": "Essay section (required for essays)"},
                    "author": {"type": "string"},
                    "date_read": {"type": "string", "description": "ISO date"},
                    "status": {"type": "string", "enum": ["read", "reading", "abandoned", "watching", "watched"]},
                    "rating": {"type": "integer", "minimum": 1, "maximum": 5},
                    "image": {"type": "string", "description": "Image URL (all resource collections)"},
                    "source": {"type": "string", "description": "Source publication name (articles)"},
                    "url": {"type": "string", "description": "Original URL (articles, podcasts)"},
                    "director": {"type": "string"},
                    "year": {"type": "integer"},
                    "date_watched": {"type": "string", "description": "ISO date"},
                    "platform": {"type": "string"},
                    "seasons_watched": {"type": "integer"},
                    "host": {"type": "string"},
                    "date_listened": {"type": "string", "description": "ISO date"},
                    "show": {"type": "string", "description": "Parent show slug (marks entry as episode)"},
                    "episode_title": {"type": "string"},
                    "episode_number": {"type": "integer"},
                    "season": {"type": "integer"},
                    "guests": {"type": "array", "items": {"type": "string"}, "description": "Podcast episode guests"},
                    "name": {"type": "string"},
                    "role": {"type": "string"},
                },
                "required": ["collection"],
            },
        ),
        Tool(
            name="search_movie",
            description="Search TMDB for movies. Returns candidates to review before creating an entry.",
            inputSchema={
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "Movie title to search"},
                    "year": {"type": "integer", "description": "Release year to narrow results"},
                    "limit": {"type": "integer", "default": 5, "description": "Max results to return"},
                },
                "required": ["title"],
            },
        ),
        Tool(
            name="search_book",
            description="Search Google Books for books. Returns candidates to review before creating an entry.",
            inputSchema={
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "Book title to search"},
                    "author": {"type": "string", "description": "Author name to narrow results"},
                    "limit": {"type": "integer", "default": 5, "description": "Max results to return"},
                },
                "required": ["title"],
            },
        ),
        Tool(
            name="search_series",
            description="Search TMDB for TV series. Returns candidates to review before creating an entry.",
            inputSchema={
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "Series title to search"},
                    "year": {"type": "integer", "description": "First air date year to narrow results"},
                    "limit": {"type": "integer", "default": 5, "description": "Max results to return"},
                },
                "required": ["title"],
            },
        ),
        Tool(
            name="search_podcast",
            description="Search Podcast Index for podcasts. Returns candidates to review before creating an entry.",
            inputSchema={
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "Podcast title to search"},
                    "limit": {"type": "integer", "default": 5, "description": "Max results to return"},
                },
                "required": ["title"],
            },
        ),
        Tool(
            name="search_person",
            description="Search Wikidata for people. Returns candidates to review before creating an entry.",
            inputSchema={
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "Person name to search"},
                    "limit": {"type": "integer", "default": 5, "description": "Max results to return"},
                },
                "required": ["name"],
            },
        ),
        Tool(
            name="search_series_episodes",
            description="Search TMDB for episodes of a TV series season. Returns episode candidates.",
            inputSchema={
                "type": "object",
                "properties": {
                    "tmdb_id": {"type": "integer", "description": "TMDB TV series ID (from search_series)"},
                    "season": {"type": "integer", "description": "Season number"},
                },
                "required": ["tmdb_id", "season"],
            },
        ),
        Tool(
            name="search_podcast_episodes",
            description="Search Podcast Index for episodes of a podcast feed. Returns episode candidates.",
            inputSchema={
                "type": "object",
                "properties": {
                    "podcastindex_id": {"type": "integer", "description": "Podcast Index feed ID (from search_podcast)"},
                    "limit": {"type": "integer", "default": 20, "description": "Max episodes to return"},
                },
                "required": ["podcastindex_id"],
            },
        ),
        Tool(
            name="create_movie_entry",
            description=(
                "Create a movie entry by looking up metadata on TMDB. "
                "Searches for the movie, fetches details (director, year, poster, overview), "
                "downloads the poster image, and creates a full movie entry."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "Movie title to search TMDB"},
                    "tmdb_id": {"type": "integer", "description": "TMDB movie ID (skip search if provided, from search_movie)"},
                    "year": {"type": "integer", "description": "Release year to disambiguate"},
                    "rating": {"type": "integer", "minimum": 1, "maximum": 5, "description": "User's rating"},
                    "content": {"type": "string", "description": "Review body markdown"},
                    "locale": {"type": "string", "enum": ["en", "fr"], "default": "fr"},
                    "flags": {"type": "array", "items": {"type": "string"}, "default": [], "description": "Flags array (e.g. ['public'])"},
                    "tags": {"type": "array", "items": {"type": "string"}, "default": []},
                },
                "required": ["title"],
            },
        ),
        Tool(
            name="create_book_entry",
            description=(
                "Create a book entry by looking up metadata on Google Books. "
                "Searches for the book, fetches cover image, and creates a full book entry."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "Book title to search"},
                    "google_books_id": {"type": "string", "description": "Google Books volume ID (skip search if provided, from search_book)"},
                    "author": {"type": "string", "description": "Author name to disambiguate"},
                    "rating": {"type": "integer", "minimum": 1, "maximum": 5},
                    "content": {"type": "string", "description": "Review body markdown"},
                    "locale": {"type": "string", "enum": ["en", "fr"], "default": "fr"},
                    "flags": {"type": "array", "items": {"type": "string"}, "default": [], "description": "Flags array (e.g. ['public'])"},
                    "tags": {"type": "array", "items": {"type": "string"}, "default": []},
                },
                "required": ["title"],
            },
        ),
        Tool(
            name="create_series_entry",
            description=(
                "Create a TV series entry by looking up metadata on TMDB. "
                "Searches for the series, fetches details (poster, overview, seasons), "
                "downloads the poster image, and creates a full series entry. "
                "If episode_title is provided, creates an episode entry (auto-creates show if missing)."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "Series title to search TMDB"},
                    "tmdb_id": {"type": "integer", "description": "TMDB TV series ID (skip search if provided, from search_series)"},
                    "year": {"type": "integer", "description": "First air date year to disambiguate"},
                    "rating": {"type": "integer", "minimum": 1, "maximum": 5},
                    "content": {"type": "string", "description": "Review body markdown"},
                    "locale": {"type": "string", "enum": ["en", "fr"], "default": "fr"},
                    "flags": {"type": "array", "items": {"type": "string"}, "default": [], "description": "Flags array (e.g. ['public'])"},
                    "tags": {"type": "array", "items": {"type": "string"}, "default": []},
                    "platform": {"type": "string", "description": "Streaming platform"},
                    "seasons_watched": {"type": "integer"},
                    "episode_title": {"type": "string", "description": "Episode title (triggers episode mode)"},
                    "episode_number": {"type": "integer"},
                    "season": {"type": "integer"},
                },
                "required": ["title"],
            },
        ),
        Tool(
            name="create_podcast_entry",
            description=(
                "Create a podcast entry by looking up metadata on Podcast Index. "
                "Searches for the podcast, fetches artwork, and creates a full podcast entry. "
                "If episode_title is provided, creates an episode entry (auto-creates show if missing)."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "Podcast title to search"},
                    "podcastindex_id": {"type": "integer", "description": "Podcast Index feed ID (skip search if provided, from search_podcast)"},
                    "content": {"type": "string", "description": "Review body markdown"},
                    "locale": {"type": "string", "enum": ["en", "fr"], "default": "fr"},
                    "flags": {"type": "array", "items": {"type": "string"}, "default": [], "description": "Flags array (e.g. ['public'])"},
                    "tags": {"type": "array", "items": {"type": "string"}, "default": []},
                    "episode_title": {"type": "string", "description": "Episode title (triggers episode mode)"},
                    "episode_number": {"type": "integer"},
                    "season": {"type": "integer"},
                    "guests": {"type": "array", "items": {"type": "string"}, "default": []},
                },
                "required": ["title"],
            },
        ),
        Tool(
            name="create_article_entry",
            description=(
                "Create an article entry by extracting Open Graph metadata from a URL. "
                "Fetches the page, extracts title/image/description/source, and creates an article entry."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "Article URL to fetch OG metadata from"},
                    "content": {"type": "string", "description": "Review body markdown"},
                    "locale": {"type": "string", "enum": ["en", "fr"], "default": "fr"},
                    "flags": {"type": "array", "items": {"type": "string"}, "default": [], "description": "Flags array (e.g. ['public'])"},
                    "tags": {"type": "array", "items": {"type": "string"}, "default": []},
                },
                "required": ["url"],
            },
        ),
        Tool(
            name="create_person_entry",
            description=(
                "Create a person entry by looking up metadata on Wikidata. "
                "Searches for the person, fetches image from Wikimedia Commons, "
                "and creates a full person entry."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "Person name to search"},
                    "wikidata_id": {"type": "string", "description": "Wikidata entity ID e.g. Q12345 (skip search if provided, from search_person)"},
                    "role": {"type": "string", "description": "Role/occupation"},
                    "content": {"type": "string", "description": "Body markdown"},
                    "locale": {"type": "string", "enum": ["en", "fr"], "default": "fr"},
                    "flags": {"type": "array", "items": {"type": "string"}, "default": [], "description": "Flags array (e.g. ['public'])"},
                    "tags": {"type": "array", "items": {"type": "string"}, "default": []},
                },
                "required": ["name"],
            },
        ),
        Tool(
            name="get_resource_entry",
            description=(
                "Get a resource entry's frontmatter and markdown body. "
                "Works for all resource collections: books, articles, movies, series, podcasts, people."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "collection": {
                        "type": "string",
                        "enum": ["books", "articles", "movies", "series", "podcasts", "people"],
                    },
                    "id": {"type": "string", "description": "Filename slug (no extension)"},
                    "locale": {"type": "string", "enum": ["en", "fr"], "default": "en"},
                },
                "required": ["collection", "id"],
            },
        ),
        Tool(
            name="update_resource_entry",
            description=(
                "Update an existing resource entry's frontmatter fields and/or body. "
                "Only provided fields are changed. Works for all resource collections."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "collection": {
                        "type": "string",
                        "enum": ["books", "articles", "movies", "series", "podcasts", "people"],
                    },
                    "id": {"type": "string", "description": "Filename slug (no extension)"},
                    "locale": {"type": "string", "enum": ["en", "fr"], "default": "en"},
                    "title": {"type": "string"},
                    "body": {"type": "string", "description": "Replace markdown body"},
                    "tags": {"type": "array", "items": {"type": "string"}},
                    "flags": {"type": "array", "items": {"type": "string"}, "description": "Replace flags array"},
                    "rating": {"type": "integer", "minimum": 1, "maximum": 5},
                    "image": {"type": ["string", "null"]},
                    "translationKey": {"type": "string"},
                    "author": {"type": "string"},
                    "status": {"type": "string"},
                    "date_read": {"type": "string"},
                    "director": {"type": "string"},
                    "year": {"type": "integer"},
                    "date_watched": {"type": "string"},
                    "source": {"type": "string"},
                    "url": {"type": "string"},
                    "platform": {"type": "string"},
                    "seasons_watched": {"type": "integer"},
                    "host": {"type": "string"},
                    "date_listened": {"type": "string"},
                    "name": {"type": "string"},
                    "role": {"type": "string"},
                },
                "required": ["collection", "id"],
            },
        ),
        Tool(
            name="list_resource_entries",
            description=(
                "List resource entries with optional filters. "
                "Returns summaries (frontmatter) without body content."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "collection": {
                        "type": "string",
                        "enum": ["books", "articles", "movies", "series", "podcasts", "people"],
                    },
                    "locale": {"type": "string", "enum": ["en", "fr"], "default": "en"},
                    "flag": {"type": "string", "description": "Filter: only entries with this flag (e.g. 'public')."},
                    "exclude_flag": {"type": "string", "description": "Filter: exclude entries with this flag."},
                },
                "required": ["collection"],
            },
        ),
        Tool(
            name="get_user_guide",
            description="Get the garden user guide with conventions, link syntax, and content structure. Call this when you need to know how to format links, structure content, or follow project conventions.",
            inputSchema={"type": "object", "properties": {}},
        ),
        # ── Hero image tools ──
        Tool(
            name="list_backlog",
            description=(
                "List all backlog items grouped by status. "
                "Scans akita-backlog-* notes (excluding the parent MOC) and returns items "
                "grouped by their frontmatter status field."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "locale": {"type": "string", "enum": ["en", "fr"], "default": "en"},
                },
            },
        ),
        Tool(
            name="generate_evocation",
            description=(
                "Generate a visual evocation description for a MOC note using AI. "
                "The evocation is a vivid, concrete, visual description used as input "
                "for hero image generation. Stored in moc-evocations.json."
            ),
            inputSchema={
                "type": "object",
                "required": ["id"],
                "properties": {
                    "id": {"type": "string", "description": "Note slug (must be a MOC)."},
                    "locale": {"type": "string", "enum": ["en", "fr"], "default": "en"},
                },
            },
        ),
        Tool(
            name="generate_hero_image",
            description=(
                "Generate an AI hero image for a MOC note using fal.ai Flux. "
                "Combines a style preamble with an evocation description to produce "
                "a 1536×512 banner image. Saves to content images and updates note frontmatter."
            ),
            inputSchema={
                "type": "object",
                "required": ["id", "style"],
                "properties": {
                    "id": {"type": "string", "description": "Note slug (must be a MOC)."},
                    "locale": {"type": "string", "enum": ["en", "fr"], "default": "en"},
                    "style": {
                        "type": "string",
                        "enum": list(HERO_STYLES.keys()),
                        "description": "Visual style for the image.",
                    },
                    "evocation": {
                        "type": "string",
                        "description": "Override evocation text (otherwise uses stored or auto-generated).",
                    },
                },
            },
        ),
        Tool(
            name="deploy_site",
            description=(
                "Build and deploy the Astro site to Cloudflare Pages. Runs the "
                "configured publish script ([deploy] script in config.toml): pulls "
                "content, builds, and deploys with wrangler."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "confirm": {
                        "type": "boolean",
                        "description": "Must be true to confirm deployment.",
                    },
                },
                "required": ["confirm"],
            },
        ),
    ]
    return [t for t in tools if _tool_allowed(t.name)]


# ---------------------------------------------------------------------------
# User guide
# ---------------------------------------------------------------------------

_USER_GUIDE = """\
# Garden User Guide

## Content Structure

Content lives in a git repo with this structure:
```
{collection}/{locale}/{slug}.md        — resource entries (books, articles, movies, series, podcasts, people)
{collection}/{locale}/{slug}-fiche.md  — fiches (personal sidecar notes, dev-only)
notes/{locale}/{slug}.md               — garden notes
```

Locales: `en`, `fr`. Default is `en` but most content is in French (`fr`).

## URL Patterns

| Content type | URL |
|---|---|
| Note | `/{locale}/notes/{slug}` |
| Resource | `/{locale}/resources/{collection}/{slug}` |
| Fiche | `/{locale}/fiches/{collection}/{slug}-fiche` |
| Essay | `/{locale}/essays/{slug}` |
| Blog | `/{locale}/blog/{slug}` |

Note: `{locale}` is omitted for English (e.g. `/notes/foo` not `/en/notes/foo`).

## Link Syntax

### In notes (wiki-links)
Notes support `[[wiki-link]]` syntax:
- `[[slug]]` — links to `/notes/{slug}`, displayed as the slug
- `[[slug|Display Text]]` — links to `/notes/{slug}`, displayed as "Display Text"
- Wiki-links to MOC notes (flags includes 'moc') are automatically rendered as visual cards

### In fiches and resources (standard markdown)
Use standard markdown links with full paths:
- `[Title](/{locale}/fiches/{collection}/{slug}-fiche)` — link to a fiche
- `[Title](/{locale}/resources/{collection}/{slug})` — link to a resource
- `[Title](/{locale}/notes/{slug})` — link to a note

Examples:
- `[Marc Zimmermann](/fr/fiches/people/marc-zimmermann-fiche)`
- `[What the Buddha Taught](/fr/resources/books/what-the-buddha-taught)`
- `[Enquête personnelle](/fr/notes/enquete-personnelle)`

### Cross-references in notes
Notes also support typed cross-refs in link URLs:
- `[Title](book:what-the-buddha-taught)` — auto-routed to `/resources/books/what-the-buddha-taught`
- `[Title](movie:some-film)` — auto-routed to `/resources/movies/some-film`
- Supported prefixes: book, movie, film, series, article, podcast, person, essay, blog, note

## Notes Conventions

- `flags: [moc]` — Map of Content, rendered with hero header and child cards/list
- `flags: [encrypted]` — encrypted at build time, visible in listings with a lock icon
- `flags: [public]` — visible in production; items without 'public' flag are drafts (dev only)
- MOC body uses wiki-links to define children: `[[child-slug]]`
- MOC children that are themselves MOCs render as visual cards; regular notes render as a list
- **MOC wikilink formatting**: wikilinks in MOC bodies must NOT be inside list items (no `- ` prefix). Each wikilink must be on its own line, separated by a blank line from the next. This is required for the card/description rendering to work. Inline annotations after the wikilink (e.g. `— *comment*`) are fine.

## Custom Frontmatter Fields

`create_note` and `update_note` support these structured fields beyond the basics:

- `parent` (string) — parent note slug for hierarchy (e.g. `sante-coaching-fitness`)
- `category` (string) — category slug (e.g. `health`)
- `active_from` / `active_until` (ISO date string) — temporal activation window for coaching plans
- `coaching_metrics` (array) — coaching metric definitions consumed by the adherence engine. Each item requires `pillar` and `signal_category`; optional keys: `match` (object), `frequency` (string like `3/week`), `duration_min` (int), `enumerate` (bool), `max_per_day` (int)
- `extra_frontmatter` (object) — arbitrary key/value pairs merged into frontmatter. Keys must not collide with known fields.

In `update_note`, passing `null` for any of these removes the key from frontmatter. Omitting the parameter leaves it untouched.

## Fiches Conventions

- Fiches are dev-only (not built for production)
- Filename pattern: `{slug}-fiche.md`
- Fiches can be promoted to full resource entries via `promote_fiche`
- Pre-fetched metadata is stored in the `meta` frontmatter field
"""


# ---------------------------------------------------------------------------
# Tool handlers
# ---------------------------------------------------------------------------

@app.call_tool()
async def call_tool(name: str, arguments: Any) -> list[TextContent]:
    try:
        args = arguments or {}
        if not _tool_allowed(name):
            return [TextContent(type="text", text=f"Tool '{name}' is not available in this build.")]
        if name == "create_note":
            result = _handle_create_note(args)
        elif name == "delete_note":
            result = _handle_delete_note(args)
        elif name == "toggle_public":
            result = _handle_toggle_public(args)
        elif name == "toggle_private":
            result = _handle_toggle_private(args)
        elif name == "get_note":
            result = _handle_get_note(args)
        elif name == "update_note":
            result = _handle_update_note(args)
        elif name == "set_image":
            result = _handle_set_image(args)
        elif name == "list_notes":
            result = _handle_list_notes(args)
        elif name == "write_dream":
            result = _handle_write_dream(args)
        elif name == "search_dreams":
            result = _handle_search_dreams(args)
        elif name == "get_dream":
            result = _handle_get_dream(args)
        elif name == "link_dream_entities":
            result = _handle_link_dream_entities(args)
        elif name == "write_daily_note":
            result = _handle_write_daily_note(args)
        elif name == "search_daily_notes":
            result = _handle_search_daily_notes(args)
        elif name == "get_daily_note":
            result = _handle_get_daily_note(args)
        elif name == "link_daily_note_entities":
            result = _handle_link_daily_note_entities(args)
        elif name == "list_coaching_plans":
            result = _handle_list_coaching_plans(args)
        elif name == "link_contact_to_person":
            result = _handle_link_contact(args)
        elif name == "find_person_by_contact":
            result = _handle_find_person_by_contact(args)
        elif name == "create_contact_fiche":
            result = _handle_create_contact_fiche(args)
        elif name == "list_backlog":
            result = _handle_list_backlog(args)
        elif name == "get_user_guide":
            result = {"guide": _USER_GUIDE}
        elif name == "create_fiche":
            result = await asyncio.to_thread(_handle_create_fiche, args)
        elif name == "get_fiche":
            result = _handle_get_fiche(args)
        elif name == "update_fiche":
            result = _handle_update_fiche(args)
        elif name == "list_fiches":
            result = _handle_list_fiches(args)
        elif name == "delete_fiche":
            result = _handle_delete_fiche(args)
        elif name == "promote_fiche":
            result = await asyncio.to_thread(_handle_promote_fiche, args)
        # ── Fragment tools ──
        elif name == "append_fragment":
            result = _handle_append_fragment(args)
        elif name == "list_fragments":
            result = _handle_list_fragments(args)
        elif name == "get_fragment":
            result = _handle_get_fragment(args)
        elif name == "update_fragment":
            result = _handle_update_fragment(args)
        elif name == "delete_fragment":
            result = _handle_delete_fragment(args)
        elif name == "update_fragment_summary":
            result = _handle_update_fragment_summary(args)
        # ── Resource management tools ──
        elif name == "publish_content":
            result = _handle_publish_content(args)
        elif name == "search_movie":
            result = await _handle_search_movie(args)
        elif name == "search_book":
            result = await _handle_search_book(args)
        elif name == "search_series":
            result = await _handle_search_series(args)
        elif name == "search_podcast":
            result = await _handle_search_podcast(args)
        elif name == "search_person":
            result = await _handle_search_person(args)
        elif name == "search_series_episodes":
            result = await _handle_search_series_episodes(args)
        elif name == "search_podcast_episodes":
            result = await _handle_search_podcast_episodes(args)
        elif name == "create_movie_entry":
            result = await _handle_create_movie_entry(args)
        elif name == "create_book_entry":
            result = await _handle_create_book_entry(args)
        elif name == "create_series_entry":
            result = await _handle_create_series_entry(args)
        elif name == "create_podcast_entry":
            result = await _handle_create_podcast_entry(args)
        elif name == "create_article_entry":
            result = await _handle_create_article_entry(args)
        elif name == "create_person_entry":
            result = await _handle_create_person_entry(args)
        elif name == "get_resource_entry":
            result = _handle_get_resource(args)
        elif name == "update_resource_entry":
            result = _handle_update_resource(args)
        elif name == "list_resource_entries":
            result = _handle_list_resources(args)
        # ── Hero image tools ──
        elif name == "generate_evocation":
            result = await asyncio.to_thread(_handle_generate_evocation, args)
        elif name == "generate_hero_image":
            result = await _handle_generate_hero_image(args)
        elif name == "deploy_site":
            result = await asyncio.to_thread(_handle_deploy_site, args)
        else:
            return [TextContent(type="text", text=f"Unknown tool: {name}")]
        return [TextContent(type="text", text=json.dumps(result, ensure_ascii=False, indent=2, default=_json_default))]
    except Exception as exc:
        return [TextContent(type="text", text=f"Error: {exc}")]


def _handle_create_note(args: dict[str, Any]) -> dict[str, Any]:
    note_id = args["id"]
    title = args["title"]
    locale = args.get("locale", "en")
    body = args.get("body", "")
    path = _resolve_note_path(note_id, locale)

    if path.exists():
        raise ValueError(f"Note '{note_id}' already exists at {path}")

    # Ensure locale directory exists
    path.parent.mkdir(parents=True, exist_ok=True)

    fm: dict[str, Any] = {
        "title": title,
        "date": date.today().isoformat(),
        "flags": args.get("flags", []),
        "locale": locale,
    }

    description = args.get("description")
    if description:
        fm["description"] = description

    tags = args.get("tags", [])
    if tags:
        fm["tags"] = tags

    image = args.get("image")
    if image:
        fm["image"] = image

    icon = args.get("icon")
    if icon:
        fm["icon"] = icon

    # Custom structured fields
    for key in ("parent", "category", "active_from", "active_until"):
        if key in args and args[key]:
            fm[key] = args[key]

    if "coaching_metrics" in args and args["coaching_metrics"]:
        fm["coaching_metrics"] = args["coaching_metrics"]

    # Generic extra frontmatter
    _RESERVED_KEYS = {"id", "title", "date", "flags", "locale", "body", "description", "tags", "image", "icon", "parent", "category", "active_from", "active_until", "coaching_metrics", "extra_frontmatter"}
    extra = args.get("extra_frontmatter")
    if extra and isinstance(extra, dict):
        bad_keys = set(extra.keys()) & _RESERVED_KEYS
        if bad_keys:
            raise ValueError(f"extra_frontmatter keys collide with known fields: {bad_keys}")
        for k, v in extra.items():
            if v is None:
                fm.pop(k, None)
            else:
                fm[k] = v

    _write_note(path, fm, body if body.startswith("\n") else f"\n{body}\n" if body else "\n")
    _auto_commit([path], f"Create note: {note_id}")

    return {"created": note_id, "path": _rel(path)}


def _handle_delete_note(args: dict[str, Any]) -> dict[str, Any]:
    if not args.get("confirm"):
        raise ValueError("confirm must be true to delete a note")

    note_id = args["id"]
    locale = args.get("locale", "en")
    path = _resolve_note_path(note_id, locale)

    if not path.exists():
        raise ValueError(f"Note '{note_id}' not found at {path}")

    # Check for associated image (.jpg or .svg)
    image_deleted = False
    image_path = None
    for ext in (".jpg", ".svg"):
        candidate = member_root() / "images" / "notes" / f"{note_id}{ext}"
        if candidate.exists():
            image_path = candidate
            break

    # Also remove _fragments/ directory if it exists
    fdir = _fragments_dir(path)

    abs_targets = [path]
    if image_path:
        abs_targets.append(image_path)
    if fdir.exists():
        abs_targets.extend(fdir.glob("*.frag"))

    if _remove_paths(abs_targets, f"Delete note: {note_id}"):
        image_deleted = image_path is not None
    else:
        # No gardens repo (or git failed): remove the files directly.
        path.unlink(missing_ok=True)
        if image_path:
            image_path.unlink(missing_ok=True)
            image_deleted = True
        if fdir.exists():
            import shutil
            shutil.rmtree(fdir, ignore_errors=True)

    _push_note_to_corpus(path, deleted=True)
    return {"deleted": note_id, "image_deleted": image_deleted}


def _handle_toggle_public(args: dict[str, Any]) -> dict[str, Any]:
    note_id = args["id"]
    locale = args.get("locale", "en")
    path = _resolve_note_path(note_id, locale)

    if not path.exists():
        raise ValueError(f"Note '{note_id}' not found at {path}")

    fm, body = _parse_note(path)
    flags = fm.get("flags", [])
    if "public" in flags:
        flags = [f for f in flags if f != "public"]
    else:
        flags = flags + ["public"]
    fm["flags"] = flags
    _write_note(path, fm, body)
    _auto_commit([path], f"Toggle public: {note_id} -> {'public' in fm['flags']}")

    return {"id": note_id, "public": "public" in fm["flags"]}


def _handle_toggle_private(args: dict[str, Any]) -> dict[str, Any]:
    note_id = args["id"]
    locale = args.get("locale", "en")
    path = _resolve_note_path(note_id, locale)

    if not path.exists():
        raise ValueError(f"Note '{note_id}' not found at {path}")

    fm, body = _parse_note(path)
    flags = fm.get("flags", [])
    if "encrypted" in flags:
        flags = [f for f in flags if f != "encrypted"]
    else:
        flags = flags + ["encrypted"]
    fm["flags"] = flags
    _write_note(path, fm, body)
    _auto_commit([path], f"Toggle private: {note_id} -> {'encrypted' in fm['flags']}")

    return {"id": note_id, "private": "encrypted" in fm["flags"]}



def _handle_get_note(args: dict[str, Any]) -> dict[str, Any]:
    note_id = args["id"]
    locale = args.get("locale", "en")
    path = _resolve_note_path(note_id, locale)

    if not path.exists():
        raise ValueError(f"Note '{note_id}' not found at {path}")

    fm, body = _parse_note(path)
    return {"id": note_id, "frontmatter": fm, "body": body.strip()}


def _handle_update_note(args: dict[str, Any]) -> dict[str, Any]:
    note_id = args["id"]
    locale = args.get("locale", "en")
    path = _resolve_note_path(note_id, locale)

    if not path.exists():
        raise ValueError(f"Note '{note_id}' not found at {path}")

    fm, body = _parse_note(path)
    updated_fields = []

    for key in ("title", "description", "flags", "status", "order"):
        if key in args:
            val = args[key]
            if val is None:
                fm.pop(key, None)
            else:
                fm[key] = val
            updated_fields.append(key)

    if "tags" in args:
        fm["tags"] = args["tags"]
        updated_fields.append("tags")

    if "image" in args:
        if args["image"]:
            fm["image"] = args["image"]
        else:
            fm.pop("image", None)
        updated_fields.append("image")

    if "icon" in args:
        if args["icon"]:
            fm["icon"] = args["icon"]
        else:
            fm.pop("icon", None)
        updated_fields.append("icon")

    # Custom structured fields — null removes, value sets
    for key in ("parent", "category", "active_from", "active_until"):
        if key in args:
            if args[key] is None:
                fm.pop(key, None)
            else:
                fm[key] = args[key]
            updated_fields.append(key)

    if "coaching_metrics" in args:
        if args["coaching_metrics"] is None:
            fm.pop("coaching_metrics", None)
        else:
            fm["coaching_metrics"] = args["coaching_metrics"]
        updated_fields.append("coaching_metrics")

    # Generic extra frontmatter
    _RESERVED_KEYS = {"id", "title", "date", "flags", "locale", "body", "description", "tags", "image", "icon", "parent", "category", "active_from", "active_until", "coaching_metrics", "extra_frontmatter", "status", "order"}
    extra = args.get("extra_frontmatter")
    if extra and isinstance(extra, dict):
        bad_keys = set(extra.keys()) & _RESERVED_KEYS
        if bad_keys:
            raise ValueError(f"extra_frontmatter keys collide with known fields: {bad_keys}")
        for k, v in extra.items():
            if v is None:
                fm.pop(k, None)
            else:
                fm[k] = v
        updated_fields.append("extra_frontmatter")

    if "body" in args:
        body = args["body"]
        if not body.startswith("\n"):
            body = f"\n{body}\n"
        updated_fields.append("body")

    _write_note(path, fm, body)
    _auto_commit([path], f"Update note: {note_id}")
    return {"id": note_id, "updated": updated_fields}


def _handle_set_image(args: dict[str, Any]) -> dict[str, Any]:
    note_id = args["id"]
    locale = args.get("locale", "en")
    path = _resolve_note_path(note_id, locale)

    if not path.exists():
        raise ValueError(f"Note '{note_id}' not found at {path}")

    fm, body = _parse_note(path)
    image = args.get("image")
    if image:
        fm["image"] = image
    else:
        fm.pop("image", None)
    _write_note(path, fm, body)
    _auto_commit([path], f"Set image: {note_id}")

    return {"id": note_id, "image": fm.get("image")}


def _handle_list_notes(args: dict[str, Any]) -> dict[str, Any]:
    locale = args.get("locale", "en")
    locale_dir = content_root() / locale

    if not locale_dir.is_dir():
        return {"notes": [], "count": 0}

    notes = []
    for md_file in sorted(locale_dir.glob("*.md")):
        try:
            fm, _ = _parse_note(md_file)
        except ValueError:
            continue

        note_id = md_file.stem

        # Apply filters
        if "flag" in args and args["flag"] not in fm.get("flags", []):
            continue
        if "exclude_flag" in args and args["exclude_flag"] in fm.get("flags", []):
            continue
        if "tag" in args:
            note_tags = [t.lower() for t in fm.get("tags", [])]
            if args["tag"].lower() not in note_tags:
                continue

        notes.append(_note_summary(note_id, fm))

    return {"notes": notes, "count": len(notes)}


def _slugify(text: str) -> str:
    """Simple ASCII slug from text."""
    import unicodedata, re
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    text = re.sub(r"[^\w\s-]", "", text.lower())
    return re.sub(r"[-\s]+", "-", text).strip("-")[:40]


def _handle_write_journal(args: dict[str, Any], jtype: _JournalType) -> dict[str, Any]:
    title = args["title"]
    body = args["body"]
    entry_date = args.get("date", date.today().isoformat())
    slug = args.get("slug") or _slugify(title)
    note_id = f"{jtype.prefix}-{entry_date}-{slug}"

    extra_tags = args.get("tags", [])
    tags = [jtype.tag] + [t for t in extra_tags if t.lower() != jtype.tag]

    create_args: dict[str, Any] = {
        "id": note_id,
        "title": title,
        "locale": "fr",
        "body": body,
        "tags": tags,
        "flags": ["encrypted"],
        "icon": jtype.icon,
    }
    description = args.get("description")
    if description:
        create_args["description"] = description

    result = _handle_create_note(create_args)

    # Overwrite the date in frontmatter if not today
    if entry_date != date.today().isoformat():
        path = _resolve_note_path(note_id, "fr")
        fm, body_text = _parse_note(path)
        fm["date"] = entry_date
        _write_note(path, fm, body_text)
        _auto_commit([path], f"Update {jtype.prefix} date: {note_id}")

    # Append wikilink to the MoC (prepend so newest entries appear first)
    moc_path = content_root() / "fr" / f"{jtype.moc_slug}.md"
    if moc_path.exists():
        moc_fm, moc_body = _parse_note(moc_path)
        wikilink = f"[[{note_id}|{title}]]"
        if note_id not in moc_body:
            # Insert after the first paragraph (intro text)
            lines = moc_body.split("\n")
            insert_idx = 0
            # Find end of intro: first blank line after content
            found_content = False
            for i, line in enumerate(lines):
                if line.strip():
                    found_content = True
                elif found_content:
                    insert_idx = i
                    break
            if not found_content:
                insert_idx = len(lines)
            lines.insert(insert_idx, f"\n{wikilink}")
            _write_note(moc_path, moc_fm, "\n".join(lines))
            _auto_commit([moc_path], f"Add {jtype.prefix} entry to MoC: {note_id}")

    return result


def _handle_write_dream(args: dict[str, Any]) -> dict[str, Any]:
    return _handle_write_journal(args, DREAM)


def _handle_write_daily_note(args: dict[str, Any]) -> dict[str, Any]:
    return _handle_write_journal(args, DAILY)


def _handle_search_journal(args: dict[str, Any], jtype: _JournalType) -> dict[str, Any]:
    locale_dir = content_root() / "fr"
    if not locale_dir.is_dir():
        return {"entries": [], "count": 0}

    query = args.get("query", "").lower()
    start_date = args.get("start_date")
    end_date = args.get("end_date")
    limit = args.get("limit", 20)

    entries = []
    for md_file in sorted(locale_dir.glob("*.md")):
        try:
            fm, body = _parse_note(md_file)
        except ValueError:
            continue

        tags = [t.lower() for t in fm.get("tags", [])]
        if jtype.tag not in tags:
            continue

        note_id = md_file.stem
        note_date = str(fm.get("date", ""))

        if start_date and note_date < start_date:
            continue
        if end_date and note_date > end_date:
            continue

        if query:
            title = fm.get("title", "").lower()
            desc = fm.get("description", "").lower()
            if query not in title and query not in desc and query not in body.lower():
                continue

        summary = _note_summary(note_id, fm)
        summary["description"] = fm.get("description", "")
        clean_body = body.strip()
        if clean_body:
            summary["preview"] = clean_body[:200]
        entries.append(summary)

    entries.sort(key=lambda d: d.get("date", ""), reverse=True)
    entries = entries[:limit]

    return {"entries": entries, "count": len(entries)}


def _handle_search_dreams(args: dict[str, Any]) -> dict[str, Any]:
    return _handle_search_journal(args, DREAM)


def _handle_search_daily_notes(args: dict[str, Any]) -> dict[str, Any]:
    return _handle_search_journal(args, DAILY)


def _find_journal_entry(args: dict[str, Any], jtype: _JournalType) -> tuple[str, dict[str, Any], str]:
    """Find a journal entry by id or date. Returns (note_id, frontmatter, body)."""
    locale_dir = content_root() / "fr"

    if "id" in args and args["id"]:
        note_id = args["id"]
        path = locale_dir / f"{note_id}.md"
        if not path.exists():
            raise ValueError(f"{jtype.label_fr} entry '{note_id}' not found")
        fm, body = _parse_note(path)
        tags = [t.lower() for t in fm.get("tags", [])]
        if jtype.tag not in tags:
            raise ValueError(f"Note '{note_id}' is not a {jtype.label_fr} entry (missing {jtype.tag} tag)")
        return note_id, fm, body

    if "date" in args and args["date"]:
        target_date = args["date"]
        for md_file in sorted(locale_dir.glob("*.md")):
            try:
                fm, body = _parse_note(md_file)
            except ValueError:
                continue
            tags = [t.lower() for t in fm.get("tags", [])]
            if jtype.tag not in tags:
                continue
            if str(fm.get("date", "")) == target_date:
                return md_file.stem, fm, body
        raise ValueError(f"No {jtype.label_fr} entry found for date {target_date}")

    raise ValueError("Provide either 'id' or 'date'")


def _handle_get_journal(args: dict[str, Any], jtype: _JournalType) -> dict[str, Any]:
    note_id, fm, body = _find_journal_entry(args, jtype)
    return {
        "id": note_id,
        "frontmatter": fm,
        "body": body.strip(),
    }


def _handle_get_dream(args: dict[str, Any]) -> dict[str, Any]:
    return _handle_get_journal(args, DREAM)


def _handle_get_daily_note(args: dict[str, Any]) -> dict[str, Any]:
    return _handle_get_journal(args, DAILY)


def _extract_names_from_text(text: str) -> list[dict[str, str]]:
    """Use an LLM to extract character names from dream text.

    Returns a list of {name, context} dicts — the name as it appears in the
    text and a short phrase describing their role in the dream.
    """
    import anthropic

    prompt = f"""\
Extract all people (characters) mentioned in this dream narrative.
For each person, return their name exactly as written and a very short phrase
(5-10 words) describing their role or what they do in the dream.

Only include actual people — not places, objects, or abstract concepts.
Include unnamed people only if they play a significant role (e.g. "un homme",
"ma mère") — use the description given in the text as their name.

Return a JSON array of objects with "name" and "context" keys.
Return [] if no people are mentioned.
Respond with ONLY the JSON array, no preamble.

Dream text:
{text[:3000]}"""

    client = anthropic.Anthropic(api_key=_anthropic_key())
    response = client.messages.create(
        model=_resolve_model("dream_analysis", fallback="claude-haiku-4-5-20251001"),
        max_tokens=500,
        messages=[{"role": "user", "content": prompt}],
    )
    raw = response.content[0].text.strip()
    # Strip markdown code fences if present
    if raw.startswith("```"):
        raw = re.sub(r"^```(?:json)?\s*\n?", "", raw)
        raw = re.sub(r"\n?```\s*$", "", raw)
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        LOGGER.warning("Failed to parse LLM name extraction: %s", raw)
        return []


def _build_known_people_map() -> dict[str, dict[str, str]]:
    """Scan all people fiches and return a map of lowercase name → {person_id, name, fiche_path}.

    Includes the title and any aliases for fuzzy matching.
    """
    known: dict[str, dict[str, str]] = {}
    for locale in ("fr", "en"):
        people_dir = member_root() / "people" / locale
        if not people_dir.is_dir():
            continue
        for md_file in people_dir.glob("*-fiche.md"):
            try:
                pfm, _ = _parse_note(md_file)
            except ValueError:
                continue
            person_id = pfm.get("resource_id", md_file.stem.removesuffix("-fiche"))
            title = pfm.get("title") or pfm.get("name", "")
            if not title:
                continue
            entry = {
                "person_id": person_id,
                "name": title,
                "fiche_path": str(md_file),
                "carddav_uid": pfm.get("carddav_uid", ""),
            }
            # Index by full name and first name (lowercase)
            known[title.lower()] = entry
            first_name = title.split()[0].lower() if title else ""
            if first_name and first_name not in known:
                known[first_name] = entry
    return known


def _create_contact_fiche(
    name: str,
    person_id: str,
    carddav_uid: str | None = None,
    locale: str = "fr",
    tags: list[str] | None = None,
    body: str = "\n",
    entry_date: str | None = None,
) -> dict[str, Any]:
    """Create a contact fiche for a person. Returns status dict."""
    fiche_path = _resolve_fiche_path("people", person_id, locale)
    if fiche_path.exists():
        return {"created": False, "already_existed": True, "fiche_path": _rel(fiche_path)}

    fiche_path.parent.mkdir(parents=True, exist_ok=True)
    fiche_fm: dict[str, Any] = {
        "title": name,
        "resource_collection": "people",
        "resource_id": person_id,
        "date": entry_date or date.today().isoformat(),
        "tags": tags or [],
        "locale": locale,
        "meta": {},
    }
    if carddav_uid:
        fiche_fm["carddav_uid"] = carddav_uid

    _write_note(fiche_path, fiche_fm, body if body.startswith("\n") else f"\n{body}\n" if body else "\n")
    LOGGER.info("Created contact fiche: %s", fiche_path)
    return {"created": True, "already_existed": False, "fiche_path": _rel(fiche_path)}


def _replace_name_in_body(body: str, name: str, person_id: str) -> str:
    """Replace bare name mentions with markdown fiche links in dream body.

    Handles both bare text and existing wikilinks like [[slug|Name]].
    Skips text that's already inside a markdown link.
    """
    fiche_url = f"/fr/fiches/people/{person_id}-fiche"

    # First: replace wikilinks containing this name as display text: [[anything|Name]]
    wikilink_pattern = re.compile(r"\[\[[^\]]*\|" + re.escape(name) + r"\]\]")
    body = wikilink_pattern.sub(f"[{name}]({fiche_url})", body)

    # Also replace simple wikilinks [[slug]] where slug matches the person_id
    simple_wikilink = re.compile(r"\[\[" + re.escape(person_id) + r"\]\]")
    body = simple_wikilink.sub(f"[{person_id}]({fiche_url})", body)

    # Then: replace bare name mentions (word boundary), but skip if already inside [...](...)
    # Pattern: name that is NOT preceded by [ and NOT followed by ](
    # Use a negative lookbehind/lookahead to skip already-linked text
    bare_pattern = re.compile(
        r"(?<!\[)" + re.escape(name) + r"(?!\]|\()",
        re.IGNORECASE,
    )

    def _replace_if_not_linked(m: re.Match) -> str:
        # Check if we're inside an existing markdown link by looking at surrounding context
        start = m.start()
        # Look backwards for an unclosed [
        before = body[:start]
        bracket_depth = 0
        for ch in reversed(before):
            if ch == "]":
                break
            if ch == "[":
                bracket_depth += 1
                break
        if bracket_depth > 0:
            return m.group(0)  # inside a link, don't replace
        return f"[{name}]({fiche_url})"

    body = bare_pattern.sub(_replace_if_not_linked, body)
    return body


def _add_journal_backlink(fiche_path: Path, entry_id: str, entry_date: str, context: str, jtype: _JournalType) -> bool:
    """Add a back-link to a journal entry in the person fiche's section.

    Returns True if the fiche was modified.
    """
    fm, body = _parse_note(fiche_path)
    backlink_line = f"- [{entry_date}](/fr/notes/{entry_id}) — {context}"

    # Check if already linked
    if f"/fr/notes/{entry_id}" in body:
        return False

    heading = jtype.backlink_heading
    if heading in body:
        idx = body.index(heading) + len(heading)
        next_heading = re.search(r"\n## ", body[idx:])
        if next_heading:
            insert_pos = idx + next_heading.start()
        else:
            insert_pos = len(body)
        body = body[:insert_pos].rstrip() + "\n" + backlink_line + "\n" + body[insert_pos:]
    else:
        body = body.rstrip() + "\n\n" + heading + "\n\n" + backlink_line + "\n"

    _write_note(fiche_path, fm, body)
    return True


def _handle_link_journal_entities(args: dict[str, Any], jtype: _JournalType) -> dict[str, Any]:
    note_id, fm, body = _find_journal_entry(args, jtype)
    original_body = body
    entry_date = str(fm.get("date", ""))

    # 1. Extract character names via LLM
    full_text = f"{fm.get('title', '')} {fm.get('description', '')} {body}"
    characters = _extract_names_from_text(full_text)

    # 2. Build known people map from existing fiches
    known_people = _build_known_people_map()

    # 3. Process explicit people overrides first
    explicit_matches: dict[str, dict[str, str]] = {}
    for person in args.get("people") or []:
        explicit_matches[person["name"].lower()] = {
            "person_id": person["person_id"],
            "name": person["name"],
            "carddav_uid": person.get("carddav_uid", ""),
        }

    # 4. Match characters to known people or explicit matches
    linked: list[dict[str, str]] = []
    unmatched: list[dict[str, str]] = []
    modified_paths: list[Path] = []

    for char in characters:
        char_name = char["name"]
        char_context = char.get("context", "")
        char_lower = char_name.lower()

        match = explicit_matches.get(char_lower) or known_people.get(char_lower)

        if not match:
            first_name = char_name.split()[0].lower() if char_name else ""
            match = explicit_matches.get(first_name) or known_people.get(first_name)

        if match:
            person_id = match["person_id"]
            fiche_filename = f"{person_id}-fiche.md"
            fiche_path = member_root() / "people" / "fr" / fiche_filename

            if not fiche_path.exists() and match.get("carddav_uid"):
                _create_contact_fiche(
                    name=match["name"],
                    person_id=person_id,
                    carddav_uid=match["carddav_uid"],
                    entry_date=entry_date,
                )

            body = _replace_name_in_body(body, char_name, person_id)

            if fiche_path.exists():
                if _add_journal_backlink(fiche_path, note_id, entry_date, char_context, jtype):
                    modified_paths.append(fiche_path)

            linked.append({"name": char_name, "person_id": person_id, "status": "linked"})
        else:
            unmatched.append({"name": char_name, "context": char_context})

    # 5. Clean up tags: remove person names
    linked_names_lower = {l["name"].lower() for l in linked}
    linked_person_ids = {l["person_id"].lower() for l in linked}
    original_tags = fm.get("tags", [])
    cleaned_tags = [
        t for t in original_tags
        if t.lower() not in linked_names_lower
        and t.lower() not in linked_person_ids
        and t.split()[0].lower() not in linked_names_lower
    ]
    tags_changed = cleaned_tags != original_tags
    if tags_changed:
        fm["tags"] = cleaned_tags

    # 6. Write updated note
    body_changed = body != original_body
    if body_changed or tags_changed:
        entry_path = content_root() / "fr" / f"{note_id}.md"
        _write_note(entry_path, fm, body)
        modified_paths.insert(0, entry_path)

    # 7. Auto-commit all changes
    if modified_paths:
        fiches_str = ", ".join(l["person_id"] for l in linked)
        _auto_commit(modified_paths, f"Link {jtype.prefix} entities: {note_id} → {fiches_str}")

    return {
        "id": note_id,
        "linked": linked,
        "unmatched": unmatched,
        "body_updated": body_changed,
        "tags_cleaned": tags_changed,
        "fiches_updated": [_rel(p) for p in modified_paths[1:] if p != modified_paths[0]] if modified_paths else [],
    }


def _handle_link_dream_entities(args: dict[str, Any]) -> dict[str, Any]:
    return _handle_link_journal_entities(args, DREAM)


def _handle_link_daily_note_entities(args: dict[str, Any]) -> dict[str, Any]:
    return _handle_link_journal_entities(args, DAILY)


def _handle_list_coaching_plans(args: dict[str, Any]) -> dict[str, Any]:
    from datetime import date as _date

    filter_date_str = args.get("date")
    filter_date = _date.fromisoformat(filter_date_str) if filter_date_str else None
    today = _date.today()

    plans: list[dict[str, Any]] = []
    for md_file in content_root().rglob("*.md"):
        try:
            fm, _ = _parse_note(md_file)
        except (ValueError, Exception):
            continue
        metrics = fm.get("coaching_metrics")
        if not metrics or not isinstance(metrics, list):
            continue
        tags = fm.get("tags", [])
        if "coaching" not in tags:
            continue
        flags = fm.get("flags", [])
        if "public" in flags:
            continue
        # Skip archived plans
        if "archived" in flags:
            continue

        active_from_str = fm.get("active_from")
        active_from = _date.fromisoformat(str(active_from_str)) if active_from_str else None
        active_until_str = fm.get("active_until")
        active_until = _date.fromisoformat(str(active_until_str)) if active_until_str else None

        # Filter by date if requested
        if filter_date:
            if active_from and filter_date < active_from:
                continue
            if active_until and filter_date > active_until:
                continue

        # currently_active: always active if no active_from
        if active_from is None:
            currently_active = active_until is None or today <= active_until
        else:
            currently_active = active_from <= today and (active_until is None or today <= active_until)

        plans.append({
            "id": md_file.stem,
            "title": fm.get("title", md_file.stem),
            "icon": fm.get("icon", ""),
            "active_from": active_from.isoformat() if active_from else None,
            "active_until": active_until.isoformat() if active_until else None,
            "currently_active": currently_active,
            "metrics_count": len(metrics),
            "tags": tags,
            "category": fm.get("category"),
            "parent": fm.get("parent"),
        })
    plans.sort(key=lambda p: (not p["currently_active"], p["title"]))
    return {"plans": plans, "count": len(plans)}


def _scan_people_for_carddav_uid(carddav_uid: str) -> dict[str, Any] | None:
    """Scan person fiches and resource entries for a matching carddav_uid."""
    for locale in ("fr", "en"):
        people_dir = member_root() / "people" / locale
        if not people_dir.is_dir():
            continue
        for md_file in people_dir.glob("*.md"):
            try:
                fm, body = _parse_note(md_file)
            except ValueError:
                continue
            if fm.get("carddav_uid") == carddav_uid:
                slug = md_file.stem
                # Strip -fiche suffix if present
                if slug.endswith("-fiche"):
                    slug = slug[:-6]
                is_fiche = md_file.stem.endswith("-fiche")
                return {
                    "person_id": slug,
                    "locale": locale,
                    "is_fiche": is_fiche,
                    "frontmatter": fm,
                }
    return None


def _handle_link_contact(args: dict[str, Any]) -> dict[str, Any]:
    carddav_uid = args["carddav_uid"]
    person_id = args["person_id"]
    locale = args.get("locale", "fr")

    # Try fiche first, then resource entry
    fiche_path = _resolve_fiche_path("people", person_id, locale)
    resource_path = _resolve_resource_path("people", person_id, locale)

    if fiche_path.exists():
        path = fiche_path
    elif resource_path.exists():
        path = resource_path
    else:
        raise ValueError(
            f"Person '{person_id}' not found as fiche or resource in people/{locale}"
        )

    fm, body = _parse_note(path)
    fm["carddav_uid"] = carddav_uid
    _write_note(path, fm, body)
    _auto_commit([path], f"Link contact {carddav_uid} to person {person_id}")

    return {
        "person_id": person_id,
        "carddav_uid": carddav_uid,
        "path": _rel(path),
    }


def _handle_find_person_by_contact(args: dict[str, Any]) -> dict[str, Any]:
    carddav_uid = args["carddav_uid"]
    result = _scan_people_for_carddav_uid(carddav_uid)
    if result is None:
        return {"found": False, "carddav_uid": carddav_uid}
    return {"found": True, **result}


def _handle_create_contact_fiche(args: dict[str, Any]) -> dict[str, Any]:
    result = _create_contact_fiche(
        name=args["name"],
        person_id=args["person_id"],
        carddav_uid=args.get("carddav_uid"),
        locale=args.get("locale", "fr"),
        tags=args.get("tags"),
        body=args.get("body", "\n"),
    )
    if result["created"]:
        fiche_path = _resolve_fiche_path("people", args["person_id"], args.get("locale", "fr"))
        _auto_commit([fiche_path], f"Create contact fiche: {args['person_id']}")
    return result


def _handle_list_backlog(args: dict[str, Any]) -> dict[str, Any]:
    """Return backlog items grouped by status."""
    locale = args.get("locale", "en")
    locale_dir = content_root() / locale

    if not locale_dir.is_dir():
        return {"backlog": {}, "count": 0}

    statuses: dict[str, list[dict[str, Any]]] = {}
    count = 0
    for md_file in sorted(locale_dir.glob("akita-backlog-*.md")):
        note_id = md_file.stem
        if note_id == "akita-backlog":
            continue  # skip parent MOC
        try:
            fm, _ = _parse_note(md_file)
        except ValueError:
            continue

        status = fm.get("status", "proposed")
        item = {
            "id": note_id,
            "title": fm.get("title", ""),
            "description": fm.get("description", ""),
            "icon": fm.get("icon"),
            "order": fm.get("order"),
            "date": str(fm.get("date", "")),
        }
        statuses.setdefault(status, []).append(item)
        count += 1

    # Sort items within each status group by order (nulls last)
    for items in statuses.values():
        items.sort(key=lambda x: (x["order"] is None, x["order"] or 0))

    return {"backlog": statuses, "count": count}


# ---------------------------------------------------------------------------
# Fiche handlers
# ---------------------------------------------------------------------------

FICHE_COLLECTIONS = ["books", "articles", "movies", "series", "podcasts", "people"]


def _handle_create_fiche(args: dict[str, Any]) -> dict[str, Any]:
    col = args["resource_collection"]
    rid = args["resource_id"]
    locale = args.get("locale", "en")
    body = args.get("body", "")
    path = _resolve_fiche_path(col, rid, locale)

    if path.exists():
        raise ValueError(f"Fiche already exists at {path}")

    path.parent.mkdir(parents=True, exist_ok=True)

    title = args.get("title", rid)
    meta: dict[str, Any] = {}

    if not args.get("skip_metadata"):
        try:
            meta = _fetch_fiche_metadata(col, title, args)
        except Exception as exc:
            LOGGER.warning("Failed to fetch metadata for fiche %s/%s: %s", col, rid, exc)

        # Use API title if available, falling back to user-provided title
        if meta.get("title"):
            title = meta["title"]

    fm: dict[str, Any] = {
        "title": title,
        "resource_collection": col,
        "resource_id": rid,
        "date": date.today().isoformat(),
        "tags": args.get("tags", []),
        "locale": locale,
        "meta": meta,
    }

    _write_note(path, fm, body if body.startswith("\n") else f"\n{body}\n" if body else "\n")
    _auto_commit([path], f"Create fiche: {col}/{rid}")

    return {"created": f"{col}/{locale}/{rid}", "path": _rel(path), "meta": meta}


def _fetch_fiche_metadata(col: str, title: str, args: dict[str, Any]) -> dict[str, Any]:
    """Fetch metadata from external APIs based on resource collection type."""
    if col == "books":
        return _fetch_book_metadata(title, args.get("author"))
    elif col == "movies":
        return _fetch_movie_metadata(title, args.get("year"))
    elif col == "series":
        return _fetch_series_metadata(title, args.get("year"))
    elif col == "podcasts":
        return _fetch_podcast_metadata(title)
    elif col == "articles":
        url = args.get("url")
        if not url:
            LOGGER.warning("No URL provided for article fiche; skipping metadata fetch")
            return {}
        return _fetch_article_metadata(url)
    elif col == "people":
        return _fetch_person_metadata(title)
    return {}


def _fetch_book_metadata(title: str, author: str | None) -> dict[str, Any]:
    api_key = os.environ.get("GOOGLE_BOOKS_API_KEY")
    results = _google_books_search(title, author, api_key)
    if not results:
        return {}
    volume = results[0].get("volumeInfo", {})
    book_author = volume.get("authors", [""])[0] if volume.get("authors") else ""
    pub_date = volume.get("publishedDate", "")
    year = int(pub_date[:4]) if pub_date and len(pub_date) >= 4 else None
    thumbnail = volume.get("imageLinks", {}).get("thumbnail", "")
    if thumbnail:
        thumbnail = thumbnail.replace("zoom=1", "zoom=2").replace("http://", "https://")
    meta: dict[str, Any] = {
        "google_books_id": results[0].get("id", ""),
        "title": volume.get("title", title),
        "author": book_author,
        "description": (volume.get("description", "") or "")[:500],
        "thumbnail": thumbnail,
    }
    if year:
        meta["year"] = year
    return meta


def _fetch_movie_metadata(title: str, year: int | None) -> dict[str, Any]:
    api_key = os.environ.get("TMDB_API_KEY")
    if not api_key:
        LOGGER.warning("TMDB_API_KEY not set; skipping movie metadata")
        return {}
    results = _tmdb_search(title, year, api_key)
    if not results:
        return {}
    movie_id = results[0]["id"]
    details = _tmdb_details(movie_id, api_key)
    release_date = details.get("release_date", "")
    movie_year = int(release_date[:4]) if release_date and len(release_date) >= 4 else None
    director = ""
    for crew_member in details.get("credits", {}).get("crew", []):
        if crew_member.get("job") == "Director":
            director = crew_member.get("name", "")
            break
    meta: dict[str, Any] = {
        "tmdb_id": movie_id,
        "title": details.get("title", title),
        "director": director,
        "overview": (details.get("overview", "") or "")[:500],
        "poster_path": details.get("poster_path", ""),
    }
    if movie_year:
        meta["year"] = movie_year
    return meta


def _fetch_series_metadata(title: str, year: int | None) -> dict[str, Any]:
    api_key = os.environ.get("TMDB_API_KEY")
    if not api_key:
        LOGGER.warning("TMDB_API_KEY not set; skipping series metadata")
        return {}
    results = _tmdb_tv_search(title, year, api_key)
    if not results:
        return {}
    series_id = results[0]["id"]
    details = _tmdb_tv_details(series_id, api_key)
    first_air = details.get("first_air_date", "")
    series_year = int(first_air[:4]) if first_air and len(first_air) >= 4 else None
    platform = None
    networks = details.get("networks", [])
    if networks:
        platform = networks[0].get("name")
    meta: dict[str, Any] = {
        "tmdb_id": series_id,
        "title": details.get("name", title),
        "overview": (details.get("overview", "") or "")[:500],
        "poster_path": details.get("poster_path", ""),
        "number_of_seasons": details.get("number_of_seasons"),
    }
    if series_year:
        meta["year"] = series_year
    if platform:
        meta["platform"] = platform
    return meta


def _fetch_podcast_metadata(title: str) -> dict[str, Any]:
    api_key = os.environ.get("PODCASTINDEX_API_KEY")
    api_secret = os.environ.get("PODCASTINDEX_API_SECRET")
    if not api_key or not api_secret:
        LOGGER.warning("PODCASTINDEX credentials not set; skipping podcast metadata")
        return {}
    results = _podcastindex_search(title, api_key, api_secret)
    if not results:
        return {}
    podcast = results[0]
    return {
        "podcastindex_id": podcast.get("id"),
        "title": podcast.get("title", title),
        "host": podcast.get("author", ""),
        "description": (podcast.get("description", "") or "")[:500],
        "artwork": podcast.get("artwork", ""),
        "url": podcast.get("url", ""),
    }


def _fetch_article_metadata(url: str) -> dict[str, Any]:
    og = _extract_og_metadata(url)
    return {
        "title": og.get("title", ""),
        "description": (og.get("description", "") or "")[:500],
        "image": og.get("image", ""),
        "site_name": og.get("site_name", ""),
        "url": url,
    }


def _fetch_person_metadata(name: str) -> dict[str, Any]:
    results = _wikidata_search(name)
    if not results:
        return {}
    entity_id = results[0]["id"]
    entity = _wikidata_entity(entity_id)
    labels = entity.get("labels", {})
    person_name = labels.get("en", {}).get("value", name)
    descriptions = entity.get("descriptions", {})
    description = descriptions.get("en", {}).get("value", "")
    image_filename = ""
    p18 = entity.get("claims", {}).get("P18", [])
    if p18:
        mainsnak = p18[0].get("mainsnak", {})
        image_filename = mainsnak.get("datavalue", {}).get("value", "")
    meta: dict[str, Any] = {
        "wikidata_id": entity_id,
        "name": person_name,
        "description": description,
    }
    if image_filename:
        meta["image_filename"] = image_filename
    return meta


def _handle_get_fiche(args: dict[str, Any]) -> dict[str, Any]:
    col = args["resource_collection"]
    rid = args["resource_id"]
    locale = args.get("locale", "en")
    path = _resolve_fiche_path(col, rid, locale)

    if not path.exists():
        raise ValueError(f"Fiche not found at {path}")

    fm, body = _parse_note(path)
    return {"resource_collection": col, "resource_id": rid, "frontmatter": fm, "body": body.strip()}


def _handle_update_fiche(args: dict[str, Any]) -> dict[str, Any]:
    col = args["resource_collection"]
    rid = args["resource_id"]
    locale = args.get("locale", "en")
    path = _resolve_fiche_path(col, rid, locale)

    if not path.exists():
        raise ValueError(f"Fiche not found at {path}")

    fm, body = _parse_note(path)
    updated_fields = []

    if "title" in args:
        fm["title"] = args["title"]
        updated_fields.append("title")

    if "tags" in args:
        fm["tags"] = args["tags"]
        updated_fields.append("tags")

    if "body" in args:
        body = args["body"]
        if not body.startswith("\n"):
            body = f"\n{body}\n"
        updated_fields.append("body")

    _write_note(path, fm, body)
    _auto_commit([path], f"Update fiche: {col}/{rid}")
    return {"resource_collection": col, "resource_id": rid, "updated": updated_fields}


def _handle_list_fiches(args: dict[str, Any]) -> dict[str, Any]:
    locale = args.get("locale")
    locales = [locale] if locale else ["en", "fr"]
    filter_col = args.get("resource_collection")
    collections = [filter_col] if filter_col else FICHE_COLLECTIONS

    fiches = []
    for col in collections:
        for loc in locales:
            col_dir = member_root() / col / loc
            if not col_dir.is_dir():
                continue
            for fiche_file in sorted(col_dir.glob("*-fiche.md")):
                try:
                    fm, _ = _parse_note(fiche_file)
                except ValueError:
                    continue
                fiches.append(_fiche_summary(fm))

    return {"fiches": fiches, "count": len(fiches)}


# ---------------------------------------------------------------------------
# Fragment handlers
# ---------------------------------------------------------------------------


def _handle_append_fragment(args: dict[str, Any]) -> dict[str, Any]:
    parent_path = _resolve_fragment_parent(args)
    if not parent_path.exists():
        raise ValueError(f"Parent not found at {parent_path}")

    fdir = _fragments_dir(parent_path)
    fdir.mkdir(parents=True, exist_ok=True)
    num = _next_fragment_num(fdir)
    fragment_file = fdir / f"{num:03d}.frag"
    _write_fragment(fragment_file, args["summary"], args["content"])

    pid = args["parent_id"]
    _auto_commit([fragment_file], f"Append fragment {num:03d} to {pid}")
    return {"parent_id": pid, "fragment_id": f"{num:03d}", "path": _rel(fragment_file)}


def _handle_list_fragments(args: dict[str, Any]) -> dict[str, Any]:
    parent_path = _resolve_fragment_parent(args)
    if not parent_path.exists():
        raise ValueError(f"Parent not found at {parent_path}")

    fdir = _fragments_dir(parent_path)
    if not fdir.exists():
        return {"fragments": [], "count": 0}

    fragments = []
    for f in sorted(fdir.glob("*.frag")):
        if f.stem.isdigit():
            summary, body = _parse_fragment(f)
            fragments.append({"id": f.stem, "summary": summary, "content": body})
    return {"fragments": fragments, "count": len(fragments)}


def _handle_get_fragment(args: dict[str, Any]) -> dict[str, Any]:
    parent_path = _resolve_fragment_parent(args)
    fdir = _fragments_dir(parent_path)
    fpath = fdir / f"{args['fragment_id']}.frag"
    if not fpath.exists():
        raise ValueError(f"Fragment not found at {fpath}")
    summary, body = _parse_fragment(fpath)
    return {"id": args["fragment_id"], "summary": summary, "content": body}


def _handle_update_fragment(args: dict[str, Any]) -> dict[str, Any]:
    parent_path = _resolve_fragment_parent(args)
    fdir = _fragments_dir(parent_path)
    fpath = fdir / f"{args['fragment_id']}.frag"
    if not fpath.exists():
        raise ValueError(f"Fragment not found at {fpath}")

    summary, _ = _parse_fragment(fpath)
    _write_fragment(fpath, summary, args["content"])
    pid = args["parent_id"]
    _auto_commit([fpath], f"Update fragment {args['fragment_id']} of {pid}")
    return {"parent_id": pid, "fragment_id": args["fragment_id"], "updated": True}


def _handle_delete_fragment(args: dict[str, Any]) -> dict[str, Any]:
    parent_path = _resolve_fragment_parent(args)
    fdir = _fragments_dir(parent_path)
    fpath = fdir / f"{args['fragment_id']}.frag"
    if not fpath.exists():
        raise ValueError(f"Fragment not found at {fpath}")

    pid = args["parent_id"]
    if not _remove_paths([fpath], f"Delete fragment {args['fragment_id']} of {pid}"):
        fpath.unlink(missing_ok=True)

    return {"parent_id": pid, "fragment_id": args["fragment_id"], "deleted": True}


def _handle_update_fragment_summary(args: dict[str, Any]) -> dict[str, Any]:
    parent_path = _resolve_fragment_parent(args)
    fdir = _fragments_dir(parent_path)
    fpath = fdir / f"{args['fragment_id']}.frag"
    if not fpath.exists():
        raise ValueError(f"Fragment not found at {fpath}")

    _, body = _parse_fragment(fpath)
    _write_fragment(fpath, args["summary"], body)
    pid = args["parent_id"]
    _auto_commit([fpath], f"Update summary of fragment {args['fragment_id']} of {pid}")
    return {"parent_id": pid, "fragment_id": args["fragment_id"], "summary": args["summary"], "updated": True}


def _handle_delete_fiche(args: dict[str, Any]) -> dict[str, Any]:
    col = args["resource_collection"]
    rid = args["resource_id"]
    locale = args.get("locale", "en")
    path = _resolve_fiche_path(col, rid, locale)

    if not path.exists():
        raise ValueError(f"Fiche not found at {path}")

    # Also remove _fragments/ directory if it exists
    fdir = _fragments_dir(path)
    abs_targets = [path]
    if fdir.exists():
        abs_targets.extend(fdir.glob("*.frag"))

    if not _remove_paths(abs_targets, f"Delete fiche: {col}/{rid}"):
        # No gardens repo (or git failed): delete files directly.
        path.unlink(missing_ok=True)
        if fdir.exists():
            import shutil
            shutil.rmtree(fdir, ignore_errors=True)

    return {"deleted": f"{col}/{locale}/{rid}"}


def _handle_promote_fiche(args: dict[str, Any]) -> dict[str, Any]:
    """Promote a fiche to a full resource entry using its pre-fetched metadata."""
    col = args["resource_collection"]
    rid = args["resource_id"]
    locale = args.get("locale", "en")

    # 1. Read the fiche
    fiche_path = _resolve_fiche_path(col, rid, locale)
    if not fiche_path.exists():
        raise ValueError(f"Fiche not found at {fiche_path}")

    fm, body = _parse_note(fiche_path)
    meta = fm.get("meta") or {}
    fiche_body = body.strip()

    # Concatenate fragments into body (strip frontmatter)
    fdir = _fragments_dir(fiche_path)
    if fdir.exists():
        fragment_parts = []
        for f in sorted(fdir.glob("*.frag")):
            if f.stem.isdigit():
                _, fbody = _parse_fragment(f)
                fragment_parts.append(fbody.strip())
        if fragment_parts:
            fiche_body = fiche_body + "\n\n" + "\n\n".join(fragment_parts) if fiche_body else "\n\n".join(fragment_parts)

    # 2. If no meta, fall back to the existing create_*_entry handlers
    if not meta:
        return _promote_fiche_without_meta(col, rid, fm, fiche_body, args)

    # 3. Build publish_args from meta
    slug = _slugify(meta.get("title") or meta.get("name") or fm.get("title", rid))

    publish_args: dict[str, Any] = {
        "collection": col,
        "locale": locale,
        "slug": slug,
        "flags": args.get("flags", []),
        "translationKey": slug,
    }

    # Merge fiche tags with promote-time tags
    tags = list(fm.get("tags", []))
    if args.get("tags"):
        tags = list(dict.fromkeys(tags + args["tags"]))  # dedupe preserving order
    if tags:
        publish_args["tags"] = tags

    if args.get("rating"):
        publish_args["rating"] = args["rating"]

    # Collection-specific field mapping + image download
    if col == "books":
        publish_args["title"] = meta.get("title", fm.get("title", rid))
        publish_args["author"] = meta.get("author", "")
        if meta.get("year"):
            publish_args["year"] = meta["year"]
        publish_args["content"] = fiche_body or meta.get("description", "")
        if meta.get("thumbnail"):
            image_rel = _download_resource_image(meta["thumbnail"], "books", locale, slug)
            if image_rel:
                publish_args["image"] = image_rel

    elif col == "movies":
        publish_args["title"] = meta.get("title", fm.get("title", rid))
        publish_args["director"] = meta.get("director", "")
        if meta.get("year"):
            publish_args["year"] = meta["year"]
        publish_args["content"] = fiche_body or meta.get("overview", "")
        if meta.get("poster_path"):
            image_rel = _download_resource_poster(meta["poster_path"], "movies", locale, slug)
            if image_rel:
                publish_args["image"] = image_rel

    elif col == "series":
        publish_args["title"] = meta.get("title", fm.get("title", rid))
        if meta.get("year"):
            publish_args["year"] = meta["year"]
        if meta.get("platform"):
            publish_args["platform"] = meta["platform"]
        publish_args["content"] = fiche_body or meta.get("overview", "")
        if meta.get("poster_path"):
            image_rel = _download_resource_poster(meta["poster_path"], "series", locale, slug)
            if image_rel:
                publish_args["image"] = image_rel

    elif col == "podcasts":
        publish_args["title"] = meta.get("title", fm.get("title", rid))
        publish_args["host"] = meta.get("host", "")
        if meta.get("url"):
            publish_args["url"] = meta["url"]
        publish_args["content"] = fiche_body or meta.get("description", "")
        if meta.get("artwork"):
            image_rel = _download_resource_image(meta["artwork"], "podcasts", locale, slug)
            if image_rel:
                publish_args["image"] = image_rel

    elif col == "articles":
        publish_args["title"] = meta.get("title", fm.get("title", rid))
        publish_args["url"] = meta.get("url", "")
        if meta.get("site_name"):
            publish_args["source"] = meta["site_name"]
        publish_args["content"] = fiche_body or meta.get("description", "")
        if meta.get("image"):
            og_image = meta["image"]
            if og_image.startswith("/") and meta.get("url"):
                from urllib.parse import urlparse
                parsed = urlparse(meta["url"])
                og_image = f"{parsed.scheme}://{parsed.netloc}{og_image}"
            image_rel = _download_resource_image(og_image, "articles", locale, slug)
            if image_rel:
                publish_args["image"] = image_rel

    elif col == "people":
        publish_args["name"] = meta.get("name", fm.get("title", rid))
        if meta.get("description"):
            publish_args["role"] = meta["description"]
        publish_args["content"] = fiche_body
        if meta.get("image_filename"):
            image_url = _wikimedia_image_url(meta["image_filename"])
            image_rel = _download_resource_image(image_url, "people", locale, slug)
            if image_rel:
                publish_args["image"] = image_rel

    result = _handle_publish_content(publish_args)

    # 4. Delete fiche (and fragments) if requested
    if args.get("delete_fiche") and not result.get("error"):
        abs_targets = [fiche_path]
        if fdir.exists():
            abs_targets.extend(fdir.glob("*.frag"))
        if not _remove_paths(abs_targets, f"Remove fiche after promotion: {col}/{rid}"):
            fiche_path.unlink(missing_ok=True)
            if fdir.exists():
                import shutil
                shutil.rmtree(fdir, ignore_errors=True)
        result["fiche_deleted"] = True

    result["promoted_from_meta"] = True
    return result


def _promote_fiche_without_meta(
    col: str, rid: str, fm: dict[str, Any], fiche_body: str, args: dict[str, Any]
) -> dict[str, Any]:
    """Fallback: promote a fiche that has no pre-fetched meta by delegating to create_*_entry."""
    title = fm.get("title", rid)
    locale = args.get("locale", "en")
    base_args: dict[str, Any] = {"title": title, "locale": locale, "flags": args.get("flags", [])}
    if fiche_body:
        base_args["content"] = fiche_body
    if args.get("rating"):
        base_args["rating"] = args["rating"]
    tags = list(fm.get("tags", []))
    if args.get("tags"):
        tags = list(dict.fromkeys(tags + args["tags"]))
    if tags:
        base_args["tags"] = tags

    if col == "books":
        result = _create_book_entry_sync(base_args)
    elif col == "movies":
        result = _create_movie_entry_sync(base_args)
    elif col == "series":
        result = _create_series_entry_sync(base_args)
    elif col == "podcasts":
        result = _create_podcast_entry_sync(base_args)
    elif col == "articles":
        # Articles need a URL — check if fiche stored one
        url = fm.get("url") or fm.get("meta", {}).get("url")
        if not url:
            return {"error": "Cannot promote article fiche without a URL (no meta and no url in frontmatter)"}
        base_args["url"] = url
        del base_args["title"]  # article handler gets title from OG
        result = _create_article_entry_sync(base_args)
    elif col == "people":
        base_args["name"] = title
        result = _create_person_entry_sync(base_args)
    else:
        return {"error": f"Unknown collection: {col}"}

    result["promoted_from_meta"] = False
    return result


def _download_resource_image(url: str, collection: str, locale: str, slug: str) -> str:
    """Download an image for a resource and return the relative image path, or empty string on failure."""
    img_filename = f"{locale}-{slug}.jpg"
    img_dest = member_root() / "images" / "resources" / collection / img_filename
    try:
        _download_image(url, img_dest)
        return f"/images/{_garden_member()}/resources/{collection}/{img_filename}"
    except Exception as exc:
        LOGGER.warning("Failed to download image for %s/%s: %s", collection, slug, exc)
        return ""


def _download_resource_poster(poster_path: str, collection: str, locale: str, slug: str) -> str:
    """Download a TMDB poster and return the relative image path, or empty string on failure."""
    img_filename = f"{locale}-{slug}.jpg"
    img_dest = member_root() / "images" / "resources" / collection / img_filename
    try:
        _download_poster(poster_path, img_dest)
        return f"/images/{_garden_member()}/resources/{collection}/{img_filename}"
    except Exception as exc:
        LOGGER.warning("Failed to download poster for %s/%s: %s", collection, slug, exc)
        return ""


# ---------------------------------------------------------------------------
# Resource publishing helpers
# ---------------------------------------------------------------------------

_RESOURCE_COLLECTIONS = {"books", "articles", "movies", "series", "podcasts", "people"}

# Images dir is inside content repo, stage it with auto-commit
# (image dir is per-member: member_root() / "images")


def _auto_commit_with_images(paths: list[Path], message: str) -> None:
    """Stage content paths + the member's images dir, commit, and push — only when
    the gardens dir is a git repo (no-op otherwise; files are already on disk)."""
    root = _gardens_git_root()
    if root is None:
        return
    try:
        targets = [*paths, member_root() / "images"]
        rel_paths = [str(p.relative_to(root)) for p in targets if p.exists() and p.is_relative_to(root)]
        if not rel_paths:
            return
        subprocess.run(["git", "add"] + rel_paths, cwd=root, check=True)
        result = subprocess.run(["git", "diff", "--cached", "--quiet"], cwd=root)
        if result.returncode != 0:
            subprocess.run(["git", "commit", "-m", message], cwd=root, check=True)
            if _git_has_remote(root):
                subprocess.run(["git", "push"], cwd=root, check=False)
    except Exception as exc:
        LOGGER.warning("auto-commit failed: %s", exc)


def _slugify(text: str) -> str:
    """Turn a title into a URL-safe slug."""
    import unicodedata
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")
    text = re.sub(r"[^\w\s-]", "", text.lower())
    return re.sub(r"[-\s]+", "-", text).strip("-")[:80]


def _yaml_str(value: str) -> str:
    """Quote a YAML string value, escaping internal quotes."""
    if any(c in value for c in '":{}[]#&*!|>\','):
        return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'
    return f'"{value}"'


def _resolve_content(args: dict[str, Any]) -> str | dict[str, Any]:
    """Return markdown body or an error dict."""
    content = args.get("content", "")
    dossier_id = args.get("dossierId")
    if dossier_id:
        # Dossier resolution lives in the private research_tracks pipeline, which
        # is not part of the public Garden tool. Degrade cleanly when it's absent.
        tracks_root = REPO_ROOT / "tools" / "pipelines" / "research_tracks"
        if not tracks_root.exists():
            return {"error": "Dossier resolution is not available in this deployment."}
        if str(tracks_root) not in sys.path:
            sys.path.insert(0, str(tracks_root))
        try:
            from research_tracks.config import load_config
            from research_tracks.store import AkitaStore
        except ImportError:
            return {"error": "Dossier resolution is not available in this deployment."}

        config_path = os.environ.get("AKITA_CONFIG")
        config = load_config(Path(config_path) if config_path else None)
        with AkitaStore(config.db_path) as store:
            dossier = store.get_dossier(dossier_id)
        if not dossier:
            return {"error": f"Dossier {dossier_id} not found"}
        content_path = config.dossier_root / dossier["content_path"]
        if content_path.exists():
            return content_path.read_text(encoding="utf-8")
        return {"error": f"Dossier content file not found: {dossier['content_path']}"}
    return content


# Frontmatter builders per collection. Each returns (lines, missing_fields).

def _fm_blog(args: dict[str, Any], today: str) -> tuple[list[str], list[str]]:
    title = args.get("title", "")
    if not title:
        return [], ["title"]
    lines = [
        f"title: {_yaml_str(title)}",
        f"date: {args.get('date', today)}",
        f"flags: [{', '.join(_yaml_str(f) for f in args.get('flags', []))}]",
    ]
    if args.get("description"):
        lines.append(f"description: {_yaml_str(args['description'])}")
    return lines, []


def _fm_essays(args: dict[str, Any], today: str) -> tuple[list[str], list[str]]:
    missing = [f for f in ["title", "section"] if not args.get(f)]
    if missing:
        return [], missing
    lines = [
        f"title: {_yaml_str(args['title'])}",
        f"date: {args.get('date', today)}",
        f"section: {_yaml_str(args['section'])}",
        f"flags: [{', '.join(_yaml_str(f) for f in args.get('flags', []))}]",
    ]
    if args.get("description"):
        lines.append(f"description: {_yaml_str(args['description'])}")
    return lines, []


def _fm_books(args: dict[str, Any], today: str) -> tuple[list[str], list[str]]:
    missing = [f for f in ["title", "author"] if not args.get(f)]
    if missing:
        return [], missing
    lines = [
        f"title: {_yaml_str(args['title'])}",
        f"author: {_yaml_str(args['author'])}",
        f"date_read: {args.get('date_read', today)}",
        f"status: {args.get('status', 'read')}",
        f"flags: [{', '.join(_yaml_str(f) for f in args.get('flags', []))}]",
    ]
    if args.get("rating"):
        lines.append(f"rating: {args['rating']}")
    if args.get("image"):
        lines.append(f"image: {_yaml_str(args['image'])}")
    return lines, []


def _fm_articles(args: dict[str, Any], today: str) -> tuple[list[str], list[str]]:
    missing = [f for f in ["title", "source", "url"] if not args.get(f)]
    if missing:
        return [], missing
    lines = [
        f"title: {_yaml_str(args['title'])}",
        f"source: {_yaml_str(args['source'])}",
        f"url: {_yaml_str(args['url'])}",
        f"date_read: {args.get('date_read', today)}",
        f"flags: [{', '.join(_yaml_str(f) for f in args.get('flags', []))}]",
    ]
    if args.get("author"):
        lines.append(f"author: {_yaml_str(args['author'])}")
    if args.get("image"):
        lines.append(f"image: {_yaml_str(args['image'])}")
    return lines, []


def _fm_movies(args: dict[str, Any], today: str) -> tuple[list[str], list[str]]:
    if not args.get("title"):
        return [], ["title"]
    lines = [
        f"title: {_yaml_str(args['title'])}",
        f"date_watched: {args.get('date_watched', today)}",
        f"flags: [{', '.join(_yaml_str(f) for f in args.get('flags', []))}]",
    ]
    if args.get("director"):
        lines.append(f"director: {_yaml_str(args['director'])}")
    if args.get("year"):
        lines.append(f"year: {args['year']}")
    if args.get("rating"):
        lines.append(f"rating: {args['rating']}")
    if args.get("image"):
        lines.append(f"image: {_yaml_str(args['image'])}")
    return lines, []


def _fm_series(args: dict[str, Any], today: str) -> tuple[list[str], list[str]]:
    if not args.get("title"):
        return [], ["title"]
    lines = [
        f"title: {_yaml_str(args['title'])}",
        f"date_watched: {args.get('date_watched', today)}",
        f"status: {args.get('status', 'watched')}",
        f"flags: [{', '.join(_yaml_str(f) for f in args.get('flags', []))}]",
    ]
    if args.get("platform"):
        lines.append(f"platform: {_yaml_str(args['platform'])}")
    if args.get("seasons_watched"):
        lines.append(f"seasons_watched: {args['seasons_watched']}")
    if args.get("rating"):
        lines.append(f"rating: {args['rating']}")
    if args.get("image"):
        lines.append(f"image: {_yaml_str(args['image'])}")
    if args.get("show"):
        lines.append(f"show: {_yaml_str(args['show'])}")
    if args.get("episode_title"):
        lines.append(f"episode_title: {_yaml_str(args['episode_title'])}")
    if args.get("episode_number") is not None:
        lines.append(f"episode_number: {args['episode_number']}")
    if args.get("season") is not None:
        lines.append(f"season: {args['season']}")
    return lines, []


def _fm_podcasts(args: dict[str, Any], today: str) -> tuple[list[str], list[str]]:
    if not args.get("title"):
        return [], ["title"]
    lines = [
        f"title: {_yaml_str(args['title'])}",
        f"date_listened: {args.get('date_listened', today)}",
        f"flags: [{', '.join(_yaml_str(f) for f in args.get('flags', []))}]",
    ]
    if args.get("host"):
        lines.append(f"host: {_yaml_str(args['host'])}")
    if args.get("url"):
        lines.append(f"url: {_yaml_str(args['url'])}")
    if args.get("image"):
        lines.append(f"image: {_yaml_str(args['image'])}")
    if args.get("show"):
        lines.append(f"show: {_yaml_str(args['show'])}")
    if args.get("episode_title"):
        lines.append(f"episode_title: {_yaml_str(args['episode_title'])}")
    if args.get("episode_number") is not None:
        lines.append(f"episode_number: {args['episode_number']}")
    if args.get("season") is not None:
        lines.append(f"season: {args['season']}")
    guests = args.get("guests", [])
    if guests:
        lines.append(f"guests: [{', '.join(_yaml_str(g) for g in guests)}]")
    return lines, []


def _fm_people(args: dict[str, Any], _today: str) -> tuple[list[str], list[str]]:
    name = args.get("name", "")
    if not name:
        return [], ["name"]
    lines = [
        f"name: {_yaml_str(name)}",
        f"flags: [{', '.join(_yaml_str(f) for f in args.get('flags', []))}]",
    ]
    if args.get("role"):
        lines.append(f"role: {_yaml_str(args['role'])}")
    if args.get("url"):
        lines.append(f"url: {_yaml_str(args['url'])}")
    if args.get("image"):
        lines.append(f"image: {_yaml_str(args['image'])}")
    return lines, []


_FM_BUILDERS: dict[str, Any] = {
    "blog": _fm_blog,
    "essays": _fm_essays,
    "books": _fm_books,
    "articles": _fm_articles,
    "movies": _fm_movies,
    "series": _fm_series,
    "podcasts": _fm_podcasts,
    "people": _fm_people,
}

_SLUG_FIELD: dict[str, str] = {
    "people": "name",
}


def _handle_deploy_site(args: dict[str, Any]) -> dict[str, Any]:
    if not args.get("confirm"):
        raise ValueError("confirm must be true to deploy")
    deploy_cfg = get_config().get("deploy", {})
    script_rel = deploy_cfg.get("script", "scripts/publish-web.sh")
    script = Path(script_rel) if os.path.isabs(script_rel) else (REPO_ROOT / script_rel)
    if not script.exists():
        raise RuntimeError(
            f"Deploy script not found: {script}. Set [deploy] script in config.toml."
        )
    result = subprocess.run(
        ["bash", str(script)],
        cwd=str(REPO_ROOT),
        capture_output=True,
        text=True,
        timeout=300,
    )
    if result.returncode != 0:
        raise RuntimeError(f"Deploy failed:\n{result.stderr[-1000:]}")
    # Prefer the actual deployment URL from wrangler output; fall back to the
    # configured site_url ([deploy] site_url in config.toml).
    output = result.stdout + result.stderr
    url = deploy_cfg.get("site_url", "")
    for line in output.splitlines():
        if "https://" in line and "pages.dev" in line:
            url = line.strip().split()[-1]
            break
    return {"deployed": True, "url": url, "output": result.stdout[-500:]}


def _handle_publish_content(args: dict[str, Any]) -> dict[str, Any]:
    collection = args.get("collection", "")
    if collection not in _FM_BUILDERS:
        return {"error": f"Unknown collection: {collection}. Use one of: {', '.join(_FM_BUILDERS)}"}

    today = date.today().isoformat()
    locale = args.get("locale", "en")
    slug_field = _SLUG_FIELD.get(collection, "title")
    slug = args.get("slug") or _slugify(args.get(slug_field, "") or args.get("title", "") or "untitled")

    body = _resolve_content(args)
    if isinstance(body, dict):
        return body

    builder = _FM_BUILDERS[collection]
    fm_lines, missing = builder(args, today)
    if missing:
        return {"error": f"Missing required fields for {collection}: {', '.join(missing)}"}

    # Auto-set translationKey for resource collections
    if not args.get("translationKey") and not args.get("show") and collection in ("books", "articles", "movies", "series", "podcasts", "people"):
        args["translationKey"] = slug

    tags = args.get("tags", [])
    if tags:
        fm_lines.append(f"tags: [{', '.join(_yaml_str(t) for t in tags)}]")
    fm_lines.append(f'locale: "{locale}"')
    if args.get("translationKey"):
        fm_lines.append(f"translationKey: {_yaml_str(args['translationKey'])}")
    if args.get("isTranslation"):
        flags = args.get("flags", [])
        if "translation" not in flags:
            flags.append("translation")
            args["flags"] = flags

    file_content = "---\n" + "\n".join(fm_lines) + "\n---\n"
    if body:
        file_content += "\n" + body

    # Notes live in the member garden (content_root()); other collections under member_root()/<collection>.
    content_dir = (content_root() / locale) if collection == "notes" else (member_root() / collection / locale)
    content_dir.mkdir(parents=True, exist_ok=True)
    file_path = content_dir / f"{slug}.md"

    if file_path.exists():
        return {"error": f"File already exists: {_rel(file_path)}"}

    _atomic_write(file_path, file_content)
    if collection == "notes":
        _mark_activity(slug)  # signal the live edit-activity indicator for new notes too
    _auto_commit_with_images([file_path], f"Publish {collection}: {slug}")

    return {
        "published": True,
        "collection": collection,
        "file": _rel(file_path),
        "slug": slug,
        "locale": locale,
        "translationKey": args.get("translationKey"),
    }


# ---------------------------------------------------------------------------
# Resource entry CRUD handlers
# ---------------------------------------------------------------------------

def _resolve_resource_path(collection: str, entry_id: str, locale: str) -> Path:
    return member_root() / collection / locale / f"{entry_id}.md"


def _handle_get_resource(args: dict[str, Any]) -> dict[str, Any]:
    collection = args["collection"]
    entry_id = args["id"]
    locale = args.get("locale", "en")

    if collection not in _RESOURCE_COLLECTIONS:
        return {"error": f"Unknown collection: {collection}"}

    path = _resolve_resource_path(collection, entry_id, locale)
    if not path.exists():
        return {"error": f"Entry '{entry_id}' not found in {collection}/{locale}"}

    fm, body = _parse_note(path)
    return {"id": entry_id, "collection": collection, "locale": locale, "frontmatter": fm, "body": body.strip()}


def _handle_update_resource(args: dict[str, Any]) -> dict[str, Any]:
    collection = args["collection"]
    entry_id = args["id"]
    locale = args.get("locale", "en")

    if collection not in _RESOURCE_COLLECTIONS:
        return {"error": f"Unknown collection: {collection}"}

    path = _resolve_resource_path(collection, entry_id, locale)
    if not path.exists():
        return {"error": f"Entry '{entry_id}' not found in {collection}/{locale}"}

    fm, body = _parse_note(path)
    updated_fields = []

    scalar_keys = (
        "title", "flags", "rating", "translationKey",
        "author", "status", "date_read",
        "director", "year", "date_watched",
        "source", "url",
        "platform", "seasons_watched",
        "host", "date_listened",
        "name", "role",
    )
    for key in scalar_keys:
        if key in args:
            fm[key] = args[key]
            updated_fields.append(key)

    if "image" in args:
        if args["image"]:
            fm["image"] = args["image"]
        else:
            fm.pop("image", None)
        updated_fields.append("image")

    if "tags" in args:
        fm["tags"] = args["tags"]
        updated_fields.append("tags")

    if "body" in args:
        body = args["body"]
        if not body.startswith("\n"):
            body = f"\n{body}\n"
        updated_fields.append("body")

    _write_note(path, fm, body)
    _auto_commit_with_images([path], f"Update {collection}: {entry_id}")
    return {"id": entry_id, "collection": collection, "updated": updated_fields}


def _handle_list_resources(args: dict[str, Any]) -> dict[str, Any]:
    collection = args["collection"]
    locale = args.get("locale", "en")

    if collection not in _RESOURCE_COLLECTIONS:
        return {"error": f"Unknown collection: {collection}"}

    locale_dir = member_root() / collection / locale
    if not locale_dir.is_dir():
        return {"entries": [], "count": 0}

    entries = []
    for md_file in sorted(locale_dir.glob("*.md")):
        try:
            fm, _ = _parse_note(md_file)
        except ValueError:
            continue

        if "flag" in args and args["flag"] not in fm.get("flags", []):
            continue
        if "exclude_flag" in args and args["exclude_flag"] in fm.get("flags", []):
            continue

        entry_id = md_file.stem
        entries.append({"id": entry_id, **{k: v for k, v in fm.items() if k != "locale"}})

    return {"entries": entries, "count": len(entries), "collection": collection, "locale": locale}


# ---------------------------------------------------------------------------
# Media search handlers
# ---------------------------------------------------------------------------

async def _handle_search_movie(args: dict[str, Any]) -> dict[str, Any]:
    return await asyncio.to_thread(_search_movie_sync, args)


def _search_movie_sync(args: dict[str, Any]) -> dict[str, Any]:
    api_key = os.environ.get("TMDB_API_KEY")
    if not api_key:
        return {"error": "TMDB_API_KEY environment variable is not set"}

    results = _tmdb_search(args["title"], args.get("year"), api_key)
    limit = args.get("limit", 5)
    candidates = []
    for r in results[:limit]:
        rd = r.get("release_date", "")
        candidates.append({
            "tmdb_id": r["id"],
            "title": r.get("title", ""),
            "year": int(rd[:4]) if rd and len(rd) >= 4 else None,
            "overview": (r.get("overview", "") or "")[:200],
            "poster_path": r.get("poster_path"),
        })
    return {"query": args["title"], "results": candidates, "count": len(candidates)}


async def _handle_search_book(args: dict[str, Any]) -> dict[str, Any]:
    return await asyncio.to_thread(_search_book_sync, args)


def _search_book_sync(args: dict[str, Any]) -> dict[str, Any]:
    api_key = os.environ.get("GOOGLE_BOOKS_API_KEY")
    results = _google_books_search(args["title"], args.get("author"), api_key)
    limit = args.get("limit", 5)
    candidates = []
    for r in results[:limit]:
        vol = r.get("volumeInfo", {})
        pub = vol.get("publishedDate", "")
        candidates.append({
            "google_books_id": r.get("id", ""),
            "title": vol.get("title", ""),
            "authors": vol.get("authors", []),
            "year": int(pub[:4]) if pub and len(pub) >= 4 else None,
            "description": (vol.get("description", "") or "")[:200],
            "thumbnail": vol.get("imageLinks", {}).get("thumbnail"),
        })
    return {"query": args["title"], "results": candidates, "count": len(candidates)}


async def _handle_search_series(args: dict[str, Any]) -> dict[str, Any]:
    return await asyncio.to_thread(_search_series_sync, args)


def _search_series_sync(args: dict[str, Any]) -> dict[str, Any]:
    api_key = os.environ.get("TMDB_API_KEY")
    if not api_key:
        return {"error": "TMDB_API_KEY environment variable is not set"}

    results = _tmdb_tv_search(args["title"], args.get("year"), api_key)
    limit = args.get("limit", 5)
    candidates = []
    for r in results[:limit]:
        fa = r.get("first_air_date", "")
        candidates.append({
            "tmdb_id": r["id"],
            "title": r.get("name", ""),
            "year": int(fa[:4]) if fa and len(fa) >= 4 else None,
            "overview": (r.get("overview", "") or "")[:200],
            "poster_path": r.get("poster_path"),
        })
    return {"query": args["title"], "results": candidates, "count": len(candidates)}


async def _handle_search_podcast(args: dict[str, Any]) -> dict[str, Any]:
    return await asyncio.to_thread(_search_podcast_sync, args)


def _search_podcast_sync(args: dict[str, Any]) -> dict[str, Any]:
    api_key = os.environ.get("PODCASTINDEX_API_KEY")
    api_secret = os.environ.get("PODCASTINDEX_API_SECRET")
    if not api_key or not api_secret:
        return {"error": "PODCASTINDEX_API_KEY and PODCASTINDEX_API_SECRET environment variables are required"}

    results = _podcastindex_search(args["title"], api_key, api_secret)
    limit = args.get("limit", 5)
    candidates = []
    for r in results[:limit]:
        candidates.append({
            "podcastindex_id": r.get("id"),
            "title": r.get("title", ""),
            "host": r.get("author", ""),
            "description": (r.get("description", "") or "")[:200],
            "artwork": r.get("artwork"),
            "url": r.get("url", ""),
        })
    return {"query": args["title"], "results": candidates, "count": len(candidates)}


async def _handle_search_person(args: dict[str, Any]) -> dict[str, Any]:
    return await asyncio.to_thread(_search_person_sync, args)


def _search_person_sync(args: dict[str, Any]) -> dict[str, Any]:
    results = _wikidata_search(args["name"])
    limit = args.get("limit", 5)
    candidates = []
    for r in results[:limit]:
        candidates.append({
            "wikidata_id": r.get("id", ""),
            "name": r.get("label", ""),
            "description": r.get("description", ""),
        })
    return {"query": args["name"], "results": candidates, "count": len(candidates)}


# ---------------------------------------------------------------------------
# TMDB helpers
# ---------------------------------------------------------------------------

def _tmdb_search(title: str, year: int | None, api_key: str) -> list[dict[str, Any]]:
    import urllib.request
    import urllib.parse

    params: dict[str, str] = {"api_key": api_key, "query": title}
    if year:
        params["year"] = str(year)
    url = f"https://api.themoviedb.org/3/search/movie?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read())
    return data.get("results", [])


def _tmdb_details(movie_id: int, api_key: str) -> dict[str, Any]:
    import urllib.request

    url = f"https://api.themoviedb.org/3/movie/{movie_id}?api_key={api_key}&append_to_response=credits"
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())


def _download_poster(poster_path: str, dest: Path) -> None:
    import urllib.request

    url = f"https://image.tmdb.org/t/p/w500{poster_path}"
    dest.parent.mkdir(parents=True, exist_ok=True)
    urllib.request.urlretrieve(url, str(dest))


def _download_image(url: str, dest: Path) -> None:
    import urllib.request

    dest.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": "Akita/1.0"})
    with urllib.request.urlopen(req) as resp:
        dest.write_bytes(resp.read())


def _tmdb_tv_search(title: str, year: int | None, api_key: str) -> list[dict[str, Any]]:
    import urllib.request
    import urllib.parse

    params: dict[str, str] = {"api_key": api_key, "query": title}
    if year:
        params["first_air_date_year"] = str(year)
    url = f"https://api.themoviedb.org/3/search/tv?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read())
    return data.get("results", [])


def _tmdb_tv_details(series_id: int, api_key: str) -> dict[str, Any]:
    import urllib.request

    url = f"https://api.themoviedb.org/3/tv/{series_id}?api_key={api_key}"
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())


# ---------------------------------------------------------------------------
# Google Books helpers
# ---------------------------------------------------------------------------

def _google_books_search(title: str, author: str | None, api_key: str | None) -> list[dict[str, Any]]:
    import urllib.request
    import urllib.parse

    q = f"intitle:{title}"
    if author:
        q += f"+inauthor:{author}"
    params: dict[str, str] = {"q": q}
    if api_key:
        params["key"] = api_key
    url = f"https://www.googleapis.com/books/v1/volumes?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read())
    return data.get("items", [])


# ---------------------------------------------------------------------------
# Podcast Index helpers
# ---------------------------------------------------------------------------

def _podcastindex_auth_headers(api_key: str, api_secret: str) -> dict[str, str]:
    import hashlib
    import time

    epoch = str(int(time.time()))
    hash_input = api_key + api_secret + epoch
    auth_hash = hashlib.sha1(hash_input.encode()).hexdigest()
    return {
        "X-Auth-Key": api_key,
        "X-Auth-Date": epoch,
        "Authorization": auth_hash,
        "User-Agent": "Akita/1.0",
    }


def _podcastindex_search(title: str, api_key: str, api_secret: str) -> list[dict[str, Any]]:
    import urllib.request
    import urllib.parse

    headers = _podcastindex_auth_headers(api_key, api_secret)
    url = f"https://api.podcastindex.org/api/1.0/search/byterm?{urllib.parse.urlencode({'q': title})}"
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read())
    return data.get("feeds", [])


# ---------------------------------------------------------------------------
# Open Graph extraction
# ---------------------------------------------------------------------------

def _extract_og_metadata(url: str) -> dict[str, str]:
    import urllib.request

    req = urllib.request.Request(url, headers={"User-Agent": "Akita/1.0"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        html = resp.read().decode("utf-8", errors="replace")

    og: dict[str, str] = {}
    for match in re.finditer(
        r'<meta\s+(?:property|name)=["\']og:(\w+)["\']\s+content=["\']([^"\']*)["\']',
        html, re.IGNORECASE,
    ):
        og[match.group(1)] = match.group(2)
    for match in re.finditer(
        r'<meta\s+content=["\']([^"\']*)["\'].*?(?:property|name)=["\']og:(\w+)["\']',
        html, re.IGNORECASE,
    ):
        og.setdefault(match.group(2), match.group(1))

    if "title" not in og:
        m = re.search(r"<title[^>]*>([^<]+)</title>", html, re.IGNORECASE)
        if m:
            og["title"] = m.group(1).strip()

    return og


# ---------------------------------------------------------------------------
# Wikidata helpers
# ---------------------------------------------------------------------------

def _wikidata_search(name: str) -> list[dict[str, Any]]:
    import urllib.request
    import urllib.parse

    params = {
        "action": "wbsearchentities",
        "search": name,
        "language": "en",
        "type": "item",
        "format": "json",
    }
    url = f"https://www.wikidata.org/w/api.php?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"User-Agent": "Akita/1.0"})
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read())
    return data.get("search", [])


def _wikidata_entity(entity_id: str) -> dict[str, Any]:
    import urllib.request
    import urllib.parse

    params = {
        "action": "wbgetentities",
        "ids": entity_id,
        "format": "json",
        "props": "claims|descriptions|labels",
    }
    url = f"https://www.wikidata.org/w/api.php?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"User-Agent": "Akita/1.0"})
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read())
    return data.get("entities", {}).get(entity_id, {})


def _wikimedia_image_url(filename: str) -> str:
    from urllib.parse import quote
    return f"https://commons.wikimedia.org/wiki/Special:FilePath/{quote(filename)}?width=500"


# ---------------------------------------------------------------------------
# Movie entry creation handler
# ---------------------------------------------------------------------------

async def _handle_create_movie_entry(args: dict[str, Any]) -> dict[str, Any]:
    return await asyncio.to_thread(_create_movie_entry_sync, args)


def _create_movie_entry_sync(args: dict[str, Any]) -> dict[str, Any]:
    api_key = os.environ.get("TMDB_API_KEY")
    if not api_key:
        return {"error": "TMDB_API_KEY environment variable is not set"}

    title = args["title"]
    year = args.get("year")

    movie_id = args.get("tmdb_id")
    if not movie_id:
        results = _tmdb_search(title, year, api_key)
        if not results:
            return {"error": f"No TMDB results found for '{title}'" + (f" ({year})" if year else "")}
        movie_id = results[0]["id"]

    details = _tmdb_details(movie_id, api_key)

    movie_title = details.get("title", title)
    release_date = details.get("release_date", "")
    movie_year = int(release_date[:4]) if release_date and len(release_date) >= 4 else year
    overview = details.get("overview", "")
    poster_path = details.get("poster_path")

    director = ""
    credits = details.get("credits", {})
    for crew_member in credits.get("crew", []):
        if crew_member.get("job") == "Director":
            director = crew_member.get("name", "")
            break

    locale = args.get("locale", "fr")
    slug = _slugify(movie_title)

    image_rel = ""
    if poster_path:
        poster_filename = f"{locale}-{slug}.jpg"
        poster_dest = member_root() / "images" / "resources" / "movies" / poster_filename
        try:
            _download_poster(poster_path, poster_dest)
            image_rel = f"/images/{_garden_member()}/resources/movies/{poster_filename}"
        except Exception as exc:
            LOGGER.warning("Failed to download poster for %s: %s", movie_title, exc)

    publish_args: dict[str, Any] = {
        "collection": "movies",
        "title": movie_title,
        "director": director,
        "year": movie_year,
        "locale": locale,
        "slug": slug,
        "flags": args.get("flags", []),
        "content": args.get("content") or overview,
        "translationKey": slug,
    }
    if image_rel:
        publish_args["image"] = image_rel
    if args.get("rating"):
        publish_args["rating"] = args["rating"]
    if args.get("tags"):
        publish_args["tags"] = args["tags"]

    result = _handle_publish_content(publish_args)
    result["tmdb"] = {
        "id": movie_id,
        "title": movie_title,
        "year": movie_year,
        "director": director,
        "overview": overview,
        "poster_path": poster_path,
    }
    return result


# ---------------------------------------------------------------------------
# Book entry creation handler
# ---------------------------------------------------------------------------

async def _handle_create_book_entry(args: dict[str, Any]) -> dict[str, Any]:
    return await asyncio.to_thread(_create_book_entry_sync, args)


def _create_book_entry_sync(args: dict[str, Any]) -> dict[str, Any]:
    api_key = os.environ.get("GOOGLE_BOOKS_API_KEY")

    title = args["title"]
    author = args.get("author")

    volume_id = args.get("google_books_id")
    if volume_id:
        import urllib.request
        url = f"https://www.googleapis.com/books/v1/volumes/{volume_id}"
        if api_key:
            url += f"?key={api_key}"
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req) as resp:
            book_data = json.loads(resp.read())
        volume = book_data.get("volumeInfo", {})
    else:
        results = _google_books_search(title, author, api_key)
        if not results:
            return {"error": f"No Google Books results for '{title}'" + (f" by {author}" if author else "")}
        volume = results[0].get("volumeInfo", {})

    book_title = volume.get("title", title)
    book_author = volume.get("authors", [author or ""])[0] if volume.get("authors") else (author or "")
    pub_date = volume.get("publishedDate", "")
    book_year = int(pub_date[:4]) if pub_date and len(pub_date) >= 4 else None
    description = volume.get("description", "")

    thumbnail = volume.get("imageLinks", {}).get("thumbnail", "")
    if thumbnail:
        thumbnail = thumbnail.replace("zoom=1", "zoom=2").replace("http://", "https://")

    locale = args.get("locale", "fr")
    slug = _slugify(book_title)

    image_rel = ""
    if thumbnail:
        cover_filename = f"{locale}-{slug}.jpg"
        cover_dest = member_root() / "images" / "resources" / "books" / cover_filename
        try:
            _download_image(thumbnail, cover_dest)
            image_rel = f"/images/{_garden_member()}/resources/books/{cover_filename}"
        except Exception as exc:
            LOGGER.warning("Failed to download cover for %s: %s", book_title, exc)

    publish_args: dict[str, Any] = {
        "collection": "books",
        "title": book_title,
        "author": book_author,
        "locale": locale,
        "slug": slug,
        "flags": args.get("flags", []),
        "content": args.get("content") or description,
        "translationKey": slug,
    }
    if book_year:
        publish_args["year"] = book_year
    if image_rel:
        publish_args["image"] = image_rel
    if args.get("rating"):
        publish_args["rating"] = args["rating"]
    if args.get("tags"):
        publish_args["tags"] = args["tags"]

    result = _handle_publish_content(publish_args)
    result["google_books"] = {
        "title": book_title,
        "author": book_author,
        "year": book_year,
        "description": description[:300] if description else "",
        "thumbnail": thumbnail,
    }
    return result


# ---------------------------------------------------------------------------
# Series entry creation handler
# ---------------------------------------------------------------------------

async def _handle_create_series_entry(args: dict[str, Any]) -> dict[str, Any]:
    return await asyncio.to_thread(_create_series_entry_sync, args)


def _create_series_entry_sync(args: dict[str, Any]) -> dict[str, Any]:
    api_key = os.environ.get("TMDB_API_KEY")
    if not api_key:
        return {"error": "TMDB_API_KEY environment variable is not set"}

    title = args["title"]
    year = args.get("year")

    series_id = args.get("tmdb_id")
    if not series_id:
        results = _tmdb_tv_search(title, year, api_key)
        if not results:
            return {"error": f"No TMDB TV results for '{title}'" + (f" ({year})" if year else "")}
        series_id = results[0]["id"]

    details = _tmdb_tv_details(series_id, api_key)

    series_title = details.get("name", title)
    first_air = details.get("first_air_date", "")
    series_year = int(first_air[:4]) if first_air and len(first_air) >= 4 else year
    overview = details.get("overview", "")
    poster_path = details.get("poster_path")
    num_seasons = details.get("number_of_seasons")

    platform = args.get("platform")
    if not platform:
        networks = details.get("networks", [])
        if networks:
            platform = networks[0].get("name")

    locale = args.get("locale", "fr")
    show_slug = _slugify(series_title)

    image_rel = ""
    if poster_path:
        poster_filename = f"{locale}-{show_slug}.jpg"
        poster_dest = member_root() / "images" / "resources" / "series" / poster_filename
        try:
            _download_poster(poster_path, poster_dest)
            image_rel = f"/images/{_garden_member()}/resources/series/{poster_filename}"
        except Exception as exc:
            LOGGER.warning("Failed to download poster for %s: %s", series_title, exc)

    episode_title = args.get("episode_title")

    if episode_title:
        show_file = member_root() / "series" / locale / f"{show_slug}.md"
        created_show = False
        if not show_file.exists():
            show_args: dict[str, Any] = {
                "collection": "series",
                "title": series_title,
                "locale": locale,
                "slug": show_slug,
                "flags": [],
                "content": overview,
                "translationKey": show_slug,
            }
            if series_year:
                show_args["year"] = series_year
            if image_rel:
                show_args["image"] = image_rel
            if platform:
                show_args["platform"] = platform
            show_result = _handle_publish_content(show_args)
            if show_result.get("error"):
                return show_result
            created_show = True

        ep_slug = _slugify(episode_title)
        episode_file_slug = f"{show_slug}--{ep_slug}"
        ep_args: dict[str, Any] = {
            "collection": "series",
            "title": series_title,
            "locale": locale,
            "slug": episode_file_slug,
            "flags": args.get("flags", []),
            "content": args.get("content", ""),
            "show": show_slug,
            "episode_title": episode_title,
        }
        if args.get("episode_number") is not None:
            ep_args["episode_number"] = args["episode_number"]
        if args.get("season") is not None:
            ep_args["season"] = args["season"]
        if args.get("rating"):
            ep_args["rating"] = args["rating"]
        if args.get("tags"):
            ep_args["tags"] = args["tags"]

        result = _handle_publish_content(ep_args)
        result["created_show"] = created_show
    else:
        publish_args: dict[str, Any] = {
            "collection": "series",
            "title": series_title,
            "locale": locale,
            "slug": show_slug,
            "flags": args.get("flags", []),
            "content": args.get("content") or overview,
            "translationKey": show_slug,
        }
        if series_year:
            publish_args["year"] = series_year
        if image_rel:
            publish_args["image"] = image_rel
        if platform:
            publish_args["platform"] = platform
        if args.get("seasons_watched"):
            publish_args["seasons_watched"] = args["seasons_watched"]
        if args.get("rating"):
            publish_args["rating"] = args["rating"]
        if args.get("tags"):
            publish_args["tags"] = args["tags"]

        result = _handle_publish_content(publish_args)

    result["tmdb"] = {
        "id": series_id,
        "title": series_title,
        "year": series_year,
        "overview": overview,
        "poster_path": poster_path,
        "number_of_seasons": num_seasons,
        "platform": platform,
    }
    return result


# ---------------------------------------------------------------------------
# Podcast entry creation handler
# ---------------------------------------------------------------------------

async def _handle_create_podcast_entry(args: dict[str, Any]) -> dict[str, Any]:
    return await asyncio.to_thread(_create_podcast_entry_sync, args)


def _create_podcast_entry_sync(args: dict[str, Any]) -> dict[str, Any]:
    api_key = os.environ.get("PODCASTINDEX_API_KEY")
    api_secret = os.environ.get("PODCASTINDEX_API_SECRET")
    if not api_key or not api_secret:
        return {"error": "PODCASTINDEX_API_KEY and PODCASTINDEX_API_SECRET environment variables are required"}

    title = args["title"]

    feed_id = args.get("podcastindex_id")
    if feed_id:
        import urllib.request
        headers = _podcastindex_auth_headers(api_key, api_secret)
        url = f"https://api.podcastindex.org/api/1.0/podcasts/byfeedid?id={feed_id}"
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read())
        podcast = data.get("feed", {})
    else:
        results = _podcastindex_search(title, api_key, api_secret)
        if not results:
            return {"error": f"No Podcast Index results for '{title}'"}
        podcast = results[0]

    podcast_title = podcast.get("title", title)
    host = podcast.get("author", "")
    description = podcast.get("description", "")
    artwork = podcast.get("artwork", "")
    website = podcast.get("url", "")

    locale = args.get("locale", "fr")
    show_slug = _slugify(podcast_title)

    image_rel = ""
    if artwork:
        art_filename = f"{locale}-{show_slug}.jpg"
        art_dest = member_root() / "images" / "resources" / "podcasts" / art_filename
        try:
            _download_image(artwork, art_dest)
            image_rel = f"/images/{_garden_member()}/resources/podcasts/{art_filename}"
        except Exception as exc:
            LOGGER.warning("Failed to download artwork for %s: %s", podcast_title, exc)

    episode_title = args.get("episode_title")

    if episode_title:
        show_file = member_root() / "podcasts" / locale / f"{show_slug}.md"
        created_show = False
        if not show_file.exists():
            show_args: dict[str, Any] = {
                "collection": "podcasts",
                "title": podcast_title,
                "host": host,
                "locale": locale,
                "slug": show_slug,
                "flags": [],
                "content": description,
                "translationKey": show_slug,
            }
            if website:
                show_args["url"] = website
            if image_rel:
                show_args["image"] = image_rel
            show_result = _handle_publish_content(show_args)
            if show_result.get("error"):
                return show_result
            created_show = True

        ep_slug = _slugify(episode_title)
        episode_file_slug = f"{show_slug}--{ep_slug}"
        ep_args: dict[str, Any] = {
            "collection": "podcasts",
            "title": podcast_title,
            "locale": locale,
            "slug": episode_file_slug,
            "flags": args.get("flags", []),
            "content": args.get("content", ""),
            "show": show_slug,
            "episode_title": episode_title,
        }
        if args.get("episode_number") is not None:
            ep_args["episode_number"] = args["episode_number"]
        if args.get("season") is not None:
            ep_args["season"] = args["season"]
        if args.get("guests"):
            ep_args["guests"] = args["guests"]
        if host:
            ep_args["host"] = host
        if args.get("tags"):
            ep_args["tags"] = args["tags"]

        result = _handle_publish_content(ep_args)
        result["created_show"] = created_show
    else:
        publish_args: dict[str, Any] = {
            "collection": "podcasts",
            "title": podcast_title,
            "host": host,
            "locale": locale,
            "slug": show_slug,
            "flags": args.get("flags", []),
            "content": args.get("content") or description,
            "translationKey": show_slug,
        }
        if website:
            publish_args["url"] = website
        if image_rel:
            publish_args["image"] = image_rel
        if args.get("tags"):
            publish_args["tags"] = args["tags"]

        result = _handle_publish_content(publish_args)

    result["podcastindex"] = {
        "title": podcast_title,
        "host": host,
        "description": description[:300] if description else "",
        "artwork": artwork,
        "url": website,
    }
    return result


# ---------------------------------------------------------------------------
# Episode search handlers
# ---------------------------------------------------------------------------

async def _handle_search_podcast_episodes(args: dict[str, Any]) -> dict[str, Any]:
    return await asyncio.to_thread(_search_podcast_episodes_sync, args)


def _search_podcast_episodes_sync(args: dict[str, Any]) -> dict[str, Any]:
    import urllib.request
    import urllib.parse

    api_key = os.environ.get("PODCASTINDEX_API_KEY")
    api_secret = os.environ.get("PODCASTINDEX_API_SECRET")
    if not api_key or not api_secret:
        return {"error": "PODCASTINDEX_API_KEY and PODCASTINDEX_API_SECRET environment variables are required"}

    feed_id = args["podcastindex_id"]
    limit = args.get("limit", 20)
    headers = _podcastindex_auth_headers(api_key, api_secret)
    url = f"https://api.podcastindex.org/api/1.0/episodes/byfeedid?id={feed_id}&max={limit}"
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read())

    episodes = []
    for ep in data.get("items", []):
        episodes.append({
            "id": ep.get("id"),
            "title": ep.get("title", ""),
            "datePublished": ep.get("datePublished"),
            "season": ep.get("season"),
            "episode": ep.get("episode"),
            "description": (ep.get("description", "") or "")[:200],
            "persons": [p.get("name", "") for p in (ep.get("persons", []) or [])],
        })

    return {"feed_id": feed_id, "count": len(episodes), "episodes": episodes}


async def _handle_search_series_episodes(args: dict[str, Any]) -> dict[str, Any]:
    return await asyncio.to_thread(_search_series_episodes_sync, args)


def _search_series_episodes_sync(args: dict[str, Any]) -> dict[str, Any]:
    import urllib.request

    api_key = os.environ.get("TMDB_API_KEY")
    if not api_key:
        return {"error": "TMDB_API_KEY environment variable is not set"}

    tmdb_id = args["tmdb_id"]
    season_num = args["season"]

    url = f"https://api.themoviedb.org/3/tv/{tmdb_id}/season/{season_num}?api_key={api_key}"
    req = urllib.request.Request(url, headers={"User-Agent": "Akita/1.0"})
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read())

    episodes = []
    for ep in data.get("episodes", []):
        episodes.append({
            "episode_number": ep.get("episode_number"),
            "name": ep.get("name", ""),
            "overview": (ep.get("overview", "") or "")[:200],
            "air_date": ep.get("air_date"),
        })

    return {"tmdb_id": tmdb_id, "season": season_num, "count": len(episodes), "episodes": episodes}


# ---------------------------------------------------------------------------
# Article entry creation handler
# ---------------------------------------------------------------------------

async def _handle_create_article_entry(args: dict[str, Any]) -> dict[str, Any]:
    return await asyncio.to_thread(_create_article_entry_sync, args)


def _create_article_entry_sync(args: dict[str, Any]) -> dict[str, Any]:
    url = args["url"]

    try:
        og = _extract_og_metadata(url)
    except Exception as exc:
        return {"error": f"Failed to fetch article URL: {exc}"}

    article_title = og.get("title", "")
    if not article_title:
        return {"error": "Could not extract title from article URL"}

    description = og.get("description", "")
    og_image = og.get("image", "")
    source = og.get("site_name", "")

    locale = args.get("locale", "fr")
    slug = _slugify(article_title)

    image_rel = ""
    if og_image:
        if og_image.startswith("/"):
            from urllib.parse import urlparse
            parsed = urlparse(url)
            og_image = f"{parsed.scheme}://{parsed.netloc}{og_image}"
        img_filename = f"{locale}-{slug}.jpg"
        img_dest = member_root() / "images" / "resources" / "articles" / img_filename
        try:
            _download_image(og_image, img_dest)
            image_rel = f"/images/{_garden_member()}/resources/articles/{img_filename}"
        except Exception as exc:
            LOGGER.warning("Failed to download OG image for %s: %s", article_title, exc)

    publish_args: dict[str, Any] = {
        "collection": "articles",
        "title": article_title,
        "url": url,
        "locale": locale,
        "slug": slug,
        "flags": args.get("flags", []),
        "content": args.get("content") or description,
        "translationKey": slug,
    }
    if source:
        publish_args["source"] = source
    if image_rel:
        publish_args["image"] = image_rel
    if args.get("tags"):
        publish_args["tags"] = args["tags"]

    result = _handle_publish_content(publish_args)
    result["og"] = {
        "title": article_title,
        "description": description[:300] if description else "",
        "image": og_image,
        "site_name": source,
    }
    return result


# ---------------------------------------------------------------------------
# Person entry creation handler
# ---------------------------------------------------------------------------

async def _handle_create_person_entry(args: dict[str, Any]) -> dict[str, Any]:
    return await asyncio.to_thread(_create_person_entry_sync, args)


def _create_person_entry_sync(args: dict[str, Any]) -> dict[str, Any]:
    name = args["name"]

    entity_id = args.get("wikidata_id")
    if not entity_id:
        results = _wikidata_search(name)
        if not results:
            return {"error": f"No Wikidata results for '{name}'"}
        entity_id = results[0]["id"]

    entity = _wikidata_entity(entity_id)

    labels = entity.get("labels", {})
    person_name = labels.get("en", {}).get("value", name)

    descriptions = entity.get("descriptions", {})
    description = descriptions.get("en", {}).get("value", "")
    role = args.get("role") or description

    image_filename = ""
    claims = entity.get("claims", {})
    p18 = claims.get("P18", [])
    if p18:
        mainsnak = p18[0].get("mainsnak", {})
        datavalue = mainsnak.get("datavalue", {})
        image_filename = datavalue.get("value", "")

    locale = args.get("locale", "fr")
    slug = _slugify(person_name)

    image_rel = ""
    if image_filename:
        image_url = _wikimedia_image_url(image_filename)
        img_filename = f"{locale}-{slug}.jpg"
        img_dest = member_root() / "images" / "resources" / "people" / img_filename
        try:
            _download_image(image_url, img_dest)
            image_rel = f"/images/{_garden_member()}/resources/people/{img_filename}"
        except Exception as exc:
            LOGGER.warning("Failed to download image for %s: %s", person_name, exc)

    publish_args: dict[str, Any] = {
        "collection": "people",
        "name": person_name,
        "locale": locale,
        "slug": slug,
        "flags": args.get("flags", []),
        "content": args.get("content", ""),
        "translationKey": slug,
    }
    if role:
        publish_args["role"] = role
    if image_rel:
        publish_args["image"] = image_rel
    if args.get("tags"):
        publish_args["tags"] = args["tags"]

    result = _handle_publish_content(publish_args)
    result["wikidata"] = {
        "id": entity_id,
        "name": person_name,
        "description": description,
        "image_filename": image_filename,
    }
    return result


# ---------------------------------------------------------------------------
# Hero image tools
# ---------------------------------------------------------------------------

def _generate_evocation(note_id: str, locale: str, fm: dict[str, Any], body: str) -> str:
    """Call Claude Haiku to generate a visual evocation from note content."""
    import anthropic

    title = fm.get("title", note_id)
    description = fm.get("description", "")
    tags = fm.get("tags", [])
    body_preview = body[:1500] if body else ""

    prompt = f"""\
You are writing a visual evocation for an AI image generator. Given a Map of Content (MOC) page,
produce a single vivid, concrete, visual description (2-3 sentences) that captures the essence
and mood of this topic. The description should be rich in sensory detail — colors, textures,
lighting, objects, atmosphere. Do NOT include any text or words in the scene.

Title: {title}
Description: {description}
Tags: {', '.join(tags) if tags else 'none'}
Content preview:
{body_preview}

Respond with ONLY the evocation text, no preamble or quotes."""

    client = anthropic.Anthropic(api_key=_anthropic_key())
    response = client.messages.create(
        model=_resolve_model("moc_evocations"),
        max_tokens=300,
        messages=[{"role": "user", "content": prompt}],
    )
    return response.content[0].text.strip()


def _handle_generate_evocation(args: dict[str, Any]) -> dict[str, Any]:
    note_id = args["id"]
    locale = args.get("locale", "en")
    path = _resolve_note_path(note_id, locale)
    if not path.exists():
        raise FileNotFoundError(f"Note not found: {path}")

    fm, body = _parse_note(path)
    if "moc" not in fm.get("flags", []):
        raise ValueError(f"Note '{note_id}' is not a MOC ('moc' not in flags)")

    evocation = _generate_evocation(note_id, locale, fm, body)

    # Store in frontmatter
    fm["evocation"] = evocation
    _write_note(path, fm, body)
    _auto_commit([path], f"evocation: generate for {note_id}")

    return {"id": note_id, "locale": locale, "evocation": evocation}


async def _handle_generate_hero_image(args: dict[str, Any]) -> dict[str, Any]:
    import urllib.request

    note_id = args["id"]
    locale = args.get("locale", "en")
    style_key = args["style"]

    if style_key not in HERO_STYLES:
        raise ValueError(f"Unknown style '{style_key}'. Valid: {', '.join(HERO_STYLES)}")

    path = _resolve_note_path(note_id, locale)
    if not path.exists():
        raise FileNotFoundError(f"Note not found: {path}")

    fm, body = _parse_note(path)
    if "moc" not in fm.get("flags", []):
        raise ValueError(f"Note '{note_id}' is not a MOC ('moc' not in flags)")

    # Resolve evocation: explicit param → frontmatter → auto-generate
    evocation = args.get("evocation") or fm.get("evocation")
    if not evocation:
        evocation = await asyncio.to_thread(
            _generate_evocation, note_id, locale, fm, body
        )
        fm["evocation"] = evocation

    # Build the full prompt
    preamble = HERO_STYLES[style_key]["preamble"]
    full_prompt = f"{preamble} Evoking the essence of: {evocation}"

    # Call fal.ai Flux
    fal_key = os.environ.get("FAL_KEY")
    if not fal_key:
        raise RuntimeError("FAL_KEY environment variable not set")

    payload = json.dumps({
        "prompt": full_prompt,
        "image_size": {"width": 1536, "height": 512},
        "num_inference_steps": 28,
        "num_images": 1,
    }).encode("utf-8")

    def _call_fal() -> dict[str, Any]:
        req = urllib.request.Request(
            "https://fal.run/fal-ai/flux/dev",
            data=payload,
            headers={
                "Authorization": f"Key {fal_key}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=120) as resp:
            return json.loads(resp.read())

    fal_result = await asyncio.to_thread(_call_fal)

    images = fal_result.get("images", [])
    if not images:
        raise RuntimeError(f"fal.ai returned no images: {fal_result}")

    image_url = images[0].get("url")
    if not image_url:
        raise RuntimeError(f"fal.ai image has no URL: {images[0]}")

    # Download and save image
    img_dest = member_root() / "images" / "notes" / f"{note_id}.jpg"
    img_dest.parent.mkdir(parents=True, exist_ok=True)

    def _download() -> None:
        req = urllib.request.Request(image_url, headers={"User-Agent": "Akita/1.0"})
        with urllib.request.urlopen(req, timeout=60) as resp:
            img_dest.write_bytes(resp.read())

    await asyncio.to_thread(_download)

    # Update note frontmatter
    image_rel = f"/images/{_garden_member()}/notes/{note_id}.jpg"
    fm["image"] = image_rel
    _write_note(path, fm, body)

    # Git commit
    _auto_commit(
        [img_dest, path],
        f"hero: generate {style_key} image for {note_id}",
    )

    return {
        "id": note_id,
        "locale": locale,
        "style": style_key,
        "image_path": _rel(img_dest),
        "image_rel": image_rel,
        "prompt": full_prompt,
        "evocation": evocation,
    }


# ---------------------------------------------------------------------------
# Standalone entrypoint
# ---------------------------------------------------------------------------

async def main() -> None:
    async with stdio_server() as (read_stream, write_stream):
        await app.run(read_stream, write_stream, app.create_initialization_options())


if __name__ == "__main__":
    asyncio.run(main())
