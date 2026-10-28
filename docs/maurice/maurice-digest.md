---
title: Maurice — the digest
date: '2026-10-28'
flags: []
locale: en
description: 'The system documentation condensed to what a user needs: everything
  Maurice can do, how it behaves, the properties of its architecture, what ships and
  what is experimental, and the known gaps. What the documentation tool reads instead
  of the full notes.'
tags:
- maurice
- documentation
- digest
icon: book-marked
parent: maurice-docs
digest: true
covers:
  maurice-applications: '2026-10-20'
  maurice-architecture: '2026-10-26'
  maurice-carnet: '2026-10-23'
  maurice-chat: '2026-10-26'
  maurice-composer: '2026-10-20'
  maurice-data-model: '2026-10-28'
  maurice-docs: '2026-10-20'
  maurice-domains: '2026-10-20'
  maurice-files: '2026-06-19'
  maurice-households-rooms: '2026-10-28'
  maurice-knowledge: '2026-10-20'
  maurice-life: '2026-10-20'
  maurice-personas-hats: '2026-09-19'
  maurice-server: '2026-10-28'
  maurice-shared-gardens: '2026-10-20'
  maurice-tools: '2026-10-20'
  maurice-web-garden: '2026-10-20'
---

# Maurice — the digest

This is the whole documentation condensed for someone who uses Maurice and will never read its code: what it can do, how it behaves, what its architecture guarantees, what is finished and what is not. It describes the system as it stands on 21 October 2026. Each section names the note that holds the detail (*Detail:* `server`, `carnet`…); any of them can be asked for in full.

Two distinctions run through everything. **Ships vs. exists**: what every install and every hosted household gets, against what runs only at the developer's home in a private overlay and is experimental. **Built vs. planned**: a planned feature is never described here as working; the gaps are listed at the end of each section and gathered at the end.

## 1. What Maurice is

Maurice is an open-source (AGPL v3) **household AI**. One server serves one household — adults and children — and each member has their own conversations, notes, files and memory. On a shared device you switch member with a tap and a PIN. It was built for one family with two children, and children are a design constraint throughout.

The founding idea is **a memory you can see and shape** — the *apprivoisé* (tamed) stance:

- Maurice knows only what is deliberately put in front of him: what the member loads into a conversation (the **composer**), the briefs Maurice keeps on the member's **domains**, the small **facts** the member agreed he may know, and what he finds when he searches the member's own material. He is not an AI that silently remembers everything.
- The lasting memory is the member's **notes**: Markdown files in a git repository of their own — readable, editable, openable in Obsidian, not hidden embeddings. What is published from them on the web is the member's **site**.
- **Notes are written by deliberate action.** A note exists because the member wrote it or asked Maurice to. Maurice does not mine conversations into notes, and does not propose notes from patterns he notices — a principle, not a missing feature. The exceptions are asked for and marked: a domain's first notes (only after a separate yes), the documents of a mail reading (only after a yes), and the fiche an article share creates, which stays marked *not opened* until the member writes on it.
- **Sovereignty** means first that your things stay yours and you are in charge; running on European infrastructure comes second.
- There is **one Maurice**. The parts of a member's life he follows are **domains**, not separate personas.

*Detail:* `docs`, `architecture`.

## 2. What ships and what exists

- **Ships to everyone** (every install, every hosted household): the Maurice app's chat, notes, the composer, files, rooms, domains and briefs, semantic search over one's own material (**corpus**), read-only access to one's own mailboxes (**email**) with its reading into the member's notes on consent, the documentation tool, Carnet's reading and entries, the site, and books from a Calibre library (reading, chapter extraction and summaries — on hosted households since 15 October 2026).
- **Exists, experimental, home only**: the private overlay of tools (`maurice-tools`) — health, signals and coaching, tasks, calendar, contacts lookup, the Calibre chat tools, Readwise, research tracks, social publishing, bank (`compte`), the owner's private mail triage — and Carnet's *Log* and *Dashboards*. They are in daily use at the developer's home, absent from public and hosted builds, and released one at a time as each is polished.

*Detail:* `architecture`, `tools`, `life`.

## 3. The parts and how they fit

1. **The Maurice app** — native SwiftUI for iPhone, iPad and Mac. It is the only place to chat with Maurice (there is no web chat client). A pure client: it holds no authoritative state and talks HTTPS and WebSocket to the server.
2. **Carnet** — the iPhone/iPad companion for capturing and reading: books, articles, the member's entries, what Maurice keeps on them. No general chat: its Maurice button opens a conversation about the entry in the Maurice app.
3. **The server** — one Bun/Hono process, the whole backend. Its chat engine handles accounts, conversations, domains, files, notes and their sharing, the composer, models, moderation and the streaming loop that calls the model and runs tools. Its data API (`/api/v1/*`) serves books, the media in the members' notes (articles, entries, résonances, flashcards) and, for the experimental tools, health, tasks, signals and so on.
4. **The tools** — small MCP servers behind one gateway, which the server calls on every turn. They are how Maurice *does* things: read and write notes, search, read mail.
5. **The site** — an Astro engine that renders each member's notes as a themeable website, privately for the member and publicly for what they publish.

There is also a **browser clipper** that saves the page being read into the member's notes, as Carnet's share sheet does.

**Security boundary:** the server is the only door. The tool gateway, the web engine and Calibre-Web listen on loopback only and are reached through the server's authenticated proxy. The admin console answers only on the machine itself.

*Detail:* `architecture`, `server`.

## 4. Where it runs

