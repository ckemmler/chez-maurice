/**
 * POST /api/v1/garden/articles       — save an article to the garden as a fiche
 * GET  /api/v1/garden/articles/lookup?url=… — is it already saved?
 *
 * The one endpoint every capture surface calls: the Carnet share sheet, the
 * browser extension, the garden MCP tool. Auth is the member bearer token that
 * index.ts already requires on every /api/v1/* route, so the fiche lands in
 * *that member's* garden — which the older /api/v1/articles/scrape never did.
 */

import { Hono } from "hono";
import {
  ArticleSaveError,
  findArticleFiche,
  saveArticleFiche,
  type SaveArticleInput,
} from "../services/gardenArticles";
import { gardenFor } from "../services/gardenFiche";
import {
  findArticleBySlug,
  scheduleArticleSummary,
  summarizeAndStore,
} from "../services/articleSummary";

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

export default app;
