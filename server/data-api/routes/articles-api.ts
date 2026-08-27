/**
 * POST /api/v1/articles/scrape       — legacy alias
 * PUT  /api/v1/articles/scrape/:slug/status
 *
 * Kept for the Carnet builds already on people's phones, which call this path.
 * It now delegates to the garden article service instead of carrying its own
 * copy of the pipeline — the old implementation fetched and extracted well
 * enough, but wrote into `web/src/content/` (the source checkout) rather than
 * the member's garden under MAURICE_GARDENS_DIR, and knew nothing about who was
 * saving. New clients should call /api/v1/garden/articles, which returns the
 * full fiche instead of this trimmed shape.
 */

import { Hono } from "hono";
import {
  ARTICLE_STATUSES,
  ArticleSaveError,
  saveArticleFiche,
  setArticleStatus,
  type ArticleStatus,
} from "../services/gardenArticles";
import { scheduleArticleSummary } from "../services/articleSummary";

const app = new Hono();

app.post("/scrape", async (c) => {
  const memberId = c.get("userId") as string;

  let body: {
    url?: string;
    tags?: string[];
    locale?: string;
    comment?: string;
    content?: string;
    html?: string;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Body must be JSON" }, 400);
  }

  try {
    const saved = await saveArticleFiche(memberId, {
      url: body.url ?? "",
      tags: body.tags,
      locale: body.locale,
      comment: body.comment,
      html: body.html,
      source_client: "legacy-scrape",
    });
    if (!saved.duplicate) scheduleArticleSummary(memberId, saved);
    // The shape the old route returned, so existing callers keep parsing it.
    return c.json(
      {
        slug: saved.slug,
        title: saved.title,
        author: saved.author,
        source: saved.publication,
        image: saved.image,
        path: saved.fiche_path,
        duplicate: saved.duplicate,
      },
      saved.duplicate ? 200 : 201,
    );
  } catch (e) {
    if (e instanceof ArticleSaveError) return c.json({ error: e.message }, e.status);
    console.error("[articles/scrape] save failed:", e);
    return c.json({ error: "Failed to save the article" }, 500);
  }
});

app.put("/scrape/:slug/status", async (c) => {
  const memberId = c.get("userId") as string;
  const slug = c.req.param("slug");

  let body: { status?: string; locale?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Body must be JSON" }, 400);
  }

  if (!body.status || !ARTICLE_STATUSES.includes(body.status as ArticleStatus)) {
    return c.json({ error: `status must be one of: ${ARTICLE_STATUSES.join(", ")}` }, 400);
  }

  try {
    return c.json(setArticleStatus(memberId, slug, body.status as ArticleStatus, body.locale));
  } catch (e) {
    if (e instanceof ArticleSaveError) return c.json({ error: e.message }, e.status);
    console.error("[articles/scrape] status update failed:", e);
    return c.json({ error: "Failed to update the article status" }, 500);
  }
});

export default app;
