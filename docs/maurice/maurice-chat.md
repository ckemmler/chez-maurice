---
title: The chat experience
date: '2026-09-18'
flags: []
locale: en
description: Streaming render, tool-result data cards, math, markdown, images, dictation,
  the model switcher and the cost meter — the native chat surface.
tags:
- maurice
- documentation
- feature
- chat
- app
icon: message-circle
parent: maurice-docs
---

# The chat experience

The chat surface is native SwiftUI (`app/Maurice/Views/ChatView.swift`, with streaming in `Services/ChatService.swift`). It consumes the [[maurice-server|server's stream]] and renders it the way a thoughtful reader wants: text that arrives at a human pace, tool results you can trust, math that looks like math.

## Finding a past conversation

The sidebar's bottom bar carries a magnifier (facing the household switcher);
tapping it opens a full-width search field in its place — the iOS 26
"minimized search" idiom, drawn in our own bar and morphing on OS 26. Two
characters in and the list becomes hits — the room plus the passage that matched, matched words
bracketed — from `GET /api/conversations/search`, a **full-text search over
messages** (an FTS5 index kept in step by triggers, see [[maurice-data-model]]),
scoped to the member's own rooms and never matching a turn by someone they have
blocked. A title match counts too. Clearing the field brings the recency list
back. The [[maurice-composer|composer]]'s picker reaches into the same index.

## The conversation header and its details sheet

There is no title bar over the stream. On iPhone the header is two floating
glass groups — back on the left, "add someone" + "…" in a capsule on the right;
on iPad and macOS the same actions sit in the system toolbar (macOS with an
explicit sidebar toggle). "…" opens the **details sheet**: the title, editable —
Save sends `PATCH /api/conversations/:id` and the sidebar follows in place —
plus the metadata the old bar showed (Maurice, model, created, last message,
message count, the room's people) and the room actions (edit Maurice, review
reports for the operator, leave the room).

## Streaming

The client reads the newline-delimited `StreamEvent`s and reacts per type: `text_delta` appends to the live text, `thinking` raises a "Thinking" activity label until the first visible word (reasoning models such as GLM go quiet for a while before answering), `ping` is a server keepalive and shows nothing, `tool_call` raises a transient activity label ("Searching the web…"), `tool_data` appends a structured result, `usage` is kept for the cost meter, `done` captures the `message_id`, `error` surfaces a banner. Image generation shows a spinner while it runs, then drops the image inline.

Two touches make it feel alive rather than mechanical:

- **Variable-speed reveal** (`StreamingRow`): a 0.01s timer advances the visible text by 1–3 characters a tick, faster when the buffer is deep — roughly 100–300 chars/sec, so it reads like typing, not like a progress bar.
- **Respectful auto-scroll**: the view follows the bottom only while you're near it (within ~120pt); scroll up to re-read mid-answer and it won't yank you back; scroll back down to re-engage.

Two failure modes fixed in September 2026: deleting a thread while Maurice was still answering left the [[maurice-server|server]] running its tools for a room that no longer existed (a fragment landed in a garden fiche a minute after the delete), so the app now stops the stream before deleting; and a room that answers 404 — deleted here, or from another device — is dropped along with its socket, where before the socket reconnected with backoff forever and refetched the vanished conversation for hours.

## Tool-result data cards

When a turn calls a data-returning tool, the result rides the `tool_data` channel and renders as a **data card** (`DataCardStack`) beside the prose, titled `"{tool} · {n} rows"` (e.g. `signals · 12 rows`), capped at 50 rows with a "+ more" tail. This is deliberate: the rows are drawn **from the data the tool returned**, not from the model's retelling — so Maurice can't silently misreport what a tool found. It is the floor under tool-result hallucination. A fiche the garden tool opens comes back the same way, as a card you can act on.

## Math

LaTeX renders properly. `renderMathMarkup()` preprocesses the text *before* MarkdownUI sees it: a regex picks out `\(…\)` (inline), `\[…\]` and `$$…$$` (display), **skipping fenced and inline code**, and rewrites each into an image tag `![](maurice-math:<base64url>)`. Two providers then draw them with **SwiftMath** — `MathInlineImageProvider` in text style, `MathBlockImageProvider` in display style (falling back to monospaced source if a formula won't render).

## Markdown, code, images

Prose is **MarkdownUI** themed to the Maurice palette (code spans and blocks in `codeInk`/`codeBg`, blockquotes with a rule-coloured border, links in `ink`). Inline images use `![](/api/images/…)` rendered via `ChatImageView`. Text selection is native click-drag on macOS; on iOS a long-press on a message offers **Copy** or a **"Select text…"** sheet where a selection can span paragraphs. Each Maurice answer carries **Copy** (strips image markup, text only) and **Regenerate** (last turn only, disabled mid-stream). Photos are sized to the vision tier's ceiling before upload, in the app and again on the server. A photo reaches the composer from the camera, the photo library, or the **clipboard**: ⌘V in the field on macOS (pixels, or a copied image file), ⌘V from a hardware keyboard on iPad when the clipboard holds an image and no text, and a *Paste Image* item in the paperclip menu on both platforms, shown only while there is an image to paste.

## Dictation

Since August 2026 the composer takes **dictation**: on-device speech recognition in the member's language (any regional variant), text shown as it is spoken, inserted at the caret, listening through pauses, and a manual edit winning over the transcript. Apple's servers are used only for languages with no local model, and only if the member allows it in Settings. On iPhone the **Action Button** opens a fresh thread and starts listening (`DictateIntent`).

## Model switcher

The composer's model pill opens a Menu grouped by provider (Anthropic, OpenAI, Mistral, Z.ai, Ollama), each with its brand-coloured dot, limited to the providers the household has a key for. The choice persists onto the active Maurice — the member's everyday preference, or the persona's own `model`. See [[maurice-personas-hats]].

## The cost meter

Off by default; "Show what each reply cost" in Settings turns it on. A coin then joins the copy and regenerate controls under each of Maurice's replies, with the turn's cost and the share of the prompt served from cache beside it; tapping the coin drops down a popover with the token split, the uncached figure for comparison, the number of rounds and the model (a popover on the phone too, not a sheet, and the transcript never reflows). Local models are free; cloud models show a figure when their price is on file (Anthropic, Mistral Medium, GLM-5.3 and Flash), token counts otherwise — never a bare "$0.00" for a model nobody has priced. The data is the `usage` event the [[maurice-server|server]] emits and stores on the message.

## Platform

The app adopts **Liquid Glass** on iOS/macOS 26 (a material fallback before; the deployment target stays iOS 17 / macOS 14) through one shared helper file, `app/Maurice/Views/Glass.swift`: the composer floats over the stream as a glass panel on every platform, custom controls (icon buttons, pills, fields) are interactive glass, `.bordered` buttons take the system glass styles, and the split view's sidebar keeps the system material. This deliberately goes further than Apple's "use sparingly" guidance — glass sits on glass in the composer — and every helper can be dialled back per call site. "Reduce transparency" in Accessibility renders it all opaque. Composing context for a turn is the [[maurice-composer|context composer]].

## Ships vs. exists

The chat surface — streaming, data cards, math, markdown, images, dictation, model switching, the cost meter — is **core and ships**. Data cards will show results from any tool, but most data-returning tools are the experimental [[maurice-tools|fleet]]; with garden-only, you mostly see prose plus the occasional garden result.

## Gaps & notes

- **Image generation has no progress** — a spinner and label, not a percentage.
- **Files reach a chat only through the composer's omnibox**, not a drag onto the transcript (see [[maurice-files]]).
- **Regenerate is single-step** — it re-runs the last turn; there's no branch/alternatives history.
- **No web chat client.** The only conversational surface is the native app; the web is the garden.
