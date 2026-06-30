import { Hono } from "hono";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { listReports, actionReport, dismissReport } from "../services/safety";

// Operator-only moderation of shared-room reports. Exposes reported room content
// + metadata only — reports never exist for private 1:1, so this path can't
// reach a member's private conversation (per-member isolation invariant).
const reports = new Hono();

reports.use("/*", requireAuth, requireAdmin);

// GET /api/reports?status=open — child_safety first, then newest.
reports.get("/", (c) => {
  const status = c.req.query("status") ?? "open";
  return c.json(listReports(status));
});

// POST /api/reports/:id/action — remove the reported message and/or eject the
// member from the room. Body: { remove_message?, eject_member? }.
reports.post("/:id/action", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    remove_message?: boolean;
    eject_member?: boolean;
  };
  const r = actionReport(c.req.param("id"), {
    removeMessage: !!body.remove_message,
    ejectMember: !!body.eject_member,
  });
  if (!r) return c.json({ error: "Not found" }, 404);
  return c.json(r);
});

// POST /api/reports/:id/dismiss
reports.post("/:id/dismiss", (c) => {
  const r = dismissReport(c.req.param("id"));
  if (!r) return c.json({ error: "Not found" }, 404);
  return c.json(r);
});

export default reports;
