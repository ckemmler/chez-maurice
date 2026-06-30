# Corpus migration: Qdrant → sqlite-vec, per-user DBs, conversation search

Status: proposed (2026-06-14)

## Goal

Replace Qdrant with **sqlite-vec** as the corpus vector store, shard the index into
**one DB file per user**, and add **conversations** (both live Maurice rooms and an
imported Claude.ai archive) as searchable sources alongside books, thoughts, and
dossiers.

## Why

- Qdrant is a running daemon/extra process that this personal, single-box setup does
  not need at current scale (~33k vectors today, 99% Calibre book chunks).
- sqlite-vec is an in-process loadable extension; brute-force KNN over 768-dim vectors
  is single-digit→tens of ms well past several hundred thousand chunks. See the scale
  analysis below.
- We have decided there is **no cross-user search**. Every query is scoped to one
  member. That makes physical per-user DB files the natural, leak-proof isolation
  grain (replacing today's "shared collection + `member_id` filter").

## Current architecture (what exists today)

File-based pipeline, single shared Qdrant collection `akita-corpus`
(768-dim, cosine), multi-user via a payload tag + query filter:

```
watcher.py ─┐
            ├─► orchestrator.index_file ─► processor.process_file
glob/initial┘                               │ hash check (hash_store.py, sqlite by path)
                                            │ read+frontmatter (utils.py)
                                            │ chunk (chunker.py: paragraph/fixed/heading/semantic)
                                            │ embed once (embedder.py: Ollama nomic-embed-text via OpenAI API)
                                            ▼
                                   indexer.CorpusIndexer (Qdrant)
                                     upsert_file / delete_file / scroll / count
                                     payload["member_id"] = member_id_var.get()
search.py ─► semantic_search ─► indexer.client.query_points(filter member_id=…)
mcp_server.py ─► MCP tools (search, search_in_book, search_by_author, search_by_tags, …)
```

Key facts that shape the migration:

- **`member_id` already flows per-request.** `mcp_gateway/server.py` `MemberContextMiddleware`
  reads `X-Maurice-Member-Id` and sets `tools/shared/context.py::member_id_var`. Both
  `indexer.upsert_file` and `search.semantic_search` already read it. → Per-user DB
  routing reuses this exact signal; no new auth plumbing.
- **Chunk identity is deterministic:** `uuid5(NAMESPACE_URL, f"{file_path}:{idx}")`
  (`indexer.upsert_file`). We extend this scheme to non-file units.
- **`search.py` reaches into `indexer.client.query_points` directly** — the one place
  the Qdrant type leaks past the indexer. The abstraction below closes that.
- **Sources are file-only.** `process_file` takes a `Path`, `hash_store` is keyed by
  path, `delete_file` selects by `file_path`. Conversations need a parallel,
  DB-backed ingestion path — none of the file machinery assumes conversations.

## Scale analysis (the basis for the decision)

~100 books → ~33k chunks ⇒ **~330 chunks/book**. Each 768-dim float32 vector ≈ 3 KB.

**Claude.ai archive measured** (the export at `data/data-4a70fa45-…-batch-0000.zip`,
`conversations.json` = 98 MB raw): **1,029 conversations, 11,018 messages (9,012
non-empty), 16.9M chars** (93% assistant text; median message 300 chars, max 34k).
This is far smaller than first feared — the archive is "1k conversations," not "tens
of thousands." Chunk projection:

| Chunking | Chunks | Vectors |
|---|---|---|
| ~256 tok (thought-like) | ~22,300 | ~69 MB |
| ~512 tok | ~14,500 | ~45 MB |

So Candide's **full** per-user DB lands around:

| Source | Chunks |
|---|---|
| Books (today) | ~33,000 |
| Thoughts + dossiers | ~260 |
| Claude archive | ~14k–22k |
| Live Maurice rooms (today: 674 msgs) | ~hundreds |
| **Total** | **~48k–55k (~150 MB vectors)** |

That is squarely in sqlite-vec's **trivial** range — brute-force KNN is single-digit→
low-tens of ms, no quantization needed. The earlier "borderline at ~1M" scenario does
not arise from this data; it would take a 20× growth in books or archive to approach
it. Forward headroom if it ever does: queries are naturally **scoped** (`source_type`,
date) so the effective scan is a fraction of the file, and sqlite-vec
**bit-quantization** (32× smaller, ~10–20× faster, with a re-rank step) is available.
Qdrant's HNSW only earns its operational cost with a *shared* multi-million-vector
pool — which we explicitly do not have, because every query hits exactly one user's
file. **Conclusion: retire Qdrant; sqlite-vec is comfortably correct.**

## Target architecture

### Per-user DB files

```
tools/corpus/data/vectors/<member_id>.db   # one sqlite-vec DB per member
tools/corpus/data/index_state.db           # unchanged: file hashes + new cursor tables
```

A request carries `member_id` (header → `member_id_var`). The store opens/caches the
connection for that member's file. **No `member_id` column, no cross-user filter** —
isolation is the filesystem. Dropping a user = delete one file. Re-indexing a user =
rebuild one file.

Shared (multi-participant) conversations are the one case where the same chunk lands
in more than one file: we **embed once and fan the resulting vector out** into each
participant's DB (see Conversations below). Embedding is the cost; copying a 3 KB
vector is free.

### Schema (per member DB)

sqlite-vec `vec0` virtual table for vectors + a plain table for metadata, joined by
`rowid`. This keeps rich filtering (book/author/tags/source_type) working and lets us
use sqlite-vec's `rowid in (...)` pre-filter for scoped KNN.

```sql
-- vectors
CREATE VIRTUAL TABLE vec_chunks USING vec0(
  embedding float[768]
);
-- metadata (rowid == vec_chunks.rowid)
CREATE TABLE chunks (
  rowid        INTEGER PRIMARY KEY,
  chunk_id     TEXT UNIQUE,          -- uuid5, stable
  source       TEXT,                 -- source name
  source_type  TEXT,                 -- book | thought | dossier | conversation
  unit_key     TEXT,                 -- file_path OR conversation/message key
  unit_hash    TEXT,                 -- file hash OR message-content hash
  chunk_index  INTEGER,
  total_chunks INTEGER,
  text         TEXT,
  embedding_model TEXT,
  indexed_at   TEXT,
  -- denormalized metadata used by filters:
  book_title TEXT, book_id TEXT, author TEXT, chapter TEXT,
  date TEXT, conversation_id TEXT, message_id TEXT, author_id TEXT
);
CREATE INDEX idx_chunks_unit   ON chunks(source_type, unit_key);
CREATE INDEX idx_chunks_convo  ON chunks(conversation_id);
CREATE INDEX idx_chunks_book   ON chunks(book_title);
-- optional: FTS5 over chunks.text/book_title for substring parity with Qdrant MatchText
```

KNN query (scoped example):

```sql
-- candidate rowids from metadata filter (e.g. a set of book_ids), then vector KNN
SELECT c.chunk_id, c.text, c.book_title, k.distance
FROM (
  SELECT rowid, distance FROM vec_chunks
  WHERE embedding MATCH :qvec AND k = :limit
        AND rowid IN (SELECT rowid FROM chunks WHERE book_id IN (:ids))
) k JOIN chunks c ON c.rowid = k.rowid
ORDER BY k.distance;
```

Unscoped search drops the `rowid IN (...)` clause.

### Storage abstraction (contains the swap)

Introduce a `VectorStore` protocol so processor/search/stats stop importing Qdrant
types. Both backends implement it; we keep Qdrant working until parity is proven.

```python
class VectorStore(Protocol):
    def upsert(self, *, member_id, unit_key, unit_hash, chunks, vectors,
               base_metadata, embedding_model) -> int: ...
    def delete_unit(self, *, member_id, unit_key) -> None: ...
    def delete_by_hash(self, *, member_id, unit_hash) -> None: ...
    def get_chunk(self, *, member_id, chunk_id) -> dict | None: ...
    def iter_chunks(self, *, member_id, where=None, limit=...) -> Iterator[dict]: ...
    def count(self, *, member_id, where=None) -> int: ...
    def search(self, *, member_id, vector, limit, filters=None) -> list[dict]: ...
    def stats(self, *, member_id) -> dict: ...
```

- `QdrantStore` = today's `CorpusIndexer` adapted to this signature (`unit_key`→`file_path`,
  filters→`member_id` payload filter). Minimal change; keeps the old path alive.
