/**
 * GET /api/v1/garden/entries — every entry in the member's garden, all
 * collections, newest first. The Carnet Garden section's list: it filters by
 * collection client-side and opens each face in the browser or an editor, so
 * one request returning everything beats a per-collection API for a tree this
 * size (hundreds of files).
 */

import { Hono } from "hono";
import { gardenFor } from "../services/gardenFiche";
import { GARDEN_COLLECTIONS, listGardenEntries } from "../services/gardenEntries";
import { cardsFace } from "../services/flashcards";
import { getShelfEntry, listNotes, listShelf, siteFor } from "../services/gardenShelf";
import {
  addNote, archiveEntry, completeCard, completeCover, deleteEntry, setCover, deployState, entryForBook, EntryWriteError, setPublished, writeShared, type EntryRef,
} from "../services/gardenWrite";

import {
  dropShares, EntryShareError, isSharedWith, memberBrief, memberBriefByUsername, shareEntry, unshareEntry,
} from "../services/entryShares";

const app = new Hono();

// A member an entry is shared with reads it and adds notes to it: the two
// routes that take `?owner=`. Every other write is on the caller's own garden
// — and must not land there by accident when the request named someone else's
// entry: the same slug may exist in both.
app.use("/entries/*", async (c, next) => {
  const named = (c.req.query("owner") ?? "").trim().replace(/^@/, "");
  if (!named || c.req.method === "GET") return next();
  const mine = memberBrief(c.get("userId") as string)?.username;
  const allowed = /\/notes$|\/participants\/[^/]+$/.test(c.req.path);
  if (named !== mine && !allowed) return c.json({ error: "Only the owner changes this" }, 403);
  return next();
});

/**
 * Whose garden a request reads: the member's own, or — `?owner=<username>` —
 * that of a member who shared this entry with them. An entry that is not
 * shared with the caller does not exist as far as they are told.
 */
function reach(c: any): { memberId: string; ownerId: string; garden: NonNullable<ReturnType<typeof gardenFor>> } | null {
  const memberId = c.get("userId") as string;
  const named = (c.req.query("owner") ?? "").trim().replace(/^@/, "");
  const owner = named ? memberBriefByUsername(named) : null;
  if (named && !owner) return null;
  const ownerId = owner?.id ?? memberId;
  if (ownerId !== memberId) {
    const { collection, locale, slug } = c.req.param();
    if (!isSharedWith(memberId, { owner_id: ownerId, collection, locale, slug })) return null;
  }
  const garden = gardenFor(ownerId);
  return garden ? { memberId, ownerId, garden } : null;
}

app.get("/entries", async (c) => {
  const memberId = c.get("userId") as string;
  const garden = gardenFor(memberId);
  if (!garden) return c.json({ error: "No garden for this member" }, 404);

  // `view=shelf` — Carnet's one list: the kinds it shows, the household's
  // books that have no entry yet, and what a row says about each (its source,
  // the member's side, the shared side). See services/gardenShelf.ts.
  if (c.req.query("view") === "shelf") {
    // `archived=1` is the other half: what the member put away, and only that.
    const { kinds, entries } = await listShelf(memberId, garden, undefined, c.req.query("archived") === "1");
    return c.json({ garden: { username: garden.username, site: siteFor(memberId) }, kinds, entries });
  }

  // `view=notes` — every note the member wrote, whatever the entry, newest
  // first, with the rows of the entries they are on.
  if (c.req.query("view") === "notes") {
    return c.json(await listNotes(memberId, garden));
  }

  // Each entry with its flashcard face — counts read off the card files, no
  // source re-read (staleness is the per-entry cards endpoint's job).
  const entries = listGardenEntries(garden).map((e) => ({
    ...e,
    cards: e.fiche ? cardsFace(garden, e.fiche.file) : null,
  }));
  return c.json({
    garden: {
      username: garden.username,
      collections: GARDEN_COLLECTIONS,
    },
    entries,
  });
});

/** One entry with both faces in full — the page the list opens. */
app.get("/entries/:collection/:locale/:slug", async (c) => {
  const at = reach(c);
  if (!at) return c.json({ error: "No such entry" }, 404);

  const { collection, locale, slug } = c.req.param();
  const entry = await getShelfEntry(at.memberId, at.garden, collection, locale, slug, undefined, at.ownerId);
  if (!entry) return c.json({ error: "No such entry" }, 404);
  return c.json(entry);
});

// ── Sharing (services/entryShares.ts) ──

