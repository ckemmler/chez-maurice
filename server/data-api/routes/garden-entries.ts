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
import { getShelfEntry, listShelf, siteFor } from "../services/gardenShelf";

const app = new Hono();

app.get("/entries", async (c) => {
  const memberId = c.get("userId") as string;
  const garden = gardenFor(memberId);
  if (!garden) return c.json({ error: "No garden for this member" }, 404);

  // `view=shelf` — Carnet's one list: the kinds it shows, the household's
  // books that have no entry yet, and what a row says about each (its source,
  // the member's side, the shared side). See services/gardenShelf.ts.
  if (c.req.query("view") === "shelf") {
    const { kinds, entries } = await listShelf(memberId, garden);
    return c.json({ garden: { username: garden.username, site: siteFor(memberId) }, kinds, entries });
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
  const memberId = c.get("userId") as string;
  const garden = gardenFor(memberId);
  if (!garden) return c.json({ error: "No garden for this member" }, 404);

  const { collection, locale, slug } = c.req.param();
  const entry = await getShelfEntry(memberId, garden, collection, locale, slug);
  if (!entry) return c.json({ error: "No such entry" }, 404);
  return c.json(entry);
});

export default app;
