---
title: The data model
date: '2026-09-19'
flags: []
locale: en
description: 'The SQLite schema behind the chat engine: identity, conversations, files,
  gardens, personas, models — the design decisions it encodes, and the data-api''s
  own tables.'
tags:
- maurice
- documentation
- architecture
- data-model
icon: database
parent: maurice-docs
---

# The data model

One **SQLite** file (`maurice.db`, WAL mode, in the Maurice home `~/.maurice/`) holds the chat engine's state. The whole schema is defined and migrated in one place — `server/src/db.ts` — as a sequence of `CREATE TABLE IF NOT EXISTS` plus append-only `ALTER`/backfill blocks (no migration framework; each change is an idempotent guarded statement). The [[maurice-server|data-api]] keeps its own tables in separate files under `~/.maurice/data/` — see *The data-api's databases* below. This note is mostly the **chat-engine** schema.

## Identity & household

| Table | Key columns | Notes |
|---|---|---|
| `households` | one row `id='default'`; `api_key`, `openai_api_key`, `mistral_api_key`, `zai_api_key`, `fal_api_key`, `default_model`, `max_tokens`, `everyday_thinking` (nullable 0/1, seeded 0), `ollama_host`, `default_tool_families`, `color`, `icon`, `providers_seeded`, `zai_seeded`, `scaleway_seeded`, `vision_seeded`, `thinking_seeded` | **A server is one household.** `everyday_thinking` is the everyday Maurice's reasoning choice — the conversation with no persona has no place in the apps to set anything, so its settings come "from the factory" and are corrected in the admin console only. Multiple households is a multi-*server* feature (the app's foyer switcher, and at home one launchd agent per extra household), not multiple rows. `color`/`icon` give the foyer its identity; the `*_seeded` flags guard the one-time model seeds so a deleted model stays deleted. |
| `users` | `id`, `username` (unique), `display_name`, `role ∈ {admin,standard,guest}`, `password_hash`, `pin_hash`, `avatar_color`, `avatar_url`, `profile_text`, `notes_domain`, `experimental_tools`, `everyday_model` | `everyday_model` = the member's preferred model for the unspecialized Maurice (null → household default). `username` is also the member's garden directory. |
| `user_preferences` | `user_id` (PK), `theme`, `serif_font`, `density`, `palette`, `locale` | Per-member app appearance and language. |

Anthropic's key stays in `households.api_key`; the other providers got their own columns as they were added (`openai_api_key`, `mistral_api_key`, `zai_api_key`).

## Auth & devices

| Table | Key columns | Purpose |
|---|---|---|
| `sessions` | `id`, `user_id`, `device_id`, `expires_at` | Opaque session tokens. |
| `api_tokens` | `id`, `user_id`, `token_hash` (unique), `token_plain` (self-service only), `label`, `scope ∈ {mcp,health,full}` | `maur_*` bearer tokens; the self-service MCP token is recoverable so all of a member's devices show the same one. |
| `invite_codes` | `code` (PK), `user_id`, `expires_at` | Admin hands one to a member to enroll a device; reusable within the window, revocable by deleting the row. |
| `device_tokens` | `token` (PK), `user_id`, `platform`, `household_tag` | APNs push; `household_tag` routes a tap to the right foyer in a multi-household app. |
| `devices` | `id`, `household_id`, `name`, `pairing_token` (unique), `paired_at` | Programmatic device pairing. |
| `guest_contacts` | `guest_user_id` + `member_id` (PK) | The people a guest may reach; enforced both directions. |

## Conversations & messages

| Table | Key columns | Notes |
|---|---|---|
| `conversations` | `id`, `user_id` (owner), `title`, `maurice_id` (bound persona, null = everyday), `origin` (null or `'anthropic'` for imports), `tool_families` (JSON, nullable), `context_from` (nullable message id) | `origin='anthropic'` marks a thread imported from a Claude export → the sidebar badge. `context_from` is where the model's window starts once the history outgrew it — see [[maurice-server]]. |
| `messages` | `id`, `conversation_id`, `role ∈ {user,assistant,system}`, `content`, `author_id` (human author, null for Maurice), `maurice_id` (which persona produced the turn), `model`, `data` (JSON `[{tool,data}]`), `usage` (JSON) | Two id columns matter: `author_id` (who said it) and `maurice_id` (which Maurice answered) drive per-message avatars and the "who participated" cluster. `data` is the frozen tool-result payload for the [[maurice-chat|data-card]] channel; `usage` is what the turn cost — tokens, cache reads and writes, and a priced figure when the model has a price on file. |
| `messages_fts` | FTS5, external-content over `messages.content`, `unicode61 remove_diacritics 2` | Kept in step by three triggers (insert, delete, update of content — cascades included), so no write path knows it exists; rebuilt once when the virtual table is first created on an existing install. What the sidebar search and the composer's picker query. |
| `conversation_summaries` | `conversation_id` (PK, cascades), the summary, `transcript_hash`, model, timestamps | One row per thread; keyed on a hash of the transcript it was made from, so a continued thread reads as stale and a fresh summary replaces the old one. See [[maurice-composer]]. |
| `conversation_participants` | `conversation_id` + `member_id` (PK), `role ∈ {owner,member}`, `last_read_at` | Membership for rooms; `last_read_at` drives the per-foyer unread roll-up. A 1:1 chat is just a room with one human. |
| `reports` | a report filed on a shared-room message: target, reporter, status, category | Operator-only moderation; never on a private 1:1. |