/** Share the entry with a member of the household: `{ member_id }` or `{ username }`. The owner's to do. */
app.post("/entries/:collection/:locale/:slug/participants", async (c) => {
  const memberId = c.get("userId") as string;
  const garden = gardenFor(memberId);
  if (!garden) return c.json({ error: "No garden for this member" }, 404);
  const body = await jsonBody(c);
  const target = body?.member_id ? memberBrief(String(body.member_id))
    : body?.username ? memberBriefByUsername(String(body.username)) : null;
  if (!target) return c.json({ error: "Unknown member" }, 404);

  const { collection, locale, slug } = c.req.param();
  if (!(await getShelfEntry(memberId, garden, collection, locale, slug))) {
    return c.json({ error: "No such entry" }, 404);
  }
  try {
    shareEntry({ owner_id: memberId, collection, locale, slug }, target.id);
  } catch (e) {
    if (e instanceof EntryShareError) return c.json({ error: e.message }, e.status);
    throw e;
  }
  return c.json(await getShelfEntry(memberId, garden, collection, locale, slug), 201);
});

/**
 * Take a member off the entry. The owner removes whom they will; a member the
 * entry is shared with (`?owner=`) may only take themselves off.
 */
app.delete("/entries/:collection/:locale/:slug/participants/:memberId", async (c) => {
  const at = reach(c);
  if (!at) return c.json({ error: "No such entry" }, 404);
  const { collection, locale, slug, memberId: target } = c.req.param();
  if (at.ownerId !== at.memberId && target !== at.memberId) {
    return c.json({ error: "Only the owner removes someone else" }, 403);
  }
  unshareEntry({ owner_id: at.ownerId, collection, locale, slug }, target);
  if (at.ownerId !== at.memberId) return c.json({ ok: true });
  return c.json(await getShelfEntry(at.memberId, at.garden, collection, locale, slug));
});

// ── Writing (services/gardenWrite.ts) ──

/** Run a write, answer with the entry as it now reads. */
async function written(c: any, ref: EntryRef | null, work: (memberId: string, garden: any, ref: EntryRef) => unknown) {
  const memberId = c.get("userId") as string;
  const garden = gardenFor(memberId);
  if (!garden) return c.json({ error: "No garden for this member" }, 404);
  try {
    const target = ref ?? (c.req.param() as EntryRef);
    const extra = await work(memberId, garden, target);
    const entry = await getShelfEntry(memberId, garden, target.collection, target.locale, target.slug);
    return c.json({ ...entry, ...(extra ? { deploy: extra } : {}) }, extra ? 202 : 201);
  } catch (e) {
    if (e instanceof EntryWriteError) return c.json({ error: e.message }, e.status);
    if (e instanceof Error && /^invalid (slug|locale)/.test(e.message)) return c.json({ error: e.message }, 400);
    console.error("[garden-entries] write failed:", e);
    return c.json({ error: "Failed to write" }, 500);
  }
}

async function jsonBody(c: any): Promise<Record<string, any> | null> {
  try {
    const body = await c.req.json();
    return body && typeof body === "object" ? body : null;
  } catch {
    return null;
  }
}

/** A note on the member's side: one dated block under `## Commentaire`. */
app.post("/entries/:collection/:locale/:slug/notes", async (c) => {
  const body = await jsonBody(c);
  if (!body) return c.json({ error: "Body must be JSON" }, 400);

  // On an entry someone shared with the caller: the note goes on the owner's
  // fiche, signed. It is the one thing a member writes there.
  const at = reach(c);
  if (!at) return c.json({ error: "No such entry" }, 404);
  if (at.ownerId !== at.memberId) {
    const ref = c.req.param() as EntryRef;
    const author = memberBrief(at.memberId)?.username;
    try {
      const before = await getShelfEntry(at.memberId, at.garden, ref.collection, ref.locale, ref.slug, undefined, at.ownerId);
      const bookId = before?.source?.type === "book" ? before.source.book_id : null;
      // Filed and indexed in the owner's garden, under the owner's name.
      addNote(at.ownerId, at.garden, ref, { text: body.text, quote: body.quote, where: body.where, author }, bookId);
      const entry = await getShelfEntry(at.memberId, at.garden, ref.collection, ref.locale, ref.slug, undefined, at.ownerId);
      return c.json(entry, 201);
    } catch (e) {
      if (e instanceof EntryWriteError) return c.json({ error: e.message }, e.status);
      if (e instanceof Error && /^invalid (slug|locale)/.test(e.message)) return c.json({ error: e.message }, 400);
      console.error("[garden-entries] shared note failed:", e);
      return c.json({ error: "Failed to write" }, 500);
    }
  }

  return written(c, null, async (memberId, garden, ref) => {
    // The book the shelf matched by title, so the first write can record it.
    const before = await getShelfEntry(memberId, garden, ref.collection, ref.locale, ref.slug);
    const bookId = before?.source?.type === "book" ? before.source.book_id : null;
    addNote(memberId, garden, ref, { text: body.text, quote: body.quote, where: body.where }, bookId);
  });
});