- `SqliteVecStore` = new; routes by `member_id` to the per-user file, implements the
  schema/queries above, caches one connection per member.
- `search.py::semantic_search` calls `store.search(...)` instead of
  `indexer.client.query_points(...)`. `corpus_stats` calls `store.stats(...)`. The
  filter dict (`book_title`, `author`, `book_id` list, etc.) is interpreted by each
  backend.

Selected via config: `store.backend: qdrant | sqlite_vec`.

## Conversations as sources

Two streams, both land as `source_type = conversation`:

### A. Live Maurice rooms (`maurice.db`)

- **Read** `conversations`, `messages`, `conversation_participants` from
  `~/.maurice/maurice.db` (path via `MAURICE_DATA_DIR`, same default as the server).
- **Unit = message.** `unit_key = f"msg:{message_id}"`,
  `chunk_id = uuid5(NAMESPACE_URL, f"msg:{message_id}:{idx}")`,
  `unit_hash = sha256(content)`.
- **Chunking:** paragraph method, small `max_tokens` (≈256) like thoughts. Maurice
  messages (`author_id` NULL) index the same as human messages.
- **Fan-out (embed once → copy):** resolve participants via
  `conversation_participants(member_id)` for the message's conversation; embed the
  message's chunks **once**, then `store.upsert(member_id=p, …)` into each
  participant's DB. Common case (1 human + Maurice) = single participant, no copy.
