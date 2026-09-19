---
title: The context composer
date: '2026-09-19'
flags: []
locale: en
description: Loading notes, books, files, and past conversations into a chat under
  a live token budget — with frozen-snapshot semantics.
tags:
- maurice
- documentation
- feature
- composer
icon: layers
parent: maurice-docs
---

# The context composer

This is where the *apprivoisé* idea becomes a control surface: you choose exactly what Maurice knows for a conversation. The composer is the app's context tray (`app/Maurice/Views/ComposerViews.swift`) over a server context service (`server/src/services/composer/*`, routes in `server/src/routes/composer.ts`).

## What you can load

| Type | Options | Notes |
|---|---|---|
| **Notes** | recursive fan-out (include descendants), include-archived, exclude list | A note or a whole subtree from the [[maurice-knowledge|garden]]. The tree follows `[[wiki-links]]` breadth-first: a note hangs under the node nearest the root that links to it, so a MOC's own links are its children and a cross-linked note appears once, at its shallowest — loading `maurice-docs` with descendants is the whole system documentation, seventeen notes. |
| **Books** | chapter scope: `all` / `up_to` (spoiler-safe slider) / pick chapters / **`progress`**; representation `summary` or `full` | Chapters from a [[maurice-life|Calibre]] library. |
| **Fiches** | include its fragments (on by default) | A garden fiche and what was written on it — the working face of a book, article, film or person. |
| **Past conversations** | representation `summary` (default past 8k tokens) or `full` | A prior thread, as memory — summarised once it is long, see below. |
| **Files** | — | Text, PDF, or image from the [[maurice-files|files library]]. |
| **Folders** | recurse, exclude list | Sweeps in text files (counted) and binaries (uncounted). |

Notes and past conversations are first-class together — both are memory you can hand Maurice.

### A long conversation is loaded as a summary

Past **8k tokens** a conversation is summarised rather than pasted, and the
summary is cached against a **hash of the transcript** it was made from
(`conversation_summaries`, one row per thread). That hash is the whole contract:
continue the thread and it moves, the summary reads as *stale* — still used, it
covers a prefix — and the messages since are appended verbatim until a fresh one
lands. Generation is asynchronous and never blocks a save or a prompt; the
resolver takes the best thing available now and the next turn gets the summary.
The tray card names which of the four states it is in (full text, summary,
summary stale, summarising), and `representation: full` pins the transcript.
`GET /api/v1/composer/conversations/:id/summary?wait=1` lets a client that saw
*pending* from `/weigh` come back for the real weight.

### A book that follows your reading

A book loaded on the **`progress`** scope stops where you have stopped. It reads
`reading_progress` — the same row [[maurice-carnet|Carnet]]'s reader writes when
you close the app mid-chapter — and loads the summaries of everything up to that
chapter, nothing beyond. Summaries, not full text, and not by preference: the
full text of *Journey to the West* volume 1 is 328k tokens against a 200k budget,
so a tracked book in full text would break silently somewhere past the middle.
The summaries of the whole thing are 23k.

Two controls sit on the card. **Pause** holds the marker where it is: go and
consult the index, a glossary, a chapter well ahead, and opening it is not
recorded as having read that far — the loaded context does not move either, and
`set_reading_progress` refuses while paused rather than quietly disagreeing with
the button. **Reset** forgets the position entirely, behind a confirmation;
losing your place in a 27-chapter book is not something an undo gives back. Both
are also tools (`pause_reading_progress`, `set_reading_progress(reset=True)`).

Pausing is what makes `enabled` mean something: the column and its toggle route
existed from akita, but `updateReadingProgress` upserted unconditionally, so
nothing ever honoured it.

