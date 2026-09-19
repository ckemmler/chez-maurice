// /api/me — what the signed-in member may know about themselves that no
// other route carries. (Their profile is /api/users/me.)
import { Hono } from "hono";
import { requireAuth } from "../middleware/auth";
import { usageFor } from "../services/budget";

const me = new Hono();

me.use("/*", requireAuth);

// ── GET /api/me/usage ───────────────────────────────────────────
// What this member has spent today (rolling 24 h) and this calendar month,
// the tightest daily cap that applies to them (null when none), and the
// headroom left under the tightest cap of any kind (null when uncapped).

me.get("/usage", (c) => c.json(usageFor(c.get("userId"))));

export default me;