- **Incremental cursor:** new table in `index_state.db`:
  `convo_index_state(conversation_id, member_id, last_message_id, last_created_at)`.
  Per `(conversation, member)` so a late joiner can be backfilled independently.
- **Lifecycle:**
  - *Join later* → backfill that conversation's existing chunks into the new
    participant's DB (vector copy from any existing participant's DB, or re-embed;
    copy preferred).
  - *Leave* → stop fanning new messages to them; existing copies kept (they had
    access at the time). Deletion is a product choice, not required for correctness.
  - *Message edit/delete* → `unit_hash` change re-indexes; delete removes by `unit_key`
    across that conversation's participant DBs.

### B. Claude.ai archive (one-shot import)

- Past Claude conversations live **outside** maurice.db (a `conversations.json`
  export). Single owner (Candide) → no fan-out, all into his member DB.
- A standalone importer parses the export, normalizes each conversation/message to the
  same chunk/metadata shape (`source_type=conversation`, `source=claude-archive`,
  `date`, `conversation_id`, `message_id`), embeds, and bulk-inserts.
- Measured: 1,029 conversations / 11,018 messages / 16.9M chars → ~14k–22k chunks
  (see Scale analysis). Modest — one indexing pass.
- Export shape: top-level JSON list; each conversation has `uuid`, `name`,
  `created_at`, `chat_messages[]`; each message has `uuid`, `sender`
  (`human`/`assistant`), `text` + `content[]` blocks, `created_at`, `attachments`,
  `files`. The zip also carries `projects/*.json` and `design_chats/*.json` (decide
  later whether to index those too).

### Triggering (live stream)

- **Push (primary, low latency):** the TS server, after a turn completes, calls a new
  corpus MCP tool `index_conversation(conversation_id)` (or `index_messages`) through
  the gateway. Gateway already attaches `member_id`; the tool resolves participants
  itself for fan-out.
