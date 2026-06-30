import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { Hono } from "hono";

const ui = new Hono();
const pagePath = resolve(import.meta.dir, "dashboard.html");
let pageHtml = "<p>Tracks dashboard missing.</p>";
try {
  pageHtml = readFileSync(pagePath, "utf8");
} catch (err) {
  console.error("Failed to load tracks dashboard", err);
}

ui.get("/", (c) => c.html(pageHtml));

export default ui;
