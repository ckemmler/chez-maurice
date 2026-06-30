# Akita MCP Servers (Tools)

This directory contains MCP servers that provide read-only, structured access to personal data sources.

## Philosophy

These servers are **data access layers**, not intelligent agents. They:

- Expose clean, minimal query primitives over personal data
- Return explicit, self-describing responses
- Make units, timestamps, and assumptions clear
- Are safe by default (read-only, no mutations)
- Serve as building blocks for higher-level agents

They do **NOT**:
- Perform analysis or make recommendations
- Infer lifestyle advice or insights
- Hide complexity behind vague abstractions
- Include "intelligence" that belongs at the agent layer

Think of them as well-designed database APIs that happen to speak MCP.

---

## Public vs. private tools (overlay model)

The MCP gateway (`mcp_gateway/server.py`) **discovers tools from disk** at runtime
— it hard-codes no tool name. On startup it scans `tools/`, skips the infra dirs
(`shared/`, `mcp_gateway/`), and mounts every remaining dir that exposes a tool
entrypoint. A dir conforms by providing, in its `server.py` (or `mcp_server.py`),
one of, tried in order:

1. `gateway_context` — an async context manager yielding a low-level MCP `Server`
   (use this when the tool owns setup/teardown or resolves its own config);
2. a module-level `app` (a low-level `Server`) — mounted directly;
3. a module-level `mcp` (a `FastMCP`) — its `_mcp_server` is mounted.

Because of this, the repo splits cleanly into **public** and **private** tools:

- **Public** (shipped in this repo): `garden/`, plus the `shared/` + `mcp_gateway/`
  infrastructure. This is all the open-source release contains.
- **Private** (everyone else: `calibre/`, `corpus/`, `tracks/`, `pipelines/`,
  `readwise/`, `health/`, `thoughts/`, `signals/`, `social/`, `calendar/`,
  `contacts/`, `tasks/`, `compte/`, `layouts/`, …). These live in a **separate
  private repo** and are dropped into `tools/` as an on-disk **overlay**. The
  gateway picks them up automatically; with them absent (the public checkout)
  it simply mounts only `garden`.

The root `.gitignore` is **default-deny** for `tools/*/`: any tool dir is private
unless explicitly allow-listed (currently `garden`, `shared`, `mcp_gateway`). To
open-source a new tool, add a `!/tools/<name>/` line; to keep one private, do
nothing.

> qdrant is used only by private tools (corpus migration reference, the calibre
> TUI, deep-research evidence search). It is therefore not part of the public
> release — the run scripts and installer don't launch or bundle it. The manual
> launcher (`scripts/start-qdrant.sh`) and its launchd plist are private-overlay
> infrastructure (gitignored).

---

## Available Servers

### 1. Health (`health/`)

**Status**: ✅ Operational

Provides access to Apple Health data (sleep, workouts, meditation, active energy).

**Data source**: MongoDB (via Health export app)
**Records**: 376 sleep sessions, 9072 energy readings, 33 workouts, 19 meditation sessions
**Coverage**: October 2024 - January 2025

**Tools**:
- `list_available_metrics()` - Discover what data exists
- `get_sleep(start_date, end_date)` - Query sleep data
- `get_recent_summary(days)` - Daily summaries for last N days

[View Health Server Documentation](./health/README.md)

---

## Planned Servers

### 2. Browser History (`browser/`)

**Status**: 🚧 Not yet implemented

Access to browser history, bookmarks, and reading patterns.

**Data source**: Browser SQLite databases
**Tools** (planned):
- `list_available_sources()` - Show browsers with available data
- `search_history(query, start_date, end_date)` - Search browsing history
- `get_frequent_sites(days)` - Most visited sites recently

---

### 3. Notes (`notes/`)

**Status**: 🚧 Not yet implemented

Access to personal notes, PKM system, second brain.

**Data source**: TBD (Obsidian, Logseq, or custom)
**Tools** (planned):
- `list_notebooks()` - Available notebooks/vaults
- `search_notes(query)` - Full-text search
- `get_recent_notes(days)` - Recently modified notes
- `get_note_by_id(id)` - Retrieve specific note

---

### 4. Readwise (`readwise/`)

**Status**: 🚧 Not yet implemented

Access to book highlights, article annotations, reading history.

**Data source**: Readwise API or export
**Tools** (planned):
- `search_highlights(query)` - Search highlights
- `get_book_highlights(book_id)` - Get all highlights from a book
- `get_recent_highlights(days)` - Recently added highlights

