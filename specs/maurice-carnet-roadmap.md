# Maurice & Carnet — Full Architectural Roadmap

## Stack assumption (post-Phase 0a)

```
SQLite       — all structured data (Maurice + Akita + Health)
Qdrant       — vectors, semantic search
Bun servers  — Maurice (3001), Akita (2077)
Python MCP   — gateway exposing tools (single process)
```

Four processes. Two SQLite files. One Qdrant directory. No MongoDB, no Docker.

---

## Phase 0a — MongoDB → SQLite consolidation

**Size: S/M**

Migrate the 6 MongoDB collections (sleep_data, hrv, workouts, mindful_minutes, hourly_active_energy, respiratory_rate) into SQLite tables in the Akita database. Update the Health Auto Export ingest endpoint, all health resolvers, and the health MCP tools to use SQLite. Migrate existing data with a one-shot script.

This is a prerequisite to everything else because it defines the persistent state surface for the installer.

---

## Phase 0b — Service bundle and installer

**Size: M**

Goal: a non-developer family member can install Maurice on a Mac Mini, it runs at startup, survives reboots, restarts on crash.

- Single launchd plist per service (Maurice, Akita, MCP gateway, Qdrant) — or a single supervisor process managing all four
- Logs to predictable locations (`~/Library/Logs/Maurice/`)
- Config file at a known location (`~/.maurice/config.toml`)
- Health check endpoint on each service for the supervisor to monitor
- macOS `.pkg` installer that drops binaries, plists, creates directories, prompts for initial setup
- Uninstaller
- Clean separation of code (in `/Applications` or `/usr/local`) from data (in `~/.maurice` and `~/.akita`)

Decision point: native launchd vs. a single supervisor binary (PM2-style). Native launchd is more macOS-idiomatic and survives Apple updates better. A supervisor is easier to debug. Worth experimenting with both during this phase.

---

## Phase 0c — Account layer

**Size: L**

Build the Account abstraction that works identically across local, private cloud, and Maurice Cloud deployments.

- Unified `accounts` table in Maurice DB (the source of truth for identity)
- Akita references account_id from Maurice via shared auth tokens
- Roles: `owner`, `member`
- Key envelope field on accounts (nullable — populated when E2EE activates)
- `account_id` column added to every table in Akita (signals, coaching_plans, layouts, dossiers, briefing_topics, deep_research_requests, dossier_follow_ups, dossier_recommendations, resonances, bookmarks, places, periodic_schedules)
- Every query, route handler, and MCP tool scoped by `account_id`
- All 14 MCP tool servers updated
- All background pipelines updated to iterate per-account
- Qdrant: per-account collection or metadata filter on every operation
- Auth middleware for Akita (currently has none)

This is the load-bearing phase. It's unglamorous and touches everything, but doing it now means Levels 2 and 3 don't require a data model rewrite later — only activating the crypto layer.

---

## Phase 1 — Shared Swift crypto package

**Size: M**

Can run in parallel with Phase 0c. No dependency on server work.

- HKDF key derivation from user passphrase
- AES-256-GCM encrypt/decrypt with associated data
- Envelope encryption: random per-record data encryption keys, wrapped by user master key
- Recovery key generation and verification (single approach: random recovery key displayed once at setup)
- Keychain integration for master key storage
- Comprehensive test suite
- Shared as a Swift package used by both Maurice client and Carnet

At this point the package exists but isn't activated. Both clients can adopt it when Phase 2 begins.

---

## Phase 2 — Carnet E2EE boundary

**Size: L**

Activate encryption in Carnet. Server starts receiving and storing ciphertext.

- Passphrase setup flow at first launch
- Encrypt signal payloads (details, metadata, tags) before POST
- Decrypt signal lists and aggregated responses
- Encrypt coaching plan content, place names/coordinates
- Move dashboard metric computation from server to client — fetch encrypted records, decrypt locally, aggregate in Swift
- Encrypt offline queue items at rest on device
- Share Extension: encrypt before queuing
- HealthKit integration (replaces Health Auto Export) — encrypt health data on-device before POST

The HealthKit integration belongs here because the Health Auto Export third-party app cannot encrypt before sending. Carnet must own the HealthKit pull and encrypt-then-push pattern.

---

## Phase 3 — Maurice client E2EE boundary

**Size: M**

Smaller scope than Carnet — fewer data types.

- Passphrase setup flow
- Encrypt user messages before POST
- Server stores user messages as ciphertext after the inference round-trip
- Decrypt conversation history on fetch
- Encrypt image data
- Assistant messages encrypted at rest after streaming completes

Chat is inherently plaintext-during-inference. The encryption guarantee is at-rest, not during-active-streaming. Document this clearly in product copy.

---

## Phase 4 — Server adaptation

**Size: M**

Both servers stop reasoning about structured content fields and treat them as opaque blobs.

