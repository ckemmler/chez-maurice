import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { noPathTraversal } from "../data-api/middleware/noPathTraversal";

// The guard sits in front of the tracks/reports routers, whose :planId/:trackId
// params are concatenated into filesystem paths. Hono decodes %2F, so without
// this a param can carry a separator or `..` and escape the tracks tree. This
// test locks the guard: traversal shapes are refused, real slugs pass through.
function app() {
  const a = new Hono();
  a.use("/api/v1/tracks/plans/*", noPathTraversal);
  a.all("/api/v1/tracks/plans/*", (c) => c.text("reached handler", 200));
  return a;
}

async function status(path: string): Promise<number> {
  return (await app().request("http://x" + path, { method: "PUT" })).status;
}

describe("noPathTraversal", () => {
  it("blocks encoded separators with a 400", async () => {
    // The real attack: %2F keeps the slash hidden from the router but Hono
    // decodes it into the param, which is then concatenated into a path.
    for (const p of [
      "/api/v1/tracks/plans/x/entries/..%2F..%2F..%2Fetc/briefing",
      "/api/v1/tracks/plans/..%2F..%2Fserver%2Fdata/something",
      "/api/v1/tracks/plans/%2Fetc%2Fpasswd",
      "/api/v1/tracks/plans/x/entries/..%5C..%5Cwindows/briefing",
    ]) {
      expect(await status(p)).toBe(400);
    }
  });

  it("never reaches the handler for a literal .. path (router normalizes it away)", async () => {
    // A literal /../ is collapsed by URL normalization before routing, so it
    // can't match a path-building handler — 404, never 200.
    expect(await status("/api/v1/tracks/plans/../../secret")).not.toBe(200);
  });

  it("lets genuine plan and track ids through", async () => {
    for (const p of [
      "/api/v1/tracks/plans/2026-q1-plan",
      "/api/v1/tracks/plans/plan_abc123/entries/track-health/briefing",
      "/api/v1/tracks/plans/my.plan.v2/digest",
    ]) {
      expect(await status(p)).toBe(200);
    }
  });
});
