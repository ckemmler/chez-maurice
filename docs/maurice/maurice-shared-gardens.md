---
title: Shared gardens
date: '2026-10-15'
flags: []
locale: en
description: Per-note sharing that derives audience-keyed gardens — collaborative
  note spaces with their own web theme.
tags:
- maurice
- documentation
- feature
- gardens
- sharing
icon: sprout
parent: maurice-docs
---

# Shared gardens

Sharing in Maurice is a fact about a **note**, not a folder you put things in. From those per-note facts, *gardens* are **derived**. The service is `server/src/services/gardens.ts` (routes in `server/src/routes/gardens.ts`); the storage is two tiny tables (see [[maurice-data-model]]).

## The model: sharing is per-note, gardens are derived

A note's **audience** is its owner plus whoever it's shared with (`noteAudience()` = owner + `note_shares` rows). Each audience has a stable **key** — the member ids sorted and joined (`audienceKey()`). A "garden" is then simply *the set of notes with the same audience key*:

- Your private garden is `audienceKey([you])` — notes shared with no one.
- A shared garden is `audienceKey([you, paola])`, or `[you, a-child]`, etc. — it springs into existence the moment a note carries that audience, and needs no `gardens` table to stay in sync (`gardensFor(memberId)` groups a member's notes by audience key on the fly).

This is the same logic the [[maurice|shared-rooms]] thinking pointed at, but for notes: a garden is a *web of overlapping audiences*, not a bulletin board.

## Verbs

The routes are small and human:

- `GET /api/v1/gardens` — the gardens you tend (yours + every shared one you're in).
- `GET /api/v1/gardens/note/:owner/:slug/access` — who can see a note.
- `POST …/share` — add a member to a note's audience (`addShare`).
- `POST …/leave` — remove *yourself* from a note's audience (`removeSelf`) — you can leave a garden, you don't delete others' access.
- `PATCH /api/v1/gardens/:id` — set the garden's **web theme** (`setGardenTheme` → `garden_settings.web_theme`, keyed by audience).

In the app, the sidebar lists the gardens you tend; a garden page shows its members and the share/leave controls per note. Its entries come newest-edit first (the server sorts on each file's mtime) and a sort menu offers **Title** and **Kind** as well; the default is named in the menu, so getting back to it is never a guess.

## On the web

One engine serves every member's garden at `/g/<member>/` (see [[maurice-web-garden]]): the server names the garden, its base path and its owner's theme in headers on each request, and the engine reads the garden from disk. A member reading a note shared with them sees it inside the owner's garden, in the owner's theme.

## Ships vs. exists

Per-note sharing and derived gardens are part of the **core** server (they ship with the garden). They don't depend on the experimental [[maurice-tools|tools]].

## Gaps & notes

- **A shared garden's own theme is stored, not used.** `PATCH /api/v1/gardens/:id` writes a `web_theme` per audience, but a page is rendered in its owner's theme (the one the owner picks in the app for their private garden); nothing renders a shared audience in the theme set for it.
- **Access is grant-and-leave, not roles.** There's no notion of read-only vs. co-editor within a shared garden, and no per-garden audit of who added what — sharing is a flat allow-list per note.
- **"Earned by presence" is aspirational.** The richer idea that you join a garden by *participating* in a conversation that loads it (from the shared-rooms thinking) isn't implemented; today access is an explicit `share`.
