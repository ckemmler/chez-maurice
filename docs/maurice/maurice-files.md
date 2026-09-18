---
title: The files library
date: '2026-06-19'
flags: []
locale: en
description: Per-member folders and files — text, PDF, images — organized on disk
  and attachable to a chat as real content.
tags:
- maurice
- documentation
- feature
- files
icon: folder
parent: maurice-docs
---

# The files library

A per-member document library: nestable folders and files you can keep around and hand to Maurice as context. The UI lives in the app's settings (`FilesLibraryView` in `app/Maurice/Views/SettingsView.swift`); the backend is `server/src/services/files.ts` with routes in `server/src/routes/files.ts`.

## Folders and files

Folders and files are stored flat (`folders`, `files` tables — see [[maurice-data-model]]) and the client nests them by `parent_id` into a collapsible tree. You can create folders, upload files, rename, and delete; deleting a folder cascades to its contents and unlinks the bytes from disk. Each member has a **5 GB quota**, shown as used-of-total in the library header.

- **Upload** — iOS via the system file importer (or camera); macOS via drag-and-drop onto the panel or a folder row.
- **Kinds** are detected by extension: **text** (`.md`, `.txt`, `.csv`, `.json`, `.yaml`, `.log`, `.rtf`), **image** (`.png`, `.jpg`, `.heic`, `.svg`, …), **PDF**, or a generic file.
- **Storage**: rows hold metadata; bytes live at `{dataDir}/files/{id}{ext}` and are served raw from `/api/files/{id}/raw`.

## Attaching to a chat

A file becomes context through the [[maurice-composer|composer]], and the two can happen in one gesture: pick a document in a chat and it's uploaded to the library *and* attached. How it reaches the model depends on kind:

- **Text files** become text in the system context (token-estimated like a note).
- **Binaries (PDF, image)** become real **content blocks** on the user turn — Maurice sees the actual document, not a description. They carry **no token estimate** (shown by size instead) and are de-duplicated by id across the context.

## Ships vs. exists

The files library is part of the **core chat engine and ships** — folders, uploads, quota, and attaching files to a conversation all work without any of the experimental [[maurice-tools|tools]].

## Gaps & notes

- **Browsing lives in Settings.** There's no standalone files browser in the chat view; you reach files for a turn through the composer's omnibox.
- **iOS has no drag-and-drop** — it uses the file importer and camera; drag-and-drop is macOS-only.
- **No previews or full-text search** of file contents in the library UI — files are organized and attached, not read in place.
