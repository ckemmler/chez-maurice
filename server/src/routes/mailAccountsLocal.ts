/**
 * The `email` tool's way to a member's accounts, passwords included.
 *
 * Two locks, both required. **Loopback only**, the admin dashboard's test
 * (middleware/loopback.ts): the tool runs on this machine or in this
 * container, and a request that came over the tunnel or the LAN is refused
 * whatever Host it claims. **And the gateway's own key** (`MAURICE_MCP_TOKEN`,
 * which the server and the gateway already share) in `X-Maurice-Tool-Token`:
 * unlike an ancillary turn, this route hands out mail passwords, and "any
 * process on the machine" is a wider circle than "the gateway". Not in
 * `Authorization`, which proxyAuth would read as a session token and refuse.
 *
 * The member is named in the path by the gateway, which took it from the
 * request it is serving; the tool asks for exactly that member and no one else.
 */
import { Hono } from "hono";
import { timingSafeEqual } from "node:crypto";
import { isLoopbackRequest } from "../middleware/loopback";
import { accountsForTool } from "../services/mailAccounts";

const local = new Hono();

function tokenMatches(given: string | undefined): boolean {
  const expected = process.env.MAURICE_MCP_TOKEN || "";
  if (!expected || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

local.use("/*", async (c, next) => {
  if (!isLoopbackRequest(c)) return c.json({ error: "local-only" }, 403);
  if (!tokenMatches(c.req.header("X-Maurice-Tool-Token"))) return c.json({ error: "the gateway's key is required" }, 403);
  await next();
});

local.get("/:memberId", (c) => c.json({ accounts: accountsForTool(c.req.param("memberId")) }));

export default local;
