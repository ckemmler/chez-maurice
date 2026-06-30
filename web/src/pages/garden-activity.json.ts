// Live garden-activity signal for the private-mode indicator. The garden MCP
// tool writes {slug: unix_ts} to <tmpdir>/maurice-garden-activity/<member>.json
// on each page write (deliberately OUTSIDE the content tree, so it never
// retriggers Astro's content watcher); we return slugs edited within a recent
// window (so the indicator stays on during a burst of edits, then fades).
import type { APIRoute } from "astro";
import fs from "node:fs";
import path from "node:path";
import { GARDEN } from "@app/lib/garden";

// SSR — read the file at request time (never prerendered/cached).
export const prerender = false;

const WINDOW_SECONDS = 30;

export const GET: APIRoute = () => {
  let pages: string[] = [];
  try {
    const file = path.join("/tmp/maurice-garden-activity", `${GARDEN}.json`);
    const data = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, number>;
    const now = Math.floor(Date.now() / 1000);
    pages = Object.entries(data)
      .filter(([, ts]) => now - Number(ts) < WINDOW_SECONDS)
      .map(([slug]) => slug);
  } catch {
    // no activity file → idle
  }
  return new Response(JSON.stringify({ active: pages.length > 0, pages }), {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
};
