---
title: Knowledge capabilities
date: '2026-09-19'
flags: []
locale: en
description: 'What Maurice can do with knowledge: the garden (notes, media, journal),
  the articles pipeline, fiches and résonances, flashcards, the corpus, and research
  tracks.'
tags:
- maurice
- documentation
- feature
- knowledge
- garden
icon: brain
parent: maurice-docs
---

# Knowledge capabilities

The knowledge tools are how Maurice reads and grows what the household *knows*. The garden and the corpus ship; tracks are experimental.

## Garden — the memory itself *(ships)*

`tools/garden/server.py` is the public capability. It is the full CRUD over the Markdown garden, all of it deliberate human action (Maurice writes only when asked):

- **Notes** — `create_note`, `update_note`, `get_note`, `list_notes`, `delete_note`, `set_image`, `toggle_public` / `toggle_private`. Frontmatter carries `flags` (public/encrypted/moc/…), `parent`, `tags`, `icon`, and more.
- **Journal** — dated **daily notes** (`write_daily_note`, `get_daily_note`, `search_daily_notes`) and **dreams** (`write_dream`, …), with entity-linking that turns named people into links to their fiches.
- **Fragments** — `append_fragment` and friends: collapsible sub-sections within a note, and the place an article's full text lives beside its fiche.
- **Resources** — typed entries for books, movies, series, podcasts, articles, games, and people. `search_*` then `create_*_entry` pull metadata and cover art from **Google Books, TMDB, IGDB, Podcast Index, Wikidata, and Open Graph**, downloading images into the garden. The metadata API keys are set from the admin dashboard.
- **Fiches** — the working face of a media entry, see below. `open_fiche` fetches the metadata and opens one; `update_fiche` re-fetches it; `promote_fiche` turns it into a published card *when a verdict exists* — a card is the reader's verdict, not Maurice's to draft.
- **Imagery & publishing** — `generate_evocation` + `generate_hero_image` (via **fal.ai**) make banner art; `publish_content` and `deploy_site` push the garden to the [[maurice-web-garden|web]], and publishing is something you can ask for in a chat.
- **People** — `link_contact_to_person` / `find_person_by_contact` bind a garden person to a CardDAV contact.

Storage is git-backed Markdown under `~/.maurice/gardens/<username>/`, one repository per member — visible, ownable, diffable, and openable in **Obsidian** on the Mac or **Working Copy** on the iPad straight from the web garden's pages. This is the [[maurice|tamed memory]] made literal.

## A media entry has faces

Since August 2026 a garden entry for a book, a film, an article, a person is one *subject* that may exist as up to three files:

- the **card** (`<slug>.md`) — the published face, what the site renders: the reader's verdict;
- the **fiche** (`<slug>-fiche.md`) — the working face, "the back of the card": provider metadata under `meta:`, the reader's comments under `## Commentaire`, résonances under `## Résonances`, and beside it a `_fragments/` directory for long material such as an article's full text;
- the **flashcards** (`<slug>-fiche/_cards/`) — see below.

Two rules keep this honest. **A fiche is *opened* by a deliberate gesture** — `open_fiche` for a book or a film, writing on it for an article. **An article share is a weak signal**, so the fiche it writes automatically carries `meta.opened: false` until the reader writes on it: a comment at share time or later, a résonance filed on it or sent from it, a highlight with a note. Unopened fiches stay out of the Garden section and out of the résonance target search; the articles shelf still lists them. The absence of the marker means opened, so every fiche written before the rule existed is one.

## The articles pipeline *(ships)*

One endpoint, `POST /api/v1/garden/articles`, that every capture surface calls: [[maurice-carnet|Carnet]]'s **share sheet**, the **browser clipper** (`clients/web-clipper`), the garden MCP tool. It writes one fiche per article, its full text as a fragment, and its cover. Details that took a while to get right:

- The caller may send the **DOM its browser already rendered**; the server parses that instead of fetching the URL — the only way past a paywall or a bot check. Carnet's share extension runs a script in the Safari page for exactly this.
- **Duplicates** are found by scanning the collection's fiches, under the page's own `rel=canonical` — a tracking link and the plain URL are the same article. A re-share with a comment appends the comment rather than making a twin.
- A site that **refuses robots** (a 403, a bot wall) does not lose the save: a **bookmark** fiche keeps the URL, the comment and the reason under `status: needs-capture`, and a later share from a browser completes it in place. A dead URL is an error, not a bookmark.
- An **AI summary** is generated after the response has gone out, into the frontmatter only, on a file re-read from disk.
- Titles are quoted defensively in YAML — `[Analyse] …` once opened a flow sequence and silently took the fiche out of everything.

