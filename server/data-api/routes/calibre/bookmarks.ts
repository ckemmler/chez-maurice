import { Hono } from "hono";
import {
  listBookmarks,
  toggleBookmark,
  deleteBookmark,
  updateBookmarkNote,
  getReadingProgress,
  updateReadingProgress,
  toggleReadingTracking,
} from "../../services/bookmarks";

const bookmarks = new Hono();

// GET /books/:bookId/bookmarks
bookmarks.get("/:bookId/bookmarks", (c) => {
  const memberId = c.get("userId") as string;
  if (!memberId) return c.json({ error: "Authentication required" }, 401);
  const bookId = Number(c.req.param("bookId"));
  if (Number.isNaN(bookId)) return c.json({ error: "Invalid book ID" }, 400);
  return c.json(listBookmarks(memberId, bookId));
});

// POST /books/:bookId/bookmarks — toggle
bookmarks.post("/:bookId/bookmarks", async (c) => {
  const memberId = c.get("userId") as string;
  if (!memberId) return c.json({ error: "Authentication required" }, 401);
  const bookId = Number(c.req.param("bookId"));
  if (Number.isNaN(bookId)) return c.json({ error: "Invalid book ID" }, 400);

  const body = await c.req.json<{ chapter_slug: string; view?: string; note?: string }>();
  if (!body.chapter_slug) return c.json({ error: "chapter_slug required" }, 400);

  const view = body.view === "summary" ? "summary" : "full";
  const result = toggleBookmark(memberId, bookId, body.chapter_slug, view, body.note);
  return c.json(result);
});

// PUT /books/:bookId/bookmarks/:id — update note
bookmarks.put("/:bookId/bookmarks/:id", async (c) => {
  const memberId = c.get("userId") as string;
  if (!memberId) return c.json({ error: "Authentication required" }, 401);
  const id = Number(c.req.param("id"));
  if (Number.isNaN(id)) return c.json({ error: "Invalid bookmark ID" }, 400);

  const body = await c.req.json<{ note: string | null }>();
  const bookmark = updateBookmarkNote(memberId, id, body.note ?? null);
  if (!bookmark) return c.json({ error: "Bookmark not found" }, 404);
  return c.json(bookmark);
});

// DELETE /books/:bookId/bookmarks/:id
bookmarks.delete("/:bookId/bookmarks/:id", (c) => {
  const memberId = c.get("userId") as string;
  if (!memberId) return c.json({ error: "Authentication required" }, 401);
  const id = Number(c.req.param("id"));
  if (Number.isNaN(id)) return c.json({ error: "Invalid bookmark ID" }, 400);

  const deleted = deleteBookmark(memberId, id);
  if (!deleted) return c.json({ error: "Bookmark not found" }, 404);
  return c.json({ ok: true });
});

// --- Reading Progress ---

// GET /books/:bookId/reading-progress
bookmarks.get("/:bookId/reading-progress", (c) => {
  const memberId = c.get("userId") as string;
  if (!memberId) return c.json({ error: "Authentication required" }, 401);
  const bookId = Number(c.req.param("bookId"));
  if (Number.isNaN(bookId)) return c.json({ error: "Invalid book ID" }, 400);

  const progress = getReadingProgress(memberId, bookId);
  return c.json(progress);
});

// POST /books/:bookId/reading-progress/toggle
bookmarks.post("/:bookId/reading-progress/toggle", (c) => {
  const memberId = c.get("userId") as string;
  if (!memberId) return c.json({ error: "Authentication required" }, 401);
  const bookId = Number(c.req.param("bookId"));
  if (Number.isNaN(bookId)) return c.json({ error: "Invalid book ID" }, 400);

  const result = toggleReadingTracking(memberId, bookId);
  return c.json(result);
});

// POST /books/:bookId/reading-progress — record visit
bookmarks.post("/:bookId/reading-progress", async (c) => {
  const memberId = c.get("userId") as string;
  if (!memberId) return c.json({ error: "Authentication required" }, 401);
  const bookId = Number(c.req.param("bookId"));
  if (Number.isNaN(bookId)) return c.json({ error: "Invalid book ID" }, 400);

  const body = await c.req.json<{ chapter_index: number; chapter_slug: string; view?: string; position?: number }>();
  if (typeof body.chapter_index !== "number" || !body.chapter_slug) {
    return c.json({ error: "chapter_index and chapter_slug required" }, 400);
  }

  const view = body.view === "summary" ? "summary" : "full";
  const position = typeof body.position === "number" ? body.position : 0;
  const result = updateReadingProgress(memberId, bookId, body.chapter_index, body.chapter_slug, view, position);
  return c.json(result);
});

export default bookmarks;
