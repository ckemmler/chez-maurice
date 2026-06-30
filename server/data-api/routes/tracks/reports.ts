import { Hono } from "hono";

import {
  renderReportsIndex,
  renderDigestPage,
  renderTrackReport,
  renderArticlePage,
  renderResearchLog,
  reportStylesCss,
} from "../../services/tracks/reports";

const reports = new Hono();

// GET /reports/styles.css — External stylesheet for all report pages
reports.get("/styles.css", (c) => {
  c.header("Content-Type", "text/css; charset=utf-8");
  c.header("Cache-Control", "no-cache");
  return c.body(reportStylesCss());
});

// GET /reports/img — Proxy external images to avoid mixed-content issues
reports.get("/img", async (c) => {
  const url = c.req.query("url");
  if (!url || !url.startsWith("https://")) {
    return c.text("Missing or invalid url parameter", 400);
  }
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": "MauriceBot/1.0" },
      redirect: "follow",
    });
    if (!resp.ok) {
      return c.text("Upstream error", 502);
    }
    const ct = resp.headers.get("content-type") || "image/png";
    c.header("Content-Type", ct);
    c.header("Cache-Control", "public, max-age=86400");
    return c.body(await resp.arrayBuffer());
  } catch {
    return c.text("Failed to fetch image", 502);
  }
});

// GET /reports — All Reports index
reports.get("/", async (c) => {
  const html = await renderReportsIndex();
  return c.html(html);
});

// GET /reports/:planId — Digest page
reports.get("/:planId", async (c) => {
  const planId = c.req.param("planId");
  const html = await renderDigestPage(planId);
  if (!html) {
    return c.text("Digest not found", 404);
  }
  return c.html(html);
});

// GET /reports/:planId/:trackId — Track issue (multi-article)
reports.get("/:planId/:trackId", async (c) => {
  const { planId, trackId } = c.req.param();
  const html = await renderTrackReport(planId, trackId);
  if (!html) {
    return c.text("Report not found", 404);
  }
  return c.html(html);
});

// GET /reports/:planId/:trackId/log — Research reasoning log
reports.get("/:planId/:trackId/log", async (c) => {
  const { planId, trackId } = c.req.param();
  const html = await renderResearchLog(planId, trackId);
  if (!html) {
    return c.text("Research log not found", 404);
  }
  return c.html(html);
});

// GET /reports/:planId/:trackId/:articleIdx — Single article standalone
reports.get("/:planId/:trackId/:articleIdx", async (c) => {
  const { planId, trackId, articleIdx } = c.req.param();
  const idx = parseInt(articleIdx, 10);
  if (isNaN(idx)) {
    return c.text("Invalid article index", 400);
  }
  const html = await renderArticlePage(planId, trackId, idx);
  if (!html) {
    return c.text("Article not found", 404);
  }
  return c.html(html);
});

export default reports;
