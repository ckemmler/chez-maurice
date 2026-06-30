/**
 * Layout spec routes — read-only.
 *
 * GET /              List layouts (query: ?cadence=daily&active_only=1)
 * GET /:id           Get single layout with full spec
 */

import { Hono } from "hono";
import { listLayouts, getLayout } from "../services/layouts";

const app = new Hono();

app.get("/", (c) => {
  const memberId = c.get("userId") as string;
  if (!memberId) return c.json({ error: "Authentication required" }, 401);

  try {
    const cadence = c.req.query("cadence");
    const active_only = c.req.query("active_only") === "1";

    const layouts = listLayouts(memberId, { cadence, active_only });
    return c.json(layouts);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

app.get("/:id", (c) => {
  const memberId = c.get("userId") as string;
  if (!memberId) return c.json({ error: "Authentication required" }, 401);

  try {
    const id = c.req.param("id");
    const layout = getLayout(memberId, id);
    if (!layout) return c.json({ error: "Layout not found" }, 404);

    return c.json(layout);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

export default app;