Reading them back — list, one article, its full text, highlights, a note — is what Carnet's Articles shelf is built on.

## Highlights & résonances *(ships with Carnet)*

Reading a book chapter or an article in Carnet, you can **highlight** a passage (with a note and a colour; stored in SQLite, per member, anchored to the chapter or the fiche, and to the view — full text or summary — the offsets belong to), and you can file a **résonance**: "this feeds my *Sugar* fiche." A résonance is a dated block written under `## Résonances` on the *target's* working face, with a literal `[[wiki-link]]` back to the source — so Obsidian resolves it natively, computes the backlink and the graph, and the site renders the same syntax. There is no link table; the markdown is the truth.

## Flashcards *(ships, September 2026)*

Cards are generated **on demand**, never on save, from a source: a book chapter, a whole book, a fiche, or one of its fragments. Highlights are not a unit but an input — the passages the reader marked are covered first, and they enter the source hash. One file per pass, beside the fragments, in the syntax of the **Obsidian Spaced Repetition plugin** (`Question::Answer`, multi-line with `?`, reversed with `:::`/`??`, cloze with `==term==`, a `#flashcards/<collection>/<slug>/<unit>` deck line), so the vault reviews the same cards the app does.

The frontmatter carries what the plugin doesn't need: the source, a **hash of it at generation time** (a fiche that has moved on is reported *stale*), the language and mode of the pass, and a **fingerprint of every generated card**. A card whose text no longer matches was edited by hand and survives regeneration; so does one the reader wrote; a regenerated card with the same question keeps its schedule. The schedule is the plugin's own `<!--SR:…-->` comment after each card, written by whichever side reviewed last, with the plugin's SM-2 constants. The `_cards/` directory is **git-ignored** — a review is never a commit, and cards regenerate from their source.

Language is French by default, the fiche's `cards_lang` over that, the call's `lang` / `answer_lang` over both; a *vocabulary* mode makes term-and-meaning cards, both directions, from a text in a language being learned. Asking for cards on a Calibre book with no garden fiche opens one — that request is the deliberate gesture. The server side is complete (`/api/v1/garden/cards`); the Carnet surfaces — a Flashcards line on every media, a review section — are the next tranche.

## Corpus — search across everything *(ships)*

`tools/corpus` is RAG over the household's reading and conversations: `search` (plus `search_by_tags`, `search_by_author`, `search_in_book`, `search_book_summaries`), `get_chunk_context`, and `index_conversation`. It moved into the main repo in September 2026 with a test suite, indexes the garden's **notes, fiches, fragments and cards** as they change (the server pushes each write; a watcher inside the gateway catches the rest, and prunes entries whose file is gone), and re-embeds only what changed. The vector store is **sqlite-vec**, one file per member under `tools/corpus/data/vectors/` (`<member>.db`, plus `_default.db` for shared content); the Qdrant block in the config is kept only as a migration reference (`specs/corpus-sqlite-vec-migration.md`).

