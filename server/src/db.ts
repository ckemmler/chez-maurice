import { Database } from "bun:sqlite";
import { join } from "path";
import { mkdirSync, existsSync } from "fs";

// Resolve database path: use MAURICE_DATA_DIR env or default to ~/.maurice
const dataDir =
  process.env.MAURICE_DATA_DIR ||
  join(process.env.HOME || "/tmp", ".maurice");
mkdirSync(dataDir, { recursive: true });

const dbPath = join(dataDir, "maurice.db");
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
// AFTER the column ALTERs above so the recreated table carries all 15 columns.
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
          cloudflare_token   TEXT
        )
      `);
      db.run(`
        INSERT INTO users_new
          (id, household_id, username, display_name, role, password_hash, pin_hash,
           avatar_color, profile_text, created_at, last_active_at, notes_domain,
           avatar_url, cloudflare_account, cloudflare_token)
        SELECT
           id, household_id, username, display_name, role, password_hash, pin_hash,
           avatar_color, profile_text, created_at, last_active_at, notes_domain,
           avatar_url, cloudflare_account, cloudflare_token
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
try { db.run(`ALTER TABLE households ADD COLUMN providers_seeded INTEGER NOT NULL DEFAULT 0`); } catch {}

// Which API a model speaks: anthropic | openai | mistral | ollama.
try { db.run(`ALTER TABLE models ADD COLUMN provider TEXT`); } catch {}
try { db.run(`UPDATE models SET provider = CASE WHEN tier = 'local' THEN 'ollama' ELSE 'anthropic' END WHERE provider IS NULL OR provider = ''`); } catch {}

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

export default db;
export { dataDir };