---

### 5. YouTube (`youtube/`)

**Status**: 🚧 Not yet implemented

### 6. Thoughts (`thoughts/`)

**Status**: 🚧 Experimental

Desktop MCP server that reads plain Markdown notes (inbox + archives) and cached
chat summaries directly from disk. There is no database layer; it streams the
existing files so agents can read your writing without touching MongoDB.

**Tools**:
- `list_thoughts(start_day, end_day, source_types?, limit?)`
- `summary_by_day(start_day, end_day, source_types?)`

Use this to surface recent ideas, interests, or prompts for downstream agents.

Access to YouTube watch history, liked videos, subscriptions.

**Data source**: Google Takeout or YouTube API
**Tools** (planned):
- `search_watch_history(query, start_date, end_date)` - Search videos watched
- `get_channel_stats()` - Subscriptions and watch patterns
- `get_recent_watches(days)` - Recently watched videos

---

## Architecture Principles

Each MCP server follows this structure:

```
<server-name>/
├── server.py          # MCP server implementation
├── queries.py         # Database/API query functions
├── schemas.py         # Response schemas (Pydantic)
├── config.py          # Configuration (env vars, paths)
├── requirements.txt   # Python dependencies
├── README.md          # Server-specific documentation
└── tests/             # Unit tests
```

### Common Patterns

All servers share these design patterns:

1. **Discovery tool**: Every server has a `list_available_*()` tool
2. **Date-scoped queries**: All time-based queries require explicit date ranges
3. **Standardized responses**: All responses include `metadata`, `data`, and `units`
4. **Read-only**: No mutations, safe by default
5. **Self-describing**: Responses include query parameters and timestamps

### Response Format

All servers return responses in this format:

```json
{
  "metadata": {
    "tool": "tool_name",
    "query": {"param": "value"},
    "returned_count": 10,
    "data_source": "source_name",
    "timestamp": "2024-01-18T10:30:00Z"
  },
  "data": [
    { ... }
  ],
  "units": {
    "field_name": "unit description"
  }
}
```

---

## Using MCP Servers

### With Claude Desktop

Add servers to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "example-tool": {
      "command": "python",
      "args": ["/path/to/your-tool/server.py"],
      "env": {
        "EXAMPLE_DB_URI": "mongodb://USER:PASSWORD@localhost:27017/db?authSource=admin"
      }
    }
  }
}
```

### With Open WebUI (Future)

An HTTP proxy will expose MCP servers as REST endpoints:

```
GET /health/sleep?start_date=2024-01-01&end_date=2024-01-31
→ Calls get_sleep() tool
→ Returns JSON response
```

The proxy will be built once multiple data sources are available.

---

## Development

### Creating a New Server

1. Copy the `health/` template
2. Implement `queries.py` for your data source
3. Define response schemas in `schemas.py`
4. Register tools in `server.py`
5. Document in README.md
6. Test with Claude Desktop

### Shared Utilities (Future)

Common code will be extracted to `shared/`:

```
tools/shared/
├── base_server.py    # Common MCP server setup
├── response.py       # Shared response formatting
└── utils.py          # Date parsing, validation
```

---

## Testing

Each server should have unit tests:

```bash
cd <server-name>
pytest
```

Test coverage should include:
- Query functions (mocked database)
- Response formatting
- Error handling
- Date range validation

---

## Constraints & Principles

These constraints apply to all MCP servers:

1. **Local-first**: Data lives on your machine, queries run locally
2. **Inspectable schemas**: You can verify data by querying sources directly
3. **Explicit semantics**: No hidden assumptions, all units stated
4. **Privacy by design**: No external API calls (except for authorized services)
5. **Read-only by default**: Mutations require explicit opt-in
6. **Minimal dependencies**: Only what's necessary
7. **No magic**: Simple, understandable code you can reason about

---

## Future: Agent Layer

Once multiple data sources are available, **agents** will be built on top:

### Recommendation Agent
- Queries: health, browser, readwise
- Generates: personalized content recommendations
- Grounds outputs in specific data items

### Synthesis Agent
- Queries: notes, readwise, health
- Generates: article drafts grounded in your notes
- Always cites sources explicitly

### Research Agent
- Queries: browser, notes, youtube
- Synthesizes: research on topics you're exploring
- Builds on your existing knowledge

Agents will use these MCP servers as **read-only data sources**, never modifying personal data directly.

---

## License

MIT