- **A container, and only a container.** One image runs on a rented Linux machine, a client's server, or a Mac through OrbStack (Ubuntu 26.04 base, about 2 GB, behind Caddy with Let's Encrypt). The old notarized `.pkg` installer is retired; self-hosting needs Docker. One container per household runs the server, the tool gateway, the web engine and Calibre-Web.
- **Footprint:** about **260 MB idle per household**, so an 8 GB machine carries about twenty households. A member costs a directory, not a process.
- **Hosted households** run on a rented Scaleway machine in Paris, several per machine, each with its own volume behind one Caddy. Scaleway supplies both the machine and the models under one restricted key, so a hosted household needs no API key of the member's, and its data and inference stay in the EU. A hosted household can be paused from outside (its container stays stopped and is skipped by backups).
- **Self-hosting at home:** TLS and remote access are the operator's (Tailscale or Cloudflare Tunnel); Maurice only needs to be reachable. Behind a tunnel on the same machine, `MAURICE_BIND_HOST=127.0.0.1` keeps the server off the network entirely, in plain HTTP with no certificate to renew — how the developer's own Mac runs it, still as launchd agents.
- **Backups:** hosted households are backed up nightly, encrypted, to Scaleway Object Storage (14 daily, 8 weekly, 12 monthly snapshots; a restore has been rehearsed). At home the databases are snapshotted nightly and the members' notes rely on git.
- **The apps** — the Maurice app (iPhone, iPad, Mac) and Carnet — are distributed through **TestFlight**, as a public beta anyone can join from the links on chezmaurice.eu; the App Store versions (iPhone and iPad, and the Mac app) are in Apple's review. The apps contain **no payment, price or "pay elsewhere"** prompt; subscriptions to a hosted household are handled on the web.

*Detail:* `architecture`, `server`.

## 5. Households, members, devices

- **One server is one household**; a device can hold several households, each with its own session, switched from a pill with an unread badge.
- **Joining:** enter the server's address; the app shows the household's name, icon and colour. A **fresh device joins with an invite code** given by an admin (8 characters, about 7 days, reusable within that window, rate-limited), then the member sets a PIN. An admin can also issue an **open invitation** — QR code, typed code or link, single use, 7 days — with which a newcomer gives a first name and colour and becomes a standard member. Once a member is signed in on a device, the device shows the household's members, and switching is a tap plus a PIN; a member without a PIN comes back on a device only with an invite code. The admin signs in with a username and password. A code the admin makes for someone who already uses their account is **told to that member** (an alert in the app, a line under *My data*, a push).
- **Roles:**
  - **admin** — manages members, keys, models, budgets and the household's identity;
  - **standard** — a full member with a mandatory PIN;
  - **guest** — full capabilities but a limited *reach*: an explicit contact list, checked both ways, and only the domains shared with them. This is how you host someone, or are hosted;
  - **child** — a flag an admin ticks (the server knows no ages): publishes only once the admin allows it, never proposed domains, never sent a conversation Maurice opened. It does not change model access or content rules.
- **Login safety:** a PIN is mandatory because the server is on the internet; failures are rate-limited and all answer the same "Invalid credentials". On the phone and the Mac, sessions are kept in the system **Keychain**. A session ended on the server — revoked, or the member removed — sends the device back to the member picker, which says so.
- **Push notifications** reach the Maurice app and Carnet when someone writes to you, including as a guest in another household: through Apple's service for the Apple apps, and through Web Push for a device that registers a subscription — the Android app, in private testing, via UnifiedPush and a relay such as ntfy. The payload is encrypted to the device: the relay sees that a message passed, not what it says.
- **Personal tokens** (`maur_…`) let a member connect other clients (see §18).

*Gaps:* sessions do not expire (they end only when revoked); a household cannot be renamed in the app; an invitation cannot create a guest (guests are set up in the console); `maurice://` invitation links open only on iOS.

*Detail:* `households-rooms`, `server`.

## 6. Privacy: where data lives and who can see it

| What | Where |
|---|---|
| Accounts, conversations, messages, domains and briefs, files' metadata, models, spending ledger, mailbox settings | `maurice.db`, the household's SQLite database |
| Highlights, reading positions, archived entries, experimental life data | `life.db` and other data databases |
| Notes, fiches, cards, fragments, résonances, flashcards | the member's **notes**: Markdown, one folder and one git repository per member (`~/.maurice/gardens/<member>/` — *garden* is the code's word for them) — the single source of truth and the versioned part of Maurice |
| Uploaded files and images | on disk, per member |
| Search vectors | one sqlite-vec file per member plus a shared one for books; rebuildable |
| Mail | headers only, in a per-member store; subjects and readings **sealed** with the household key; message bodies stay in the mailbox |
| Books | a genuine Calibre library; extracted chapters and summaries beside it, keyed by the book's Calibre uuid |

