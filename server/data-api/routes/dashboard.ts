/**
 * Dashboard data route — resolves all widget metrics in one shot.
 *
 * GET /:id/data              Resolve all metrics for a layout (defaults to today)
 * GET /:id/data?date=YYYY-MM-DD  Resolve for a specific date
 * GET /:id/data?refresh=1   Bypass cache
 */

import { Hono } from "hono";
import { getLayout } from "../services/layouts";
import { resolveMetrics } from "../services/metrics";
import type { WidgetDataBinding } from "../services/metrics";

const app = new Hono();

app.get("/:id/data", async (c) => {
  try {
    const memberId = c.get("userId") as string;
    if (!memberId) return c.json({ error: "Authentication required" }, 401);

    const id = c.req.param("id");
    const refresh = c.req.query("refresh") === "1";

    const layout = getLayout(memberId, id);
    if (!layout) return c.json({ error: "Layout not found" }, 404);

    // Walk spec.rows[].widgets[], flatten all data bindings
    const allBindings: WidgetDataBinding[] = [];
    const spec = layout.spec as {
      rows?: Array<{
        widgets?: Array<{
          data?:
            | WidgetDataBinding
            | WidgetDataBinding[];
        }>;
      }>;
    };

    for (const row of spec.rows ?? []) {
      for (const widget of row.widgets ?? []) {
        if (!widget.data) continue;
        if (Array.isArray(widget.data)) {
          allBindings.push(...widget.data);
        } else {
          allBindings.push(widget.data);
        }
      }
    }

    const dateParam = c.req.query("date"); // ISO date string, e.g. 2026-05-20
    const date = dateParam ? new Date(`${dateParam}T12:00:00`) : new Date();
    if (isNaN(date.getTime())) return c.json({ error: "Invalid date" }, 400);

    const { payload, resolvedAt } = await resolveMetrics(memberId, allBindings, date, {
      layoutId: id,
      refresh,
    });

    return c.json({
      layout_id: layout.id,
      layout_version: layout.version,
      resolved_at: resolvedAt,
      metrics: payload,
    });
  } catch (e: any) {
    console.error("Dashboard data error:", e);
    return c.json({ error: e.message }, 500);
  }
});

export default app;
