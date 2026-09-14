/**
 * The live plumbing around a page: the activity indicator's JSON (written by
 * the garden MCP tool, read per request) and the socket the browser opens
 * through the proxy — today Vite's HMR channel, tomorrow the reload signal.
 */
import { test, expect, api, notes } from "./helpers";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";

const G = "/g/theo";
const ACTIVITY = "/tmp/maurice-garden-activity/theo.json";

test.afterEach(() => { rmSync(ACTIVITY, { force: true }); });

test("garden-activity.json reflects a write within the window", async () => {
  mkdirSync("/tmp/maurice-garden-activity", { recursive: true });
  const now = Math.floor(Date.now() / 1000);
  writeFileSync(ACTIVITY, JSON.stringify({ "nara-deer": now, "kyoto-kids": now - 600 }));
  const r = await api("theo", `${G}/garden-activity.json`);
  expect(r.status).toBe(200);
  expect(r.headers.get("cache-control")).toContain("no-store");
  expect(await r.json()).toEqual({ active: true, pages: ["nara-deer"] });
});

test("garden-activity.json is idle without a file", async () => {
  const r = await api("theo", `${G}/garden-activity.json`);
  expect(await r.json()).toEqual({ active: false, pages: [] });
});

test("the page subscribes to its garden's changes", async ({ as }) => {
  const page = await as("theo");
  const events: number[] = [];
  page.on("response", (r) => { if (r.url().includes("/garden-tools/events")) events.push(r.status()); });
  await page.goto(`${G}/notes/nara-deer`);
  await expect.poll(() => events.length, { timeout: 10_000 }).toBeGreaterThan(0);
  expect(events[0]).toBe(200);
});

test("a note rewritten under the reader reloads the page", async ({ as }) => {
  const page = await as("theo");
  notes.write("live-reload", "Before the rewrite", "RELOAD-MARKER-before");
  await page.goto(`${G}/notes/live-reload`);
  expect(await page.locator("body").innerText()).toContain("RELOAD-MARKER-before");
  // What Maurice does mid-read: rewrite the file the page is showing.
  notes.write("live-reload", "After the rewrite", "RELOAD-MARKER-after");
  await expect
    .poll(async () => (await page.locator("body").innerText()).includes("RELOAD-MARKER-after"), { timeout: 15_000 })
    .toBe(true);
  notes.remove("live-reload");
});

test("the stream is the caller's own garden, and none for a guest", async () => {
  const guest = await api("visitor", "/api/v1/garden-tools/events");
  expect(guest.status).toBe(403);
  await guest.body?.cancel();
  expect((await api(null, "/api/v1/garden-tools/events")).status).toBe(401);
});

test("HTML is served uncached so a theme switch is immediate", async () => {
  const r = await api("theo", `${G}/notes/nara-deer`, { headers: { accept: "text/html" } });
  expect(r.headers.get("cache-control")).toContain("no-store");
});
