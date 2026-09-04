/**
 * POST /api/v1/garden/articles       — save an article to the garden as a fiche
 * GET  /api/v1/garden/articles       — list every saved article, newest first
 * GET  /api/v1/garden/articles/lookup?url=… — is it already saved?
 * GET  /api/v1/garden/articles/:slug        — one article's metadata + body
 * GET  /api/v1/garden/articles/:slug/text   — the captured full text
 * CRUD /api/v1/garden/articles/:slug/highlights — passage highlights
 *
 * The one endpoint every capture surface calls: the Carnet share sheet, the
 * browser extension, the garden MCP tool. Auth is the member bearer token that
 * index.ts already requires on every /api/v1/* route, so the fiche lands in
 * *that member's* garden — which the older /api/v1/articles/scrape never did.
 * The GETs are the other half of the loop: the Carnet reading section pulls
 * the same fiches back to read them in place.
 */

import { Hono } from "hono";
import {
  ArticleSaveError,
  describeArticle,
  findArticleFiche,
  listArticles,
  readArticleBody,
  saveArticleFiche,
  type SaveArticleInput,
} from "../services/gardenArticles";
import { gardenFor } from "../services/gardenFiche";
import {
  findArticleBySlug,
  readFullText,
  scheduleArticleSummary,
  summarizeAndStore,
} from "../services/articleSummary";
import { asHighlightView, HIGHLIGHT_VIEWS } from "../services/highlights";
import {
  countArticleHighlights,
  createArticleHighlight,
  deleteArticleHighlight,
  listArticleHighlights,
  updateArticleHighlight,
} from "../services/articleHighlights";

const app = new Hono();

/** Cap the supplied DOM before it reaches the parser. */
const MAX_HTML_BYTES = 8 * 1024 * 1024;

app.post("/", async (c) => {
  const memberId = c.get("userId") as string;

  let body: SaveArticleInput;
  try {
    body = await c.req.json<SaveArticleInput>();
  } catch {
    return c.json({ error: "Body must be JSON" }, 400);
  }

  if (typeof body.html === "string" && body.html.length > MAX_HTML_BYTES) {
    return c.json({ error: "html exceeds the size limit" }, 413);
  }

  try {
    const result = await saveArticleFiche(memberId, body);
    // Answer now, summarise after. A share sheet has to close immediately, and
    // the summary is worth several seconds we are not going to make it wait.
    //
    // Never for a bookmark: it has no text, so the summariser would fall back to
    // fetching the URL — the very call that just refused us, which is why the
    // bookmark exists.
    if (!result.duplicate && !result.needs_capture) scheduleArticleSummary(memberId, result);
    return c.json(result, result.duplicate ? 200 : 201);
  } catch (e) {
    if (e instanceof ArticleSaveError) return c.json({ error: e.message }, e.status);
    console.error("[garden-articles] save failed:", e);
    return c.json({ error: "Failed to save the article" }, 500);
  }
});

app.get("/", (c) => {
  const memberId = c.get("userId") as string;
  const garden = gardenFor(memberId);
  if (!garden) return c.json({ error: "No garden for this member" }, 404);

  // Highlight counts ride along so the list can badge rows without N requests.
  const counts = countArticleHighlights(memberId);
  const articles = listArticles(garden).map((a) => ({
    ...a,
    file: undefined, // absolute server path — not the client's business
    highlight_count: counts.get(`${a.locale}/${a.slug}`) ?? 0,
  }));
  return c.json({ articles });
});

app.get("/lookup", (c) => {
  const memberId = c.get("userId") as string;
  const url = c.req.query("url");
  if (!url) return c.json({ error: "url is required" }, 400);

  const garden = gardenFor(memberId);
  if (!garden) return c.json({ error: "No garden for this member" }, 404);

  const found = findArticleFiche(garden, url);
  return c.json({ saved: !!found, article: found });
});

/**
 * Generate (or regenerate) the summary now and wait for it.
 *
 * The save path schedules this in the background; this route is how you retry
 * one that failed, or fill in an article saved before summaries existed.
 */
app.post("/:slug/summary", async (c) => {
  const memberId = c.get("userId") as string;
  const slug = c.req.param("slug");

  let body: { locale?: string; force?: boolean } = {};
  try {
    if (c.req.header("content-type")?.includes("json")) body = await c.req.json();
  } catch {
    return c.json({ error: "Body must be JSON" }, 400);
  }

  try {
    const ref = findArticleBySlug(memberId, slug, body.locale);
    const { summary, regenerated } = await summarizeAndStore(memberId, ref, { force: body.force });
    return c.json({ slug: ref.slug, locale: ref.locale, summary, regenerated });
  } catch (e) {
    if (e instanceof ArticleSaveError) return c.json({ error: e.message }, e.status);
    console.error("[garden-articles] summary failed:", e);
    return c.json({ error: `Failed to summarise: ${(e as Error).message}` }, 502);
  }
});

