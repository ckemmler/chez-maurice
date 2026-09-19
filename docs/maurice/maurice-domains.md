---
title: Domains and their briefs
date: '2026-09-19'
flags: []
locale: en
description: A domain is a part of a member's life Maurice follows, with a brief
  he keeps on it — written at night, read in every private conversation, corrected
  or erased by the member in the app. What is built of the domains design.
tags:
- maurice
- documentation
- feature
- domains
icon: book-open
parent: maurice-docs
---

# Domains and their briefs

The design is the owner's French note *maurice-domaines* (19 September 2026): one Maurice, domains that emerge from the conversations, each with a visible brief, proposed in a conversation Maurice opens, the garden seeded on consent. This note is the part of it that **exists in the code**, session by session of its roadmap. What is not here yet is listed under *Gaps*.

## What a domain is today

A row of `maurices` of **kind `domain`** — since the afternoon of 19 September 2026 the table holds no personas any more ([[maurice-personas-hats]] tells what became of them): a part of its creator's life that Maurice follows, with its name, tagline, statement (`prompt`), bound context, model and tools. The other kind of row, `companion`, is a **reading companion** — one book followed at the reading position, entered as a pinned conversation — and is not a domain: no brief, not in the prompt, not on the brief routes. A NULL `kind` reads as `domain`; the rows that predate the column were sorted once at the server's first start (a followed book → companion, the rest → domain), and the member re-sorts by hand in the editor or with `PATCH /api/maurices/:id { kind }`. A domain shared with a guest is the creator's domain, not the guest's (`domainsOf` in `services/domainBriefs.ts`, `isDomain` in `services/maurices.ts`).

## The brief

A short text Maurice keeps on the domain, two or three paragraphs, his working memory on it made visible. One row of `domain_briefs` per domain and member: `text`, `updated_at`, `sources_json` (the conversations the last rewrite read), `read_until` (the newest message it saw), `model` (what wrote it — the night's model, or `member` when the member did). See [[maurice-data-model]].

**Written at night** (`services/domainBriefs.ts`, 04:00 local, an hour after the corpus reconciles) or on demand: for each domain the server gathers what touched it since the last brief — the conversations bound to it, then the corpus's semantic search, then the full-text search on the name; eight at most — and asks the night's model (`domain_brief` invocation: DeepSeek V4 Flash, Mistral Small 3.2 in reserve) to rewrite the brief from the previous one and the excerpts. A first brief is ~300 words, an incremental one ~200; the output is capped at twice that, on a paragraph. Two rules in the prompt: nothing lent to the member they did not state, no question. The domain's own `prompt`, when it has one, is read as the statement of what the domain is about — its opening sentences join the semantic query, and the writer is told "the brief covers this, not the rest". A brief the member corrected is given to the next rewrite as *their* words, to be kept unless the new conversations moved things on. Every call is charged to the ledger's `system` spender under its own daily cap; the details of the night are in [[maurice-server]].

**Read in every private conversation.** The everyday Maurice's system prompt carries a section *Your briefs on {name}'s domains* with every brief of the member's domains, most recently rewritten first, under a global budget of **3 000 estimated tokens** (`briefsSection`, `BRIEFS_BUDGET_TOKENS`): a brief that does not fit whole is cut at a paragraph and closes the section, and the domains left out are named so Maurice knows they exist. The section comes **after the persona and the loaded context**, so the cached prefix only moves when a brief does — once a night, or on a correction — and before the tool roster. Two rules held in `services/claude.ts`: **never in a room** (more than one participant: another member would read them) and **never for another member** (the section is built from the briefs of the domains the turn's member created). The prompt tells Maurice a brief marked *in their own words* is the member's and prevails, to draw on the briefs without reciting them, and that the member can read and edit every brief in the app.

**Routes** (`routes/domains.ts`). `GET /api/domains` lists the member's domains and companions as two arrays — a standard member's own rows, the rows granted to a guest (`mine: false`, no brief) — each domain with `brief: { updated_at, model, sources }` or `null`, each companion with its `book_id` and the `conversation_id` of its pinned conversation (the most recently touched one bound to it that the member sits in) or `null`. The brief routes are the creator's only, 404 otherwise, and for a companion (*A reading companion has no brief*): `GET /api/domains/:id/brief` (the brief or `null`, with the domain's name), `PUT` with `{ text }` (the correction, stored with `model = member`; an empty text erases), `DELETE` (erase; idempotent), `POST …/brief/refresh` (rewrite now; `outcome` ∈ `written | unchanged | failed | capped`, 429 when the night's allowance is spent).

## The domains in the app

The Maurice app (Mac and iOS) has **one Maurice** in its header and its send button, and a **domains list** (`DomainsViews.swift`) opened from a button beside *New conversation* in the sidebar — the Studio and the summon picker went with the personas. The list shows the member's domains, each with when its brief was last written and by whom (*Written by Maurice · 3d*, *In your words · 3d*, *No brief yet*), their reading companions, and *New domain* (Maurice Maurice sat there under *About Maurice* for a few hours on the 19th, before the documentation tool of [[maurice-tools]] replaced him). A domain of the member's own opens its **page** (`DomainBriefView.swift`): the mark, the name and the tagline; when the brief was last rewritten and by whom (*Written by Maurice · 3d · 16 Sept 2026, 04:02*, with how many conversations it read; *In your words* once corrected); the text in an editor; and the actions — **Save** (what the member wrote is what Maurice reads from the next turn on), **Rewrite now** (the outcome is said in a line: rewritten from N conversations, nothing new, allowance spent, failed), **Talk about it** (a new conversation bound to the domain, its baked-in context preloaded by the [[maurice-composer|composer]]), **Erase** (with a confirmation), **Edit** (the domain editor: name, tagline, kind, statement, context, model, tools). A companion's row resumes its pinned conversation or starts one; a domain granted to a guest opens a conversation on it (no page: the brief is the creator's). The greeting of a bound conversation shows the same mark and name and leads to the page and the editor. No brief yet reads as such, with the night and the button as the two ways to get one. Fifty-odd strings in the seven app languages.

## Ships vs. exists

The briefs — the data, the night, the prompt section, the routes, the page — and the domains themselves — the kind, the sort, the list, the editor — are in the server and the Maurice app; nothing depends on the private tools except the semantic search's reach (the corpus ships). The hosted households run the same image and the same one-time sort at first start. Carnet has no domain page yet and shows no hat: nothing changes there until P3-C.

## Gaps

- **Domains are still created by hand**, in the domain editor (*New domain* in the list). The mapping that discovers them at night (`tools/corpus/scripts/map_domains.py` exists as a script), the conversation Maurice opens to propose them, the `domains__propose|adjust|adopt` tools and the seeding of the garden are the next sessions of the roadmap.
- **A reading companion's pinned conversation is found, not designed.** The row of kind `companion` holds the book and the conduct prompt; the list resumes the most recently touched conversation bound to it, and `GET /api/domains` names it. Opening it from the *book's* page — book preloaded at the reading position, the rules living with the book rather than in a row — is what the design asks for and what P3-C (Carnet) or a later app session builds on this data.
- **The briefs are the creator's.** A guest granted a persona has no brief on it, and a room never sees one. Whether a shared domain should have a shared brief is open.
- **The budget is estimated**, at three characters a token, like the rest of the context window; and the whole section is cached with the system prompt, so a correction in the afternoon costs one cache miss.
- **The rewrite's material is found by name and tagline** plus the prompt's opening; until the mapping gives domains with a real paragraph, a one-word domain still pulls in neighbours.
