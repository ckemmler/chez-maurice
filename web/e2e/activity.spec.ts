/**
 * The live plumbing around a page: the activity indicator's JSON (written by
 * the garden MCP tool, read per request) and the socket the browser opens
 * through the proxy — today Vite's HMR channel, tomorrow the reload signal.
 */
import { test, expect, api } from "./helpers";
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

test("the page opens its live socket through the proxy", async ({ as }) => {
  const page = await as("theo");
  const sockets: string[] = [];
  page.on("websocket", (ws) => sockets.push(ws.url()));
  const messages: string[] = [];
  page.on("console", (m) => messages.push(m.text()));
  await page.goto(`${G}/notes/nara-deer`);
  await expect.poll(() => sockets.length, { timeout: 10_000 }).toBeGreaterThan(0);
  // Today this is Vite's HMR client; it must report a connection, not a loop.
  await expect.poll(() => messages.some((m) => /connected/.test(m)), { timeout: 10_000 }).toBe(true);
  expect(messages.filter((m) => /server connection lost|full reload/i.test(m))).toHaveLength(0);
});

test("HTML is served uncached so a theme switch is immediate", async () => {
  const r = await api("theo", `${G}/notes/nara-deer`, { headers: { accept: "text/html" } });
  expect(r.headers.get("cache-control")).toContain("no-store");
});