- **No telemetry**: no analytics, no cloud account, no mail from the system. The apps tell their own household's server which language, kind of device, model and system they run on, and nothing else; on a Maurice we host, the operator's counters read how many of each, never whose.
- **Model providers** receive the prompt and context of each turn, nothing more.
- **Dictation audio** stays on the device with Apple's on-device recognisers. Sent to the household's server, it is transcribed there by whisper.cpp when the server has it (it then never leaves the house) or, on a hosted household, by the provider's Whisper — the default, which a member turns off in Settings → Dictation to keep the audio on the device; the server keeps neither the clip nor the words. Apple's servers hear it only for a language with no local model, after the member allowed it — the mic shows a cloud.
- **Members are separated**: every tool call carries the member's id; one member's notes, search, mail and briefs are not reachable by another. In a room, Maurice cannot use anyone's memory, mail or briefs.
- **The admin is the exception, and it is said:** a Maurice belongs to whoever opens it. The admin manages the accounts and can, if need be, get into a member's — a device brought in with a code — or export the whole household. On a hosted Maurice that is done from the account page at account.chezmaurice.eu with the admin password: the link comes by mail and works once, for a few hours, and the archive holds no credentials, no household key and no mail store. At home it is done from the console on the machine itself, by whoever owns it. Each time the member is told: an alert when the app opens, the date under Settings → *My data* → *What the admin did in your account*, and a push. The app itself shows the admin nobody's conversations, notes or mail, but it does show what each member spends. Join the Maurice of someone you trust.
- **Mail passwords** are sealed with the household key, never returned by any route, readable only by the email tool through a local route.
- **The operator** (whoever runs the server) can see the admin console from the machine itself — provider keys, member settings, per-member spend, reports filed in shared rooms, health counters, logs of model rounds and tool calls. They cannot see mail passwords, reports on private one-to-one conversations (those cannot be reported), or names and content through the health probe. This is policy and plumbing, not encryption against the operator: whoever runs the server runs its storage.
- **Your data, your copy:** *My data* in the app exports a member archive (conversations, rows, notes with their history, files, mail store — no credentials), imports one, and **erases** — the member's data, or the whole account — everywhere the server reaches, including nightly local snapshots. The answer lists what it cannot reach: a copy of the notes on a remote elsewhere, a published site, archives an admin already exported, and a hosted household's off-site backups (kept up to 12 months; restoring one would bring the member back). Carnet offers the same *Delete my account*.
- **Your notes as a git clone:** each member can clone their own notes (Settings → *My data* → *Clone my notes*), read-only, with a key that opens nothing else. The clone holds the notes, fiches and their history, and every night Maurice writes into it, under `_maurice/`, the member's highlights, reading positions, archived entries and domains (brief, instructions, context, what is filed in each), and their conversations if they turn that on. It is **not encrypted**: notes marked encrypted are in clear text in it, as they are on the server's disk.
- **Household archive:** the whole household as one file (databases, every member's notes with their history, files, configuration, the household key) to move it elsewhere. No password is in it: each member reconnects their mailbox after a move. At home it comes from the admin console on the machine. A hosted household's admin asks for it on their Chez Maurice account, with their password, and gets a link by mail that works once, for a few hours. That copy holds no session, PIN or provider key either, nor the household key and the mail it seals: in the new home everyone joins again with a code and reconnects their mailbox, which Maurice reads again.

*Detail:* `data-model`, `server`, `architecture`.

## 7. Models and providers

- **Providers:** Anthropic (Claude Opus 5.5, Sonnet 5.5 and Haiku 4.5); OpenAI, Mistral, Z.ai and **Scaleway** (Generative APIs, Paris) through an OpenAI-style path; **Ollama** for local models (free, unmetered); an echo mode when no key is set.
- **A key is what makes a model exist**: the apps, the access grid and the admin console only list models whose provider has a key. The admin's **access grid** says which models each standard member may use; an admin may use all.
- **Which model answers:** the conversation's domain (if it names one), else the member's everyday choice, else the household default. The model pill in the composer switches model, grouped by provider. There is **no automatic failover** between providers.
- **The household default is a setting.** The policy for hosted households is Scaleway only: **DeepSeek V4 Flash** as the everyday model and the small **Qwen 3.6** for light work.
- **Background work** (summaries, briefs, mail reading, the documentation tool…) runs through named *ancillary invocations*. Each resolves to an admin's pin, else its own default, else the household's ancillary model, else the chat default. Chapter summaries and the full mail reading use the household's default model; summaries and other prose, and the night's domain work, prefer DeepSeek V4 Flash; light sorting jobs prefer the small Qwen. No Mistral model is ever advised.
- **Reasoning:** a household setting for the everyday Maurice ("answer directly" by default) and a per-domain choice; some models always reason, DeepSeek V4 Flash can be told not to, and on Claude Opus 5.5 "answer directly" means the least reasoning it allows. A domain's creativity setting is ignored by the current Claude models, which accept none.
- **Prompt caching** lowers the cost of repeated prefixes: explicitly on Anthropic, automatically on Z.ai and, among Scaleway's models, reported only by DeepSeek V4 Flash. The cost meter shows what it saved.
- **Context window:** when a conversation outgrows the model's window, the oldest turns are dropped, the cut is remembered so later turns stay consistent, and the model is told the beginning is missing.
- **Provider plugins** can add a provider from outside the repository; none ships.

*Gaps:* no provider failover; the context size is estimated from characters, not counted tokens; caching is invisible on most Scaleway models; Scaleway retires GLM 5.2 on 16 November 2026 (GLM 5.3, on Scaleway too, replaces it).

*Detail:* `server`, `chat`.

## 8. Costs and budgets

- **Prices are in euros.** Every turn records its cost on the message. A member can turn on **"Show what each reply cost"**: a coin under each reply (cost, cached share, a breakdown on tap) and a *Cost and tokens* section per conversation. An unpriced model shows token counts, never a false zero.
- **Members are never asked spending questions and never shown euros for their budget.** They see a **ring** in the sidebar (∞ with no budget, orange then red as it runs low, with three gentle warnings a month) and a *Budget* pane with its reset date.
- **The operator sets the limits**, all optional, the tightest winning: an instance total or rolling-day cap (the hosted fleet's default is 10 € a day per household), a household daily cap, a member daily cap, a monthly household budget split into member shares, and a separate allowance for the night's automatic work. Caps are checked before every model round, not once per turn. Under a cap an unpriced model is refused; local models are exempt.
- **Who pays what:** a member's own turns, the documentation tool, scanned-attachment transcription, mail reading and its documents, a domain's first notes, chapter and article summaries and the summaries of conversations on a fiche are charged to that member; the night's briefs and domain mapping to the household's *system* spender.
- **Orders of magnitude:** a short classic summarized chapter by chapter costs a cent or two, a long novel some tens of cents; writing a domain's first notes under a cent; a night's domain mapping a few cents per member.

*Gaps:* no payment — a member cannot top up their share, and when they can it will be on the web, never in the apps; flashcards and signal parsing are not recorded in the ledger; the documentation tool's cost is not in the chat's displayed figure.

*Detail:* `server`, `chat`.

## 9. What happens when you send a message

- **What Maurice reads**, in order: household context and the member's profile; the conversation's domain (or reading companion) and its bound context; what the member loaded in the composer; in private conversations only, an **index of the member's domains** (one line each), the full brief being fetched when a question falls in one; the facts the member kept; and last, a **content-safety floor** no setting can remove — refusal of explicit sexual content and sadistic gore, with an absolute carve-out for minors.
- **Tools:** only the tool families the conversation has (§18), plus web search and the documentation tool. Up to **six tool rounds**, then a final round with tools off so Maurice always answers. At most four web searches and three memory searches per turn; a reworded repeat gets the earlier result.
- **Streaming:** the reply arrives at a typing pace. **One activity line** per turn shows the sources found, a count of searches and tool calls, the current step and a timer; after the reply it stays as a record and opens a drawer of every search, query, source and tool call.
- **Data cards:** what a tool returns is drawn from the tool's data beside the prose, so Maurice cannot quietly misreport it. **Source cards** show exactly what a search found.
- **A reply belongs to the conversation, not to the phone.** Locking the phone or losing the network does not stop it: the turn runs to the end on the server and the app reattaches. **Stop** ends it and keeps what was written. One reply at a time per conversation.

*Gaps:* a server restart loses a reply in progress; reasoning-off DeepSeek can open an answer with an English working sentence, and reasoning-off Claude Sonnet 5.5 says a line before a tool call that runs into its answer.

*Detail:* `server`, `chat`.

## 10. The Maurice app

- **Conversations:** a sidebar list with full-text **search** over one's own conversations (passages highlighted, blocked people excluded); on iPhone and iPad, as in Carnet, an empty search field shows a keyboard glyph that hides the keyboard; a details sheet (title, model, people, costs, leaving a room).
- **Writing:** one **+** (camera, photos, files, pasted image, context, the conversation's tools); a **long paste** (1 000 characters or 20 lines) becomes a card above the field instead of a wall of text — removable, opened in full, or put back in the field — and shows as a card in the conversation too; an **article shared from another app** on iOS (*Chez Maurice* in the share sheet) opens a new conversation with the article as such a card — read by the household's server from the page as Safari showed it, so a paywalled article you are reading comes whole, nothing saved to your notes, but offered at once in the conversation's Carnet drawer (*Add to Carnet*), which saves it and ties the conversation to it — ready for your question; **dictation** — by default the recording goes to the household's server and **Whisper** transcribes it whole when you stop (better punctuation, the household's names spelled right, and the language you spoke recognised on its own, whatever the phone's is), its text replacing a live preview the device writes as you speak; turned off in Settings, dictation stays on the device, with Apple's newest recogniser on iOS/macOS 26; Apple's model downloads in the background the first time, and dictation does not wait on it when another engine can listen; the old recogniser last, using Apple's servers only for a language without a local model and only if allowed; the iPhone **Action Button** to start a dictated conversation.
- **Replies:** Markdown, **LaTeX math**, tables (a grid when they fit, a list of short records on a narrow screen), code blocks with their language and a **Copy** button, Copy, **Regenerate** (last turn only, also after an error; switching model first replays on the new model; the conversation keeps its domain or reading companion). A reply that comes back empty ends with a message saying so, not a long wait for a lost connection. Every message is **one selectable text**, on the iPhone as on the Mac: a selection runs across paragraphs, lists, code and tables with the system's handles and menu, and copies as clean text — a blank line between blocks, formulas as TeX, a table's cells tab-separated.
- **Images:** sent from camera, library or clipboard — up to ten in one message, several picked at once — and read by a vision model; **generated** when an image provider key is set (a spinner, then the image).
- **After a reply — "worth keeping":** in a private conversation, a light model names at most three works or people the exchange established (a song is offered under its album), matched first against the member's notes, then a catalogue (someone from the member's own life is never looked up online). A Carnet mark in the header counts them; *Keep* files a dated note on the entry with a link back to the conversation; *Look again* and *Refine* correct a wrong match; a dismissed subject is never offered again. Never in rooms, for guests or for children.
- **"To check":** when a person fiche written from the mail and not yet confirmed enters a turn, a card lists its unconfirmed elements to confirm, reject or correct.
- **Facts:** Maurice may propose a small stable fact about the member ("X is eleven") as a card; it reaches his prompt only once kept, and can be corrected, dismissed or forgotten.
- **Settings:** appearance and language, *Activity* (the progress pulse), the cost meter, *Budget*, *Mail*, the files library, *Import my conversations* (ChatGPT and Claude exports), *My data*, and for admins members and invitations.
- **Platforms:** Liquid Glass on iOS/macOS 26 with a fallback to iOS 17 / macOS 14; iPad and Mac use the system toolbar; drag-and-drop on the Mac.

*Gaps:* no branching; no cost total across conversations; a selection stays within one message; image generation shows no progress; the server dictation's live preview is not marked as provisional; sharing an article is iOS only, and a long article goes whole into the conversation (a Wikipedia page is about 30k tokens, read again on every turn).

*Detail:* `chat`.

## 11. Rooms and safety

- A **room** is a conversation with more than one person. Humans talk freely; **Maurice answers only when summoned** (`@maurice`, or the ➤ button; on the Mac, Return posts to humans only). Everyone in a room shares the loaded context; no one's briefs, memory search, mail or suggestions are used there.
- Live updates over WebSocket, push when no socket is connected.
- **Moderation**, in shared rooms only: long-press a message to **Report** (child safety first) or **Block** a participant. Reports reach the household's operator. A private one-to-one can never be reported, so private conversations stay out of the operator's reach. Before connecting to a household as a non-admin, the app shows a notice about who runs the server; the settings link to Apple and to child-protection authorities, and the terms of use forbid objectionable content.

*Gaps:* no private per-person context in a room.

*Detail:* `households-rooms`, `chat`, `server`.

## 12. The composer: choosing what Maurice knows

- One search box finds **notes** (one, or a subtree following wiki-links), **fiches** (with their fragments), **books**, **past conversations**, **files** and **folders**, and loads them into the conversation.
- **Books:** all chapters, up to a point (a spoiler-safe slider), picked chapters, or **following your reading** — the summaries of everything up to where Carnet's reader says you stopped, never beyond. Summaries or full text. Saying "I've read three more chapters" moves the position; *Pause* lets you look ahead without it counting.
- **Past conversations** past about 8k tokens load as a summary.
- A running total against a **200,000-token budget**, coloured as it fills; PDFs and images ride as real attachments.
- **Baked-in** context comes from the domain (locked); **added** context is the member's for this conversation. The *set* of items is frozen when saved (a new child note does not join until refreshed); their content stays live.

*Gaps:* the budget is fixed, not the model's real window, and loaded context is never trimmed to fit.

*Detail:* `composer`.

## 13. The files library

Each member has folders and files (5 GB each), in **Settings**: text, images, PDFs and other files, uploaded from the file picker, the camera, or by drag-and-drop on the Mac. Picking a document in a chat uploads and attaches it in one gesture. Text becomes context; PDFs and images are real attachments the model sees.

*Gaps:* no previews, no search inside files, no drag-and-drop on iOS.

*Detail:* `files`, `composer`.

## 14. Domains, briefs and reading companions

- A **domain** is a part of a member's life that Maurice follows: name, tagline, a statement of what it covers, bound context, model, tools, icon. A **reading companion** follows one book at the reading position, with a no-spoiler conduct.
- **The brief** is Maurice's working memory on a domain, made visible: two or three short paragraphs, in the member's language, saying who wrote it ("Written by Maurice" or "In your words") and from how many conversations. It is rewritten **at night** from the previous brief and the conversations that touched the domain since, or on demand (*Rewrite now*). The member can **correct** it (their words then prevail), **erase** it, or **talk about it** in a new conversation bound to the domain. Briefs never appear in rooms or to other members; a guest can talk on a domain shared with them but sees no brief.
- **How domains appear:** each night Maurice groups the member's unbound conversations by meaning (and, once the member's mail has been read, the mail's thread digests) and keeps only subjects that recur over months. Each becomes a **proposal** in the domains list, with a badge — **Maurice opens no conversation and posts nothing**. On a proposal's page the member renames it, merges or cuts proposals, puts it away, or **adopts** it; nothing becomes a domain without that yes. A domain can also be made by hand.
- **Filing:** each night, an unbound conversation whose nearest neighbours mostly belong to one adopted domain is filed there — marked, listed on the domain's page, reversible with *Detach*. During a turn, a recognised domain shows as a mark on the conversation and, when the match is strong, Maurice reads its brief first.
- **A domain's first notes** need their own yes (*Write a few notes to start with*): one hub note and up to three topic notes, written from the domain's conversations, marked *written by Maurice, not reviewed yet* until the member keeps, corrects or throws them away.
- **Bringing a history in:** *Import my conversations* takes ChatGPT and Claude export files; the next night maps them, so domains can appear at once.
- **One domain per name:** a member cannot make two domains of the same name (case and accents aside); the editor says which one has it, a proposal of that name joins it, and duplicates made before the rule were merged into one, conversations, briefs and context together.
- **In the clone of the notes:** each domain the member made is written there every night as a readable file — the brief, the instructions, the context, the conversations and mail filed in it — as it stood at the close of the previous day.
- In Carnet, the *Maurice* screen lists domains (with the brief's age and author) and companions; a domain's brief can be edited, rewritten or erased there.

*Gaps:* the marks exist only in the Maurice app; a large mixed subject (over about 80 conversations) is never proposed; members with few conversations get no filing; the grouping is not deterministic; a domain's first notes can carry personal details from conversations; shared domains have no shared brief; a reading companion's conversation cannot yet be opened from the book's page.

*Detail:* `domains`, `personas-hats`.

## 15. Your notes and what goes in them

- **Notes:** created, updated and listed by Maurice when asked ("keep this in my notes" works in any private conversation); private until the member says otherwise; in the member's language; an existing note is updated rather than duplicated. **Journal** notes and dreams, with named people linked to their fiches. **Fragments** hold long material inside a note.
- **Entries** — books, films, series, podcasts (and single episodes), articles, games, music, people — can have up to three faces: the **fiche** (the member's private working notes: metadata, dated comments, résonances, fragments), the **card** (the published face, in the member's own words — Maurice never drafts it), and **flashcards**. Metadata and covers come from public catalogues (Google Books, TMDB, IGDB, MusicBrainz, Podcast Index, Wikidata, Open Graph); a hosted household needs no keys for them. An entry kept while its catalogue had no key fills itself in from *Refresh details* once the key is set, when its title names one work only; otherwise Carnet says why. A fiche is opened only by a deliberate gesture.
- **Articles:** saved from Carnet's share sheet, the browser clipper or a conversation. The rendered page is captured (past paywalls), duplicates detected, page furniture (credits, ads, newsletter boxes) removed by a light model that only drops blocks and never rewrites, and two summaries written in the background: the essence in a paragraph, in your language, and a longer one in the article's, meant to be read instead of it, its length following the article's. A site that blocks robots leaves a **bookmark** to complete later from a browser.
- **Highlights** (with note and colour) in books and articles, per member. A **résonance** files a passage onto another fiche as a dated block with a plain wiki-link back.
- **People as hubs:** a person's fiche gathers what is known — relation, contact cards and addresses, fragments drawn from mail, a list of exchanges. The member's word is final: each element can be confirmed, rejected (never proposed again) or corrected; a confirmed relation is never overwritten (Maurice may only propose a revision beside it). Two people merge only on strong signals, never on a name alone.
- **Flashcards** from a chapter, a book, a fiche or a fragment, in the Obsidian Spaced Repetition format, so the vault and the app share one schedule; hand-written cards survive regeneration.

*Gaps:* no flashcard review in Carnet yet, and flashcards are not backed up; notes cannot be edited from the phone; no automatic weekly or monthly reviews (a "temporal mirror" is not intended).

*Detail:* `knowledge`, `web-garden`.

## 16. Searching your memory (corpus)

- Semantic search over the member's **notes** (notes proper, fiches, fragments, cards), their **conversations** with Maurice, and shared reading (**books**, dossiers). Each member has their own index; books are shared.
- In a turn Maurice searches each layer in the same round, weighted in this order: what the member **kept**, what they **said**, what they **read**. A question about a person (by name or by role, "my accountant") opens that person's fiche first.
- Weak results are dropped rather than padded; the current conversation is excluded; source cards show what Maurice read.
- Kept current as notes are written, after each reply, and by a nightly reconcile (03:00) that prunes deleted material.
- Embeddings: Qwen3-Embedding (multilingual) — locally through Ollama at home, on Scaleway for hosted households. Changing the model means a full re-index.
- Never used in rooms; a model is only ever given its reading tools.

*Gaps:* if indexing a note fails, only a log knows; mail is not in the corpus.

*Detail:* `knowledge`, `tools`.

## 17. Mail

- **Adding a mailbox:** *Settings → Mail → Mailboxes*, an address and an app password. The provider is recognised (Gmail, iCloud, Fastmail, Yahoo, Proton through Bridge, Orange, Free, SFR, La Poste…), the login is tested before anything is kept, and the password is sealed. CardDAV **address books** can be added beside.
- **Strictly read-only:** the email tool has **no send, move, flag or delete** — absent, not disabled — and marks nothing as read. Honestly stated: over IMAP a password opens everything, so the guarantee is that the tool cannot send, not that the credential could not. Message bodies are passed to the model as untrusted text, and Maurice is told never to obey instructions found in mail.
- **What you can ask:** find a message, read it, read an attachment (text, PDF, Word, OpenDocument; scanned pages and photos transcribed by a vision model, read once and cached), everything exchanged with a person or a domain, who writes most.
- **For free, without a model:** when a mailbox is added and each night, Maurice walks the **headers only** into a private store and sorts bulk mail from correspondence.
- **Reading on consent:** the mailbox's card in *Settings → Mail* shows what reading would take (messages, time — never money). **Yes** is given per mailbox and can be withdrawn. The default is an **overview** — the people the member really corresponds with and the last 90 days — and the member may read further back (5 or 10 years, everything). Reading runs at night, or at once with *Read now*.
- **What it writes:** under a **My mail** hub in the member's notes, marked as written by Maurice and not reviewed: **person fiches** (relationship, what was promised, what is open, the exchanges) and **thread digests** (timeline, decisions, open questions), each line linked to its source message, in the language of the mail. A note thrown away is never written again. **Forget** erases a mailbox's store and what was written from it.

*Gaps:* no OAuth, so no Outlook.com and no Google contacts; no full-text index of bodies; some formats (spreadsheets, slides, HEIC, protected files) cannot be read; scan transcriptions are close, not certified.

*Detail:* `tools`, `knowledge`, `applications`.

## 18. Tools

- **The gateway** mounts whatever tools are installed and scopes every call to the member asking. Tool names look like `garden__create_note`, `corpus__search`.
- **Families:** a conversation holds only some tools (a model given a hundred tools does worse). Always on in a private conversation: web search (when a search key is set), the note-writing tools, the reading side of the corpus, email (once a mailbox is added) and the documentation tool. Other families are chosen per conversation or per domain. Corpus, email and mail triage are withdrawn as soon as a second person joins. Maurice's instructions list only the tools actually present, so "what can you do?" gets a true answer.
- **Experimental gate:** everything beyond those core families needs an admin to tick *experimental tools* for the member.
- **External clients:** a member can add their Maurice as a **custom connector** in Claude Desktop or claude.ai (OAuth with a personal token) and use their notes and corpus there. Hosted gateways refuse anonymous callers.
- **The documentation tool** (`maurice_docs`) answers questions about Maurice himself from this documentation, on a strong cloud model of the household's provider, charged to the member who asks; it can also return any documentation note in full.
- **The private overlay** (home only, experimental): health (from Apple Health exports), signals and coaching plans declared as notes, tasks, calendar (CalDAV), contacts lookup, Calibre chat tools, Readwise, captured thoughts, dashboard layouts for Carnet, research tracks, social scanning and publishing, and the owner's mail triage (it files messages from a closed list of actions and never sends or deletes).

*Gaps:* an external client connected with a member's token sees every mounted tool, since families and the experimental gate are enforced by the server, not the gateway; there is no per-tool sandbox.

*Detail:* `tools`, `life`.

## 19. Books and the library

- A household's library is a genuine **Calibre library**, managed in the browser with **Calibre-Web** at `/calibre` (upload, metadata, shelves, OPDS for e-readers, a reader, send to Kindle) behind Maurice's login — nobody signs in twice. Desktop Calibre can still open it.
- **Chapters and summaries are made by the server** (since 15 October 2026, so on hosted households too): an EPUB is cut at its table of contents; each chapter is summarized with the summaries before it as context, in the voice of the book, by the household's default model, charged to the member who asks. A call the provider drops is retried twice; if the run still stops, asking again resumes where it stopped. Front and back matter (cover, contents, a Project Gutenberg licence…) is left out.
- Books feed Carnet's reader (§20), the composer (§12), reading companions (§14), flashcards and the corpus.
- The App Review household carries nine public-domain classics from Project Gutenberg.

*Gaps:* adding a book through Maurice's own API needs Calibre's binaries, absent from the container — hosted households add books through Calibre-Web; a PDF's chapters and indexing summaries into the corpus still need the private tool.

*Detail:* `architecture`, `carnet`.

## 20. Carnet

- **Joining:** the same household and identity as the Maurice app — an invite code on a fresh device (an open invitation too: a first name and a colour), then a PIN; several households on one device; a session ended on the server sends the device back to the member picker. The member sheet holds households, members, *Disconnect*, and a **Privacy** section (privacy policy, terms, **Delete my account**).
- **Home: one list of entries** of every kind — books, articles, films, series, music, podcasts, games, posts — each row saying what the member has on it (notes, *Draft*, *Published*, *Not opened*) and where they are in it. Filters by kind, search and sort, an offline copy of the list. Swipe right to archive, left to delete (with a confirmation saying what is removed).
- **An entry's page:** identity and cover, the source (read, resume, chapters, original), and **one sheet with two faces**; an article opens on its summary instead — the essence, then *See more…* for the long one — its sheet a tap away (*Fiche*, beside *Read*) — the member's side (dated notes and quotes, with a page) and the shared side (write, publish, unpublish; publishing takes about 15 s). Dictation beside every field, in the entry's language on the device; Whisper recognises the language spoken.
- **Reading:** books from the household's library with chapters, summaries, highlights, the exact position synced per member and offline; *pause tracking* to look ahead without it counting; *Resume* takes another device's position when it is newer. Articles with their styles, a Text/Summary switch, cached on the device.
- **Sharing an entry** with other members: nothing is copied; they read it and may add signed notes. A first cut.
- **Maurice from an entry:** the button opens the Maurice app — a new conversation with the entry as context, or, from a short menu, one already held about it. The fiche lists every conversation about the entry (from its page, or linked to it in the app — a fiche loaded in the composer is offered in the conversation's Carnet drawer, *Link*, and loading it alone is not talking about it), each with a summary of what it came to, written into the fiche once the conversation has settled and rewritten when it goes on. Without the Maurice app on the device, a text-only thread in Carnet, with what is worth keeping under each reply. Maurice's replies, the conversations read in Carnet and their summaries select from end to end, as in the Maurice app (formulas show as TeX).
- **Share extension** (*Save to Carnet*): saves the rendered page from Safari (past paywalls), or an address from other apps, with an optional first note; an offline queue keeps what could not be sent and sends it later as the member who shared it — kept, and listed in the member sheet, while that member has no session on the device.
- **Open in the browser** opens the member's site signed in.
- **The *Maurice* screen:** domains and their briefs (edit, rewrite, erase), reading companions, and older conversations Maurice opened (answered in the Maurice app). A book's page can create a reading companion.
- No location tracking; a privacy manifest declares no tracking and nothing collected by the publisher. English only. Reading is iPhone/iPad only; on a Mac the notes are read in the browser.

*Status:* in daily use at home; the build prepared for App Review is with Apple. *Gaps:* *Log* and *Dashboards* are experimental and not shipped; the hand-off to the Maurice app and the fiche's conversations were not yet tried on a phone, nor were the session, invitation and offline-queue fixes of 21 October (checked on a simulator); no flashcard review; notes cannot be edited or deleted from the phone; shared articles show no text; the iPad and a real publish from a phone were never exercised.

*Detail:* `carnet`.

## 21. The site, publishing and shared notes

- **Private view:** each member's site at `/g/<member>/` shows all their notes, rendered from disk on every request, live-reloading when a note changes, in English and French. Wiki-links resolve the way Obsidian does. The owner sees drafts, fiches and a toolbar (public/private/encrypted, delete, reorder, open in Obsidian or Working Copy). Unreviewed notes Maurice wrote carry a *Keep / Throw away* banner; mail person fiches a review panel.
- **Public, private, encrypted:** a note is published **only with the `public` flag**. An `encrypted` note is encrypted in the page (AES-256-GCM, the password typed in the browser) or withheld. Fiches, drafts, unopened articles, person fiches and other members' content never enter a published build — checked by an automated leak test.
- **A member's site:** the household's public pages at `/@<member>/`, a static build every member may publish to at any time (a child once the admin allows it); or a domain of one's own (today only at home, through Cloudflare Pages).
- **Themes:** manuscript (default), botanical, newsprint, terminal, chosen in the app (Settings → *Your site*).
- **The notes as a git address:** `https://<household>/git/<member>.git`, for `git clone`, Obsidian (the *Git* plugin) or Working Copy. HTTP Basic: any username, the member's git key as the password; a member clones only their own notes; a push is refused. Notes not yet versioned become a repository at their first clone. The clone is a vault and a near-complete backup (see §6); flashcards, mail and the search index are not in it.
- **Shared notes:** sharing is a property of a note — its audience. The app lists *My notes*, then one set per audience (*You & Paola / notes*): simply the notes sharing that audience; members can see who reads a note, share it, or leave its audience. A shared note is read inside its owner's site, in the owner's theme.

*Gaps:* the git clone is read-only (writing back from Obsidian is not built), and untested so far on an iPad with Obsidian Git or Working Copy; English-only site search; translation and social sharing unavailable in the container; shared notes have no roles (read-only vs co-editor), and a theme set for a shared audience is stored but not used; a public host's duties (reporting, takedown) are not defined.

*Detail:* `web-garden`, `shared-gardens`.

## 22. The night and the operator's tools

- **Night jobs** run inside the server, at home and hosted alike, each catching up if the server was down and each switchable off: 03:00 search reconcile and the mail header walk; 03:30 the export into the notes (highlights, reading, domains, and conversations if asked, written into each member's notes that have been cloned and committed only when something changed); 04:00 domain briefs; 05:00 domain mapping and filing. The night spends from its own allowance.
- **Admin console** (`/admin`, only from the machine itself; the operator of a hosted household reaches it through an ssh tunnel): members, PINs and invitations, models and their windows, the access grid, provider keys, the Calibre library, caps and budget shares, the night's allowance, background model pins, which children may publish, cards for the night's jobs with *run now*, the household export.
- **Health:** `/healthz` answers status and version publicly, and build, database, disk and error counts (never names or content) to a health token or to a caller on the machine itself.
- **Documentation refresh:** each server fetches the latest documentation from the public repository once a day.
- **Fleet:** a hand-kept inventory and terminal tools to check, deploy and restart households; no central registry, by design.

*Detail:* `server`, `architecture`.

## 23. How do I…

- **…join my household on a new phone?** Install the app (the TestFlight beta, linked from chezmaurice.eu), enter the server's address, and type the invite code an admin gave you (Settings → Members → New device); then choose your PIN. Carnet joins the same way.
- **…invite someone who is not a member yet?** As an admin: Settings → Members → invitation (QR code, code or link, single use, 7 days). The person picks a first name and colour and becomes a standard member. A guest is set up in the admin console instead.
- **…choose which model answers?** The model pill above the message field; the choice becomes your everyday model, or the model of the domain the conversation is bound to. Only models your household has a key for, and that the admin allowed you, are listed.
- **…add a provider key or change the household's default model?** In the admin console, on the server's machine (the operator does it for a hosted household).
- **…see what a reply cost?** Settings → *Show what each reply cost*. Your own budget, if the household has one, is the ring in the sidebar and Settings → *Budget*.
- **…make Maurice know a document, a book or an old conversation?** The composer (*+* → add context): search, pick, and it is loaded for this conversation. For a book, choose *following my reading* to stay spoiler-free.
- **…keep something from a conversation?** Ask ("keep this in my notes"), or tap *Keep* on what Maurice offers under a reply; for a work or a person it goes on that entry's fiche with a link back to the conversation.
- **…correct what Maurice keeps about me?** A domain's brief: its page in the app or in Carnet (correct, rewrite, erase). A fact: the card's *correct*, *dismiss* or *forget*. A conversation filed in the wrong domain: *Detach* on the domain's page. A person fiche from the mail: confirm, reject or correct each element.
- **…have Maurice read my mail?** Settings → Mail → Mailboxes, with an app password. Then the mailbox's card: *yes* to reading (overview by default), *read further back* if you want more, *Read now* if you don't want to wait for the night. *Forget* undoes it.
- **…save an article?** From Safari, share → *Save to Carnet* (the page as you see it, paywalls included); from a computer, the browser clipper; or ask Maurice with the link.
- **…add books and get chapter summaries?** Upload them in the library page (`/calibre`); in Carnet, a book's page offers to extract its chapters and to summarize them.
- **…publish a note or a card?** On your site, open the note in the browser and flip it to public; in Carnet, write the shared side of an entry and tap *Publish*. It appears on your public pages if the household has them, or on your own domain.
- **…bring my ChatGPT or Claude history?** Settings → *Import my conversations*, with the export file from ChatGPT or Claude. The next night proposes domains from it.
- **…use my notes from Claude Desktop or claude.ai?** Add your Maurice as a custom connector and sign in with a personal token; you get your notes and your search there.
- **…report or block someone?** In a shared room, long-press their message. Private conversations cannot be reported.
- **…keep my dictation on the device?** By default the household's server transcribes it (Whisper, the better text; a preview shows as you speak). Turn off Settings → Dictation → *Transcribe on the household server* and it stays on the device — Apple's newest recogniser on iOS or macOS 26.
- **…open my notes in Obsidian?** Settings → *My data* → *Clone my notes*: copy the address, username and key. In Obsidian, install the community plugin *Git* and run *Clone an existing remote repo*; on an iPad, Working Copy clones it too; on a computer, `git clone` the address and open the folder as a vault. It stays read-only: edit in Maurice, the clone follows.
- **…take my data with me, or leave?** Settings → *My data*: export an archive, erase your data, or delete your account (Carnet: member sheet → Privacy → *Delete my account*).
- **…run Maurice myself?** Run the container on a machine of yours (Docker), make it reachable (Tailscale or Cloudflare Tunnel), and set the provider keys in the admin console. Or be hosted: a household on Maurice's own Scaleway machines, with models included.

## 24. Not built, and known gaps

- **Not built:** payment and top-ups; writing back to the notes from an Obsidian clone (push); a web chat client; OAuth for mail (Outlook.com, Google contacts); mail in the corpus; flashcard review in Carnet; demo servers for trying the apps without a household (designed, deferred); a hosted member's own domain; on-device inference.
- **Not intended:** Maurice proposing notes from patterns he notices; automatic periodic reviews.
- **Rough edges:** sessions never expire (only revoked); a reply in progress is lost on a server restart; no provider failover; external MCP clients see every mounted tool; some member-triggered background calls are not on the ledger; erasure cannot reach off-site backups or exported archives; the databases are snapshot, not versioned (the notes are); after a household import the search index and git remotes are fixed by hand; the experimental tools are partly documented and absent from hosted households.

## 25. Where to look

| Question about | Note |
|---|---|
| Concept, the parts, delivery, hosting | `architecture`, `docs` |
| Accounts, turns, models, budgets, mail import, night jobs, admin, operator | `server` |
| Where each kind of data lives, export and erase | `data-model` |
| Tools, gateway, families, email, corpus, private overlay | `tools`, `life` |
| The Maurice app, cost meter, suggestions, facts | `chat` |
| Loading context into a conversation | `composer` |
| Files library | `files` |
| Domains, briefs, proposals, first notes, import | `domains`, `personas-hats` |
| Notes, entries, articles, people, flashcards, search | `knowledge` |
| Carnet | `carnet` |
| The site, publishing, themes | `web-garden` |
| Shared notes | `shared-gardens` |
| Households, roles, invitations, rooms | `households-rooms` |
| Personal applications, the case of mail | `applications` |
