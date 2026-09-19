---
title: Carnet — the pocket companion
date: '2026-09-19'
flags: []
locale: en
description: 'The iOS/iPadOS companion to Maurice: log what happened, read books and
  articles, browse the garden, and save what you read into it.'
tags:
- maurice
- documentation
- feature
- carnet
- app
icon: notebook
parent: maurice-docs
---

# Carnet — the pocket companion

**Carnet** is the second native client, in its own repo. Where the Maurice app is the conversational front door and the [[maurice-web-garden|web garden]] is the browsable read surface, Carnet is the pocket client for *capturing and consuming* a household's signals and content: log what happened, read and edit what's remembered. It sits on its own **Grid** theme (paper and near-black ink, one red, Archivo grotesk and Space Mono, sharp corners and hairlines, no shadows) with Liquid Glass on the functional layer since iOS 26 (see below), pairs to the same [[maurice-server|server]], and uses the same household identity — pair once, switch members with a PIN — so login and visual language are consistent across every surface.

Started in May 2026; iOS 17+, XcodeGen project, SwiftUI.

## Three peer roles

| Role | What it does | Backed by |
|---|---|---|
| **Log** | Fast ad-hoc capture — meals, exercise, breathwork, meditation, notes, places, documents, tasks — via a radial FAB, free-text parsing, the share extension, and passive location signals. | `signals`, `uploads`, `places` |
| **Dashboards** | Server-defined layouts of warm-monochrome widgets over the household's health, activity, and coaching data, navigable by day. | `layouts`, health, `signals`, `coaching` |
| **Content** | Read and edit the household's living memory: reading (books and articles), the garden's entries, résonances, and — next — flashcards. | `calibre`, `garden/*` |

## Reading

The **Library** shows the household's Calibre books with covers, chapters, summaries, and where you left off, ordered by what you last opened and then by what Calibre took in most recently (`/books` carries the Calibre `timestamp` as `added`; the last-opened side comes from the on-device reading positions, so the order is per device until a position syncs), with a sort menu for **Recently added**, **Title** and **Author**; the reader restores the exact position (character index in the full text, paragraph in the summary), synced per member and kept offline. That sync only started working in September 2026: `reading_progress` came from akita keyed on `book_id` alone, `member_id` was added by an ALTER that cannot change a primary key, and the upsert's `ON CONFLICT(member_id, book_id)` therefore threw on every call — silently, with the on-device store covering for it. The table is now rekeyed on the pair, so two members can track the same book and a position can reach the server. It is also what the [[maurice-composer|composer]]'s `progress` book scope reads. A row with `enabled = 0` is paused and the reader no longer moves it — which is how you consult a chapter well ahead without it counting as read. A book's page keeps Resume in a pinned footer and everything else behind one glyph each, two of which open a drawer: **reading** (where you are, a switch that pauses tracking so consulting an index or a chapter further on does not count as read, and reset) and **this book** (offline copy, summaries). Chapters can be extracted and summarised from there; a book can be downloaded for offline reading. Anything that places the reader goes by chapter *slug*: `Chapter.index` is derived from the file's `NNNN-` prefix and counts the front matter the list hides, so using it put the reader several chapters ahead of where they were. Passages can be **highlighted** with a note and a colour.

The **Articles** shelf lists what was saved through the share sheet or the browser clipper, straight from the garden, each row carrying the lead image the save captured (served open at `/api/garden-images/<member>/…`, the mirror of the site's session-gated `/images/…`; a bookmark the site refused has none and keeps a lettered placeholder): readable in place when the text was captured, marked as a bookmark when the site refused, with the AI summary, highlights, notes, and links to the original and to the fiche on the site. An article that nobody has written on shows as *not a fiche yet*, with a button to open it by writing a note. See the pipeline in [[maurice-knowledge]].

## The share extension

"Save to Carnet" takes a URL, a file, or data from any app and posts it as the active member. For a web page it runs a script inside the Safari page and hands back the **rendered DOM**, so an article is saved from what you actually read rather than from a server-side fetch that meets a paywall. A note typed in the sheet becomes the fiche's first comment — and the gesture that opens it. The send finishes before the sheet dismisses, and an offline queue keeps shares that couldn't reach the server.

## Garden

The **Garden** section lists every entry of the member's garden across all collections, filterable by type and searchable, ordered by what was last written on (`/garden/entries` carries `updated_at`, the newest mtime across an entry's faces) with a sort menu for the entry's own date and for title; each entry opens its card or its fiche where it lives — in the browser, or in Obsidian on the Mac and Working Copy on the iPad, which hold the same checkout the server writes to. Rows carry their cover art where the entry has some; a note's illustration does not show, since it lives under `images/notes` and the open mirror only serves `images/resources` — a private note's artwork is not worth an unauthenticated route. Unopened article fiches stay out of this list. From a book, an article, or a highlighted passage, **Résonance** files a dated `[[wiki-link]]` block on another entry's fiche.

## Design: the Grid, and Liquid Glass

