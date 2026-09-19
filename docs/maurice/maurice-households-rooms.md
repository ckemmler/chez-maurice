---
title: Households, rooms & devices
date: '2026-09-19'
flags: []
locale: en
description: Members and roles, guests, multi-person rooms, device pairing and PINs,
  and foyer switching across households.
tags:
- maurice
- documentation
- feature
- households
- multi-user
icon: users-round
parent: maurice-docs
---

# Households, rooms & devices

This is the social layer — the part that makes Maurice a *household* assistant rather than a single-user chatbot. Several of the [[maurice|differentiators]] live here: free user-switching on a shared device, multi-person rooms, and being a guest across households.

The shape in one line: **a server is one household; a device can hold several households; switching member is a tap and a PIN.**

## Onboarding & pairing

First run is `app/Maurice/Views/PairingView.swift`: you enter a server URL, the app calls `GET /api/health` to confirm it and read the household's identity (name, colour, icon), and stores it as a local **Household** (`Services/SessionStore.swift`, persisted to UserDefaults). Pairing is device-local, and a device can pair **multiple** households.

Then `UserPickerView.swift` is the member grid, with three ways in:

- **PIN** — tap your avatar, enter your PIN → `POST /api/auth/login` (`{ user_id, pin }`).
- **Admin** — username + password → `POST /api/auth/login`.
- **Invite code** — `POST /api/auth/enroll` redeems a code; if you're a standard member you then set a PIN (`/api/auth/set-pin`). Guests enroll without one.

Invite codes (`server/src/services/auth.ts`) are 8 characters from an unambiguous alphabet (no I/O/0/1), one active per member, valid ~7 days, reusable within the window; `/api/auth/enroll` is the public guessing surface so failed attempts are rate-limited per-IP and globally. Sessions are opaque 64-char tokens, refreshed on use.

## Members, roles & guests

