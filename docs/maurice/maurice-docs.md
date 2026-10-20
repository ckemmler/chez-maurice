---
title: Maurice — system documentation
date: '2026-10-20'
flags:
- moc
locale: en
description: 'The documentation hub for Maurice: concept, architecture, and features
  — grounded in what is actually built.'
tags:
- maurice
- documentation
- architecture
icon: book-open
parent: maurice
---

# Maurice — system documentation

This is the working reference for what Maurice *actually is today*, used both as the starting point for discussing features and as the seed for outward-facing presentation. First written on 19 June 2026; brought up to date on 6 September 2026 against the code as it stands.

A note on scope: the original **vision note** (under *Concept* below) and `specs/maurice-spec.md` describe a deliberately tiny v1 — "chat only, garden only" (the garden being what the interface now calls a member's notes). The codebase has since grown well past that into a full personal-knowledge-and-household system. These docs describe the **built** system, flagging gaps against the vision where they matter.

One distinction runs throughout: *what ships* versus *what exists*. The public release (30 June 2026: server `.pkg`, macOS and iOS apps on TestFlight) is **chat + notes**, and since September the **corpus** search is public too. The wider capabilities — Calibre, tasks, coaching, health, tracks, and the rest — are **experimental**, live in the private **`maurice-tools`** overlay, and are shipped gradually as each is polished. They are documented here because they are real and in daily use, but each note marks whether the thing ships now or is experimental.

The system is five cooperating parts: the native **Maurice app** (conversation), **Carnet** (the pocket companion for capturing and reading), a **server** (chat engine + data API), a fleet of MCP **tools**, and a **web** engine that renders each member's notes as a site.

[[maurice-digest|The digest]] is the whole set condensed for someone who uses Maurice and will never read its code: what he can do, how he behaves, what his architecture guarantees, what ships and what does not, the gaps, and a *How do I…* section — about 7 000 words, stating the present rather than a history, each section naming the notes that hold the detail. It is what Maurice reads when asked about himself, through his **documentation tool** (`maurice_docs`, see [[maurice-tools]]), with any note updated since loaded whole beside it; a note edit that changes what the digest says corrects the digest in the same piece of work, so that delta stays empty.

## Concept — the *why*

[[maurice|Maurice — a household AI with a tamed memory]] — the founding vision: scoped, visible memory; the *apprivoisé* stance; hats as chosen personas; notes growing by deliberate action; sovereignty and "small on purpose."

[[maurice-applications|Applications, plugins, and the case of the mail]] — how a personal application attaches to the Maurice story: what is generic in it, what is one person's life, and the open questions — client-side inference, conversational onboarding, and what sovereignty actually means when what you hand over is not a copy but the keys. A parked thread, written down to be picked up.

[[maurice-domaines|Un seul Maurice, des domaines qui émergent]] — the design decided on 19 September 2026 (in French; being built session by session — see [[maurice-domains]] for what exists): one Maurice, domains that emerge from the conversations, each with a visible *cahier*, proposed in a conversation Maurice opens, first notes written on consent; the plan, the data, the costs, the test cases.

[[maurice-commercialisation|Commercialising Maurice — the inventory]] — everything between "it works at home" and "a stranger pays for it": demos, conversion, payment, metering and bundles, import/export, the App Store, the legal frame, documentation, videos, and what the whole thing forces on the operations.

[[maurice-mail-overview|Mail: what a whole mailbox costs, and the overview to build first]] — the measurements of the first whole-mailbox reading and the four-depths specification they led to; not built, shelved. *Internal: kept in the owner's notes.*

## Architecture — the *how*

**Where it stands, 14 September 2026.** Maurice is delivered as a **container,
and only as a container** — the "no Docker, install a `.pkg`" promise is
retired. A household costs **~260 MB** idle, so one 8 GB machine carries about
twenty of them; that became true when the web engine stopped running an
Astro dev server per member. And one European supplier, Scaleway, sells both
halves of the chain — the machine and the model — which is what makes a fleet
of **demo servers** affordable: enough of them running that anyone can point
the apps at one and use the real thing, with no machine and no account.
See [[maurice-architecture]]. **17 September:** the first rented host runs two
real households on Scaleway, hosting and inference both, and Scaleway is a
provider in the server — the friends first, the demos next.

[[maurice-architecture|Architecture overview]] — the five parts, how a message flows end-to-end, and where each concern lives.

[[maurice-server|The server]] — Hono/Bun engine: API surface, the streaming agentic loop, prompt caching and the context window, provider selection, auth, MCP execution, rooms, push.

[[maurice-data-model|The data model]] — the SQLite schema: households, users, sessions, conversations, messages, maurices, files, notes (gardens), composer specs, models — and the data-api's own tables.

[[maurice-tools|The MCP tool ecosystem]] — the gateway, per-member context, tool families, and the public/private split.

[[maurice-web-garden|The site]] — the Astro renderer: per-request theme engine, wiki-links, fiches, build-time encryption, per-member bases.

## Features — the *what*

[[maurice-domains|Domains and their briefs]] — one Maurice, and the domains of a member's life he follows: the brief he keeps on each, written at night, read in every private conversation, corrected or erased in the app; the reading companions beside them; the list and the editor; what is built of the domains design.

[[maurice-personas-hats|From specialized Maurices to domains]] — what became of the personas and their hats on 19 September 2026: every row of `maurices` is a domain or a reading companion, the Studio and the summon picker are gone, and Maurice Maurice — the built-in specialist who answered questions about Maurice from these very notes — went the same evening, replaced by the documentation tool the everyday Maurice calls.

[[maurice-chat|The chat experience]] — streaming, model switching, tool-result data cards, math rendering, image input and generation, dictation, the cost meter.

[[maurice-composer|The context composer]] — loading notes, books, files, and past conversations into a chat under a live token budget.

[[maurice-carnet|Carnet]] — the iOS companion: log signals, read books and articles, browse your notes, save what you read into them.

[[maurice-shared-gardens|Shared notes]] — per-note sharing and the shared notes it derives for each audience, with their own web themes.

[[maurice-files|The files library]] — per-user folders and files, attachable as chat context.

[[maurice-households-rooms|Households, rooms & devices]] — members, roles, guests, multi-person rooms, device pairing, PINs, foyer switching, moderation.

[[maurice-knowledge|Knowledge capabilities]] — notes and media, the articles pipeline, fiches and résonances, flashcards, corpus search, tracks.

[[maurice-life|Life capabilities]] — health, tasks, signals & coaching, calendar, contacts, reading (Calibre/Readwise), dashboards.

---

*Status: second pass, September 2026 — every note re-checked against the code, the June gaps re-stated as closed or still open, and Carnet added. Next passes: deepen individual notes as features settle, and add the outward-facing presentation layer on top.*