Carnet draws its content flat and sharp; the *chrome* — what floats over the content — takes **Liquid Glass** on iOS 26 and keeps the square Grid look before, the deployment target staying at iOS 17. `CarnetApp/Views/Glass.swift` holds the split, the same shape as the Maurice app's: every helper is behind `#available(iOS 26)` with the pre-26 rendering beside it, and an environment flag (`glassChrome`) tells a control it sits inside glass, where it drops its hairline square and renders as a bare glyph. The rule follows Apple's adoption guide — glass on the functional layer only, sparingly, never on content:

- **Floating chrome.** No screen uses the system navigation bar; each pins its own row over the scrolling content (`safeAreaBar` on 26, so the scroll edge effect keeps the controls legible; a painted `safeAreaInset` before): back or the member badge alone at the leading edge, the actions together in one capsule at the trailing edge (`GlassBar`), the title and the shelf toggle scrolling beneath. Shelves, book and article details, both readers, both highlights lists.
- **Search** lives in the bottom bar: a magnifier alone that morphs (`glassEffectID` in a `GlassEffectContainer`) into a full-width field with a close button — iOS 26's minimized search behaviour. The glass sits on the *button*, not its label; on the label the hit area drifted off the glyph.
- **Glass footers.** The book page's Resume footer and the reader's chapter nav float as inset glass panels (`glassFooter`), the full-width material strip before.
- **Sheets** keep the system's glass background (`glassSheetBackground` paints nothing on 26, the page background before); the PIN and invite cards are glass without a drop shadow; the member picker's system buttons take `.glass` / `.glassProminent`; the reset-progress confirmation is attached to its button so it originates from it.
- **Not glass:** rows, covers, cards, the shelf toggle, progress bars and text — the content keeps the Grid.

A DEBUG launch argument, `-carnet.previewReading`, walks the reading screens on the bundled samples without a server or a member, which is how the chrome is checked on iOS 26 and iOS 18 simulators.

## Scope and distribution

Carnet has two scopes, chosen at compile time by `CarnetScope.current` (`CarnetApp/CarnetScope.swift`). **Full** is the drawer with the three roles above. **Minimal** — the cut that ships to TestFlight since 11 September 2026, for the two-person experiment — is reading only: the Books and Articles shelves, the reader, the fiches, the share extension that feeds the articles, plus household and member switching. A fresh device joins a household the way the Maurice app does, with an **invite code** (`/api/auth/enroll`, then the member sets a PIN): the admin password is only for the owner. In the minimal scope there is no drawer: the library is the root and the active member's badge, alone at the leading edge of the floating chrome where ☰ used to be, opens the member/household sheet (households, members, *Add household*, *Disconnect*). Nothing is deleted; the other sections come back by flipping the value. The minimal build also drops the background-location mode and its permission strings from `project.yml`, since nothing visible uses them.

**TestFlight.** `./build-testflight.sh` at the repo root archives the `Carnet` scheme for iOS and uploads it, the same circuit as the Maurice app: marketing version from `./VERSION` (kept at `1.0.0` so external builds ship without a new beta review), build number asked of App Store Connect by `asc-build-info.ts`, automatic signing with the team's API key (set `PROVISIONING_PROFILE_IOS` to sign manually; the app and the share extension each need a profile). Bundle id `me.candide.carnet-app`, kept because the App Group shared with the share extension is named after it. The App Store Connect app record and the external tester group are console state, created by hand.

**Icon.** A bent pipe in silhouette on the same cream ground as Maurice's bowler hat — Magritte's pipe, the way Maurice's hat is Magritte's hat: *ceci n'est pas un carnet*. Generated (fal.ai) and recomposed on Maurice's background; the source is `CarnetApp/Assets.xcassets/AppIcon.appiconset/icon-ios-1024.png` — a single flat PNG, not yet the layered Icon Composer icon iOS 26 renders in glass.

## Ships vs. exists

Carnet is in daily use at home; the minimal scope is on its way to TestFlight (first 1.0.0 build pending the App Store Connect record and beta review). Its reading and garden features depend on the Calibre and garden routes of the [[maurice-server|data-api]]; the Log and Dashboards roles depend on the experimental [[maurice-life|life]] tools.

## Gaps & notes

- **No conversations, no push.** Carnet lists no conversations and registers no APNs token: a conversation [[maurice-chat|Maurice opens on his own]] (19 September 2026) reaches the Maurice app only. The domains tranche for iOS (P3-C in the domains plan) brings the domain page, the list and the notification here.
- **Flashcards** are server-side only so far; the Flashcards line on each media and the review section are the next tranche.
- **Unified navigation** across the three roles, and a refreshed design pass covering the expanded scope, are on the roadmap (`design/`).
- **Reading is iOS-only**; the Mac reads the garden on the web.
- **Liquid Glass gaps**: the app icon is still a flat PNG (Icon Composer layers pending); the full scope's custom drawer and the radial log FAB have not been re-thought for iOS 26 (a `NavigationSplitView` or a sidebar-adaptable `TabView` is the likely answer when `.full` returns); nothing has been tested with Reduce Transparency yet.