Three roles (`server/src/services/users.ts`): **admin** (manages members and household identity), **standard** (full member, PIN-protected), and **guest** (full capabilities but a *limited reach*). Orthogonal to the role, a member can be marked a **child** (`users.is_child`, a box on the console's member page, 19 September 2026): Maurice never opens a conversation on his own for a child, and the night proposes nothing to them — a flag the admin sets, not an age the server knows. A guest's reach is an explicit allow-list — `guest_contacts`, checked **both directions** by `guestCanReach()` — so a guest sees only themselves plus their contacts in the roster, and can only share rooms with them. Guests get curated [[maurice-personas-hats|Maurices]] through each persona's own access list. This is how you safely **host a guest, or be a guest** in another household.

## Foyer switching (multiple households)

`SessionStore` holds an array of paired households, each with its **own per-household session token** (`maurice.token.<household>.<user>`); `switchHousehold()` flips the active one, and `refreshFoyers()` polls each household's `/api/health` and unread count for the switcher badges. The picker shows a pill per household with a "+" to pair another server. So the same device is your own household *and* the one where you're a guest — and a notification can route a tap to the right one via its `household_tag`.

## Rooms (multi-person conversations)

A conversation is a **room**; a 1:1 chat is just a room with one human. Membership is `conversation_participants`, and access is participant-based — `listConversations()` joins on membership, so you only see rooms you're in. `addParticipant()` enforces guest reach, fans the event to the room, and notifies the newcomer.

Maurice's role shifts with the room: in a 1:1 every message summons him; in a multi-human room he answers **only when mentioned** — `mentionsMaurice()` matches `@claude` / `@maurice` (the ➤ button posts a summon, 💬 posts a human-only message). The composer follows that: in a room 💬 is the **default button** — last in the row, at the far right, filled with the member's accent, and what Return posts; ➤ sits to its left and keeps ⌘Return. A 1:1 has no 💬 at all, so Return still goes to Maurice. Read state (`last_read_at` per participant) drives the per-foyer unread roll-up, which counts rooms where someone else wrote since you last read — and, since 19 September 2026, the conversations [[maurice-chat|Maurice opened on his own]] that you have not opened yet (his replies in a thread you started never count).

Liveness uses two WebSocket channels off `roomBus` (`server/src/services/roomBus.ts`): a per-room channel for live messages, and a **per-user channel** (`/api/me/ws`) for activity — "someone is chatting with you" — even when you're not in that room. Its events: `activity` (a message in a room you are in), `conversation_added` (someone added you), and `conversation_opened` (Maurice opened a conversation for you, with his first message). See [[maurice-server]].

The household guards how often Maurice may open one: "Days between two conversations Maurice opens" in the console's settings (`households.maurice_opens_min_days`, fifteen by default), never for a child, never for a guest; the operator's route (`POST /api/admin/conversations/open`) can pass `force` to step over it, the night never will.

## Moderation

In a shared room, the long-press menu on a message offers **Report** and **Block**. A report carries the message and its metadata to the operator (`/api/reports`, child-safety reports first, then newest); blocking removes the participant's reach. Reports never exist for a private 1:1, so this path can't reach a member's private conversation — the per-member isolation invariant holds.

## Push

When an event can't reach a live socket, it becomes an APNs push (`server/src/services/push.ts` + `apns.ts`, token-based ES256 over HTTP/2) — a room's activity, an invitation to a room, or a conversation Maurice opened ("Maurice: …", opening on the conversation when tapped). Device tokens carry a `platform` and a `household_tag`; the platform picks the APNs topic (`carnet-ios` → Carnet's bundle id `eu.chezmaurice.carnet`, `APNS_CARNET_TOPIC`; anything else → the Maurice app, `APNS_TOPIC`), so a conversation Maurice opens reaches Carnet too (19 September 2026, evening); dead tokens are pruned on Apple's say-so. This is what notifies you across households when you're a guest elsewhere.

## The household archive

Since 19 September 2026 a household knows how to export itself. The **household archive** is a versioned `.maurice.tar.gz` (`maurice-archive` v1, `server/src/services/archive.ts`, format documented in `docs/household-archive.md`) holding everything the household *is*: `maurice.db` and the data-api databases as consistent `VACUUM INTO` snapshots checked by `integrity_check`, the gardens with each member's git history and `gardens.json`, images, files, uploads, avatars, `config.toml`, and a `manifest.json` (household, members, schema version, server version, contents). Left out: backups, logs, the dead Qdrant directory, the corpus vector index (regenerable), `.env` and the Mac's `ops/` secrets, and the bare git remotes under `~/.maurice/git`. It contains the provider keys: **it is a secret.**

The admin gets it from the console's section 07, "Export this household" (`GET /admin/export`), or with a bearer token on `GET /api/admin/export` — streamed as `tar` reads, so the first byte leaves before the uploads are read. A fresh Maurice imports it into an empty data directory (refused if a `maurice.db` is already there; the server's own migrations bring the schema forward on first boot): `scripts/import-household.sh <archive> [dir]` on a Mac, `scripts/container.sh import <archive>` for a local container, `ops/household.sh add <host> <name> <domain> --from <archive>` for a household on a shared host — the archive travels over ssh's stdin and no copy stays on the host. Still by hand after an import: rebuilding the corpus index, and the gardens' `origin` remotes, which point at the old machine.

## Ships vs. exists

All of this — members, roles, guests, rooms, device enrollment, PINs, foyer switching, push, the archive — is **core chat-engine functionality and ships**. None of it needs the experimental [[maurice-tools|tools]].

## Gaps & notes

- **The server is single-tenant.** There is one hardcoded `'default'` household per server; "multiple households" is a *client* capability (one device, many servers). The schema carries `household_id` everywhere, but a single server doesn't host multiple households. At home this is literal: each extra household is its own launchd agent, on its own port, with its own data directory and gardens root (see [[maurice-architecture]]).
- **A device-pairing ceremony exists but is unused.** `/api/auth/pair` + the `devices` table (one-time pairing tokens) are implemented, yet the app pairs via the unauthenticated `/api/health` — the token flow is currently orphaned.
- **Sessions don't expire** in this version.
- **Guest persona access has no override** — it reuses each persona's `maurice_access` list rather than a guest-specific grant.
- **"Child" is a box, not a birth date** — the server knows nothing of ages; the admin ticks it, and only what Maurice does on his own reads it (opening a conversation, the night's proposals). It does not change a child's model access or content rules, which are their own settings.
