---
title: From specialized Maurices to domains
date: '2026-09-19'
flags: []
locale: en
description: What became of the personas — the specialized Maurices with their hats
  — on 19 September 2026 — every row of `maurices` is now a domain or a reading
  companion; the Studio and the summon picker are gone; Maurice Maurice stays
  until the documentation tool replaces him.
tags:
- maurice
- documentation
- feature
- domains
icon: hard-hat
parent: maurice-docs
---

# From specialized Maurices to domains

Until 19 September 2026 a "Maurice" was a **persona**: a named assistant with its own personality, model, creativity, a frozen bundle of context, and a **hat** that signalled its identity — the [[maurice|vision's]] hat metaphor made concrete, chosen from a grid when the persona was created. That afternoon the design changed ([[maurice-domaines]], in French): **there is one Maurice**, and what a member used to shape as a second Maurice is a **domain** — a part of their life that Maurice follows closely, with a brief he keeps on it. This note records what became of the personas; what a domain is, and everything built around it, is in [[maurice-domains]].

## What a row of `maurices` is now

The table did not change shape, only meaning ([[maurice-data-model]]). Each row is one of two things, told apart by a new column, `kind`:

| `kind` | What it is | Brief |
|---|---|---|
| `domain` (the default) | A part of its creator's life: a name, a tagline, a statement (`prompt`), a bound context (`context_json`), a model and creativity of its own, tool families | Yes — written at night, read in every private conversation |
| `companion` | A **reading companion**: one book in bound context, followed at the reading position, with a conduct prompt (no spoilers) — an activity with an object, not a part of a life | No |

`hat` and `palette` are still columns, with their old values, but **nothing writes or reads them any more**: the API neither returns nor accepts them, the apps draw a mark on the member's accent instead (a closed book for a domain, open pages for a companion). The migration is additive and reversible: dropping the `kind` column would bring the personas back exactly as they were.

**The one-time sort.** At its first start on a database that predates the column, the server sorts every row once (`migrateMauriceKinds()` in `server/src/db.ts`): a row whose bound context is exactly one book on the `progress` scope — the composer's [[maurice-composer|book that follows your reading]] — is a companion; anything else (a book loaded whole, notes, an empty context) is a domain. The rule is the design's own: a followed book is a mode one enters, a book loaded whole is a reference. On the Mac at home this made *JTTW guide* a companion and *Yi Jing* a domain, which is what the owner had decided. The sort never revisits a row: the member's hand, `PATCH /api/maurices/:id { kind }` and the Domain / Reading companion switch in the editor, is final until they change it again. The brief a companion had before the sort stays in `domain_briefs` (nothing is deleted) but reaches nobody — not the prompt, not the routes — and comes back if the row is made a domain again.

**What stayed.** Ownership (`created_by`), the access list a guest is granted through (`maurice_access`), the frozen context bundle a conversation can extend but not shrink, the model preference and the reasoning choice (`thinking`), the tool families — all as before, all documented in [[maurice-data-model]] and [[maurice-tools]]. `POST /api/conversations { maurice_id }` still binds a conversation to a row, which is how a domain's page opens a conversation with its context preloaded and how a companion's pinned conversation starts.

## What the app lost, and what took its place

- **Maurice Studio** (the picker of Maurices to summon, `StudioViews.swift`) and the **summon picker** on the composer's send button (long-press to pick who answers, tap to choose one when the field was empty) are gone. The send button is Maurice's boater on the member's accent, the same whatever the conversation is bound to; empty, it waits. The header shows one Maurice — no badge, whatever the binding.
- **In their place, the domains list** (`DomainsViews.swift`), opened from a button beside *New conversation* in the sidebar: the member's domains (each opening its page — the brief — with when it was last written and by whom), their reading companions (each resuming its pinned conversation, or starting one), Maurice Maurice (a conversation bound to him), and *New domain*. A guest sees the domains granted to them, marked *shared with you*, and opens a conversation on them; a guest's list has no *New domain*.
- **The persona creator** became the **domain editor** (`DomainEditorView.swift`): name and tagline, the Domain / Reading companion switch, *what it is about* (the statement the night's brief follows), the bound context, the model with its creativity and reasoning choice, the tools. The hat grid and the colour grid went; the preview lost its banner. It opens from the domain page (*Edit*), from the greeting of a bound conversation, and from the conversation's details sheet.
- **The greeting** of a bound conversation (`DomainGreeting`) shows the mark, DOMAIN or READING COMPANION, the name and tagline, the model / context / creativity pills, and the way to the brief and the editor.
- **The sidebar rows and search hits** carry the mark instead of a hat for a bound conversation; nothing for the everyday Maurice, as before. *New conversation* always starts with the one Maurice — entering a domain is done from its page (*Talk about it*).
- Thirty-two strings changed or added in the seven app languages; the `studio.*` keys, the hat and colour labels and *Switch specialist* went.

The hat collection itself (`Hats.swift`) lives on in the loading animation, with its palettes.

## Rooms and summoning

A room — a conversation with more than one human — is unchanged in what it can do and explicit in what it cannot: Maurice answers there when mentioned or summoned with ➤ ([[maurice-households-rooms]]), and if the room was bound to a row when it was created, the server still reads that row's prompt and context for his turns. What a room **never** gets is a domain's brief — the rule of [[maurice-domains]], held in `services/claude.ts`: briefs are a member's, and another participant would read them. Nothing in the apps offers to bind a room to a domain any more; the binding a conversation has is the one it was created with (`PATCH /api/conversations/:id/maurice` remains for a client that wants to change it).

## Maurice Maurice — still here, for now

The built-in specialist of Maurice itself (18 September 2026) is **not a row and not a domain**: defined in code (`builtinMaurice()` in `server/src/services/maurices.ts`, id `maurice-maurice`), heading every member's `GET /api/maurices` (guests included), not editable, no brief, his model the server's choice and locked. He is reached from the domains list under *About Maurice*, which opens a conversation bound to him; his greeting shows the boater. Everything about how he reads the documentation — the digest plus the notes newer than it, the refresh from the public repo, the `internal: true` notes he never sees, the locked model — is unchanged and is described in [[maurice-server]] (the documentation reader and its refresh) and [[maurice-digest]]. He goes when **P3-A** of the [[maurice-domaines-feuille-de-route|roadmap]] replaces him with a documentation tool the everyday Maurice calls.

## Ships vs. exists

All of it — the column, the sort, the routes, the list, the editor — is in the server and the Maurice app and ships. On the hosted households the same image runs the same sort at first start, without intervention. **Carnet** does not read `/api/maurices` and shows no hat: nothing changes there until P3-C brings the domain page.

## Gaps

- **Domains are still made by hand**, in the editor, until the night proposes them (P2-B). *New domain* is the honest placeholder for that.
- **A companion's pinned conversation is found, not designed**: the list resumes the most recently touched conversation bound to the companion, and `GET /api/domains` names it (`conversation_id`) with the book (`book_id`). Opening it *from the book's page* — book preloaded at the reading position, the conduct rules living with the book rather than in a row — is what the design asks for and what P3-C (Carnet) or a later app session will build; the data is ready for it.
- **Emergent hats**, the vision's idea of a scope that follows the active note subtree, is closed by another route: a domain *is* the scope, proposed from the conversations rather than derived from a folder.
