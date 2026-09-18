---
title: Life capabilities
date: '2026-09-18'
flags: []
locale: en
description: 'The experimental tool fleet: health, tasks, signals & coaching, calendar,
  contacts, reading, and more.'
tags:
- maurice
- documentation
- feature
- life
- tools
icon: heart-pulse
parent: maurice-docs
---

# Life capabilities

Beyond knowledge, Maurice plugs into the practical texture of a life — sleep, tasks, habits, calendar, reading. These are the **private [[maurice-tools|overlay]]**: real and in daily use at home, but **experimental**, and **none of them ship in the initial release** (which is chat + garden). Tool *names* below are the live MCP tools; some internals are approximate because the overlay is private.

## The fleet

| Capability | Server | Key tools | Integrates |
|---|---|---|---|
| **Health** | `health` | `get_sleep`, `get_hrv`, `get_respiratory_rate`, `get_recent_summary`, `list_available_metrics` | Apple Health export |
| **Signals & coaching** | `signals` | `signal_log`, `signal_list`, `signal_summary`, `signal_categories`, `coaching_plan_*`, `coaching_adherence` | self-tracked |
| **Tasks** | `tasks` | `inbox`, `list`, `triage`, `update`, `complete`, `defer`, `drop`, `chain`, `stats` | local |
| **Calendar** | `calendar` | `get_events`, `create_event`, `update_event`, `search_events`, `list_calendars`, `*_task` | CalDAV |
| **Contacts** | `contacts` | `list_contacts`, `get_contact`, `search_contacts` | CardDAV |
| **Reading — library** | `calibre` | `list_books`, `get_book`, `list_chapters`, `extract_chapters`, `summarize_chapters`, `get_chapter_summary`, `get_reading_progress`, `set_reading_progress` | Calibre |
| **Reading — highlights** | `readwise` | `get_documents`, `get_document_content`, `get_reading_activity` | Readwise API |
| **Capture** | `thoughts` | `list_thoughts`, `list_summaries` | desktop Markdown |
| **Dashboards** | `layouts` | `create`, `get`, `list`, `update` | local |
| **Social** | `social` | `reddit_scan`, `reddit_search`, `reddit_thread`, `linkedin_publish`, `linkedin_analytics`, `twitter_publish` | Reddit / LinkedIn / X |

## A couple of loops worth seeing

- **Coaching adherence** closes a loop across servers: a [[maurice-knowledge|garden]] note declares `coaching_metrics` (a pillar, a signal category, a target like `3/week`); you log activity with `signals.signal_log`; `coaching_adherence` then scores how you're tracking. The plan lives as a visible, editable note — not a hidden setting.
- **Reading into a chat**: `calibre` is what makes **books** a [[maurice-composer|composer]] source — chapter summaries or full text, scoped (all / up-to / selected / progress) and weighed against the token budget. Since September 2026 the tools count chapters one way: `list_chapters` returns each chapter's `chapter` (1-based over the body chapters, null for front and back matter) and `section` beside the raw file `index`; `get_chapter_summary` and `get_chapter_summaries_up_to` take `chapter` first, and `get_reading_progress` reports `chapter` and the matching `chapter_index`. The composer's chapter headers and its "Books in this conversation" prompt use the same numbers. There is one global library, configurable from the admin dashboard (`calibre_libraries`, see [[maurice-data-model]]).
- **Reading on the phone**: the same Calibre routes back [[maurice-carnet|Carnet]]'s library — covers, chapters and summaries, highlights, bookmarks, the reading position synced per member, offline downloads. Chapter extraction and summarisation run as server-side jobs whose errors surface on `/status`; the CLI interpreter is chosen per action by capability, after Python 3.14 broke extraction once. Highlights and the reading position are what feed a book's [[maurice-knowledge|flashcards]].
- **Dashboards and capture**: `layouts` defines the server-driven dashboards Carnet renders by day; `places` and `uploads` take its passive location signals and its documents.

## Ships vs. exists

**Everything on this page is experimental and does not ship initially.** It lives in the private `maurice-tools` overlay and rolls out gradually as each piece is polished. A public, garden-only install has none of it.

## Gaps & notes

- **Internals are approximate.** The overlay is gitignored; the tool names are authoritative (they're live MCP tools), but storage and integration details vary and aren't all verified here.
- **Health storage is still in flux** — the SQLite consolidation of `specs/maurice-carnet-roadmap.md` is under way (the data-api's health service speaks both), and the health tool's install scripts still reference MongoDB. The ingest is the Health Auto Export endpoint.
- **`compte` (accounting/budget)** exists as a [[maurice-server|data-api]] surface (bank transactions) rather than an MCP tool, so it's not in the table above.
- **These are the least battle-tested surfaces** in the system — promising loops, experimental polish.