- **Backfill/reconcile (safety net + initial import):** `main.py` gains
  `index --source conversations`, scanning maurice.db for messages past each
  `(conversation, member)` cursor. Mirrors today's `initial_index` + watcher split.

## Server integration (TS side)

- **Query:** no server change needed for search itself — the app/server already reach
  corpus search via the MCP gateway with the member header. Conversation results just
  appear with `source_type=conversation`.
- **Index trigger:** add one call after assistant turn persists (in
  `server/src/services/conversations.ts` or wherever the turn finalizes) →
  gateway → `index_conversation`. Fire-and-forget; the backfill loop covers misses.

## Phased delivery (ordered to de-risk)

1. ✅ **DONE — Abstraction, no behavior change.** Added `src/store.py`
   (`VectorStore` Protocol + `make_store` factory); renamed `CorpusIndexer`→
   `QdrantStore` (alias kept) implementing the generic surface
   (`upsert`/`delete_unit`/`get_chunk`/`iter_chunks`/`search`/`total_count`); moved the
   Qdrant filter helpers into the store so the `.client.query_points`/`get_collection`
   leaks are gone from `search.py`. `processor`/`search`/`orchestrator` route through
   the protocol; `mcp_server.py`/`main.py` untouched (var still named `indexer`).
   Verified: all modules import, `QdrantStore` structurally satisfies `VectorStore`,
   live search/filter/stats/file-chunks/chunk-context return identical results against
   the existing collection (33,254 chunks).
2. ✅ **DONE — sqlite-vec backend.** Added `src/sqlite_vec_store.py`
   (`SqliteVecStore`): per-member DB file routing (`<vectors_dir>/<member>.db`,
   `member_id`→file, `_default.db` when unset), `vec0(... distance_metric=cosine)` +
   a `chunks` table holding the full Qdrant-equivalent payload as JSON, KNN with a
   `rowid IN (subquery)` pre-filter for scoped search, thread-safe connection cache,
   and embedding-model pinning in `corpus_meta` (mixed models refused). `config.py`
   gains `StoreConfig` (`backend` + `path`); `make_store` branches on
   `store.backend: sqlite_vec`. `requirements.txt` adds `sqlite-vec>=0.1.9`.
   Verified on real data: indexing dossiers gives an exact 96/96 chunk match;
   filtered search / stats / `get_chunk` / `get_file_chunks` / `get_chunk_context`
   all pass; cosine `score = 1 − distance` matches Qdrant within ~2% (residual is
   historical-vs-fresh embedding drift); **sqlite-vec KNN ordering is identical to a
   numpy brute-force over the same vectors** (KNN is exact). Note: `total_count` now
   returns the real per-file count — Qdrant's returned 0 (a pre-existing quirk), so
   `corpus_stats.total_chunks` becomes correct under sqlite-vec.
   Env note: this box's homebrew Python 3.14 has a broken `pyexpat`, so pip/uv can't
   run; sqlite-vec was installed by unzipping the wheel into site-packages. The
   runtime itself is fine (no XML on the hot path).
3. ✅ **DONE — cutover (migrate, not re-index).** Discovery changed the approach: the
   collection holds **167 `report` chunks with no live source** in `corpus.yaml`
   (a re-index would silently drop them), plus all 33,254 chunks carry no `member_id`
   (→ one `_default.db`). So instead of re-indexing we **migrate the vectors verbatim**
   — `migrate_qdrant_to_sqlite.py` scrolls Qdrant `with_vectors=True` and
   `SqliteVecStore.bulk_load`s each point into `<vectors_dir>/<member>.db`, routed by
   payload `member_id`. Preserves orphaned content, zero embedding drift, no re-embed
   (33,254 chunks in ~12 s; `_default.db` = 251 MB). `corpus.yaml` now sets
   `store.backend: sqlite_vec` (qdrant block kept as migration reference).
   Parity verified: counts exact (book 32,991 / report 167 / dossier 96); unfiltered
   and `source_type`-filtered queries match Qdrant **10/10 with max|Δscore| = 0.00000**;
   narrow `book_title` filters return identical *score distributions* (the only
   chunk-id differences are tie-breaks among equal-distance chunks). E2E: the MCP
   server path (`orchestrator` → `search`/`search_in_book`/`stats`) runs entirely on
   sqlite-vec and constructs **no Qdrant client**. The Qdrant daemon/data is untouched
   and can be stopped once you're satisfied — not torn down here.
