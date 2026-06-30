import { Hono } from "hono";

import {
  listPlanSummaries,
  readPlanDetail,
  updatePlanEntryDecision,
  readBriefing,
  writeBriefing,
  generateBriefing,
  getBriefingContext,
  writeBriefingPrompt,
  readReport,
  readReportHtml,
  generateReport,
  exportDeepResearchPrompt,
  readDigest,
  generateDigest,
  deletePlan,
} from "../../services/tracks/plans";

const plans = new Hono();

plans.get("/", async (c) => {
  const summaries = await listPlanSummaries();
  return c.json({ plans: summaries });
});

plans.get("/:planId", async (c) => {
  const { planId } = c.req.param();
  const plan = await readPlanDetail(planId);
  if (!plan) {
    return c.json({ error: "Plan not found" }, 404);
  }
  return c.json(plan);
});

plans.delete("/:planId", async (c) => {
  const { planId } = c.req.param();
  const result = await deletePlan(planId);
  if (!result.deleted) {
    return c.json({ error: "Plan not found" }, 404);
  }
  return c.json({ status: "ok", planId });
});

plans.patch("/:planId/entries/:trackId", async (c) => {
  const { planId, trackId } = c.req.param();
  let body: { decision?: string; note?: string | null; justification?: string | null };
  try {
    body = await c.req.json();
  } catch (err) {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const allowedDecision = body.decision?.toLowerCase();
  if (allowedDecision && !["research", "monitor", "skip"].includes(allowedDecision)) {
    return c.json({ error: "decision must be one of research/monitor/skip" }, 400);
  }
  const entry = await updatePlanEntryDecision(planId, trackId, {
    decision: allowedDecision,
    note: body.note,
    justification: body.justification,
  });
  if (!entry) {
    return c.json({ error: "Plan or track not found" }, 404);
  }
  return c.json(entry);
});

plans.get("/:planId/entries/:trackId/briefing", async (c) => {
  const { planId, trackId } = c.req.param();
  const briefing = await readBriefing(trackId, planId);
  if (!briefing) {
    return c.json({ error: "Briefing not found" }, 404);
  }
  return c.json(briefing);
});

plans.put("/:planId/entries/:trackId/briefing", async (c) => {
  const { planId, trackId } = c.req.param();
  let body: { content?: string };
  try {
    body = await c.req.json();
  } catch (err) {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  if (typeof body.content !== "string") {
    return c.json({ error: "content is required" }, 400);
  }
  const info = await writeBriefing(trackId, planId, body.content);
  return c.json(info);
});

plans.post("/:planId/entries/:trackId/briefing", async (c) => {
  const { planId, trackId } = c.req.param();
  let body: { prompt?: string } | undefined;
  try {
    body = await c.req.json();
  } catch (err) {
    body = undefined;
  }
  try {
    await generateBriefing(planId, trackId, body?.prompt);
  } catch (err: any) {
    return c.json({ error: err?.message || "Failed to generate briefing" }, 500);
  }
  const info = await readBriefing(trackId, planId);
  return c.json({ status: "ok", briefing: info });
});

plans.get("/:planId/entries/:trackId/report", async (c) => {
  const { planId, trackId } = c.req.param();
  const report = await readReport(trackId, planId);
  if (!report) {
    return c.json({ error: "Report not found" }, 404);
  }
  return c.json(report);
});

plans.get("/:planId/entries/:trackId/report/html", async (c) => {
  const { planId, trackId } = c.req.param();
  const html = await readReportHtml(trackId, planId);
  if (!html) {
    return c.json({ error: "HTML report not found" }, 404);
  }
  return c.html(html);
});

plans.post("/:planId/entries/:trackId/report", async (c) => {
  const { planId, trackId } = c.req.param();
  let body: { force?: boolean } | undefined;
  try {
    body = await c.req.json();
  } catch {
    body = undefined;
  }
  try {
    await generateReport(planId, trackId, { force: body?.force });
  } catch (err: any) {
    return c.json({ error: err?.message || "Failed to generate report" }, 500);
  }
  const info = await readReport(trackId, planId);
  return c.json({ status: "ok", report: info });
});

plans.put("/:planId/entries/:trackId/prompt", async (c) => {
  const { trackId } = c.req.param();
  let body: { prompt?: string };
  try {
    body = await c.req.json();
  } catch (err) {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  if (typeof body.prompt !== "string") {
    return c.json({ error: "prompt is required" }, 400);
  }
  try {
    const result = await writeBriefingPrompt(trackId, body.prompt);
    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err?.message || "Failed to save prompt" }, 500);
  }
});

plans.get("/:planId/entries/:trackId/context", async (c) => {
  const { planId, trackId } = c.req.param();
  const context = await getBriefingContext(planId, trackId);
  if (!context) {
    return c.json({ error: "Context not found" }, 404);
  }
  return c.json(context);
});

// Export the deep research prompt for running in Claude with MCP tools
plans.get("/:planId/entries/:trackId/report/prompt", async (c) => {
  const { planId, trackId } = c.req.param();
  try {
    const result = await exportDeepResearchPrompt(planId, trackId);
    if (!result) {
      return c.json({ error: "Failed to export prompt" }, 500);
    }
    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err?.message || "Failed to export prompt" }, 500);
  }
});

// Read the aggregated digest for a plan
plans.get("/:planId/digest", async (c) => {
  const { planId } = c.req.param();
  const digest = await readDigest(planId);
  if (!digest.exists) {
    return c.json({ error: "Digest not found" }, 404);
  }
  return c.json(digest);
});

// Generate the aggregated digest for a plan
plans.post("/:planId/digest", async (c) => {
  const { planId } = c.req.param();
  try {
    const digest = await generateDigest(planId);
    return c.json({ status: "ok", digest });
  } catch (err: any) {
    return c.json({ error: err?.message || "Failed to generate digest" }, 500);
  }
});

export default plans;
