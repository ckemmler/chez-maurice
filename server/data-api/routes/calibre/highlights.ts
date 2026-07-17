import { Hono } from "hono";
import {
  listHighlights,
  createHighlight,
  updateHighlight,
  deleteHighlight,
} from "../../services/highlights";

const highlights = new Hono();

// GET /books/:bookId/highlights
highlights.get("/:bookId/highlights", (c) => {
  const memberId = c.get("userId") as string;
  if (!memberId) return c.json({ error: "Authentication required" }, 401);
  const bookId = Number(c.req.param("bookId"));
  if (Number.isNaN(bookId)) return c.json({ error: "Invalid book ID" }, 400);
  return c.json(listHighlights(memberId, bookId));
});

// POST /books/:bookId/highlights
highlights.post("/:bookId/highlights", async (c) => {
  const memberId = c.get("userId") as string;
  if (!memberId) return c.json({ error: "Authentication required" }, 401);
  const bookId = Number(c.req.param("bookId"));
  if (Number.isNaN(bookId)) return c.json({ error: "Invalid book ID" }, 400);

  const body = await c.req.json<{
    chapter_slug: string;
    quote: string;
    note?: string | null;
    color?: string;
    start_offset?: number | null;
    end_offset?: number | null;
  }>().catch(() => null);
  if (!body?.chapter_slug || !body.quote?.trim()) {
    return c.json({ error: "chapter_slug and quote required" }, 400);
  }

  const created = createHighlight(memberId, bookId, {
    chapterSlug: body.chapter_slug,
    quote: body.quote,
    note: body.note ?? null,
    color: body.color,
    startOffset: body.start_offset ?? null,
    endOffset: body.end_offset ?? null,
  });
  return c.json(created, 201);
});

// PUT /books/:bookId/highlights/:id — update note and/or colour
highlights.put("/:bookId/highlights/:id", async (c) => {
  const memberId = c.get("userId") as string;
  if (!memberId) return c.json({ error: "Authentication required" }, 401);
  const id = Number(c.req.param("id"));
  if (Number.isNaN(id)) return c.json({ error: "Invalid highlight ID" }, 400);

  const body = await c.req
    .json<{ note?: string | null; color?: string }>()
    .catch(() => ({}) as { note?: string | null; color?: string });
  const updated = updateHighlight(memberId, id, { note: body.note, color: body.color });
  if (!updated) return c.json({ error: "Highlight not found" }, 404);
  return c.json(updated);
});

// DELETE /books/:bookId/highlights/:id
highlights.delete("/:bookId/highlights/:id", (c) => {
  const memberId = c.get("userId") as string;
  if (!memberId) return c.json({ error: "Authentication required" }, 401);
  const id = Number(c.req.param("id"));
  if (Number.isNaN(id)) return c.json({ error: "Invalid highlight ID" }, 400);

  const deleted = deleteHighlight(memberId, id);
  if (!deleted) return c.json({ error: "Highlight not found" }, 404);
  return c.json({ ok: true });
});

export default highlights;
