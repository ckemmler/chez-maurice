import { Hono } from "hono";
import { requireAuth } from "../middleware/auth";
import { listFamilies } from "../services/toolFamilies";

// GET /api/tool-families — the household's tool families (MCP server groups)
// with live tool counts, for the persona/conversation tool pickers.
const toolFamilies = new Hono();
toolFamilies.use("/*", requireAuth);
toolFamilies.get("/", async (c) => c.json(await listFamilies(c.get("userId"))));

export default toolFamilies;