Index: `messages(conversation_id, created_at)` and `conversations(user_id, updated_at DESC)`.

| Table | Key columns | Notes |
|---|---|---|
| `spend_ledger` | `id`, `at`, `provider`, `model`, `cost_usd` | A row per billed turn, written by `addMessage` alongside `messages.usage`. Duplicated on purpose: summing a JSON column across every message an instance ever held is the wrong shape for something consulted *before each agentic round*, and a deleted message must not un-spend its money. Read only by the spending fuse (see [[maurice-server]]); a household with no cap set writes to it and never reads it. |

The ledger is what makes an answer possible to the question §4 of
[[maurice-commercialisation]] says nothing can answer today — *what has this
instance spent* — but it is not yet aggregation by member or by month, and it
holds no quota or balance. It is a fuse's fuel gauge, not a statement.

## Files

| Table | Key columns |
|---|---|
| `folders` | `id`, `user_id`, `parent_id` (self-FK, nestable), `name` |
| `files` | `id`, `user_id`, `folder_id`, `name`, `kind`, `size_bytes`, `storage` (disk path), `token_estimate` |

The [[maurice-files|files library]]: rows are metadata; bytes live on disk at `storage`.

## Gardens — sharing is *derived*, not stored

There is **no `gardens` table.** Sharing is a fact about a note:

| Table | Key columns | Notes |
|---|---|---|
| `note_shares` | `owner_id` + `slug` + `member_id` (PK) | A note's audience = its owner plus these rows. |
| `garden_settings` | `id` = audience key (sorted member ids joined with `+`), `web_theme` | A "[[maurice-shared-gardens|shared garden]]" is the *set of notes with the same audience*, so there's nothing to keep in sync — the garden is computed from `note_shares`. |

The garden's *content* is not in SQLite at all: it is Markdown under `~/.maurice/gardens/<username>/`, one git repository per member. The article fiches, fragments, résonances and flashcards all live there as files, deliberately — the markdown is the single source of truth, and no table mirrors it (see [[maurice-knowledge]]).

## Personas & composer context — frozen snapshots

