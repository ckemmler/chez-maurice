import { Hono } from "hono";
import { getChapterContent, getChapterBySlug, listChapters } from "../../services/calibre";

const chapters = new Hono();

chapters.get("/:bookId/chapters", async (c) => {
  const bookId = Number(c.req.param("bookId"));
  if (Number.isNaN(bookId)) {
    return c.json({ error: "Invalid book id" }, 400);
  }

  const bookChapters = await listChapters(bookId);
  if (!bookChapters) {
    return c.json({ error: "Book not found" }, 404);
  }

  return c.json(bookChapters);
});

chapters.get("/:bookId/chapters/:chapterIndex", async (c) => {
  const bookId = Number(c.req.param("bookId"));
  const chapterIndex = Number(c.req.param("chapterIndex"));
  if (Number.isNaN(bookId) || Number.isNaN(chapterIndex)) {
    return c.json({ error: "Invalid identifiers" }, 400);
  }

  const chapter = await getChapterContent(bookId, chapterIndex);
  if (!chapter) {
    return c.json({ error: "Chapter not found" }, 404);
  }

  return c.json(chapter);
});

chapters.get("/:bookId/chapters/by-slug/:slug", async (c) => {
  const bookId = Number(c.req.param("bookId"));
  const slug = c.req.param("slug");
  if (Number.isNaN(bookId)) {
    return c.json({ error: "Invalid book id" }, 400);
  }

  const chapter = await getChapterBySlug(bookId, slug);
  if (!chapter) {
    return c.json({ error: "Chapter not found" }, 404);
  }

  return c.json(chapter);
});

export default chapters;
