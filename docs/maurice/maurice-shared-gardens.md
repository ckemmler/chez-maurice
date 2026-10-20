---
title: Shared notes
date: '2026-10-20'
flags: []
locale: en
description: Per-note sharing, from which each audience's shared notes are derived —
  collaborative note spaces with their own web theme.
tags:
- maurice
- documentation
- feature
- gardens
- sharing
icon: sprout
parent: maurice-docs
---

# Shared notes

Sharing in Maurice is a fact about a **note**, not a folder you put things in. From those per-note facts, each audience's set of notes is **derived** — what the interface lists under *Notes*: *My notes*, then one entry per group of people you share notes with (*You & Paola / notes*). In the code each such set is a *garden*. The service is `server/src/services/gardens.ts` (routes in `server/src/routes/gardens.ts`); the storage is two tiny tables (see [[maurice-data-model]]).

## The model: sharing is per-note, the sets are derived

A note's **audience** is its owner plus whoever it's shared with (`noteAudience()` = owner + `note_shares` rows). Each audience has a stable **key** — the member ids sorted and joined (`audienceKey()`). A set of shared notes is then simply *the notes with the same audience key*:

- Your own notes are `audienceKey([you])` — notes shared with no one.
- The notes you share with Paola are `audienceKey([you, paola])`, or `[you, a-child]`, etc. — the set exists the moment a note carries that audience, and needs no `gardens` table to stay in sync (`gardensFor(memberId)` groups a member's notes by audience key on the fly).

This is the same logic the [[maurice|shared-rooms]] thinking pointed at, but for notes: shared notes are a *web of overlapping audiences*, not a bulletin board.

## Verbs

The routes are small and human:

- `GET /api/v1/gardens` — the sets of notes you belong to (your own + every shared one you're in).
- `GET /api/v1/gardens/note/:owner/:slug/access` — who can see a note.
- `POST …/share` — add a member to a note's audience (`addShare`).
- `POST …/leave` — remove *yourself* from a note's audience (`removeSelf`) — you can leave shared notes, you don't delete others' access.
- `PATCH /api/v1/gardens/:id` — set the shared notes' **web theme** (`setGardenTheme` → `garden_settings.web_theme`, keyed by audience).

In the app, the sidebar's *Notes* section lists your own notes and every set you share; a set's page shows its members and the share/leave controls per note. Its entries come newest-edit first (the server sorts on each file's mtime) and a sort menu offers **Title** and **Kind** as well; the default is named in the menu, so getting back to it is never a guess. Sharing a note with someone moves it among the notes you keep together; the note's page says where it is (*in the notes you keep with Paola*, *in your own notes*).

## On the web

One engine serves every member's site at `/g/<member>/` (see [[maurice-web-garden]]): the server names the member, the base path and the owner's theme in headers on each request, and the engine reads the member's notes from disk. A member reading a note shared with them sees it inside the owner's site, in the owner's theme.

## Ships vs. exists

Per-note sharing and the derived shared notes are part of the **core** server (they ship with the notes). They don't depend on the experimental [[maurice-tools|tools]].

## Gaps & notes

- **Shared notes' own theme is stored, not used.** `PATCH /api/v1/gardens/:id` writes a `web_theme` per audience, but a page is rendered in its owner's theme (the one the owner picks in the app for their own site); nothing renders a shared audience in the theme set for it.
- **Access is grant-and-leave, not roles.** There's no notion of read-only vs. co-editor within shared notes, and no per-audience audit of who added what — sharing is a flat allow-list per note.
- **"Earned by presence" is aspirational.** The richer idea that you join shared notes by *participating* in a conversation that loads them (from the shared-rooms thinking) isn't implemented; today access is an explicit `share`.
