// /api/import — a member imports their own chat history (services/chatImport.ts).
// The app's settings call these; the admin console has the same three under
// /admin/users/:id/import for any member. A guest has no history here: their
// life is in another household.
import { Hono } from "hono";
import { requireAuth } from "../middleware/auth";
import { ImportError, importHistory, importStatus, isImportProvider, startImport } from "../services/chatImport";

const importRoutes = new Hono();

importRoutes.use("/*", requireAuth);
importRoutes.use("/*", async (c, next) => {
  if (c.get("userRole") === "guest") return c.json({ error: "guests_cannot_import" }, 403);
  await next();
});

function failed(c: any, e: unknown) {
  if (e instanceof ImportError) {
    return c.json({ error: e.code, detail: e.message }, e.code === "not_zip" ? 400 : 502);
  }
  throw e;
}

// POST /api/import?provider=anthropic|chatgpt — multipart, field `file`: the
// export .zip. Answers { job_id, provider }; poll /status with the job.
importRoutes.post("/", async (c) => {
  const provider = c.req.query("provider") || "anthropic";
  if (!isImportProvider(provider)) return c.json({ error: "bad_provider" }, 400);
  let body: Record<string, any>;
  try {
    body = await c.req.parseBody();
  } catch {
    return c.json({ error: "bad_form" }, 400);
  }
  const file = body["file"];
  if (!(file instanceof File)) return c.json({ error: "no_file" }, 400);
  try {
    return c.json(await startImport(c.get("userId"), provider, file));
  } catch (e) {
    return failed(c, e);
  }
});

// GET /api/import/status?job=… — { phase, done, total, status, result | error }.
importRoutes.get("/status", async (c) => {
  const jobId = c.req.query("job");
  if (!jobId) return c.json({ error: "no_job" }, 400);
  try {
    return c.json(await importStatus(c.get("userId"), jobId));
  } catch (e) {
    return failed(c, e);
  }
});

// GET /api/import/history?provider=… — the runs, newest first, and the watermark.
importRoutes.get("/history", async (c) => {
  const provider = c.req.query("provider") || "anthropic";
  if (!isImportProvider(provider)) return c.json({ error: "bad_provider" }, 400);
  try {
    return c.json(await importHistory(c.get("userId"), provider));
  } catch (e) {
    return failed(c, e);
  }
});

export default importRoutes;
