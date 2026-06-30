import { Hono } from "hono";
import { getChapterSummaryText, getChapterSummaryBySlug } from "../../services/calibre";

const summaries = new Hono();

summaries.get("/:bookId/chapters/:chapterIndex/summary", async (c) => {
  const bookId = Number(c.req.param("bookId"));
  const chapterIndex = Number(c.req.param("chapterIndex"));

  if (Number.isNaN(bookId) || Number.isNaN(chapterIndex)) {
    return c.json({ error: "Invalid identifiers" }, 400);
  }

  const summary = await getChapterSummaryText(bookId, chapterIndex);
  if (!summary) {
    return c.json({ error: "Chapter not found" }, 404);
  }

  return c.json(summary);
});

summaries.get("/:bookId/chapters/by-slug/:slug/summary", async (c) => {
  const bookId = Number(c.req.param("bookId"));
  const slug = c.req.param("slug");

  if (Number.isNaN(bookId)) {
    return c.json({ error: "Invalid book id" }, 400);
  }

  const summary = await getChapterSummaryBySlug(bookId, slug);
  if (!summary) {
    return c.json({ error: "Chapter not found" }, 404);
  }

  return c.json(summary);
});

export default summaries;
