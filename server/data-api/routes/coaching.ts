/**
 * Coaching plans CRUD routes.
 *
 * GET    /                 List plans (query: ?active_on=YYYY-MM-DD&category=health&include_archived=1)
 * GET    /:id              Get single plan
 * POST   /                 Create plan
 * PUT    /:id              Update plan
 * DELETE /:id              Delete plan
 */

import { Hono } from "hono";
import {
  listPlans,
  getPlan,
  createPlan,
  updatePlan,
  deletePlan,
} from "../services/coaching";

const app = new Hono();

// List plans — optionally filter by active date, category, archived status
app.get("/", (c) => {
  const memberId = c.get("userId") as string;
  if (!memberId) return c.json({ error: "Authentication required" }, 401);

  try {
    const active_on = c.req.query("active_on");
    const category = c.req.query("category");
    const include_archived = c.req.query("include_archived") === "1";

    const plans = listPlans(memberId, { active_on, category, include_archived });
    return c.json(plans);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// Get single plan
app.get("/:id", (c) => {
  const memberId = c.get("userId") as string;
  if (!memberId) return c.json({ error: "Authentication required" }, 401);

  try {
    const id = parseInt(c.req.param("id"), 10);
    if (isNaN(id)) return c.json({ error: "Invalid id" }, 400);

    const plan = getPlan(memberId, id);
    if (!plan) return c.json({ error: "Plan not found" }, 404);

    return c.json(plan);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// Create plan
app.post("/", async (c) => {
  const memberId = c.get("userId") as string;
  if (!memberId) return c.json({ error: "Authentication required" }, 401);

  try {
    const body = await c.req.json();

    if (!body.title || !Array.isArray(body.metrics) || body.metrics.length === 0) {
      return c.json({ error: "title and metrics (non-empty array) are required" }, 400);
    }

    const plan = createPlan(memberId, {
      title: body.title,
      description: body.description,
      icon: body.icon,
      category: body.category,
      tags: body.tags,
      active_from: body.active_from,
      active_until: body.active_until,
      metrics: body.metrics,
      note_slug: body.note_slug,
    });

    return c.json(plan, 201);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// Update plan
app.put("/:id", async (c) => {
  const memberId = c.get("userId") as string;
  if (!memberId) return c.json({ error: "Authentication required" }, 401);

  try {
    const id = parseInt(c.req.param("id"), 10);
    if (isNaN(id)) return c.json({ error: "Invalid id" }, 400);

    const body = await c.req.json();
    const plan = updatePlan(memberId, id, body);
    if (!plan) return c.json({ error: "Plan not found" }, 404);

    return c.json(plan);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// Delete plan
app.delete("/:id", (c) => {
  const memberId = c.get("userId") as string;
  if (!memberId) return c.json({ error: "Authentication required" }, 401);

  try {
    const id = parseInt(c.req.param("id"), 10);
    if (isNaN(id)) return c.json({ error: "Invalid id" }, 400);

    const deleted = deletePlan(memberId, id);
    if (!deleted) return c.json({ error: "Plan not found" }, 404);

    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

export default app;
