/**
 * GET  /api/v1/garden/links/targets?q=… — autocomplete over the garden's entries
 * POST /api/v1/garden/links            — append a resonance (a dated block with
 *                                        a [[wiki-link]]) to a target entry
 *
 * The reading surfaces call these: highlight an article or a book chapter,
 * pick "this feeds my Sugar fiche", add a note — the markdown lands on the
 * Sugar fiche under ## Résonances. See services/gardenLinks.ts for the shape.
 */

import { Hono } from "hono";
import { gardenFor } from "../services/gardenFiche";
import {
  appendResonance,
  findBookEntryByTitle,
  GardenLinkError,
  searchLinkTargets,
  type ResonanceInput,
} from "../services/gardenLinks";

const app = new Hono();

app.get("/targets", (c) => {
  const memberId = c.get("userId") as string;
  const garden = gardenFor(memberId);
  if (!garden) return c.json({ error: "No garden for this member" }, 404);

  const q = c.req.query("q") ?? "";
  return c.json({ targets: searchLinkTargets(garden, q) });
});

app.post("/", async (c) => {
  const memberId = c.get("userId") as string;
  const garden = gardenFor(memberId);
  if (!garden) return c.json({ error: "No garden for this member" }, 404);

  let body: ResonanceInput & { source_book_title?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Body must be JSON" }, 400);
  }
  if (!body.to?.slug || !body.to?.locale) {
    return c.json({ error: "to.slug and to.locale required" }, 400);
  }

  // A Calibre-side source (a book highlight) names the book by title; when
  // that book also lives in the garden, the resonance gets a real wiki-link.
  if (!body.source && body.source_book_title) {
    const entry = findBookEntryByTitle(garden, body.source_book_title);
    body.source = {
      label: body.source_book_title,
      basename: entry ? (entry.fiche ? `${entry.slug}-fiche` : entry.slug) : undefined,
    };
  }

  try {
    return c.json(appendResonance(memberId, garden, body), 201);
  } catch (e) {
    if (e instanceof GardenLinkError) return c.json({ error: e.message }, e.status);
    console.error("[garden-links] append failed:", e);
    return c.json({ error: "Failed to write the resonance" }, 500);
  }
});

export default app;
