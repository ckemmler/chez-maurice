import { Hono } from "hono";
import { requireAuth } from "../middleware/auth";
import {
  availableModelsForUser,
  everydayModelFor,
  setEverydayModel,
} from "../services/modelAccess";

const models = new Hono();
models.use("/*", requireAuth);

// GET /api/models — the roster the signed-in member is allowed to use.
models.get("/", (c) => c.json(availableModelsForUser(c.get("userId"))));

// GET /api/models/everyday — the model this member's everyday Maurice runs.
models.get("/everyday", (c) => c.json({ id: everydayModelFor(c.get("userId")) }));

// PUT /api/models/everyday — set it ({ id } must be one the member may use;
// null clears back to the household default). Per-member, so foyer-mates can
// each pick their own everyday LLM.
models.put("/everyday", async (c) => {
  const { id } = (await c.req.json().catch(() => ({}))) as { id?: string | null };
  if (!setEverydayModel(c.get("userId"), id ?? null)) {
    return c.json({ error: "model not allowed" }, 403);
  }
  return c.json({ id: everydayModelFor(c.get("userId")) });
});

export default models;