| Table | Key columns | Notes |
|---|---|---|
| `maurices` | `id`, `name`, `hat`, `palette`, `model` (nullable), `temp` (creativity), `thinking` (nullable 0/1), `tagline`, `prompt`, `context_json` (frozen spec), `tool_families` (nullable), `created_by` | A [[maurice-personas-hats|specialized Maurice]]. `context_json` is the persona's **baked-in** context. `thinking` is its reasoning choice for a model whose roster entry is `optional`: NULL leaves the provider's default, 1 asks for the phase, 0 skips it. |
| `maurice_access` | `maurice_id` + `member_id` (PK) | Which members may use a persona (also how guests get curated Maurices). |
| `composer_specs` | `conversation_id` + `account_id` (PK), `spec_json` | The [[maurice-composer|composer's]] context for a conversation. |

Both `context_json` and `spec_json` store the **resolved set frozen at save time** (note slugs, chapter refs) — so a context can't silently grow when an underlying note changes. `composer_specs` is keyed `(conversation_id, account_id)`, a seam for *per-participant* room context later (today a room's loaded context is shared common ground — see *Gaps*).

## Models

| Table | Key columns | Notes |
|---|---|---|
| `ancillary_models` | `invocation` (PK), `model_id`, `updated_at` | A pin: this ancillary function (conversation summary, flashcards, a tool's classifier…) runs on that model. No row means the household's `ancillary_model`, itself backfilled from `default_model`. Read by the server and, read-only, by the Python tools. See [[maurice-server]]. |
| `models` | `id`, `name`, `tier ∈ {cloud,local}`, `vendor`, `provider ∈ {anthropic,openai,mistral,zai,scaleway,ollama}`, `ctx` (k tokens), `ram` (local), `discovered`, `vision`, `thinking ∈ {none,optional,always}`, `sort` | Cloud roster is seeded once per provider (Anthropic, OpenAI/Mistral, Z.ai, Scaleway); local models are discovered from Ollama's `/api/tags`. `ctx` is what the [[maurice-server|engine]] bounds the conversation by, and the admin can correct it. `vision` gates whether images are sent to an OpenAI-style model. `thinking` (18 September 2026) is what the roster knows about a model's reasoning phase: `none` it has none, `optional` it has one and the request can turn it on or off, `always` it has one and no switch is known — the persona editor offers its choice only on `optional`, and the admin can correct the value per model. Seeded on a generation counter (`thinking_seeded`) like `vision`; Ollama fills it at discovery from the `thinking` capability `/api/show` reports. Prices are *not* here: they live in `pricing.ts`, a hand-copied sheet, and the two are the roster's metadata split by whether an admin should be able to change it (yes for a window or a capability, no for a list price). |
| `user_model_access` | `user_id` + `model_id` (PK) | Which models a *standard* member may use; admins are computed-all (no rows). |

`households.default_tool_families`, `maurices.tool_families`, and `conversations.tool_families` together encode the resolution order **conversation → persona → household default → tier default** (all tools for cloud, none for local) — so small local models aren't drowned in 100+ tools.

## Bridge to the tools

| Table | Key columns | Notes |
|---|---|---|
| `calibre_libraries` | `id`, `account_id`, `label`, `library_root`, `is_default` | One global Calibre library, configurable from the admin dashboard; the Python Calibre tools and the data-api read this table *in `maurice.db`* — a concrete example of a tool sharing the chat engine's DB. |

## The data-api's databases

Under `~/.maurice/data/` (`MAURICE_DATA_DIR`):

| File | Holds |
|---|---|
| `life.db` | Book **highlights** and article **highlights** (with the view their offsets belong to — full text or summary), **reading positions** and bookmarks per member, health, tasks, signals, dossiers and research, coaching, layouts, places. It was `akita.db` — the prototype's name — until 2026-09-13: the server renames the file on its first start after the change (`getLifeDbPath()`), and Python tools look for the new name and fall back to the old, never renaming. Until that day it was **not in the nightly backup**, which only snapshotted `maurice.db`; `scripts/backup-db.sh` now takes both. |
| `compte.db` | Bank transactions and budgets (`compte`). |
| `recommendations.db` | Reading recommendations. |

Plus the corpus's vector store (see [[maurice-knowledge]]) and, elsewhere, the Calibre library itself.

## Ships vs. exists

Identity, auth, conversations, messages, files, gardens, personas, reports, and models are **core and ship**. `spend_ledger` exists and is written unconditionally; nothing reads it unless a cap is set, so on a household paying its own provider it is inert. `calibre_libraries` and the data-api databases back the [[maurice-tools|tools]] and [[maurice-carnet|Carnet]]; chat + garden ship first.

## Gaps & notes

- **Single household per server.** "Multiple households" is multiple servers (foyer switcher; one launchd agent per household at home), not multiple `households` rows. There is no cross-server schema; coordination is the app's job.
- **Room context is shared, not per-participant.** `composer_specs` is keyed per account, anticipating private per-participant room context (the shared-rooms idea), but today everyone in a room shares the loaded context as common ground.
- **The ledger knows the member (19 September 2026).** `spend_ledger` carries `user_id` (indexed with `at`), written by `recordSpend` with the member whose turn it was — in a room, the sender of the message Maurice answered; rows from before stay null and count only in household sums. Two new columns hold the caps: `households.spend_cap_daily_usd REAL` and `users.spend_cap_daily_usd REAL` (null = no cap of its own); the latter is added before the guest-role rebuild of `users` and listed in both of its column lists — which is how it came out that `everyday_model` and `experimental_tools` had been left out of those lists and were dropped on any database old enough to be rebuilt; both are carried across now, and a test boots the schema over a hand-made pre-guest database to prove it. Precedence: instance (env) ≥ household ≥ member, the tightest wins; the first two are summed over the household, the third over the member. Routes: `GET /api/me/usage`, `GET /api/admin/usage`.
- **The ledger counts money, not tokens.** A turn whose model has no price on file records nothing at all, because `pricing.ts` prices an unknown model at `null` rather than zero. That is right for a meter and a hole in a fuse, which is why the fuse refuses such a model outright instead of trusting the ledger — see [[maurice-server]]. It does mean the ledger under-reports on any instance that has used an unpriced model.
- **Migrations are hand-rolled.** `db.ts` is append-only guarded `ALTER`s and idempotent backfills (the guest-role table rebuild, the model-id remap, the `garden` tool-family sub-split, the GLM window correction). Robust, but there's no schema-version table — correctness rests on each block being idempotent.
- **Test isolation is by environment.** The data-api services bind their database path at import time; the test suites set `MAURICE_DATA_DIR` for exactly that moment. A module that imports one of them eagerly can bind the real database first — it happened once, and the fix was a lazy import.

See [[maurice-server]] for how these tables are read and written, and [[maurice-architecture]] for where the database sits.