- Akita: store encrypted payloads in content columns, return as-is
- Maurice: store encrypted messages, return as-is
- API contract versioning (clients declare encryption capability per request)
- Server-side validation switches to validating envelope structure only, not content
- Drop server-side text search (replaced by client-side search in Phase 2/3)
- Remove or deprecate endpoints that required plaintext access (e.g., server-side filtering by content)

This is smaller than the original L estimate because Phase 0c already did the multi-tenancy work. Server adaptation is now mostly about treating fields as opaque.

---

## Phase 5 — AI plaintext window protocol

**Size: L**

Design the explicit boundary where data temporarily leaves the encrypted state for inference.

- Client-initiated inference sessions: client provides a session key to the server, server decrypts only what's needed for that request, calls Claude/inference endpoint, encrypts result back, discards plaintext
- Signal parsing: either move to client-side direct Claude calls (BYO API key per client) or use the session window pattern
- Research and briefings: convert from server-side cron to client-initiated with session keys
- Chat: confirmed as plaintext-during-streaming, encrypted at rest after
- UI signaling in both clients: clear indication when data is crossing the plaintext boundary

This is the architecturally novel phase. The protocol design matters more than the implementation. Worth a design document before code.

---

## Phase 6 — Qdrant and semantic search

**Size: M** (revised down from XL because the pragmatic answer is now clear)

Accept that vectors are a semantic fingerprint of plaintext and treat them as a weaker-than-content tier of protection.

- Per-account Qdrant scoping (collections or strict metadata filter — already done in Phase 0c)
- Document the privacy model honestly: source documents are encrypted, vectors are not, server could infer topics but not reconstruct text
- Vectors generated server-side during the AI plaintext window (Phase 5) when content is temporarily decrypted
- No homomorphic encryption, no client-side vector DB — both are dead ends at current scale

The original report listed this as XL because it tried to solve the problem. The honest answer is to scope it correctly and disclose the limitation. That's an M.

---

## Phase 7 — Background processing redesign

**Size: M**

The cron-based pipelines (briefings, signal reports, nightly agent, RSS reports, adherence) need a new home in the E2EE world.

Three patterns to mix and match per pipeline:

- **User-triggered**: convert cron jobs to actions invoked when the user opens the app. Loses "ambient intelligence" but trivial to implement.
- **Standing session**: client periodically refreshes a session key the server can use for scheduled work while the key is valid. Preserves background processing but requires the client to be online regularly.
- **Public-data-only**: pipelines that only touch non-private data (RSS fetching public feeds) keep running unchanged.

Per-pipeline assessment:

| Pipeline | New pattern |
|---|---|
| RSS fetch | Public-data-only (feeds are public) |
| RSS report generation | Standing session (mixes feeds with user context) |
| Briefings | Standing session |
| Signal reports | User-triggered |
| Adherence | Client-side computation in Carnet |
| Calibre summaries | User-triggered |
| Nightly agent | Standing session |
| Git signals | Local-only (already runs on the dev machine) |

---

## Phase 8 — Private cloud deployment (Level 2 gate)

**Size: M**

Once Phases 0-7 are complete, exposing Maurice to friends-as-testers is largely a deployment exercise.

- TLS termination and proper certificates
- Domain and DNS
- Public auth flow (PIN/passphrase login from outside the LAN)
- Backup and restore tooling
- Account provisioning flow for inviting testers
- Documentation of the privacy model for testers

This is where the friends beta becomes possible. The architecture didn't need to change between Levels 1 and 2 — only the network exposure and a few operational pieces.

---

## Summary table

| Phase | Scope | Size | Depends on | Notes |
|---|---|---|---|---|
| 0a | MongoDB → SQLite | S/M | — | Quick win, unblocks installer |
| 0b | Installer & service bundle | M | 0a | **You start here** |
| 0c | Account layer | L | 0a | The load-bearing prerequisite |
| 1 | Swift crypto package | M | — | Parallel with 0c |
| 2 | Carnet E2EE + HealthKit | L | 0c, 1 | |
| 3 | Maurice client E2EE | M | 0c, 1 | |
| 4 | Server adaptation | M | 0c | |
| 5 | AI plaintext window | L | 2, 3, 4 | Architecturally novel |
| 6 | Qdrant scoping & disclosure | M | 0c, 5 | |
| 7 | Background pipeline redesign | M | 5 | |
| 8 | Private cloud deployment | M | 0-7 | Level 2 gate |

---

## The honest bottom line

Phase 0 (a + b + c) is roughly 30-40% of the total work and produces no user-visible features. It's the foundation that makes everything else either trivial or possible. Phases 1-4 are well-understood engineering. Phase 5 is the one that deserves real design time before implementation. Phase 6 is mostly a documentation and scoping problem once you accept the pragmatic constraint. Phase 7 is UX-shaped more than crypto-shaped. Phase 8 is a deployment exercise.

If Phase 0a + 0b alone get done well, you have something genuinely new: a sovereign personal intelligence system that a non-developer can install. That's already a story worth telling, before any E2EE work begins.
