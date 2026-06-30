/**
 * Dossier API routes + HTML UI.
 *
 * API: /api/v1/dossiers/...
 * UI:  /dossiers (dashboard SPA)
 */

import { readFileSync, openSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

import { Hono } from "hono";

import {
  getDossier,
  listDossiers,
  getDossierTree,
  getResonances,
  deleteDossier,
  listBriefingTopics,
  createBriefingTopic,
  updateBriefingTopic,
  deleteBriefingTopic,
  getLatestBriefing,
  listResearchRequests,
  getResearchRequest,
  getBriefingTopicNames,
} from "../services/dossiers";

import { listSignals, signalSummary, deleteSignal, updateSignal } from "../services/signals";

import { deleteRecommendationsByPlanId, deleteRecommendationsByTrackId, getArticlesByPlanId, getBooksByPlanId, getArticleRecommendations, getBookRecommendations, getDistinctTrackIds, getDistinctMediaTypes } from "../services/recommendations";

const repoRoot = resolve(import.meta.dir, "..", "..", "..");
const researchDir = resolve(repoRoot, "tools", "pipelines", "research_tracks");
const defaultPython = resolve(researchDir, ".venv", "bin", "python");

const app = new Hono();

// ── API routes ──

// List dossiers
app.get("/api/v1/dossiers", (c) => {
  const memberId = c.get("userId") as string;
  if (!memberId) return c.json({ error: "Authentication required" }, 401);

  const type = c.req.query("type");
  const limit = parseInt(c.req.query("limit") || "20", 10);
  const since = c.req.query("since");
  const dossiers = listDossiers(memberId, { type: type || undefined, limit, since: since || undefined });
  return c.json({ dossiers });
});

// Get single dossier
app.get("/api/v1/dossiers/:id", (c) => {
  const memberId = c.get("userId") as string;
  if (!memberId) return c.json({ error: "Authentication required" }, 401);

  const id = c.req.param("id");
  const dossier = getDossier(memberId, id);
  if (!dossier) return c.json({ error: "Dossier not found" }, 404);
  return c.json(dossier);
});

// Delete dossier (cascades in akita.db; optionally cleans up recommendations.db)
app.delete("/api/v1/dossiers/:id", (c) => {
  const memberId = c.get("userId") as string;
  if (!memberId) return c.json({ error: "Authentication required" }, 401);

  const id = c.req.param("id");
  const deleteRecs = c.req.query("deleteRecs") === "true";
  try {
    const deleted = deleteDossier(memberId, id);
    if (!deleted) return c.json({ error: "Dossier not found" }, 404);
    if (deleteRecs) {
      deleteRecommendationsByPlanId(memberId, id);
    }
    return c.json({ deleted: id });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// Backfill book metadata (spawns Python CLI in background)
app.post("/api/v1/books/backfill-metadata", (c) => {
  const pid = spawnResearchBackground([
    "-m", "research_tracks.cli", "backfill-metadata",
  ]);
  return c.json({ status: "running", pid });
});

// Get dossier tree
app.get("/api/v1/dossiers/:id/tree", (c) => {
  const memberId = c.get("userId") as string;
  if (!memberId) return c.json({ error: "Authentication required" }, 401);

  const id = c.req.param("id");
  return c.json(getDossierTree(memberId, id));
});

// Get resonances for a dossier
app.get("/api/v1/dossiers/:id/resonances", (c) => {
  const memberId = c.get("userId") as string;
  if (!memberId) return c.json({ error: "Authentication required" }, 401);

  const id = c.req.param("id");
  return c.json({ resonances: getResonances(memberId, id) });
});

// List briefing topics
app.get("/api/v1/briefing-topics", (c) => {
  const memberId = c.get("userId") as string;
  if (!memberId) return c.json({ error: "Authentication required" }, 401);

  return c.json({ topics: listBriefingTopics(memberId) });
});

// Create briefing topic
app.post("/api/v1/briefing-topics", async (c) => {
  const memberId = c.get("userId") as string;
  if (!memberId) return c.json({ error: "Authentication required" }, 401);

  const body = await c.req.json<{
    name: string;
    description: string;
    format?: string;
    searchQueries?: string[];
    webProvider?: string | null;
    llmModel?: string | null;
    extractArticles?: boolean;
    extractVideos?: boolean;
    extractPodcasts?: boolean;
    extractBooks?: boolean;
    runSynthesis?: boolean;
    maxAgeDays?: number;
    scheduleDays?: string;
  }>();
  if (!body.name || !body.description) {
    return c.json({ error: "name and description are required" }, 400);
  }
  try {
    const id = createBriefingTopic(memberId, {
      name: body.name,
      description: body.description,
      format: body.format,
      search_queries: body.searchQueries,
      web_provider: body.webProvider,
      llm_model: body.llmModel,
      extract_articles: body.extractArticles,
      extract_videos: body.extractVideos,
      extract_podcasts: body.extractPodcasts,
      extract_books: body.extractBooks,
      run_synthesis: body.runSynthesis,
      max_age_days: body.maxAgeDays,
      schedule_days: body.scheduleDays,
    });
    return c.json({ id, name: body.name });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// Update briefing topic
app.put("/api/v1/briefing-topics/:id", async (c) => {
  const memberId = c.get("userId") as string;
  if (!memberId) return c.json({ error: "Authentication required" }, 401);

  const id = c.req.param("id");
  const body = await c.req.json<{
    name?: string;
    description?: string;
    format?: string;
    active?: boolean;
    searchQueries?: string[];
    webProvider?: string | null;
    llmModel?: string | null;
    extractArticles?: boolean;
    extractVideos?: boolean;
    extractPodcasts?: boolean;
    extractBooks?: boolean;
    runSynthesis?: boolean;
    maxAgeDays?: number;
    analysisBrief?: string | null;
    scheduleDays?: string;
  }>();
  try {
    updateBriefingTopic(memberId, id, {
      name: body.name,
      description: body.description,
      format: body.format,
      active: body.active,
      search_queries: body.searchQueries,
      web_provider: body.webProvider,
      llm_model: body.llmModel,
      extract_articles: body.extractArticles,
      extract_videos: body.extractVideos,
      extract_podcasts: body.extractPodcasts,
      extract_books: body.extractBooks,
      run_synthesis: body.runSynthesis,
      max_age_days: body.maxAgeDays,
      analysis_brief: body.analysisBrief,
      schedule_days: body.scheduleDays,
    });
    return c.json({ updated: id });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// Purge all recommendations for a briefing topic
app.delete("/api/v1/briefing-topics/:id/recommendations", (c) => {
  const memberId = c.get("userId") as string;
  if (!memberId) return c.json({ error: "Authentication required" }, 401);

  const id = c.req.param("id");
  try {
    const count = deleteRecommendationsByTrackId(memberId, id);
    return c.json({ purged: count, trackId: id });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// Delete briefing topic
app.delete("/api/v1/briefing-topics/:id", (c) => {
  const memberId = c.get("userId") as string;
  if (!memberId) return c.json({ error: "Authentication required" }, 401);

  const id = c.req.param("id");
  try {
    deleteBriefingTopic(memberId, id);
    return c.json({ deleted: id });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// Regenerate analysis brief for a topic (background)
app.post("/api/v1/briefing-topics/:id/regenerate-analysis", (c) => {
  const id = c.req.param("id");
  const pid = spawnResearchBackground([
    "-m", "research_tracks.cli", "briefing", "regenerate-analysis", "--topic", id,
  ]);
  return c.json({ status: "running", pid, topicId: id });
});

// Generate briefing (background)
app.post("/api/v1/briefings/generate", async (c) => {
  const body = await c.req.json<{ topicId?: string }>().catch(() => ({}));
  const args = [
    "-m", "research_tracks.cli", "briefing", "generate",
    ...(body.topicId ? ["--topic", body.topicId] : ["--all"]),
  ];
  const pid = spawnResearchBackground(args);
  return c.json({ status: "running", pid });
});

// Get latest briefing for a topic
app.get("/api/v1/briefings/latest/:topicId", (c) => {
  const memberId = c.get("userId") as string;
  if (!memberId) return c.json({ error: "Authentication required" }, 401);

  const topicId = c.req.param("topicId");
  const briefing = getLatestBriefing(memberId, topicId);
  if (!briefing) return c.json({ error: "No briefing found for topic" }, 404);
  return c.json(briefing);
});

// List signals (raw feed)
// By default, noisy high-frequency categories (geolocation) are excluded.
// Pass ?include=geolocation or ?category=geolocation to see them.
app.get("/api/v1/signals", (c) => {
  const memberId = c.get("userId") as string;
  if (!memberId) return c.json({ error: "Authentication required" }, 401);

  const category = c.req.query("category");
  const since = c.req.query("since");
  const until = c.req.query("until");
  const include = c.req.query("include");
  const limit = parseInt(c.req.query("limit") || "100", 10);

  const NOISY_CATEGORIES = ["geolocation"];
  // Exclude noisy categories unless explicitly requesting one or opting in via ?include=
  const excludeCategories =
    category || include ? undefined : NOISY_CATEGORIES;

  return c.json({ signals: listSignals(memberId, { category: category || undefined, excludeCategories, since: since || undefined, until: until || undefined, limit }) });
});

// Delete a non-git signal
app.delete("/api/v1/signals/:id", (c) => {
  const memberId = c.get("userId") as string;
  if (!memberId) return c.json({ error: "Authentication required" }, 401);

  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid id" }, 400);
  const deleted = deleteSignal(memberId, id);
  if (!deleted) return c.json({ error: "Not found or is a git signal" }, 404);
  return c.json({ deleted: true });
});

// Update a non-git signal
app.put("/api/v1/signals/:id", async (c) => {
  const memberId = c.get("userId") as string;
  if (!memberId) return c.json({ error: "Authentication required" }, 401);

  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) return c.json({ error: "Invalid id" }, 400);
  const body = await c.req.json<{ details?: string; category?: string | null; tags?: string[] }>();
  const updated = updateSignal(memberId, id, body);
  if (!updated) return c.json({ error: "Not found or is a git signal" }, 404);
  return c.json(updated);
});

// Signal summary (counts by category)
app.get("/api/v1/signals/summary", (c) => {
  const memberId = c.get("userId") as string;
  if (!memberId) return c.json({ error: "Authentication required" }, 401);

  const since = c.req.query("since");
  const until = c.req.query("until");
  const include = c.req.query("include");
  const NOISY_CATEGORIES = ["geolocation"];
  const excludeCategories = include ? undefined : NOISY_CATEGORIES;
  return c.json({ summary: signalSummary(memberId, { since: since || undefined, until: until || undefined, excludeCategories }) });
});

// List research requests
app.get("/api/v1/research", (c) => {
  const memberId = c.get("userId") as string;
  if (!memberId) return c.json({ error: "Authentication required" }, 401);

  const status = c.req.query("status");
  const limit = parseInt(c.req.query("limit") || "20", 10);
  return c.json({ requests: listResearchRequests(memberId, { status: status || undefined, limit }) });
});

// Get research request status
app.get("/api/v1/research/:requestId/status", (c) => {
  const memberId = c.get("userId") as string;
  if (!memberId) return c.json({ error: "Authentication required" }, 401);

  const id = c.req.param("requestId");
  const request = getResearchRequest(memberId, id);
  if (!request) return c.json({ error: "Request not found" }, 404);
  return c.json(request);
});

// Submit deep research request (spawns Python CLI in background)
app.post("/api/v1/research", async (c) => {
  const body = await c.req.json<{
    command: string;
    parentId?: string;
    annotation?: string;
    webProvider?: string;
    llmModel?: string;
    extractArticles?: boolean;
    extractBooks?: boolean;
    corpusOnly?: boolean;
    maxRounds?: number;
    calibreTags?: string;
  }>();
  if (!body.command) return c.json({ error: "command is required" }, 400);

  const metadata: Record<string, boolean> = {};
  if (body.extractArticles) metadata.extractArticles = true;
  if (body.extractBooks) metadata.extractBooks = true;

  // Fire-and-forget: spawn CLI in background, return immediately
  const pid = spawnResearchBackground([
    "-m",
    "research_tracks.cli",
    "research",
    body.command,
    ...(body.parentId ? ["--parent", body.parentId] : []),
    ...(body.annotation ? ["--annotation", body.annotation] : []),
    ...(body.webProvider ? ["--web-provider", body.webProvider] : []),
    ...(body.llmModel ? ["--llm-model", body.llmModel] : []),
    ...(body.corpusOnly ? ["--corpus-only"] : []),
    ...(body.maxRounds != null ? ["--max-rounds", String(body.maxRounds)] : []),
    ...(body.calibreTags ? ["--calibre-tags", body.calibreTags] : []),
    ...(Object.keys(metadata).length ? ["--metadata", JSON.stringify(metadata)] : []),
  ]);

  return c.json({ status: "running", pid, command: body.command });
});

// ── Recommendation feeds (JSON API) ──

app.get("/api/v1/feeds/articles", (c) => {
  const memberId = c.get("userId") as string;
  if (!memberId) return c.json({ error: "Authentication required" }, 401);

  const trackId = c.req.query("track");
  const month = c.req.query("month");
  const mediaType = c.req.query("type");
  const sort = c.req.query("sort") === "asc" ? "asc" as const : "desc" as const;
  const limit = parseInt(c.req.query("limit") || "200", 10);
  const articles = getArticleRecommendations(memberId, {
    trackId: trackId || undefined,
    month: month || undefined,
    mediaType: mediaType || undefined,
    sortOrder: sort,
    limit,
  });
  const trackIds = getDistinctTrackIds(memberId, "article");
  const mediaTypes = getDistinctMediaTypes(memberId);
  const topicNames = getBriefingTopicNames(memberId);
  return c.json({ articles, trackIds, mediaTypes, topicNames });
});

app.get("/api/v1/feeds/books", (c) => {
  const memberId = c.get("userId") as string;
  if (!memberId) return c.json({ error: "Authentication required" }, 401);

  const trackId = c.req.query("track");
  const month = c.req.query("month");
  const sort = c.req.query("sort") === "asc" ? "asc" as const : "desc" as const;
  const limit = parseInt(c.req.query("limit") || "200", 10);
  const books = getBookRecommendations(memberId, {
    trackId: trackId || undefined,
    month: month || undefined,
    sortOrder: sort,
    limit,
  });
  const trackIds = getDistinctTrackIds(memberId, "book");
  const topicNames = getBriefingTopicNames(memberId);
  return c.json({ books, trackIds, topicNames });
});

// ── Dashboard UI ──

const dashboardPath = resolve(import.meta.dir, "dossiers", "dashboard.html");
let dashboardHtml = "<p>Dossier dashboard missing.</p>";
try {
  dashboardHtml = readFileSync(dashboardPath, "utf8");
} catch (err) {
  console.error("Failed to load dossier dashboard", err);
}

app.get("/dossiers", (c) => c.html(dashboardHtml));

// ── Dossier detail page (server-rendered) ──

app.get("/dossiers/:id", (c) => {
  const memberId = c.get("userId") as string;
  if (!memberId) return c.json({ error: "Authentication required" }, 401);

  const id = c.req.param("id");
  const dossier = getDossier(memberId, id);
  if (!dossier) return c.html("<p>Dossier not found.</p>", 404);

  const typeLabelMap: Record<string, [string, string]> = {
    deep_research: ["DR", "badge-dr"],
    daily_briefing: ["Briefing", "badge-briefing"],
    periodic_signal_report: ["Signal", "badge-signal"],
  };
  const [typeLabel, typeCls] = typeLabelMap[dossier.type] || [dossier.type, ""];
  const date = new Date(dossier.created_at).toLocaleDateString("en-US", {
    year: "numeric", month: "short", day: "numeric",
  });

  const metaParts = [`<span class="badge ${typeCls}">${typeLabel}</span>`, date];
  if (dossier.corpus_hits) metaParts.push(`${dossier.corpus_hits} corpus hits`);
  if (dossier.web_sources_used) metaParts.push(`${dossier.web_sources_used} web sources`);

  let bodyHtml = serverMdToHtml(dossier.content || "");

  if (dossier.follow_ups?.length && !dossier.content?.includes("Follow-up Questions")) {
    bodyHtml += "<h2>Follow-up Questions</h2><ul>";
    for (const q of dossier.follow_ups) {
      bodyHtml += `<li>${escHtml(q)}</li>`;
    }
    bodyHtml += "</ul>";
  }

  // Resonances are rendered inline in the dossier markdown content
  // (appended by ResonanceExtractor.render_section during pipeline)

  // Extracted recommendations (articles, videos, podcasts, books)
  const dossierArticles = getArticlesByPlanId(memberId, id);
  const dossierBooks = getBooksByPlanId(memberId, id);

  const articleRecs = dossierArticles.filter(a => (a.media_type || "article") === "article");
  const videoRecs = dossierArticles.filter(a => a.media_type === "video");
  const podcastRecs = dossierArticles.filter(a => a.media_type === "podcast");

  const renderArticleRow = (items: typeof dossierArticles, sectionTitle: string) => {
    if (!items.length) return "";
    const cards = items.map(a => {
      const img = a.og_image
        ? `<img class="rr-img" src="/reports/img?url=${encodeURIComponent(a.og_image)}" alt="" loading="lazy" />`
        : `<div class="rr-img rr-img-placeholder"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z"/></svg></div>`;
      const title = escHtml(a.og_title || a.title);
      const desc = a.summary || a.og_description || "";
      const excerpt = desc.length > 120 ? desc.slice(0, 120) + "..." : desc;
      const domain = (() => { try { return new URL(a.url).hostname.replace("www.", ""); } catch { return ""; } })();
      return `<a class="rr-card" href="${escHtml(a.url)}" target="_blank" rel="noopener">
        ${img}
        <div class="rr-caption">
          <div class="rr-title">${title}</div>
          ${domain ? `<div class="rr-domain">${escHtml(domain)}</div>` : ""}
          ${excerpt ? `<div class="rr-excerpt">${escHtml(excerpt)}</div>` : ""}
        </div>
      </a>`;
    }).join("");
    return `<h2>${escHtml(sectionTitle)}</h2><div class="rr-row">${cards}</div>`;
  };

  const renderBookRow = (items: typeof dossierBooks) => {
    if (!items.length) return "";
    const cards = items.map(b => {
      const img = b.cover_url
        ? `<img class="rr-img" src="${escHtml(b.cover_url)}" alt="" loading="lazy" />`
        : `<div class="rr-img rr-img-placeholder"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"/></svg></div>`;
      const searchQ = encodeURIComponent(`${b.title}${b.author ? " " + b.author : ""}`);
      const href = `https://www.google.com/search?tbm=bks&q=${searchQ}`;
      const details = [b.pub_year, b.page_count ? `${b.page_count} pp.` : null, b.publisher].filter(Boolean).join(" · ");
      const excerpt = b.summary ? (b.summary.length > 120 ? b.summary.slice(0, 120) + "..." : b.summary) : "";
      return `<a class="rr-card" href="${escHtml(href)}" target="_blank" rel="noopener">
        ${img}
        <div class="rr-caption">
          <div class="rr-title">${escHtml(b.title)}</div>
          <div class="rr-author">${escHtml(b.author || "Unknown author")}</div>
          ${details ? `<div class="rr-details">${escHtml(details)}</div>` : ""}
          ${excerpt ? `<div class="rr-excerpt">${escHtml(excerpt)}</div>` : ""}
        </div>
      </a>`;
    }).join("");
    return `<h2>Books</h2><div class="rr-row">${cards}</div>`;
  };

  if (articleRecs.length || videoRecs.length || podcastRecs.length || dossierBooks.length) {
    bodyHtml += '<div class="rr-section">';
    bodyHtml += renderArticleRow(articleRecs, "Articles");
    bodyHtml += renderArticleRow(videoRecs, "Videos");
    bodyHtml += renderArticleRow(podcastRecs, "Podcasts");
    bodyHtml += renderBookRow(dossierBooks);
    bodyHtml += '</div>';
  }

  // API Stats
  const statsJson = dossier.stats_json;
  if (statsJson) {
    try {
      const stats = JSON.parse(statsJson);
      bodyHtml += "<h2>API Usage</h2>";
      bodyHtml += '<table style="width:auto;font-size:0.8125rem;margin-top:0.5rem;">';
      bodyHtml += "<thead><tr><th>Provider</th><th>Calls</th><th>Tokens</th><th>Cost</th></tr></thead><tbody>";
      if (stats.anthropic?.calls) {
        const a = stats.anthropic;
        bodyHtml += `<tr><td>Anthropic</td><td>${a.calls}</td><td>${(a.input_tokens + a.output_tokens).toLocaleString()} (${a.input_tokens.toLocaleString()} in / ${a.output_tokens.toLocaleString()} out)</td><td>$${a.estimated_cost.toFixed(4)}</td></tr>`;
      }
      if (stats.perplexity?.calls) {
        const p = stats.perplexity;
        bodyHtml += `<tr><td>Perplexity</td><td>${p.calls}${p.failures ? ` (${p.failures} failed)` : ""}</td><td>—</td><td>$${p.estimated_cost.toFixed(4)}</td></tr>`;
      }
      if (stats.tavily?.calls) {
        const t = stats.tavily;
        bodyHtml += `<tr><td>Tavily</td><td>${t.calls}${t.failures ? ` (${t.failures} failed)` : ""}</td><td>—</td><td>$${(t.estimated_cost || 0).toFixed(4)}</td></tr>`;
      }
      bodyHtml += `<tr style="font-weight:600;border-top:2px solid var(--paper-rule);"><td>Total</td><td></td><td></td><td>$${(stats.total_estimated_cost || 0).toFixed(4)}</td></tr>`;
      bodyHtml += "</tbody></table>";
    } catch { /* invalid JSON */ }
  } else if (dossier.cost_usd) {
    bodyHtml += "<h2>API Usage</h2>";
    bodyHtml += `<p style="font-size:0.8125rem;color:var(--ink-muted);">Estimated cost: $${dossier.cost_usd.toFixed(4)} &middot; ${dossier.tokens_used?.toLocaleString() || 0} tokens</p>`;
  }

  // Sources — extract all URLs from the research log
  if (dossier.research_log) {
    const urlRegex = /https?:\/\/[^\s)>\]]+/g;
    const allUrls = [...new Set((dossier.research_log.match(urlRegex) || []))];
    if (allUrls.length) {
      bodyHtml += "<h2>Sources</h2>";
      bodyHtml += '<ul style="font-size:0.8125rem;word-break:break-all;">';
      for (const url of allUrls) {
        const domain = (() => { try { return new URL(url).hostname.replace("www.", ""); } catch { return ""; } })();
        bodyHtml += `<li><a href="${escHtml(url)}" target="_blank" rel="noopener">${escHtml(domain || url)}</a></li>`;
      }
      bodyHtml += "</ul>";
    }
  }

  // Research Log (collapsible)
  if (dossier.research_log) {
    bodyHtml += `<details style="margin-top:2rem;"><summary style="cursor:pointer;font-family:var(--font-sans);font-size:1.25rem;font-weight:600;margin-bottom:0.75rem;">Research Log</summary>`;
    bodyHtml += `<div style="font-size:0.8125rem;color:var(--ink-light);">${serverMdToHtml(dossier.research_log)}</div>`;
    bodyHtml += "</details>";
  }

  const page = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escHtml(dossier.title)} — Chez Maurice</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --font-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      --font-serif: 'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, serif;
      --font-mono: 'SF Mono', SFMono-Regular, ui-monospace, Menlo, Consolas, monospace;
      --ink: #1a1a1a; --ink-light: #4a4a4a; --ink-muted: #6b6b6b; --ink-faint: #999;
      --paper: #fafaf8; --paper-warm: #f5f3ef; --paper-rule: #e0ddd6;
      --accent: #8b4513; --accent-light: #b8860b;
      --link: #2c5282; --link-hover: #1a365d;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --ink: #e8e6e1; --ink-light: #bbb8b0; --ink-muted: #8a8780; --ink-faint: #6b6860;
        --paper: #1a1915; --paper-warm: #22211c; --paper-rule: #3a3830;
        --accent: #d4a064; --accent-light: #e0c080;
        --link: #7bb0d4; --link-hover: #a0ccee;
      }
    }
    html { font-size: 100%; -webkit-font-smoothing: antialiased; }
    body { font-family: var(--font-serif); font-size: 1rem; line-height: 1.65;
      color: var(--ink); background: var(--paper); }
    .shell { max-width: 780px; margin: 0 auto; padding: 2rem 2.5rem; }
    .back-link { font-family: var(--font-sans); font-size: 0.8125rem; color: var(--ink-muted);
      text-decoration: none; display: inline-block; margin-bottom: 1.5rem; }
    .back-link:hover { color: var(--ink); }
    h1 { font-family: var(--font-sans); font-size: 1.5rem; margin-bottom: 0.5rem; letter-spacing: -0.02em; }
    .meta { font-family: var(--font-sans); font-size: 0.75rem; color: var(--ink-muted);
      margin-bottom: 2rem; display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
    .badge { display: inline-block; font-size: 0.6875rem; font-weight: 700;
      text-transform: uppercase; letter-spacing: 0.06em; padding: 0.1em 0.5em; border-radius: 4px; }
    .badge-dr { background: #2c528220; color: var(--link); }
    .badge-briefing { background: #22763820; color: #227638; }
    .badge-signal { background: #8b451320; color: var(--accent); }
    @media (prefers-color-scheme: dark) {
      .badge-dr { background: #7bb0d430; }
      .badge-briefing { background: #4abb7030; }
    }
    .content h2 { font-family: var(--font-sans); font-size: 1.25rem; margin-top: 2rem; margin-bottom: 0.75rem; }
    .content h3 { font-family: var(--font-sans); font-size: 1.0625rem; margin-top: 1.5rem; margin-bottom: 0.5rem; }
    .content p { margin-bottom: 1rem; max-width: 65ch; }
    .content ul, .content ol { margin-bottom: 1rem; padding-left: 1.4em; }
    .content li { margin-bottom: 0.25rem; }
    .content blockquote { border-left: 3px solid var(--accent); padding-left: 1rem;
      color: var(--ink-light); margin: 1rem 0; }
    .content a { color: var(--link); }
    .content a:hover { color: var(--link-hover); }
    .content hr { border: none; border-top: 1px solid var(--paper-rule); margin: 2rem 0; }
    .rr-section { margin-top: 2.5rem; }
    .rr-section h2 { font-family: var(--font-sans); font-size: 1.125rem; margin-bottom: 0.75rem; }
    .rr-row { display: flex; gap: 1rem; overflow-x: auto; padding-bottom: 0.75rem;
      scrollbar-width: thin; scrollbar-color: var(--paper-rule) transparent; }
    .rr-row::-webkit-scrollbar { height: 6px; }
    .rr-row::-webkit-scrollbar-track { background: transparent; }
    .rr-row::-webkit-scrollbar-thumb { background: var(--paper-rule); border-radius: 3px; }
    .rr-card { flex: 0 0 200px; background: var(--paper-warm); border: 1px solid var(--paper-rule);
      border-radius: 10px; overflow: hidden; text-decoration: none; color: inherit;
      transition: border-color 0.15s, box-shadow 0.15s; display: flex; flex-direction: column; }
    .rr-card:hover { border-color: var(--accent); box-shadow: 0 2px 12px rgba(0,0,0,0.08); text-decoration: none; }
    .rr-img { width: 100%; height: 120px; object-fit: cover; background: var(--paper-rule); }
    .rr-img-placeholder { display: flex; align-items: center; justify-content: center; color: var(--ink-faint); }
    .rr-img-placeholder svg { width: 28px; height: 28px; }
    .rr-caption { padding: 0.6rem 0.75rem; display: flex; flex-direction: column; gap: 0.15rem; flex: 1; }
    .rr-title { font-family: var(--font-sans); font-size: 0.75rem; font-weight: 600; color: var(--ink);
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; line-height: 1.3; }
    .rr-author { font-family: var(--font-sans); font-size: 0.6875rem; color: var(--ink-muted); }
    .rr-domain { font-family: var(--font-sans); font-size: 0.625rem; color: var(--ink-faint); }
    .rr-details { font-family: var(--font-sans); font-size: 0.625rem; color: var(--ink-faint); }
    .rr-excerpt { font-family: var(--font-serif); font-size: 0.6875rem; color: var(--ink-light); line-height: 1.4;
      display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; margin-top: 0.15rem; }
    @media (max-width: 600px) {
      .shell { padding: 1rem; }
      .rr-card { flex: 0 0 170px; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <a class="back-link" href="/dossiers">&larr; Back to dossiers</a>
    <div style="display:flex; align-items:baseline; justify-content:space-between; gap:1rem; flex-wrap:wrap;">
      <h1>${escHtml(dossier.title)}</h1>
      <button onclick="deleteDossier()" class="btn-del" style="font-family:var(--font-sans);font-size:0.75rem;padding:0.3rem 0.7rem;border:1px solid #cc0000;background:var(--paper);color:#cc0000;border-radius:6px;cursor:pointer;font-weight:600;">Delete</button>
    </div>${dossier.command && dossier.command !== dossier.title ? `\n    <p style="font-size:0.85rem;color:var(--ink-light);margin:0.25rem 0 0.5rem;line-height:1.4;font-style:italic;">${escHtml(dossier.command)}</p>` : ""}
    <div class="meta">${metaParts.join(" &middot; ")}</div>
    <div class="content">${bodyHtml}</div>
  </div>
  <script>
    function deleteDossier() {
      if (!confirm('Permanently delete this dossier?')) return;
      const deleteRecs = confirm('Also delete associated recommendations?');
      const qs = deleteRecs ? '?deleteRecs=true' : '';
      fetch('/api/v1/dossiers/${id}' + qs, { method: 'DELETE' })
        .then(r => r.json())
        .then(data => {
          if (data.error) { alert('Error: ' + data.error); return; }
          window.location.href = '/dossiers';
        })
        .catch(() => alert('Failed to delete dossier.'));
    }
  </script>
</body>
</html>`;

  return c.html(page);
});

// ── Helpers ──

function escHtml(s: string): string {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function serverInlineFmt(s: string): string {
  return escHtml(s)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

function serverMdToHtml(md: string): string {
  return md
    .split(/\n{2,}/)
    .map((block) => {
      block = block.trim();
      if (!block) return "";
      const hm = block.match(/^(#{1,6})\s+(.*)/);
      if (hm) {
        const lvl = hm[1].length;
        return `<h${lvl}>${serverInlineFmt(hm[2])}</h${lvl}>`;
      }
      if (/^---+$/.test(block)) return "<hr/>";
      const lines = block.split("\n");
      if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
        return "<ul>" + lines.map((l) => "<li>" + serverInlineFmt(l.replace(/^\s*[-*]\s+/, "")) + "</li>").join("") + "</ul>";
      }
      if (block.startsWith(">")) {
        const text = block.replace(/^>\s?/gm, "");
        return `<blockquote>${serverInlineFmt(text)}</blockquote>`;
      }
      return `<p>${serverInlineFmt(block.replace(/\n/g, " "))}</p>`;
    })
    .join("\n");
}

function spawnResearchBackground(args: string[]): number | undefined {
  const pythonBin = process.env.RESEARCH_PYTHON || defaultPython;
  const logDir = resolve(repoRoot, "logs");
  mkdirSync(logDir, { recursive: true });
  const logFile = resolve(logDir, "research_spawn.log");
  const fd = openSync(logFile, "a");
  console.log(`[research] Spawning: ${pythonBin} ${args.join(" ")}`);
  console.log(`[research] cwd: ${researchDir}`);
  console.log(`[research] log: ${logFile}`);
  const proc = spawn(pythonBin, args, {
    cwd: researchDir,
    env: { ...process.env },
    stdio: ["ignore", fd, fd],
    detached: true,
  });
  const pid = proc.pid;
  proc.on("exit", (code) => {
    console.log(`[research] PID ${pid} exited with code ${code}`);
  });
  proc.on("error", (err) => {
    console.error(`[research] PID ${pid} error:`, err);
  });
  proc.unref();
  return pid;
}

export default app;