**The embedding model, since 19 September 2026: Qwen3-Embedding, 1024 dimensions.** Until then the corpus ran on `nomic-embed-text`, which does not separate French: mapping Candide's conversations by their vectors ([[maurice-domaines]], step 0) put every French one — 1 173 of them, nearly all of the life lived with Maurice — in one block, whatever the clustering, while the English ones fell into recognisable groups. Three multilingual models were measured on that block with the same protocol: `nomic-embed-text-v2-moe`, `qwen3-embedding:0.6b` and `qwen3-embedding:4b` all separate it into a dozen living domains; Qwen leaves the smallest remainder; the 4B is no better at it than the 0.6B and runs four times slower on the Mac mini (about 4 chunks a second against 19). The decision, and why it is a family rather than one model: **Scaleway serves `qwen3-embedding-8b`** (and `bge-multilingual-gemma2`) and Ollama serves the 0.6B, 4B and 8B, so a household runs whichever size its machine can — **0.6B through Ollama at home, 8B on Scaleway for a hosted instance** — and the family is matryoshka-trained, so every size is asked for the same **1024 dimensions** (`dimensions` on the request; Ollama and Scaleway both honour it, `bge` refuses it) and a store has one shape whichever size wrote it. Never two models in one store, though: `corpus_meta` pins the model and width that wrote a file, and since this change the store **refuses to open** under another (`sqlite_vec_store.py`, `_check_pin`) rather than answering searches from an unrelated space until the next write tripped on the pin. A model change is therefore a full re-index into a fresh store, the old one kept beside it until checked — `python -m src.main index --force` for the file sources, `--source conversations` for the rest; the home corpus (125 000 chunks, 168 M characters, two thirds of it books) takes a night on the 0.6B. Two smaller things came with it. The embedder now knows what each family wants **in front of the text** — Qwen's instruction line on the query and nothing on the document, nomic's `search_query:` / `search_document:`, BGE's markers — so a search is embedded as a query and a chunk as a document; the nomic index had been built with bare text on both sides. And the config is one number: `vector_size` sizes the store and, for a matryoshka family, the request; `query_prefix` / `document_prefix` override the family table when a model needs something else. Hosted households installed before this run `bge-multilingual-gemma2` at its native 3584, set explicitly in their env, and keep it: multilingual too, and a working index is not worth a re-index for the family's sake.

**Live conversations, 19 September 2026.** After every reply the server asks the corpus to reconcile the conversation (`indexConversationInBackground`, fire-and-forget). It called the tool by its bare name, `index_conversation`, while the gateway only knows `corpus__index_conversation`; the gateway answered "Unknown tool" as ordinary text, not as an error, so the call reported success and **no conversation lived after a turn had entered the index since the June import** — three months of Candide's and Paola's talks were invisible to `search` and to anything built on the corpus. The call now goes through `corpusCall`, which carries the prefix and logs a refusal. The backlog was reconciled by hand (`python -m src.main index --source conversations` from `tools/corpus`), and the same day the reconciliation got a schedule: **once a night the server asks the corpus to reconcile every conversation and to prune the file entries whose file is gone** (`services/corpusNightly.ts`, described in [[maurice-server]]) — the safety net the comment in `mcpClient.ts` had been promising. The admin dashboard shows when it last ran and what it did, with a "Reconcile now" button.

It is also the engine behind the **"bring your history"** [[maurice|differentiator]]: `import_chat_export` ingests the official **Claude and ChatGPT** data-export `.zip`s, so your past threads become searchable memory.

## Tracks — research *(experimental)*

`tools/tracks` turns a question into structured output: **deep research** (`request_deep_research`, `get_research_status`), **briefings** (`generate_briefing`, `get_latest_briefing`), **dossiers** (`get_dossier`, `get_dossier_tree`, `list_dossiers`), and **signal reports** (`trigger_signal_report`). Findings can flow into the garden via `publish_content`. Storage is SQLite.

## Ships vs. exists

**Garden, the articles pipeline, résonances, flashcards, and corpus ship.** **Tracks are experimental** (the private `maurice-tools` overlay).

## Gaps & notes

- **No automatic "temporal mirror."** Daily notes are a real, deliberate garden artifact, but Maurice does **not** generate weekly/monthly reviews of your thinking — that idea has no code (see [[maurice|the vision's]] corrected scope).
- **Flashcards have no backup.** The gardens rely on git, which ignores the cards; the nightly backup covers `maurice.db` only. Either the backup grows to cover `~/.maurice/gardens`, or the cards are accepted as regenerable.
- **The corpus reconciles itself nightly** (closed 19 September 2026, `services/corpusNightly.ts`): every conversation and a prune per member, from 03:00 local, once a day, and the admin can run it now. What it does not cover: the shared `_default.db` (books, dossiers) is out of reach of a member-scoped gateway session, so a book removed from Calibre keeps its chunks until someone runs `prune` from the corpus CLI; and the watcher inside the gateway remains the only thing that notices a garden file changed while the server was down (the nightly does not re-walk the file sources).
- **The shared pool is on the old model until the books are re-indexed.** The re-index of 19 September 2026 runs conversations, gardens, then books, in that order; until the last source is done, the fresh store answers without the books, and the old store is kept beside it (`tools/corpus/data-nomic-embed-text/`) for a rollback.
- **Tracks' "deep research" depth** is the least battle-tested of the three; treat it as experimental.
