---
title: Households, rooms & devices
date: '2026-09-18'
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

Three roles (`server/src/services/users.ts`): **admin** (manages members and household identity), **standard** (full member, PIN-protected), and **guest** (full capabilities but a *limited reach*). A guest's reach is an explicit allow-list — `guest_contacts`, checked **both directions** by `guestCanReach()` — so a guest sees only themselves plus their contacts in the roster, and can only share rooms with them. Guests get curated [[maurice-personas-hats|Maurices]] through each persona's own access list. This is how you safely **host a guest, or be a guest** in another household.

## Foyer switching (multiple households)

`SessionStore` holds an array of paired households, each with its **own per-household session token** (`maurice.token.<household>.<user>`); `switchHousehold()` flips the active one, and `refreshFoyers()` polls each household's `/api/health` and unread count for the switcher badges. The picker shows a pill per household with a "+" to pair another server. So the same device is your own household *and* the one where you're a guest — and a notification can route a tap to the right one via its `household_tag`.

## Rooms (multi-person conversations)

A conversation is a **room**; a 1:1 chat is just a room with one human. Membership is `conversation_participants`, and access is participant-based — `listConversations()` joins on membership, so you only see rooms you're in. `addParticipant()` enforces guest reach, fans the event to the room, and notifies the newcomer.

Maurice's role shifts with the room: in a 1:1 every message summons him; in a multi-human room he answers **only when mentioned** — `mentionsMaurice()` matches `@claude` / `@maurice` (the ➤ button posts a summon, 💬 posts a human-only message). The composer follows that: in a room 💬 is the **default button** — last in the row, at the far right, filled with the member's accent, and what Return posts; ➤ sits to its left and keeps ⌘Return. A 1:1 has no 💬 at all, so Return still goes to Maurice. Read state (`last_read_at` per participant) drives the per-foyer unread roll-up.

Liveness uses two WebSocket channels off `roomBus` (`server/src/services/roomBus.ts`): a per-room channel for live messages, and a **per-user channel** (`/api/me/ws`) for activity — "someone is chatting with you" — even when you're not in that room. See [[maurice-server]].

## Moderation

In a shared room, the long-press menu on a message offers **Report** and **Block**. A report carries the message and its metadata to the operator (`/api/reports`, child-safety reports first, then newest); blocking removes the participant's reach. Reports never exist for a private 1:1, so this path can't reach a member's private conversation — the per-member isolation invariant holds.

## Push

When an event can't reach a live socket, it becomes an APNs push (`server/src/services/push.ts` + `apns.ts`, token-based ES256 over HTTP/2). Device tokens carry a `platform` and a `household_tag`; dead tokens are pruned on Apple's say-so. This is what notifies you across households when you're a guest elsewhere.

## Ships vs. exists

All of this — members, roles, guests, rooms, device enrollment, PINs, foyer switching, push — is **core chat-engine functionality and ships**. None of it needs the experimental [[maurice-tools|tools]].

## Gaps & notes

- **The server is single-tenant.** There is one hardcoded `'default'` household per server; "multiple households" is a *client* capability (one device, many servers). The schema carries `household_id` everywhere, but a single server doesn't host multiple households. At home this is literal: each extra household is its own launchd agent, on its own port, with its own data directory and gardens root (see [[maurice-architecture]]).
- **A device-pairing ceremony exists but is unused.** `/api/auth/pair` + the `devices` table (one-time pairing tokens) are implemented, yet the app pairs via the unauthenticated `/api/health` — the token flow is currently orphaned.
- **Sessions don't expire** in this version.
- **Guest persona access has no override** — it reuses each persona's `maurice_access` list rather than a guest-specific grant.