A loaded book **says which book it is.** Until September 2026 it was its chapter
texts joined by rules — no title, no chapter numbers, no id — and a persona with
the whole of *Journey to the West* loaded asked Calibre which book this was on
every turn, guessed ids when it did not, and called the third file "chapter 3"
when the book calls it 1. Now the block opens with a header naming the book,
its authors and its **calibre `book_id`**, and each chapter carries `## Chapter
N: title`, numbered the reader's way — 1-based over the body chapters, front
and back matter labelled and unnumbered. A **Books in this conversation**
section in the system prompt repeats the id and states the numbering rule, and
the calibre tools speak the same count (`chapter` on `list_chapters`,
`get_chapter_summary`, `get_reading_progress`). The apparatus of a scholarly
edition — abbreviations, introduction, chronology, translator's or editor's
notes, a note on the text — is front matter on both sides of the rule
(`classifyChapters` and the tool's `_body_chapters`, kept identical), so a
40,000-word translator's introduction is no longer the book's chapter 2.

The conversation carries a **Reading in progress** section in its system prompt
naming the book, the chapter, and the standing instruction never to allude to
anything past it. Say *"I've read three more chapters"* and Maurice calls
`calibre__set_reading_progress`; that moves where Carnet resumes, and the next
turn's context follows. If you do not say how far, it asks rather than guesses —
being spoiled is the one failure a reader cannot undo.

A **fiche** loaded beside it carries its fragments, which is where your
conversations about the book are saved. A book on `progress` plus its fiche is
the whole of a Maurice dedicated to one book: the reading, and what you have made
of it, both current without a refresh.

## The token budget

The tray shows a running total against a **200,000-token budget** (`CTX_BUDGET`, `composer/weights.ts`), colour-graded so you feel the weight: muted under ~18%, soft to ~55%, **caution** amber (`#b97a1e`) to 100%, **warning** red (`#a6452e`) over. Weights are estimated server-side — text at ~4 chars/token, book chapters from per-chapter `full_tok`/`summary_tok`, conversations from transcript length. Binaries (PDF/image) carry **no token estimate** — they ride as attachments, shown by size, and are content blocks on the turn rather than prompt text.

## Baked-in vs. added

Two layers stack:

- **Baked-in (locked)** — a [[maurice-personas-hats|persona's]] own `context_json`, frozen onto the conversation. It shows with a lock icon ("baked-in to {name}"), is always included, and can't be removed — only the persona's editor changes it.
- **Added** — whatever you attach for this conversation via the omnibox; removable with a tap.

A third layer rides beside them since 19 September 2026, invisible in the tray: the member's [[maurice-domains|domain briefs]], placed after the loaded context in the prompt (3 000 tokens at most, private conversations only). They are not context the member loads; they are what Maurice remembers, and the domain page is where they are edited.

## The omnibox

`GET /api/v1/composer/search` is one search across notes, fiches, books, conversations, files, and folders, ranked exact → starts-with → contains — and, for conversations, through the full-text index over their messages as well, ranked under a title match so what you remember by name still comes first, each result carrying an `updated_at` (a note's mtime, a conversation's last message, a book's arrival, a file's upload). The picker orders on that date by default — reaching for context nearly always means reaching for what you were just working on, and with an empty field the relevance score ranks everything alike — with **Relevance** and **Title** one tap away in its sort menu. Pick a result and it joins the tray; the server resolves it (a note's subtree, a book's chapters, a folder's files) and weighs it.

## Frozen snapshots

When the context is saved (`composer/specs.ts`), each item's **resolved set is frozen** — the exact note slugs, chapter refs, file ids at that moment — as a `SpecItemSnapshot`. The *content* stays live (text is re-read from those ids when Maurice loads), but the *scope* is fixed: adding a child note later won't silently grow an existing context until you explicitly **refresh**. The one deliberate exception is a book on the `progress` scope, whose chapter set is recomputed at every turn — following the reader is the entire point of it, and a companion you had to refresh by hand would be worse than none. Binary attachments are de-duplicated by id across the whole spec. This is the same snapshot shape personas use (see [[maurice-data-model]]).

## Ships vs. exists

The composer and its **notes / conversations / files** sources are **core and ship**. **Books** depend on the experimental [[maurice-life|Calibre]] tool, so that source only lights up where the private tools are installed. Loading a garden note is the one place that reads the note's text at turn time. **Fiches and their fragments** are now a composer source of their own (`src/services/composer/fiches.ts`), alongside the corpus search that already reached them.

## Gaps & notes

- **Room context is shared, not per-participant.** The spec is stored per `(conversation, account)` — a seam for private per-participant room context — but today everyone in a [[maurice-households-rooms|room]] shares the loaded context as common ground.
- **The budget is a fixed 200k, not the model's window.** GLM-5.3 takes a million tokens, Ollama 32k; the tray's gauge doesn't know. Since September the [[maurice-server|engine]] does bound the *conversation history* by the model's real window — but the loaded context is never trimmed or summarised to fit; that's still on the person composing.