4. ✅ **DONE (corpus side) — live conversations.** `src/conversations.py`
   (`MauriceConversations`) reads `maurice.db` read-only and **reconciles** each
   conversation per `(conversation, member)`: it diffs the DB against what each
   participant's vector DB holds, then adds/edits/deletes — idempotent, no cursor
   table needed. Unit = message (`unit_key = msg:<id>`, `unit_hash = sha256(content)`),
   paragraph-chunked at ~256 tokens, `user`+`assistant` roles. Embedding happens once
   per message and the vectors fan out to every participant's DB. Routing fix in the
   store: a member's `search` now **unions their own DB with the shared `_default`
   pool** (private conversations + household books) and merge-sorts by score; writes
   stay per-member. Wired: `orchestrator.index_conversations`, MCP `index_conversation`
   tool (one room or all), `main.py` `index --source conversations` backfill.
   Verified: synthetic lifecycle test passes fan-out / edit / delete / join /
   idempotency; real backfill = 83 conversations → 1,015 chunks across 5 member DBs
   (~25 s); a member search returns conversation hits *and* shared books merged by
   score. **Server push hook added:** `mcpClient.indexConversationInBackground()` is
   fired (fire-and-forget) right after the assistant message is persisted in
   `routes/conversations.ts`, calling the corpus `index_conversation` tool via the
   loopback gateway. Compiles + bundles clean under Bun; the live push path
   (server→gateway→corpus) still needs end-to-end verification on a running stack —
   the periodic `index --source conversations` backfill is the safety net until then.