/** The same, on a book of the library that has no entry yet: the fiche is made first. */
app.post("/entries/from-book", async (c) => {
  const memberId = c.get("userId") as string;
  const garden = gardenFor(memberId);
  if (!garden) return c.json({ error: "No garden for this member" }, 404);
  const body = await jsonBody(c);
  const bookId = Number(body?.book_id);
  if (!body || !Number.isInteger(bookId)) return c.json({ error: "book_id required" }, 400);
  let ref: EntryRef;
  try {
    ref = await entryForBook(memberId, garden, bookId, body.locale);
  } catch (e) {
    if (e instanceof EntryWriteError) return c.json({ error: e.message }, e.status);
    throw e;
  }
  const hasNote = String(body.text ?? "").trim() || String(body.quote ?? "").trim();
  return written(c, ref, (m, g, r) => {
    if (hasNote) addNote(m, g, r, { text: body.text, quote: body.quote, where: body.where }, bookId);
  });
});

/** The shared side: the body of the card, a draft until published. */
app.put("/entries/:collection/:locale/:slug/shared", async (c) => {
  const body = await jsonBody(c);
  if (!body || typeof body.body !== "string") return c.json({ error: "body required" }, 400);
  return written(c, null, async (memberId, garden, ref) => {
    const before = await getShelfEntry(memberId, garden, ref.collection, ref.locale, ref.slug);
    writeShared(memberId, garden, ref, { body: body.body, title: body.title });
    // A card that was just made gets its cover too, which is a fetch and so
    // not writeShared's to do. A failure there leaves a card without a cover.
    if (!before?.shared) await completeCard(memberId, garden, ref).catch(() => {});
  });
});

/**
 * Complete the card from the fiche's metadata: the fields of its kind it
 * lacks, and its cover. What is asked for when an entry shows without them.
 */
app.post("/entries/:collection/:locale/:slug/details", (c) =>
  written(c, null, async (memberId, garden, ref) => {
    // The same request for every kind and every shape of entry: a cover for
    // one that has none, whatever faces it has; then the card's own fields,
    // when there is a card.
    await completeCover(memberId, garden, ref);
    await completeCard(memberId, garden, ref);
  }));

/** Publish: the `public` flag, then a deploy of the member's site. */
app.post("/entries/:collection/:locale/:slug/shared/publish", (c) =>
  written(c, null, (memberId, garden, ref) => setPublished(memberId, garden, ref, true)));

app.delete("/entries/:collection/:locale/:slug/shared/publish", (c) =>
  written(c, null, (memberId, garden, ref) => setPublished(memberId, garden, ref, false)));

/**
 * The entry's cover, brought by the member's device: the body is the picture
 * (JPEG or PNG). For what the server could not fetch one for — a site that
 * refuses anything but a browser, read on the phone by the system's link
 * preview.
 */
app.put("/entries/:collection/:locale/:slug/cover", (c) =>
  written(c, null, async (memberId, garden, ref) => {
    setCover(memberId, garden, ref, new Uint8Array(await c.req.arrayBuffer()));
  }));

/**
 * Delete an entry: both faces, in every locale of the subject. Answers with
 * the shelf ids that are gone, and a deploy when one of them was online.
 */
app.delete("/entries/:collection/:locale/:slug", (c) => {
  const memberId = c.get("userId") as string;
  const garden = gardenFor(memberId);
  if (!garden) return c.json({ error: "No garden for this member" }, 404);
  try {
    const { deleted, deploy } = deleteEntry(memberId, garden, c.req.param() as EntryRef);
    dropShares(memberId, deleted);
    return c.json({ deleted, ...(deploy ? { deploy } : {}) }, deploy ? 202 : 200);
  } catch (e) {
    if (e instanceof EntryWriteError) return c.json({ error: e.message }, e.status);
    if (e instanceof Error && /^invalid (slug|locale)/.test(e.message)) return c.json({ error: e.message }, 400);
    console.error("[garden-entries] delete failed:", e);
    return c.json({ error: "Failed to delete" }, 500);
  }
});

/**
 * Put an entry away from the list, or bring it back: `{ id, archived }`, the
 * id as the list gives it (it holds slashes, hence the body). Nothing in the
 * garden changes.
 */
app.post("/entries/archive", async (c) => {
  const memberId = c.get("userId") as string;
  const garden = gardenFor(memberId);
  if (!garden) return c.json({ error: "No garden for this member" }, 404);
  const body = await jsonBody(c);
  if (!body || typeof body.id !== "string" || typeof body.archived !== "boolean") {
    return c.json({ error: "id and archived required" }, 400);
  }
  try {
    return c.json({ ids: archiveEntry(memberId, garden, body.id, body.archived), archived: body.archived });
  } catch (e) {
    if (e instanceof EntryWriteError) return c.json({ error: e.message }, e.status);
    if (e instanceof Error && /^invalid (slug|locale)/.test(e.message)) return c.json({ error: e.message }, 400);
    throw e;
  }
});

/** Where the site deploy stands — what the phone shows after "Publish". */
app.get("/site/deploy", (c) => {
  const garden = gardenFor(c.get("userId") as string);
  if (!garden) return c.json({ error: "No garden for this member" }, 404);
  return c.json(deployState(garden.username));
});

export default app;