// One article — everything the fiche knows, plus its markdown body (the lead
// quote and the comment history). `?locale=` disambiguates the rare slug that
// exists under two locales; without it the first match wins, as in the
// summary route below.
app.get("/:slug", (c) => {
  const memberId = c.get("userId") as string;
  const garden = gardenFor(memberId);
  if (!garden) return c.json({ error: "No garden for this member" }, 404);

  try {
    const ref = findArticleBySlug(memberId, c.req.param("slug"), c.req.query("locale"));
    const described = describeArticle(garden, ref);
    return c.json({ ...described, file: undefined, body: readArticleBody(ref) });
  } catch (e) {
    if (e instanceof ArticleSaveError) return c.json({ error: e.message }, e.status);
    throw e;
  }
});

// The captured full text — what the fragment holds. 404 when the save never
// got the page (a bookmark), so the app can tell "not captured" from "empty".
app.get("/:slug/text", (c) => {
  const memberId = c.get("userId") as string;

  try {
    const ref = findArticleBySlug(memberId, c.req.param("slug"), c.req.query("locale"));
    const text = readFullText(ref.file);
    if (!text) return c.json({ error: "No captured text for this article" }, 404);
    return c.json({ slug: ref.slug, locale: ref.locale, title: ref.title, text });
  } catch (e) {
    if (e instanceof ArticleSaveError) return c.json({ error: e.message }, e.status);
    throw e;
  }
});

// ── Highlights ──
//
// Same API shape as the book highlights under /api/v1/calibre/books, with the
// fiche's locale+slug standing in for book_id+chapter_slug. The slug is
// resolved to a fiche first, so a highlight can't be filed under an article
// that doesn't exist — and so the stored locale is the fiche's, not a guess.

app.get("/:slug/highlights", (c) => {
  const memberId = c.get("userId") as string;
  try {
    const ref = findArticleBySlug(memberId, c.req.param("slug"), c.req.query("locale"));
    return c.json(listArticleHighlights(memberId, ref.locale, ref.slug));
  } catch (e) {
    if (e instanceof ArticleSaveError) return c.json({ error: e.message }, e.status);
    throw e;
  }
});

app.post("/:slug/highlights", async (c) => {
  const memberId = c.get("userId") as string;

  const body = await c.req.json<{
    quote: string;
    note?: string | null;
    color?: string;
    start_offset?: number | null;
    end_offset?: number | null;
    view?: string;
    locale?: string;
  }>().catch(() => null);
  if (!body?.quote?.trim()) return c.json({ error: "quote required" }, 400);
  if (body.view && !HIGHLIGHT_VIEWS.includes(body.view as any)) {
    return c.json({ error: `view must be one of: ${HIGHLIGHT_VIEWS.join(", ")}` }, 400);
  }

  try {
    const ref = findArticleBySlug(memberId, c.req.param("slug"), body.locale);
    const created = createArticleHighlight(memberId, ref.locale, ref.slug, {
      quote: body.quote,
      note: body.note ?? null,
      color: body.color,
      startOffset: body.start_offset ?? null,
      endOffset: body.end_offset ?? null,
      view: asHighlightView(body.view),
    });
    return c.json(created, 201);
  } catch (e) {
    if (e instanceof ArticleSaveError) return c.json({ error: e.message }, e.status);
    throw e;
  }
});

app.put("/:slug/highlights/:id", async (c) => {
  const memberId = c.get("userId") as string;
  const id = Number(c.req.param("id"));
  if (Number.isNaN(id)) return c.json({ error: "Invalid highlight ID" }, 400);

  const body = await c.req
    .json<{ note?: string | null; color?: string }>()
    .catch(() => ({}) as { note?: string | null; color?: string });
  const updated = updateArticleHighlight(memberId, id, { note: body.note, color: body.color });
  if (!updated) return c.json({ error: "Highlight not found" }, 404);
  return c.json(updated);
});

app.delete("/:slug/highlights/:id", (c) => {
  const memberId = c.get("userId") as string;
  const id = Number(c.req.param("id"));
  if (Number.isNaN(id)) return c.json({ error: "Invalid highlight ID" }, 400);

  const deleted = deleteArticleHighlight(memberId, id);
  if (!deleted) return c.json({ error: "Highlight not found" }, 404);
  return c.json({ ok: true });
});

export default app;
