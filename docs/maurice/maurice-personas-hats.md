---
title: Specialized Maurices & hats
date: '2026-09-19'
flags: []
locale: en
description: Named personas with their own prompt, model, creativity, bound context,
  and a visual hat identity.
tags:
- maurice
- documentation
- feature
- personas
icon: hard-hat
parent: maurice-docs
---

# Specialized Maurices & hats

A "Maurice" is a persona: a named assistant with its own personality, model, creativity, optionally a frozen bundle of context, and a visual **hat** that signals its identity. The everyday Maurice is the baseline; specialized Maurices are how a household member shapes a focused helper — a physics tutor, a trip planner, a storyteller — and recognises it at a glance.

This is the [[maurice|vision's]] hat metaphor made concrete, with one honest difference: today hats are **chosen** when creating a persona, not yet **emergent** from the active note subtree (see *Gaps* below).

## The model

Each persona is a row in the `maurices` table (`server/src/services/maurices.ts`, routes in `server/src/routes/maurices.ts`):

| Field | Meaning |
|---|---|
| `name`, `tagline` | Identity and a short blurb shown in the greeting |
| `hat` | One of the hat styles (see roster below) |
| `palette` | Accent colour + surface tints derived from the hat's hue |
| `prompt` | The system instruction that gives the persona its voice and rules |
| `model` | Preferred LLM (nullable → falls back to the member's everyday model) |
| `temp` | Creativity (0–1 → precise / balanced / creative) |
| `thinking` | Reasoning choice, for a model the roster marks `optional` (see [[maurice-data-model]]): `null` = the provider's own default, `true` = think first, `false` = answer directly. Ignored on any other model, and kept when the model changes. Maurice Maurice is `false`: his answers are lookups. |
| `context_json` | A **frozen** composer spec — notes/books/files baked in (see below) |
| `tool_families` | Optional restriction of which tool groups this persona may use |
| `created_by` | Owner; drives access (and guest-granting) |

The **everyday Maurice** is represented by a `null` persona on a conversation: no hat, no bound context, the member's default model. Every new conversation starts from whichever Maurice is "armed" in the composer.

## Maurice Maurice — the built-in specialist

Since 18 September 2026 one persona is not a row at all. **Maurice Maurice** is the specialist of Maurice itself: he heads every member's list — standard members and guests alike — right after the everyday Maurice, and answers questions about the system from this documentation. He is defined in code (`builtinMaurice()` in `server/src/services/maurices.ts`, id `maurice-maurice`), which is what makes him the same on every install, from the Mac at home to a demo container:

- **His context is these notes, as a digest plus a delta.** [[maurice-digest]] condenses the whole set to its facts — what each part is, the names, what ships, the gaps — in about 12k tokens, and its frontmatter `covers` map records the date of every note it reflects. On each turn the server loads the digest, then in full every note under `maurice-docs` that the digest does not cover or whose `date` is later than the covered one, marked "loaded in full, prevails over the digest". So documenting *au fil de l'eau* needs no new condensation: the fresh notes ride along whole until the digest is rewritten, which is done in a session every so often, when the delta has grown to three or four notes. Without a digest the full set is loaded (~60k tokens). A note under the index marked `internal: true` in its frontmatter — [[maurice-commercialisation]], which names the company and its business — is skipped by the reader and by the sync script alike, so it never reaches another household's Maurice Maurice. The server reads the notes from `MAURICE_DOCS_DIR` when set (a garden notes directory, for a live view), else from `docs/maurice/` in the repo, a snapshot `scripts/sync-docs.sh` copies out of the owner's garden and which the container image ships. The reader (`services/mauriceDocs.ts`) caches on the files' mtimes, so an edited note is picked up without a restart. The apps show the set as his baked-in bundle (count and weight) but not as chips: there is nothing to unlock.
- **His model is the server's choice, and locked.** Not the member's preference, not the household default, and not subject to the member's allow-list: a strong cloud model from a provider the household holds a key for, the household default's provider first — Claude Sonnet 4.6 on an Anthropic key, Mistral Medium 3.5 on Scaleway, then Mistral Large, GPT-4o, GLM-5.3 (`builtinMauriceModel()`). Never a local model: the docs alone outgrow the 32k asked of Ollama. With no cloud key at all he falls back to the household default and says what he can. The chat's model pill shows the model with a lock instead of the chevron; `PATCH /api/maurices/maurice-maurice` answers 403.
- **Nothing about him is editable** — no pencil in Maurice Studio, no "Edit Maurice" on the greeting; `DELETE` answers 403 too. Hat: the boater, the brand's own. Creativity low (0.3). His tagline follows the member's language; his prompt tells him to answer in the language the question is asked in, to ground every answer in the notes, to name the note he draws on, to respect the "ships vs. exists" and "gaps" sections, and to say so when the docs are silent rather than guess.
- **Tool families** are inherited (household default), like a persona with no restriction; a conversation-level override still applies.

Keeping him accurate is the documentation discipline itself: every change to the system updates the note it touches (the rule in the workspace `CLAUDE.md`), and `scripts/sync-docs.sh` then refreshes the snapshot the server and the image read. Rewriting the digest is the periodic chore: re-read the notes, rewrite [[maurice-digest]], set its `covers` dates to the notes' current dates.

## Bound context ("baked-in")

A persona can carry its own context — the trip-planner Maurice always knows the itinerary notes; the tutor always has the school notes. This is stored as a frozen composer spec in `context_json` and surfaced in the app's context tray as locked, "baked-in" items (lock icon), always included and separate from whatever the member adds ad hoc for a single turn. See [[maurice-composer]] for the composer mechanics and token budgeting.

Because it is frozen at creation/edit time, the bound context is a snapshot — editing the persona re-freezes it.

## The hats

Hats are defined in `app/Maurice/Hats.swift`, with the brand boater logomark drawn as a tintable SVG in `BoaterHat.swift`. There are 16 styles — Boater, Fedora, Top Hat, Beret, Flat Cap, Ball Cap, Chef, Grad, Hard Hat, Detective, Explorer, Wizard, Crown, Party, Swim, Captain — each mapping to a palette (an accent hue plus two surface tints). The hat appears as a badge in the chat toolbar/header, on conversation rows in the sidebar, and on the composer's send button so the member always knows *who they are about to summon*.

## Creating and using a persona (app)

- **Maurice Studio** (`StudioViews.swift`) — the picker: everyday Maurice always first, then the member's custom Maurices, then "Create New." Tapping a row *arms* that Maurice for the conversation; an edit affordance opens the creator.
- **Persona Creator** (`PersonaCreatorView.swift`) — form fields (name, tagline, prompt), the hat grid, a palette/hue selector, a creativity slider, a **reasoning switch** (three pills under the slider — provider default / answer directly / think first — shown only when the chosen model's roster entry says the phase is optional, since 18 September 2026), and a context section to bind notes/books/files. On iPad (regular width) a live preview is pinned beside the form; the controls' accent follows the chosen hat. Delete is destructive (red).
- **Greeting** — when a conversation is empty, the persona's hat, name, tagline, and creativity pill are shown as a greeting card, with a reasoning pill beside it when the persona made a choice on a model that takes one.

The armed persona persists per conversation; switching personas is done from the picker on the composer's send button.

## A Maurice of your own is a domain

Since 19 September 2026 a persona the member made is, seen from the other side, a **domain** of their life — and Maurice keeps a **brief** on it, written at night from the conversations that touched it and read in every private conversation. The Studio row of such a Maurice carries a book icon, and the greeting a **Brief** button beside *Edit Maurice*: both open the domain page, where the brief is read, corrected, erased or rewritten now. Neither appears on the everyday Maurice, on Maurice Maurice, or on a persona another member shared. The whole of it — data, night, prompt, routes, page, and the design it comes from — is in [[maurice-domains]].

## Access & guests

Personas are owned by their creator. Guests (a restricted role — see [[maurice-households-rooms]]) don't create their own; an admin grants them access to specific personas, which is how a guest gets a curated, bounded Maurice rather than the full system.

## Tool families

A persona can be limited to specific **tool families** (`tool_families`), so e.g. a kids' tutor persona can be denied web search or social tools. Families are the same grouping the conversation-level tool overrides use; see [[maurice-tools]].

## Gaps vs. the vision

- **Emergent hats.** The vision has the hat *emerge* from whichever note subtree is active ("Maurice is in scientist mode because you opened the dinosaur folder"). Today the hat is a property the member sets on a persona. Closing this means deriving a hat/scope from the loaded composer context automatically.
- **Consent-driven creation.** The vision's Layer 2 ("You've been curious about black holes — want me to start remembering this?") would create a persona/note pair on consent. Persona creation is currently fully manual.
- **Maurice Maurice refreshes his own reading (closed 19 September 2026) — but still in English.** He no longer answers only from the snapshot his image was built with. `scripts/sync-docs.sh` writes a `manifest.json` beside the notes (date, size and sha256 per note, digest included), committed and pushed with them; every instance fetches that manifest from the public repo's `main` branch 20 s after boot and then daily, and when it is newer than the one on hand pulls the notes that changed into `~/.maurice/docs/maurice`, verified against the manifest, staged and swapped in whole (see [[maurice-server]]). He reads that set once it is at least as new as the bundle; a live `MAURICE_DOCS_DIR` still wins, and his `updated_at` follows the set actually read. What remains true: the notes are written in this garden and reach other households only through a push of the repo — the refresh closes the gap between a push and an image rebuild, not the one between the garden and a push. And the notes are English only — he translates as he answers, which is fine for the answer and less so for a quoted heading.
- **The everyday Maurice's settings are the household's, not the member's.** The conversation with no persona has no editor in the apps, so its reasoning choice is a factory setting on the household (`everyday_thinking`, seeded to "answer directly": reasoning is something a persona asks for), corrected in the admin console and nowhere else. A per-member or per-conversation choice would need a column beside the everyday model.
- **Fine detail lives in the delta or nowhere.** Between condensations, a question about an old note's fine print — why the Scaleway key names its project, say — gets the digest's one line. If that bites, the next step is a read-on-demand tool for one full note, not a bigger digest.

These two are the most interesting feature conversations this note is meant to seed.
