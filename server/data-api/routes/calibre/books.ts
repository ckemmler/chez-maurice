import { Hono } from "hono";
import { getBookMetadata, getChapterStats, getCoverFile, listBooks, listChapters, searchBooksByTags } from "../../services/calibre";
import { renderBookBrowserArtifact } from "../../services/calibreArtifact";

const books = new Hono();

books.get("/", async (c) => {
  const allBooks = listBooks();
  const stats = await Promise.all(allBooks.map((b) => getChapterStats(b.bookPath)));
  return c.json({
    books: allBooks.map((b, i) => ({
      id: b.id,
      title: b.title,
      authors: b.authors,
      tags: b.tags,
      formats: b.formats,
      series: b.series,
      chapters: stats[i].chapters,
      summarized: stats[i].summarized,
      indexed: stats[i].indexed,
    })),
  });
});

books.get("/search", async (c) => {
  const tagsParam = c.req.query("tags");
  if (!tagsParam) {
    return c.json({ error: "tags query parameter required" }, 400);
  }
  const tags = tagsParam.split(",").map((t) => t.trim()).filter(Boolean);
  const results = searchBooksByTags(tags);
  return c.json({
    books: results.map((b) => ({
      id: b.id,
      title: b.title,
      authors: b.authors,
      tags: b.tags,
      series: b.series,
    })),
  });
});

books.get("/:bookId/cover", async (c) => {
  const bookId = Number(c.req.param("bookId"));
  if (Number.isNaN(bookId)) return c.json({ error: "Invalid book id" }, 400);
  const file = await getCoverFile(bookId);
  if (!file) return c.json({ error: "No cover" }, 404);
  return new Response(Bun.file(file), {
    headers: { "Cache-Control": "public, max-age=86400" },
  });
});

books.get("/:bookId/metadata", async (c) => {
  const bookId = Number(c.req.param("bookId"));
  if (Number.isNaN(bookId)) {
    return c.json({ error: "Invalid book id" }, 400);
  }

  const metadata = await getBookMetadata(bookId);
  if (!metadata) {
    return c.json({ error: "Book not found" }, 404);
  }

  return c.json({
    id: metadata.id,
    title: metadata.title,
    authors: metadata.authors,
    tags: metadata.tags,
    formats: metadata.formats,
    series: metadata.series,
    description: metadata.description,
  });
});

books.get("/:bookId/browser", async (c) => {
  const bookId = Number(c.req.param("bookId"));
  if (Number.isNaN(bookId)) {
    return c.json({ error: "Invalid book id" }, 400);
  }

  const apiKey = c.req.query("api_key") ?? c.req.header("x-api-key");
  if (!apiKey) {
    return c.json({ error: "API key required" }, 401);
  }

  const metadata = await getBookMetadata(bookId);
  if (!metadata) {
    return c.json({ error: "Book not found" }, 404);
  }

  const chapters = await listChapters(bookId);
  if (!chapters || chapters.length === 0) {
    return c.json({ error: "No chapter data available" }, 404);
  }

  const apiBaseUrl = deriveApiBaseUrl(new URL(c.req.url));

  try {
    const html = await renderBookBrowserArtifact({
      book: metadata,
      chapters,
      apiBaseUrl,
      apiKey,
      bookId,
    });
    return c.html(html);
  } catch (error) {
    console.error("Failed to render book browser", error);
    return c.json({ error: "Failed to render artifact" }, 500);
  }
});

function deriveApiBaseUrl(url: URL): string {
  const configured = process.env.CALIBRE_ARTIFACT_BASE_URL;
  if (configured) {
    return configured.replace(/\/$/, "");
  }

  const pathname = url.pathname;
  const apiIndex = pathname.indexOf("/api/");
  const prefix = apiIndex === -1 ? "" : pathname.slice(0, apiIndex);
  const origin = `${url.protocol}//${url.host}`;
  return `${origin}${prefix}`.replace(/\/$/, "");
}

export default books;
