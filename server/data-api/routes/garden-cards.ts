/**
 * Flashcards — the third face of a garden entry.
 *
 * GET  /api/v1/garden/cards/due                       — every due card, across the garden
 * GET  /api/v1/garden/cards/entry?collection&locale&slug — the entry's card files, with staleness
 * GET  /api/v1/garden/cards/file?path=…               — one card file: metadata, cards, raw body
 * PUT  /api/v1/garden/cards/file                      — replace a card file's body (edit)
 * POST /api/v1/garden/cards/generate                  — make (or remake) the cards of a source
 * POST /api/v1/garden/cards/review                    — record one answer on one card
 *
 * Files are in the Obsidian Spaced Repetition plugin's syntax and git-ignored
 * — see services/flashcards.ts.
 */

import { Hono } from "hono";
import { gardenFor } from "../services/gardenFiche";
import { listGardenEntries } from "../services/gardenEntries";
import {
  CARD_MODES,
  FlashcardError,
  generateCards,
  listCardFiles,
  listDueCards,
  parseSource,
  readCardFile,
  reviewCard,
  saveCardFileBody,
  type CardMode,
  type Rating,
} from "../services/flashcards";

const app = new Hono();

function fail(c: any, e: unknown, what: string) {
  if (e instanceof FlashcardError) return c.json({ error: e.message }, e.status);
  console.error(`[garden-cards] ${what} failed:`, e);
  return c.json({ error: `Failed to ${what}` }, 500);
}

app.get("/due", (c) => {
  const memberId = c.get("userId") as string;
  const garden = gardenFor(memberId);
  if (!garden) return c.json({ error: "No garden for this member" }, 404);
  const cards = listDueCards(garden);
  return c.json({ cards, count: cards.length });
});

app.get("/entry", async (c) => {
  const memberId = c.get("userId") as string;
  const garden = gardenFor(memberId);
  if (!garden) return c.json({ error: "No garden for this member" }, 404);

  const collection = c.req.query("collection"), locale = c.req.query("locale"), slug = c.req.query("slug");
  if (!collection || !locale || !slug) return c.json({ error: "collection, locale and slug are required" }, 400);
  const entry = listGardenEntries(garden).find(
    (e) => e.collection === collection && e.locale === locale && e.slug === slug,
  );
  if (!entry) return c.json({ error: "No such entry" }, 404);

  try {
    return c.json({ entry: { collection, locale, slug, title: entry.title }, files: await listCardFiles(memberId, garden, entry) });
  } catch (e) {
    return fail(c, e, "list the cards");
  }
});

app.get("/file", (c) => {
  const memberId = c.get("userId") as string;
  const garden = gardenFor(memberId);
  if (!garden) return c.json({ error: "No garden for this member" }, 404);
  const rel = c.req.query("path");
  if (!rel) return c.json({ error: "path is required" }, 400);
  try {
    return c.json(readCardFile(garden, rel));
  } catch (e) {
    return fail(c, e, "read the card file");
  }
});

app.put("/file", async (c) => {
  const memberId = c.get("userId") as string;
  const garden = gardenFor(memberId);
  if (!garden) return c.json({ error: "No garden for this member" }, 404);
  let body: { path?: string; body?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Body must be JSON" }, 400);
  }
  if (!body.path || typeof body.body !== "string") return c.json({ error: "path and body are required" }, 400);
  try {
    return c.json(saveCardFileBody(garden, body.path, body.body));
  } catch (e) {
    return fail(c, e, "save the card file");
  }
});

app.post("/generate", async (c) => {
  const memberId = c.get("userId") as string;
  let body: { source?: unknown; lang?: string; answer_lang?: string; mode?: string; count?: number; hint?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Body must be JSON" }, 400);
  }
  if (body.mode && !CARD_MODES.includes(body.mode as CardMode)) {
    return c.json({ error: `mode must be one of: ${CARD_MODES.join(", ")}` }, 400);
  }
  try {
    const source = parseSource(body.source);
    const file = await generateCards(memberId, source, {
      lang: body.lang,
      answer_lang: body.answer_lang,
      mode: body.mode as CardMode | undefined,
      count: body.count,
      hint: body.hint,
    });
    return c.json(file, 201);
  } catch (e) {
    return fail(c, e, "generate the cards");
  }
});

app.post("/review", async (c) => {
  const memberId = c.get("userId") as string;
  const garden = gardenFor(memberId);
  if (!garden) return c.json({ error: "No garden for this member" }, 404);
  let body: { path?: string; card_id?: string; rating?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Body must be JSON" }, 400);
  }
  if (!body.path || !body.card_id) return c.json({ error: "path and card_id are required" }, 400);
  if (body.rating !== "hard" && body.rating !== "good" && body.rating !== "easy") {
    return c.json({ error: "rating must be hard, good or easy" }, 400);
  }
  try {
    return c.json(reviewCard(garden, body.path, body.card_id, body.rating as Rating));
  } catch (e) {
    return fail(c, e, "record the review");
  }
});

export default app;
