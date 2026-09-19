import { Database } from "bun:sqlite";
import { join } from "path";
import { mkdirSync, existsSync } from "fs";
import { getAppDir, getMauriceDbPath } from "../lib/appDir";

// Where the app's own state lives (maurice.db, avatars, images, files). The rule
// itself lives in lib/appDir.ts so data-api resolves maurice.db identically —
// see the note there about why this is not config.toml's data_dir.
const dataDir = getAppDir();
mkdirSync(dataDir, { recursive: true });

const dbPath = getMauriceDbPath();
const db = new Database(dbPath, { create: true });

// WAL mode for concurrent reads
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA foreign_keys = ON");

// ── Schema ──────────────────────────────────────────────────────

db.run(`
  CREATE TABLE IF NOT EXISTS households (
    id         TEXT PRIMARY KEY DEFAULT 'default',
    name       TEXT NOT NULL DEFAULT 'Home',
    api_key    TEXT,
    default_model TEXT NOT NULL DEFAULT 'claude-sonnet-4-20250514',
    max_tokens INTEGER NOT NULL DEFAULT 4096,
    color      TEXT,
    icon       TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);
// Per-foyer identity for the app's household switcher (optional overrides; the
// app falls back to a derived colour/icon when null).
try { db.run(`ALTER TABLE households ADD COLUMN color TEXT`); } catch {}
try { db.run(`ALTER TABLE households ADD COLUMN icon TEXT`); } catch {}

// Ensure the single household row exists
db.run(`
  INSERT OR IGNORE INTO households (id) VALUES ('default')
`);

db.run(`
  CREATE TABLE IF NOT EXISTS users (
    id           TEXT PRIMARY KEY,
    household_id TEXT NOT NULL DEFAULT 'default' REFERENCES households(id),
    username     TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    role         TEXT NOT NULL DEFAULT 'standard' CHECK (role IN ('admin', 'standard', 'guest')),
    password_hash TEXT,
    pin_hash     TEXT,
    avatar_color TEXT NOT NULL DEFAULT '#2c5aa0',
    profile_text TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    last_active_at TEXT
  )
`);
// Each member's preferred model for the everyday (unspecialized) Maurice. Null =
// the household default. Specialized Maurices carry their own `model`; this is
// the per-member equivalent for the everyday one, which has no row of its own.
try { db.run(`ALTER TABLE users ADD COLUMN everyday_model TEXT`); } catch {}

db.run(`
  CREATE TABLE IF NOT EXISTS sessions (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id  TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_used_at TEXT,
    expires_at TEXT
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS conversations (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title      TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS messages (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role            TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content         TEXT NOT NULL,
    model           TEXT,
    maurice_id      TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

db.run(`
  CREATE INDEX IF NOT EXISTS idx_messages_convo
    ON messages(conversation_id, created_at)
`);
// Which Maurice produced each assistant turn (null = everyday). Drives per-
// message avatars + the "who participated" cluster. The ALTER runs once on
// existing DBs; the backfill (same try) then stamps historical assistant
// messages with their conversation's specialist.
try {
  db.run(`ALTER TABLE messages ADD COLUMN maurice_id TEXT`);
  db.run(
    `UPDATE messages SET maurice_id =
       (SELECT maurice_id FROM conversations c WHERE c.id = messages.conversation_id)
     WHERE role = 'assistant'`
  );
} catch {}

// Structured tool results for a turn — a JSON array of { tool, data } captured
// at stream time so the client can render the actual rows alongside Maurice's
// prose (a deterministic, model-untouched ground-truth channel). Null for turns
// that called no data-returning tools.
try { db.run(`ALTER TABLE messages ADD COLUMN data TEXT`); } catch {}

// What the turn cost — a JSON TurnUsage (see services/pricing.ts) with the token
// counts summed across the turn's agentic rounds, plus the priced figure. Kept
// on the message so the cost stays visible after a reload, not just live on the
// stream. Null for human turns and for providers that report no usage.
try { db.run(`ALTER TABLE messages ADD COLUMN usage TEXT`); } catch {}

db.run(`
  CREATE INDEX IF NOT EXISTS idx_conversations_user
    ON conversations(user_id, updated_at DESC)
`);

// ── Shared rooms ────────────────────────────────────────────────
// A conversation is a "room". 1:1 chats are just rooms with a single human
// participant; multi-human rooms summon Maurice with @claude. conversations.user_id
// stays as the creator/owner; membership lives here so access is participant-based.
db.run(`
  CREATE TABLE IF NOT EXISTS conversation_participants (
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    member_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role            TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
    joined_at       TEXT NOT NULL DEFAULT (datetime('now')),
    last_read_at    TEXT,
    PRIMARY KEY (conversation_id, member_id)
  )
`);
// Read state per participant → drives the per-foyer unread roll-up.
try { db.run(`ALTER TABLE conversation_participants ADD COLUMN last_read_at TEXT`); } catch {}
db.run(`
  CREATE INDEX IF NOT EXISTS idx_participants_member
    ON conversation_participants(member_id, conversation_id)
`);

// Messages carry their human author (null for Maurice/assistant + system).
try { db.run(`ALTER TABLE messages ADD COLUMN author_id TEXT REFERENCES users(id)`); } catch {}

// Backfill (idempotent): every existing conversation's owner becomes an 'owner'
// participant, and existing human messages get authored by that owner.
db.run(`
  INSERT OR IGNORE INTO conversation_participants (conversation_id, member_id, role)
    SELECT id, user_id, 'owner' FROM conversations
`);
db.run(`
  UPDATE messages SET author_id = (
    SELECT user_id FROM conversations WHERE conversations.id = messages.conversation_id
  ) WHERE role = 'user' AND author_id IS NULL
`);

// ── Shared-rooms safety surface (reports / blocks) ──────────────
// Member↔member moderation handled by the household operator (admin). Reports
// are ONLY created for multi-participant rooms, never private 1:1 — so the
// operator review path can never expose a member's private conversation (see
// services/safety.ts). Blocks are per-member and respect data isolation.
db.run(`
  CREATE TABLE IF NOT EXISTS reports (
    id                 TEXT PRIMARY KEY,
    reporter_member_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    room_id            TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    target_type        TEXT NOT NULL CHECK (target_type IN ('message', 'member')),
    target_id          TEXT NOT NULL,
    reason             TEXT NOT NULL CHECK (reason IN ('spam', 'harassment_or_bullying', 'sexual_content', 'child_safety', 'other')),
    note               TEXT,
    status             TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'actioned', 'dismissed')),
    created_at         TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);
db.run(`CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, created_at)`);

db.run(`
  CREATE TABLE IF NOT EXISTS blocks (
    id                TEXT PRIMARY KEY,
    member_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_member_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (member_id, blocked_member_id)
  )
`);

// Operator's published contact (Guideline 1.2 reachable contact info). Surfaced
// in the client as the *app/publisher* contact, not an abuse desk.
try { db.run(`ALTER TABLE households ADD COLUMN operator_published_contact TEXT`); } catch {}

db.run(`
  CREATE TABLE IF NOT EXISTS user_preferences (
    user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    theme      TEXT NOT NULL DEFAULT 'auto',
    serif_font TEXT NOT NULL DEFAULT 'system',
    density    TEXT NOT NULL DEFAULT 'regular',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// Migrations
try { db.run(`ALTER TABLE user_preferences ADD COLUMN palette TEXT`); } catch {}
try { db.run(`ALTER TABLE user_preferences ADD COLUMN locale TEXT`); } catch {}
// A conversation may be bound to a specialized Maurice (persona). Null = the
// everyday, unspecialized Maurice. Kept as a plain id (no FK) so this migration
// doesn't depend on table-creation order; deleting a Maurice nulls it explicitly
// in the maurices service.
try { db.run(`ALTER TABLE conversations ADD COLUMN maurice_id TEXT`); } catch {}
// Provenance: null = native Maurice conversation; 'anthropic' = imported from a
// Claude.ai data export. Drives the Anthropic badge in the sidebar.
try { db.run(`ALTER TABLE conversations ADD COLUMN origin TEXT`); } catch {}
try { db.run(`ALTER TABLE households ADD COLUMN fal_api_key TEXT`); } catch {}
try { db.run(`ALTER TABLE users ADD COLUMN notes_domain TEXT`); } catch {}
// Optional photo avatar (a filename served from /api/avatars/<file>); null →
// the client falls back to an initial on the user's avatar_color.
try { db.run(`ALTER TABLE users ADD COLUMN avatar_url TEXT`); } catch {}
try { db.run(`ALTER TABLE users ADD COLUMN cloudflare_account TEXT`); } catch {}
try { db.run(`ALTER TABLE users ADD COLUMN cloudflare_token TEXT`); } catch {}
// Per-member gate that unlocks the Experimental tool families (off by default).
try { db.run(`ALTER TABLE users ADD COLUMN experimental_tools INTEGER NOT NULL DEFAULT 0`); } catch {}
// A member's own daily spending cap (USD, rolling 24 hours); null = none of
// their own. The household's and the instance's still apply — see budget.ts.
// Added here, before the guest-role rebuild below, which must carry it across.
try { db.run(`ALTER TABLE users ADD COLUMN spend_cap_daily_usd REAL`); } catch {}

// ── Per-user file library: nestable folders + files stored on disk ──────────
db.run(`
  CREATE TABLE IF NOT EXISTS folders (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    parent_id  TEXT REFERENCES folders(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);
db.run(`
  CREATE TABLE IF NOT EXISTS files (
    id             TEXT PRIMARY KEY,
    user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    folder_id      TEXT REFERENCES folders(id) ON DELETE CASCADE,
    name           TEXT NOT NULL,
    kind           TEXT NOT NULL,
    size_bytes     INTEGER NOT NULL DEFAULT 0,
    storage        TEXT NOT NULL,
    token_estimate INTEGER,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// ── Shared gardens: per-note sharing ────────────────────────────────────────
// Sharing is a fact about a NOTE (owner's garden file, identified by slug): its
// audience = owner + these rows. A "shared garden" is derived — the set of
// notes with the same audience — so there is no gardens table to keep in sync.
db.run(`
  CREATE TABLE IF NOT EXISTS note_shares (
    owner_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    slug       TEXT NOT NULL,
    member_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (owner_id, slug, member_id)
  )
`);
db.run(`
  CREATE INDEX IF NOT EXISTS idx_note_shares_member
    ON note_shares(member_id, owner_id, slug)
`);
// Per-garden web theme, keyed by the audience key (sorted member ids joined
// with '+'). "How this garden looks on the web — every gardener sees it."
db.run(`
  CREATE TABLE IF NOT EXISTS garden_settings (
    id         TEXT PRIMARY KEY,
    web_theme  TEXT NOT NULL DEFAULT 'manuscript',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// Add 'guest' to the role enum. SQLite can't alter a CHECK in place, so recreate
// the users table (idempotent: only when 'guest' isn't already allowed). FK
// references are by table name, so they survive drop+rename with FKs off. Runs
// AFTER the column ALTERs above so the recreated table carries every column
// they added — a column left out of the two lists below is silently dropped.
try {
  const cur = db.query(`SELECT sql FROM sqlite_master WHERE type='table' AND name='users'`).get() as { sql: string } | undefined;
  if (cur && !cur.sql.includes("'guest'")) {
    const before = (db.query(`SELECT COUNT(*) AS n FROM users`).get() as { n: number }).n;
    db.run(`PRAGMA foreign_keys=OFF`);
    db.transaction(() => {
      db.run(`
        CREATE TABLE users_new (
          id            TEXT PRIMARY KEY,
          household_id  TEXT NOT NULL DEFAULT 'default' REFERENCES households(id),
          username      TEXT NOT NULL UNIQUE,
          display_name  TEXT NOT NULL,
          role          TEXT NOT NULL DEFAULT 'standard' CHECK (role IN ('admin', 'standard', 'guest')),
          password_hash TEXT,
          pin_hash      TEXT,
          avatar_color  TEXT NOT NULL DEFAULT '#2c5aa0',
          profile_text  TEXT,
          created_at    TEXT NOT NULL DEFAULT (datetime('now')),
          last_active_at TEXT,
          notes_domain  TEXT,
          avatar_url    TEXT,
          cloudflare_account TEXT,
          cloudflare_token   TEXT,
          everyday_model     TEXT,
          experimental_tools INTEGER NOT NULL DEFAULT 0,
          spend_cap_daily_usd REAL
        )
      `);
      db.run(`
        INSERT INTO users_new
          (id, household_id, username, display_name, role, password_hash, pin_hash,
           avatar_color, profile_text, created_at, last_active_at, notes_domain,
           avatar_url, cloudflare_account, cloudflare_token, everyday_model,
           experimental_tools, spend_cap_daily_usd)
        SELECT
           id, household_id, username, display_name, role, password_hash, pin_hash,
           avatar_color, profile_text, created_at, last_active_at, notes_domain,
           avatar_url, cloudflare_account, cloudflare_token, everyday_model,
           experimental_tools, spend_cap_daily_usd
        FROM users
      `);
      const after = (db.query(`SELECT COUNT(*) AS n FROM users_new`).get() as { n: number }).n;
      if (after !== before) throw new Error(`row count mismatch ${before} → ${after}`);
      db.run(`DROP TABLE users`);
      db.run(`ALTER TABLE users_new RENAME TO users`);
    })();
    db.run(`PRAGMA foreign_keys=ON`);
    console.log(`[db] users migrated to allow 'guest' role (${before} rows preserved)`);
  }
} catch (e) {
  console.error("[db] guest-role migration failed:", (e as Error).message);
}

// Who a guest may reach: people they can start/join conversations with. (Their
// allowed Maurices reuse each persona's own access list.) Enforced both ways.
db.run(`
  CREATE TABLE IF NOT EXISTS guest_contacts (
    guest_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    member_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (guest_user_id, member_id)
  )
`);

// Invite codes: an admin hands one to a member so they can enroll a fresh device
// without the admin password. Reusable within a window (expires_at), revocable
// (delete the row), one active code per member.
db.run(`
  CREATE TABLE IF NOT EXISTS invite_codes (
    code       TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// APNs device tokens for push. A token belongs to whoever is the active user on
// that device (re-registered on user switch); pruned when Apple reports it dead.
db.run(`
  CREATE TABLE IF NOT EXISTS device_tokens (
    token         TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    platform      TEXT,
    household_tag TEXT,
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);
db.run(`CREATE INDEX IF NOT EXISTS idx_device_tokens_user ON device_tokens(user_id)`);
// The device's local id for this household, echoed in pushes so a multi-household
// app can route the tap to the right household.
try { db.run(`ALTER TABLE device_tokens ADD COLUMN household_tag TEXT`); } catch {}
// Recoverable raw token, set only for self-service tokens (label 'mcp-settings')
// so any of a member's devices can display the same stable MCP bearer.
try { db.run(`ALTER TABLE api_tokens ADD COLUMN token_plain TEXT`); } catch {}


db.run(`
  CREATE TABLE IF NOT EXISTS api_tokens (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  TEXT NOT NULL UNIQUE,
    label       TEXT NOT NULL,
    scope       TEXT NOT NULL DEFAULT 'full' CHECK (scope IN ('mcp', 'health', 'full')),
    -- Recoverable raw token for self-service 'mcp-settings' tokens. Declared here
    -- so a fresh DB has it; the ALTER above backfills pre-existing databases.
    token_plain TEXT,
    last_used_at TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS devices (
    id           TEXT PRIMARY KEY,
    household_id TEXT NOT NULL DEFAULT 'default' REFERENCES households(id),
    name         TEXT,
    pairing_token TEXT UNIQUE,
    paired_at    TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// ── Per-account Calibre libraries ───────────────────────────────
// Each account points at its own Calibre library (the root directory, not the
// bare metadata.db — chapter extraction reads the EPUB/PDF files relative to
// the root). Modelled as a table so an account can later hold more than one;
// for now one is_default=1 library per account. The Python Calibre MCP tools
// read this table (in maurice.db) to scope every call to the caller's library.
db.run(`
  CREATE TABLE IF NOT EXISTS calibre_libraries (
    id           TEXT PRIMARY KEY,
    account_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label        TEXT NOT NULL DEFAULT 'Library',
    library_root TEXT NOT NULL,
    is_default   INTEGER NOT NULL DEFAULT 1,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);
db.run(`
  CREATE INDEX IF NOT EXISTS idx_calibre_libraries_account
    ON calibre_libraries(account_id, is_default)
`);

// ── Composer context specs ──────────────────────────────────────
// The composed context (chips + options) for a conversation, per account.
// Snapshot semantics: each item stores the resolved set (note slugs / chapter
// refs) frozen at save/refresh time, so a later child note can't silently grow
// an existing context. Keyed (conversation_id, account_id) so a room can later
// hold a private context per participant.
db.run(`
  CREATE TABLE IF NOT EXISTS composer_specs (
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    account_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    spec_json       TEXT NOT NULL DEFAULT '{"items":[]}',
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (conversation_id, account_id)
  )
`);

// ── Specialized Maurices (personas) ─────────────────────────────
// A "Maurice" is a named, hatted assistant with its own behaviour prompt, model
// preference, creativity, and a baked-in context bundle. Household-shared: any
// member may create/edit/use them. context_json holds a frozen composer spec
// (same SpecItem snapshot shape as composer_specs) — the persona's locked
// knowledge, which a conversation can extend but not remove.
db.run(`
  CREATE TABLE IF NOT EXISTS maurices (
    id           TEXT PRIMARY KEY,
    household_id TEXT NOT NULL DEFAULT 'default' REFERENCES households(id),
    name         TEXT NOT NULL,
    hat          TEXT NOT NULL DEFAULT 'boater',
    palette      TEXT NOT NULL DEFAULT 'ink',
    model        TEXT,                                   -- preferred model id; null = household default
    temp         REAL NOT NULL DEFAULT 0.5,
    tagline      TEXT NOT NULL DEFAULT '',
    prompt       TEXT NOT NULL DEFAULT '',
    context_json TEXT NOT NULL DEFAULT '{"items":[]}',
    created_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// Which family members may use a given Maurice (the persona's access list).
db.run(`
  CREATE TABLE IF NOT EXISTS maurice_access (
    maurice_id TEXT NOT NULL REFERENCES maurices(id) ON DELETE CASCADE,
    member_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (maurice_id, member_id)
  )
`);
db.run(`
  CREATE INDEX IF NOT EXISTS idx_maurice_access_member
    ON maurice_access(member_id, maurice_id)
`);

// ── Model roster + per-member access ────────────────────────────
// The models Maurice can run: `cloud` (Anthropic, metered) and `local`
// (Ollama on the household Mac mini, private). Local models are discovered from
// Ollama's /api/tags (discovered=1) or added manually (discovered=0). `descr`
// avoids the SQL keyword `desc`. Where the model runs is the `tier`.
db.run(`
  CREATE TABLE IF NOT EXISTS models (
    id           TEXT PRIMARY KEY,
    household_id TEXT NOT NULL DEFAULT 'default' REFERENCES households(id),
    name         TEXT NOT NULL,
    tier         TEXT NOT NULL CHECK (tier IN ('cloud','local')),
    vendor       TEXT NOT NULL DEFAULT '',
    ctx          INTEGER NOT NULL DEFAULT 0,   -- context window, k tokens
    ram          INTEGER,                      -- local only: resident size, GB
    discovered   INTEGER NOT NULL DEFAULT 0,   -- local: came back from /api/tags
    descr        TEXT NOT NULL DEFAULT '',
    sort         INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// access[member][model] — which models a standard member may use. Admins are
// computed-all (no rows persisted for them).
db.run(`
  CREATE TABLE IF NOT EXISTS user_model_access (
    user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, model_id)
  )
`);
db.run(`
  CREATE INDEX IF NOT EXISTS idx_user_model_access_user
    ON user_model_access(user_id, model_id)
`);

// Where Ollama listens (the on-device model host) + when it was last scanned.
try { db.run(`ALTER TABLE households ADD COLUMN ollama_host TEXT NOT NULL DEFAULT 'http://localhost:11434'`); } catch {}
try { db.run(`ALTER TABLE households ADD COLUMN ollama_scanned_at TEXT`); } catch {}

// Tool families: which MCP tool groups a turn may use. JSON array of family ids
// (the MCP server prefix, e.g. ["calendar","tasks"]); NULL = inherit. Resolution
// order: conversation override → persona → household default → tier default
// ("all" for cloud, none for local). Keeps small local models from drowning in
// 100+ tools.
try { db.run(`ALTER TABLE households ADD COLUMN default_tool_families TEXT`); } catch {}
try { db.run(`ALTER TABLE maurices ADD COLUMN tool_families TEXT`); } catch {}
try { db.run(`ALTER TABLE conversations ADD COLUMN tool_families TEXT`); } catch {}

// Extra cloud providers (Anthropic stays in the existing `api_key`).
try { db.run(`ALTER TABLE households ADD COLUMN openai_api_key TEXT`); } catch {}
try { db.run(`ALTER TABLE households ADD COLUMN mistral_api_key TEXT`); } catch {}
// Z.ai (GLM). Its API is OpenAI-compatible, so it rides the Chat Completions
// path — only the key and the base URL differ.
try { db.run(`ALTER TABLE households ADD COLUMN zai_api_key TEXT`); } catch {}
try { db.run(`ALTER TABLE households ADD COLUMN scaleway_api_key TEXT`); } catch {}
// A Scaleway key whose IAM policy is scoped to one project must name that
// project in the URL (api.scaleway.ai/<project>/v1); an organization-wide key
// needs nothing. Empty = organization-wide.
try { db.run(`ALTER TABLE households ADD COLUMN scaleway_project_id TEXT`); } catch {}
try { db.run(`ALTER TABLE households ADD COLUMN providers_seeded INTEGER NOT NULL DEFAULT 0`); } catch {}
// The household's own daily spending cap (USD, rolling 24 hours, summed over
// every member); null = none. The operator's env caps stay above it — budget.ts.
try { db.run(`ALTER TABLE households ADD COLUMN spend_cap_daily_usd REAL`); } catch {}
// Separate guard from providers_seeded: that flag is already set on every
// existing database, so the GLM rows would never appear if they rode on it.
try { db.run(`ALTER TABLE households ADD COLUMN zai_seeded INTEGER NOT NULL DEFAULT 0`); } catch {}
try { db.run(`ALTER TABLE households ADD COLUMN scaleway_seeded INTEGER NOT NULL DEFAULT 0`); } catch {}

// ── Ancillary models ────────────────────────────────────────────
// The models behind the functions that are not the chat: summaries, flashcards,
// signal parsing, the tools' own classifiers and syntheses. Each function is an
// "invocation" (services/ancillary.ts lists them); a row here pins one to a
// model. Nothing is pinned by default — an invocation without a row runs on the
// household's ancillary model, which must always be set: a function that fails
// because nobody chose its model is the failure this exists to rule out.
db.run(`
  CREATE TABLE IF NOT EXISTS ancillary_models (
    invocation TEXT PRIMARY KEY,
    model_id   TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);
// Which invocations have had their advice at least once. The seed above runs
// once per household, and the refresh only revises pins that exist, so an
// invocation added to the catalogue after a household was seeded had no pin
// at all — the domains' two night functions (19 September 2026) would have
// run on the household's flagship. A row here says "this one was offered its
// pin"; an invocation without a row is new and gets one at the next start,
// while a pin the admin deleted keeps its row and is never re-created.
db.run(`
  CREATE TABLE IF NOT EXISTS ancillary_advised (
    invocation TEXT PRIMARY KEY,
    at         TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);
try { db.run(`ALTER TABLE households ADD COLUMN ancillary_model TEXT`); } catch {}
// Forced: an install that predates the column gets its chat default as its
// ancillary default, so every function has a model from the first request.
db.run(`UPDATE households SET ancillary_model = default_model WHERE ancillary_model IS NULL OR ancillary_model = ''`);
// Guard for the one-off that pins each invocation to its tier's model in the
// household's provider range (services/ancillary.ts). It is set only once a
// range has actually applied, so an instance with no provider key yet still
// gets its pins the day it has one.
try { db.run(`ALTER TABLE households ADD COLUMN ancillary_pins_seeded INTEGER NOT NULL DEFAULT 0`); } catch {}
// Who chose a pin. 'auto' is this codebase's own advice, which may therefore be
// revised when the advice changes; 'admin' is a person's decision and is never
// touched again.
//
// The rows that predate the column have to be sorted the one time it is added,
// and the seed guard above says how: on an instance where the seed has run
// (ancillary_pins_seeded = 1) the rows are what it wrote and follow the advice;
// on one where it never ran, every row was written by a person through the
// admin form, which has existed since 13 September 2026, and is theirs. The
// default stays 'auto' for rows written afterwards without a source, which is
// only this codebase's own writes.
export function migrateAncillaryPinSource(): void {
  try {
    db.run(`ALTER TABLE ancillary_models ADD COLUMN source TEXT NOT NULL DEFAULT 'auto'`);
  } catch {
    return; // already there: sorted on an earlier start
  }
  db.run(
    `UPDATE ancillary_models SET source = 'admin'
     WHERE (SELECT ancillary_pins_seeded FROM households WHERE id = 'default') = 0`,
  );
}
migrateAncillaryPinSource();

// Non-model API keys, for the tools that enrich garden entries with metadata
// and cover art. The Python MCP tools read these columns straight out of
// maurice.db (env vars of the same name still win, for headless setups).
try { db.run(`ALTER TABLE households ADD COLUMN tmdb_api_key TEXT`); } catch {}
try { db.run(`ALTER TABLE households ADD COLUMN google_books_api_key TEXT`); } catch {}
try { db.run(`ALTER TABLE households ADD COLUMN podcastindex_api_key TEXT`); } catch {}
try { db.run(`ALTER TABLE households ADD COLUMN podcastindex_api_secret TEXT`); } catch {}
// IGDB authenticates through Twitch: the id/secret pair buys a short-lived
// app token, so both halves are stored and the token is fetched on demand.
try { db.run(`ALTER TABLE households ADD COLUMN igdb_client_id TEXT`); } catch {}
try { db.run(`ALTER TABLE households ADD COLUMN igdb_client_secret TEXT`); } catch {}

// Which API a model speaks: anthropic | openai | mistral | zai | scaleway | ollama.
try { db.run(`ALTER TABLE models ADD COLUMN provider TEXT`); } catch {}
try { db.run(`UPDATE models SET provider = CASE WHEN tier = 'local' THEN 'ollama' ELSE 'anthropic' END WHERE provider IS NULL OR provider = ''`); } catch {}

// Whether the model can actually read an image. Only consulted on the
// OpenAI-compatible path, which has to decide whether to send image content
// blocks at all: a text-only model rejects the request outright, so the default
// is off and a model opts in. Anthropic models are marked for completeness —
// that path sends images unconditionally, as it always could.
try { db.run(`ALTER TABLE models ADD COLUMN vision INTEGER NOT NULL DEFAULT 0`); } catch {}
try { db.run(`ALTER TABLE households ADD COLUMN vision_seeded INTEGER NOT NULL DEFAULT 0`); } catch {}
// The seed itself runs further down, after the model rows exist — see
// seedVisionFlags(). Ordering matters more than it looks: run it here and it
// matches nothing on a fresh database, then marks itself done forever.

// Whether — and how — the model reasons before it answers. `none`: it does not.
// `optional`: it does, and the request can turn the phase on or off (Z.ai's
// `thinking`, Anthropic's `thinking`, Ollama's `think`). `always`: it reasons
// and Maurice knows no switch for it (the Scaleway-hosted reasoning models).
// Only `optional` models offer the setting in the persona editor; the other
// two values are documentation the roster carries about itself. Seeded below,
// after the rows exist, on a generation counter like vision's.
try { db.run(`ALTER TABLE models ADD COLUMN thinking TEXT NOT NULL DEFAULT 'none'`); } catch {}
try { db.run(`ALTER TABLE households ADD COLUMN thinking_seeded INTEGER NOT NULL DEFAULT 0`); } catch {}

// A persona's choice for a model that reasons optionally: NULL leaves the
// provider's own default (Z.ai thinks unless told not to; Anthropic 4.6+ does
// not unless asked), 1 asks for the reasoning phase, 0 asks it to be skipped.
// Ignored on a model whose `thinking` is not `optional`.
try { db.run(`ALTER TABLE maurices ADD COLUMN thinking INTEGER`); } catch {}

// What a row of `maurices` is, since the personas became domains (19 September
// 2026, roadmap P3-B): `domain` — a part of its creator's life Maurice follows,
// with a brief he keeps on it — or `companion` — a reading companion: one book
// in bound context, followed at the reading position, entered as a pinned
// conversation from the book, never a brief. NULL reads as `domain`. The
// one-time sort below fills the rows that predate the column, and only those:
// a member's later choice (PATCH /api/maurices/:id { kind }) is never
// revisited. `hat` and `palette` stay as columns nothing writes or reads any
// more; dropping the column brings the personas back as they were.
try { db.run(`ALTER TABLE maurices ADD COLUMN kind TEXT`); } catch {}

/** A row whose bound context is exactly one book followed at the reading
 *  position is a reading companion; anything else is a domain. The rule is
 *  the design's own (a companion is "a book in context, a conduct prompt, a
 *  mode one enters"): a book loaded whole is a reference, hence a domain. */
export function mauriceKindOf(contextJson: string): "domain" | "companion" {
  let items: any[] = [];
  try {
    const spec = JSON.parse(contextJson);
    items = Array.isArray(spec?.items) ? spec.items : [];
  } catch {
    return "domain";
  }
  if (items.length !== 1) return "domain";
  const it = items[0];
  if (it?.type !== "book") return "domain";
  const progress = it?.scope?.mode === "progress" || it?.snapshot?.tracksProgress === true;
  return progress ? "companion" : "domain";
}

export function migrateMauriceKinds(): void {
  const rows = db.query(`SELECT id, context_json FROM maurices WHERE kind IS NULL`).all() as Array<{ id: string; context_json: string }>;
  for (const r of rows) {
    db.run(`UPDATE maurices SET kind = ? WHERE id = ? AND kind IS NULL`, [mauriceKindOf(r.context_json), r.id]);
  }
  if (rows.length) console.log(`[db] maurices: sorted ${rows.length} persona(s) into domains and companions`);
}
migrateMauriceKinds();

// The same choice for the everyday Maurice — the conversation with no persona,
// which the member cannot configure and which therefore needs its settings
// "from the factory". Seeded to 0: the everyday Maurice answers directly and
// reasoning is something a persona asks for. NULL = the provider's default,
// 1 = reason. Editable in the admin console, nowhere in the apps.
try { db.run(`ALTER TABLE households ADD COLUMN everyday_thinking INTEGER DEFAULT 0`); } catch {}

// Migration: `garden` was one 54-tool family, now sub-split. Expand any stored
// "garden" selection to its sub-families so existing personas/chats keep the
// same tools. Idempotent (only acts on the exact "garden" element). Ids mirror
// gardenSub() in services/toolFamilies.ts.
try {
  const GARDEN_SUBS = [
    "garden-notes", "garden-journal", "garden-people",
    "garden-fragments", "garden-media", "garden-publish", "garden-other",
  ];
  for (const tbl of ["maurices", "conversations"] as const) {
    const rows = db.query(`SELECT id, tool_families FROM ${tbl} WHERE tool_families LIKE '%garden%'`).all() as Array<{ id: string; tool_families: string }>;
    for (const r of rows) {
      try {
        const v = JSON.parse(r.tool_families);
        if (!Array.isArray(v) || !v.includes("garden")) continue;
        const next = [...new Set(v.filter((x: string) => x !== "garden").concat(GARDEN_SUBS))];
        db.run(`UPDATE ${tbl} SET tool_families = ? WHERE id = ?`, [JSON.stringify(next), r.id]);
      } catch {}
    }
  }
} catch {}

// Seed the Anthropic cloud roster once — real model ids (the three families
// don't share a version number, so they can't be derived from one suffix).
const CLOUD_SEED: Array<[string, string, number, string]> = [
  ["claude-opus-4-8",           "Claude Opus 4.8",   200, "Deepest reasoning. Hard, multi-step problems."],
  ["claude-sonnet-4-6",         "Claude Sonnet 4.6", 200, "Balanced and fast — the everyday default."],
  ["claude-haiku-4-5-20251001", "Claude Haiku 4.5",  200, "Quick and economical. Good for kids."],
];
try {
  const have = db.query(`SELECT COUNT(*) AS n FROM models WHERE tier = 'cloud'`).get() as { n: number };
  if (have.n === 0) {
    CLOUD_SEED.forEach(([id, name, ctx, descr], i) => {
      db.run(
        `INSERT OR IGNORE INTO models (id, name, tier, vendor, ctx, discovered, descr, sort, provider)
         VALUES (?, ?, 'cloud', 'Anthropic', ?, 0, ?, ?, 'anthropic')`,
        [id, name, ctx, descr, i],
      );
    });
  }
} catch {}

// Seed default OpenAI + Mistral cloud models once (guarded so later deletions
// stick). Stable ids; the admin can add/correct exact models per key.
try {
  const hh = db.query(`SELECT providers_seeded FROM households WHERE id = 'default'`).get() as { providers_seeded: number } | undefined;
  if (!hh?.providers_seeded) {
    const EXTRA: Array<[string, string, string, string, number, string, number]> = [
      ["gpt-4o",               "GPT-4o",        "openai",  "OpenAI",  128, "OpenAI's multimodal flagship.",     10],
      ["gpt-4o-mini",          "GPT-4o mini",   "openai",  "OpenAI",  128, "Fast, economical OpenAI model.",    11],
      ["mistral-large-latest", "Mistral Large", "mistral", "Mistral", 128, "Mistral's flagship.",              20],
      ["mistral-small-latest", "Mistral Small", "mistral", "Mistral", 128, "Fast, economical Mistral model.",  21],
    ];
    for (const [id, name, provider, vendor, ctx, descr, sort] of EXTRA) {
      db.run(
        `INSERT OR IGNORE INTO models (id, name, tier, vendor, ctx, discovered, descr, sort, provider)
         VALUES (?, ?, 'cloud', ?, ?, 0, ?, ?, ?)`,
        [id, name, vendor, ctx, descr, sort, provider],
      );
    }
    db.run(`UPDATE households SET providers_seeded = 1 WHERE id = 'default'`);
  }
} catch {}

// Seed the Z.ai (GLM) roster once, on its own guard. Same shape as the block
// above: stable ids, and the admin can add or correct models per key.
try {
  const hh = db.query(`SELECT zai_seeded FROM households WHERE id = 'default'`).get() as { zai_seeded: number } | undefined;
  if (!hh?.zai_seeded) {
    // Both carry a 1M-token window (docs.z.ai, GLM-5.3 and GLM-5.3-Flash pages).
    const ZAI: Array<[string, string, number, string, number]> = [
      ["glm-5.3",       "GLM-5.3",       1024, "Z.ai's flagship — strong reasoning and tool use.", 30],
      ["glm-5.3-flash", "GLM-5.3 Flash", 1024, "Fast, economical GLM model.",                      31],
    ];
    for (const [id, name, ctx, descr, sort] of ZAI) {
      db.run(
        `INSERT OR IGNORE INTO models (id, name, tier, vendor, ctx, discovered, descr, sort, provider)
         VALUES (?, ?, 'cloud', 'Z.ai', ?, 0, ?, ?, 'zai')`,
        [id, name, ctx, descr, sort],
      );
    }
    db.run(`UPDATE households SET zai_seeded = 1 WHERE id = 'default'`);
  }
} catch {}

// Seed the Scaleway roster once, on its own guard like Z.ai's. These are the
// models Scaleway's Generative APIs serve in Serverless mode as of September
// 2026 (docs: generative-apis/reference-content/supported-models), minus the
// two already deprecated there (pixtral-12b, qwen3-coder: EOL 2026-10-01).
// The vendor is the model's maker, not the host — that is what the sub-label
// in the apps shows; the provider is what the request travels under. `ctx` is
// the Serverless window in k tokens; glm-5.2 and deepseek-v4-flash are 1M
// models capped at 256k during preview. `vision` is set here rather than by
// the generation counter below, which only ever adds.
try {
  const hh = db.query(`SELECT scaleway_seeded FROM households WHERE id = 'default'`).get() as { scaleway_seeded: number } | undefined;
  if (!hh?.scaleway_seeded) {
    // id, name, vendor, ctx (k), vision, descr, sort
    const SCW: Array<[string, string, string, number, number, string, number]> = [
      ["mistral-small-3.2-24b-instruct-2506", "Mistral Small 3.2",  "Mistral",  128, 1, "Quick, cheap, reads images — the everyday default on Scaleway.",     40],
      ["gemma-4-26b-a4b-it",                  "Gemma 4 26B",        "Google",   256, 1, "Google's small frontier model: agentic, multilingual, reads images.",  41],
      ["qwen3.6-35b-a3b",                     "Qwen 3.6 35B",       "Qwen",     256, 1, "Small, fast reasoning model with tool use and vision.",               42],
      ["gpt-oss-120b",                        "GPT-OSS 120B",       "OpenAI",   128, 0, "OpenAI's open-weight reasoning model. Text only.",                    43],
      ["deepseek-v4-flash-0731",              "DeepSeek V4 Flash",  "DeepSeek", 256, 0, "Fast reasoning model with a cached-input price. Text only.",          44],
      ["qwen3.5-397b-a17b",                   "Qwen 3.5 397B",      "Qwen",     250, 1, "Qwen's frontier reasoning model; reads images.",                      45],
      ["qwen3-235b-a22b-instruct-2507",       "Qwen 3 235B",        "Qwen",     250, 0, "Large instruct model, no reasoning phase. Text only.",                46],
      ["llama-3.3-70b-instruct",              "Llama 3.3 70B",      "Meta",     100, 0, "Meta's dependable generalist. Text only.",                            47],
      ["mistral-medium-3.5-128b",             "Mistral Medium 3.5", "Mistral",  180, 1, "Mistral's strongest hosted model; reads images.",                     48],
      ["glm-5.2",                             "GLM 5.2",            "Z.ai",     256, 0, "Z.ai's flagship, served from Paris. Text only.",                      49],
    ];
    for (const [id, name, vendor, ctx, vision, descr, sort] of SCW) {
      db.run(
        `INSERT OR IGNORE INTO models (id, name, tier, vendor, ctx, discovered, descr, sort, provider, vision)
         VALUES (?, ?, 'cloud', ?, ?, 0, ?, ?, 'scaleway', ?)`,
        [id, name, vendor, ctx, descr, sort, vision],
      );
    }
    db.run(`UPDATE households SET scaleway_seeded = 1 WHERE id = 'default'`);
  }
} catch {}

// Migration: the first GLM seed guessed 200k/128k windows; both models have 1M.
// Only the guessed figures are touched, so a value the admin set stays.
try {
  db.run(`UPDATE models SET ctx = 1024 WHERE id = 'glm-5.3' AND ctx = 200`);
  db.run(`UPDATE models SET ctx = 1024 WHERE id = 'glm-5.3-flash' AND ctx = 128`);
} catch {}

// Where a conversation's context window starts: the id of the oldest message
// still sent to the model, or NULL for "from the beginning". Set by the
// generation path when the history outgrows the model's window (see
// services/contextWindow.ts); persisted so the prompt prefix stays the same
// from one turn to the next, which is what the cache is keyed on.
try { db.run(`ALTER TABLE conversations ADD COLUMN context_from TEXT`); } catch {}

// ── Domains (19 September 2026) ─────────────────────────────────
// `maurices` is the table of domains — it always was, without knowing it: a
// name, a prompt, a bound context. What a domain adds is its *brief*: the short
// text Maurice keeps on that part of a member's life, rewritten at night from
// the previous brief and the conversations that touched it since, and read,
// corrected or erased by the member (services/domainBriefs.ts). One row per
// domain and member. `sources_json` names the conversations the last rewrite
// read; `read_until` is the timestamp of the newest message it saw, which is
// what makes the next night incremental — only what came after is read again.
db.run(`
  CREATE TABLE IF NOT EXISTS domain_briefs (
    maurice_id   TEXT NOT NULL REFERENCES maurices(id) ON DELETE CASCADE,
    member_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text         TEXT NOT NULL DEFAULT '',
    updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
    sources_json TEXT NOT NULL DEFAULT '[]',
    read_until   TEXT,
    model        TEXT,
    PRIMARY KEY (maurice_id, member_id)
  )
`);
// Who opened a conversation: a member, as always until now, or Maurice — the
// conversation the night creates to propose domains (the design's 4b). Read by
// nothing yet; the column exists so the proposal path has a place to land.
try { db.run(`ALTER TABLE conversations ADD COLUMN opened_by TEXT NOT NULL DEFAULT 'member'`); } catch {}
// The night's own daily cap: what Maurice may spend on nobody's turn — briefs,
// and later the mapping — counted under the ledger's "system" spender
// (services/budget.ts). Null = no cap of its own; the household's still applies.
try { db.run(`ALTER TABLE households ADD COLUMN spend_cap_system_daily_usd REAL`); } catch {}
// A conversation Maurice opens on his own (P2-A, 19 September 2026): who may
// receive one. `users.is_child` — a child never gets one, and the night
// proposes nothing to them (design, section 7); set in the console. The
// household's guard between two openings for one member, in days (null = the
// default, fifteen; services/openedConversations.ts).
try { db.run(`ALTER TABLE users ADD COLUMN is_child INTEGER NOT NULL DEFAULT 0`); } catch {}
try { db.run(`ALTER TABLE households ADD COLUMN maurice_opens_min_days INTEGER`); } catch {}

// Migration: an earlier seed minted fabricated ids (opus/haiku at the sonnet
// version), which 404 at Anthropic. Remap to the real ids and make sure the
// household default points at a model that actually exists.
try {
  const remap: Array<[string, string, string]> = [
    ["claude-opus-4-6",  "claude-opus-4-8",           "Claude Opus 4.8"],
    ["claude-haiku-4-6", "claude-haiku-4-5-20251001", "Claude Haiku 4.5"],
  ];
  for (const [oldId, newId, name] of remap) {
    if (!db.query(`SELECT 1 FROM models WHERE id = ?`).get(oldId)) continue;
    // FK-safe (model_id is a referenced PK): insert the corrected row, repoint
    // any access rows, then drop the bad one — never rename a referenced PK.
    db.run(
      `INSERT OR IGNORE INTO models (id, name, tier, vendor, ctx, ram, discovered, descr, sort)
       SELECT ?, ?, tier, vendor, ctx, ram, discovered, descr, sort FROM models WHERE id = ?`,
      [newId, name, oldId],
    );
    db.run(`UPDATE user_model_access SET model_id = ? WHERE model_id = ?`, [newId, oldId]);
    db.run(`DELETE FROM models WHERE id = ?`, [oldId]);
  }
  // Personas can still point at a fabricated id even after the model row is
  // gone — remap unconditionally (idempotent) so they don't silently fall back.
  const personaRemap: Array<[string, string]> = [
    ["claude-opus-4-6", "claude-opus-4-8"],
    ["claude-haiku-4-6", "claude-haiku-4-5-20251001"],
  ];
  for (const [oldId, newId] of personaRemap) {
    db.run(`UPDATE maurices SET model = ? WHERE model = ?`, [newId, oldId]);
  }
  // Guarantee the household default points at a model that exists; the bad
  // fabricated ids were never a deliberate choice, so fall back to known-good
  // Sonnet (the original default) rather than guess.
  const def = (db.query(`SELECT default_model FROM households WHERE id = 'default'`).get() as any)?.default_model;
  if ((!def || !db.query(`SELECT 1 FROM models WHERE id = ?`).get(def)) &&
      db.query(`SELECT 1 FROM models WHERE id = 'claude-sonnet-4-6'`).get()) {
    db.run(`UPDATE households SET default_model = 'claude-sonnet-4-6' WHERE id = 'default'`);
  }
} catch {}

// ── Full-text search over messages ──────────────────────────────
// An external-content FTS5 index over messages.content, kept in step by
// triggers so every insert/update/delete on `messages` (cascades included)
// lands in the index without the write paths knowing about it. Built once on
// existing installs: the rebuild runs only when the virtual table is new.
{
  const hadFts = !!db
    .query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'messages_fts'`)
    .get();
  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content,
      content='messages',
      content_rowid='rowid',
      tokenize='unicode61 remove_diacritics 2'
    )
  `);
  db.run(`
    CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
    END
  `);
  db.run(`
    CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
    END
  `);
  db.run(`
    CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE OF content ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
      INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
    END
  `);
  if (!hadFts) db.run(`INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')`);
}

// ── Conversation summaries (context composer) ───────────────────
// A conversation loaded as context past a certain length is summarised rather
// than pasted whole. The summary is keyed by a hash of the transcript it was
// made from: the moment the conversation is continued the hash no longer
// matches, and the composer knows the summary is behind. One row per
// conversation — a fresh summary replaces the stale one.
db.run(`
  CREATE TABLE IF NOT EXISTS conversation_summaries (
    conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
    content_hash    TEXT NOT NULL,
    summary         TEXT NOT NULL,
    model           TEXT,
    message_count   INTEGER NOT NULL,
    source_tokens   INTEGER NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// Which models can read an image. Runs here, below every block that inserts or
// remaps model rows, because it can only mark rows that already exist — an
// earlier placement matched nothing on a fresh database and then marked itself
// done, leaving every model text-only with no way back.
//
// vision_seeded is a generation counter, not a boolean: bumping it re-seeds once
// and repairs databases that ran the mis-ordered version, while still never
// overwriting a later operator change twice for the same generation.
const VISION_SEED_GENERATION = 3;
try {
  const seeded =
    (db.query(`SELECT vision_seeded FROM households WHERE id = 'default'`).get() as
      | { vision_seeded: number }
      | undefined
    )?.vision_seeded ?? 0;
  if (seeded < VISION_SEED_GENERATION) {
    db.run(
      `UPDATE models SET vision = 1
       WHERE provider = 'anthropic'
          OR id IN ('gpt-4o', 'gpt-4o-mini',
                    'mistral-medium-latest', 'mistral-large-latest', 'mistral-small-latest',
                    -- GLM-5.3 is text-only; the Flash is the multimodal one of the pair.
                    'glm-5.3-flash')`,
    );
    db.run(`UPDATE households SET vision_seeded = ? WHERE id = 'default'`, [VISION_SEED_GENERATION]);
  }
} catch {}

// The reasoning capability of the seeded roster, on the same generation-counter
// pattern. Anthropic: every 4.6+ model takes `thinking` (Haiku 4.5 still wants
// the old budget form, which Maurice does not send, so it stays `none`). Z.ai:
// both GLM-5.3 models think by default and accept `thinking.type = disabled` —
// this is the switch that turns a three-minute Flash answer into a thirty-second
// one. Scaleway: the models that stream a `reasoning` delta do so with no
// documented switch, so they are `always`. Local models are set by discovery
// (Ollama reports a `thinking` capability), not here.
const THINKING_SEED_GENERATION = 1;
try {
  const seeded =
    (db.query(`SELECT thinking_seeded FROM households WHERE id = 'default'`).get() as
      | { thinking_seeded: number }
      | undefined
    )?.thinking_seeded ?? 0;
  if (seeded < THINKING_SEED_GENERATION) {
    db.run(
      `UPDATE models SET thinking = 'optional'
       WHERE id IN ('glm-5.3', 'glm-5.3-flash')
          OR (provider = 'anthropic' AND (
                id LIKE 'claude-opus-5%' OR id LIKE 'claude-sonnet-5%' OR id LIKE 'claude-fable-%'
             OR id LIKE 'claude-opus-4-6%' OR id LIKE 'claude-opus-4-7%' OR id LIKE 'claude-opus-4-8%'
             OR id LIKE 'claude-sonnet-4-6%'))`,
    );
    db.run(
      `UPDATE models SET thinking = 'always'
       WHERE provider = 'scaleway'
         AND id IN ('qwen3.6-35b-a3b', 'gpt-oss-120b', 'deepseek-v4-flash-0731', 'qwen3.5-397b-a17b', 'glm-5.2')`,
    );
    db.run(`UPDATE households SET thinking_seeded = ? WHERE id = 'default'`, [THINKING_SEED_GENERATION]);
  }
} catch {}

// Seed default access for standard members who have none yet: the household
// default model, so everyone can at least chat. Admins are computed-all.
try {
  const def = (db.query(`SELECT default_model FROM households WHERE id = 'default'`).get() as { default_model: string } | undefined)?.default_model;
  if (def && db.query(`SELECT 1 FROM models WHERE id = ?`).get(def)) {
    const standards = db.query(`SELECT id FROM users WHERE role = 'standard'`).all() as Array<{ id: string }>;
    for (const u of standards) {
      const n = db.query(`SELECT COUNT(*) AS n FROM user_model_access WHERE user_id = ?`).get(u.id) as { n: number };
      if (n.n === 0) {
        db.run(`INSERT OR IGNORE INTO user_model_access (user_id, model_id) VALUES (?, ?)`, [u.id, def]);
      }
    }
  }
} catch {}

// A5 migration: assign the legacy single library to the owner (admin) account.
// Reversible (delete the row) and idempotent (only seeds when the table is
// empty and the legacy library actually exists on disk — a no-op elsewhere).
try {
  const have = db.query(`SELECT COUNT(*) AS n FROM calibre_libraries`).get() as { n: number };
  if (have.n === 0) {
    const legacyRoot =
      process.env.CALIBRE_LIBRARY ||
      process.env.CALIBRE_LIBRARY_PATH;
    const admin = db
      .query(`SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1`)
      .get() as { id: string } | undefined;
    if (admin && legacyRoot && existsSync(join(legacyRoot, "metadata.db"))) {
      db.run(
        `INSERT INTO calibre_libraries (id, account_id, label, library_root, is_default)
         VALUES (?, ?, 'Library', ?, 1)`,
        [crypto.randomUUID(), admin.id, legacyRoot],
      );
    }
  }
} catch {}

// Schema version, stamped in the file's PRAGMA user_version so an operator can
// see from /healthz which shape of database an instance runs. Bump it by hand
// whenever a migration above changes the schema; the number is descriptive,
// nothing branches on it yet.
export const SCHEMA_VERSION = 1;
db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);

export default db;
export { dataDir };