5. ✅ **DONE (backend) — Anthropic data-export import.** `src/anthropic_import.py`:
   `AnthropicArchiveImporter` reads the Claude.ai export `.zip` (`conversations.json`),
   imports **incrementally** from a per-member **watermark** (only conversations newer
   than the last successful sync), dedupes by message hash, and embeds into the
   member's private index as `source_type=conversation`, `source=anthropic-archive`,
   keyed `amsg:<uuid>` (no collision with live `msg:<id>` rooms). `ImportHistoryStore`
   logs each `ImportRun {range_from, range_to, conversations, messages, ran_at, status}`;
   **watermark = latest *successful* run's `range_to`** — a `partial`/`failed` run is
   logged but does **not** advance it (next run dedupes the already-written chunks, so
   no staging/swap needed). Wired: `orchestrator.import_anthropic_export` /
   `get_import_history`, MCP tools `import_anthropic_export` + `import_history`.
   Matches the Claude Design handoff contracts (saved at
   `design/import_conversations/`). Verified on the real 1,029-conversation export:
   incremental slices advance the watermark monotonically, re-import writes 0 (dedupe),
   a simulated mid-run failure records `partial` without advancing the watermark, the
   `text`/`content[]` duplication is de-dup'd, and imported conversations are
   searchable. **Async job + admin UI added:** the corpus has an in-process import-job
   registry (`start_import_job`/`job_status`; the corpus runs inside the persistent MCP
   gateway, so jobs survive across calls) exposed as MCP `import_anthropic_export`
   (returns `job_id`) + `import_status` + `import_history`. The real admin is the
   **server-rendered web admin** (`server/src/routes/web-admin.ts`, mounted `/admin` —
   not SwiftUI, my earlier miss): the member fiche (`/users/:id/edit`) gains an
   "Anthropic data export" card (history + watermark + upload + live progress), backed
   by `POST /users/:id/import` (multipart → save zip → start corpus job), `GET
   …/import/status`, `GET …/import/history`, which proxy the corpus tools via
   `mcpClient.corpusCall`. Corpus + server both verified (import-check; tsc clean on the
   touched files; bundles).
   **Reframed + shipped live — import creates real conversations, not just vectors.**
   The importer now creates a first-class `maurice.db` conversation per Claude
   conversation (id = the export's own uuid → trivial dedup; `origin='anthropic'`;
   export timestamps normalized to maurice.db's naive-UTC format), then search-indexes
   each via the Phase 4 reconcile — the `amsg` direct-embed path was dropped.
   `conversations.origin` is exposed in the DTO; the iOS/macOS sidebar badges
   `origin=='anthropic'` rows with the Anthropic logo (reusing `ProviderBadge`). The
   gateway namespaces tools as `corpus__<tool>` — `corpusCall` now prefixes
   accordingly. Verified live end-to-end: a UI-triggered import created **725
   conversations / 9,012 messages** in maurice.db (sidebar-visible), indexed to 14,980
   chunks under the unified `maurice-conversations` source, **no DB locks/errors**
   despite the corpus writing the server's DB concurrently. **Remaining:**
   `with_projects` path, uploaded-zip cleanup, the section's full i18n/visual polish.
6. **Cleanup.** Remove Qdrant deps (`qdrant_client`), `qdrant:` config block, dead
   `member_id` filter code. Update `corpus.yaml` + README.

## Forward compatibility: local search + sync

Per-user files are chosen partly to keep a future **on-device vector search + sync**
open. The enabling principle, which constrains the design now:

- **The vector DB is derived data.** Embeddings are a deterministic function of
  (content + model). Nothing may live *only* in a vector DB — every chunk is
  rebuildable from its source (book/message/note). `chunk_id` is already deterministic
  (`uuid5` of the unit key), so this holds; keep it that way.
- **Never CRDT-merge vector tables.** `vec0` is backed by shadow tables with no
  row-level multi-writer merge story. Sync the **source content** (already the server's
  job via `maurice.db` + API); treat each per-user vector DB as a rebuildable cache.
- **Two sync topologies**, easy → hard: (a) one-way replica — server builds the index
  and ships read-only snapshots to the device, which does KNN locally; (b) offline-first
  — device re-embeds synced content into its own DB. Neither needs vector conflict
  resolution.
- **Portability:** sqlite-vec is a single C file, statically compilable into the
  iOS/macOS app (`sqlite3_auto_extension`; iOS forbids runtime dynamic loading). The
  same `.db` opens identically on server and device. (Qdrant could not do this.)
- **Gotchas:** embedding-model parity is mandatory (pin model in DB metadata, refuse
  mismatch — query and index must share a model); snapshot via SQLite backup API /
  `VACUUM INTO`, never `cp` a live WAL DB; quantize (int8/bit) if shipping ~150 MB to
  phones.

This costs nothing extra now — it is satisfied by keeping the vector DB strictly
derivable from synced source content.

## Open decisions to confirm before building

1. **One file per user vs one file + `member_id` partition column.** ✅ RESOLVED:
   **per-user files.** Max isolation, bounded scan, trivial per-user drop/rebuild,
   fan-out = N inserts across N files — and the natural sync/replication unit for the
   future on-device search (see Forward compatibility).
2. **Leave semantics:** keep a departed participant's existing copies (recommended) or
   purge on leave?
3. **Text-filter parity:** Qdrant `MatchText` does token/substring matching on
   `book_title`/`author`. Match it in sqlite with `LIKE`, or add FTS5 for closer
   parity? (FTS5 if substring search quality matters.)
4. **Embed-model lock-in:** all DBs must share one embedding model
   (`nomic-embed-text`, 768-dim). A model change = full re-index. Worth pinning the
   model name in each DB's metadata (already in schema) and refusing mixed models.
```
