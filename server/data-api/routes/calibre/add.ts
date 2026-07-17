/**
 * POST /add — upload a PDF or EPUB and add it to the Calibre library.
 *
 * Accepts multipart form data with a `file` field.
 * Writes to a temp file, runs `calibredb add`, then cleans up.
 */

import { Hono } from "hono";
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve, extname } from "node:path";
import { spawnSync } from "node:child_process";
import { getLibraryRoot } from "../../services/calibre";

const app = new Hono();

const CALIBRE_DB =
  "/Applications/calibre.app/Contents/MacOS/calibredb";
const tmpDir = resolve(import.meta.dir, "../../../../data/tmp");

const ALLOWED_EXTENSIONS = new Set([".pdf", ".epub"]);

app.post("/", async (c) => {
  const formData = await c.req.formData();
  const file = formData.get("file");

  if (!file || !(file instanceof File)) {
    return c.json({ error: "file field is required" }, 400);
  }

  const filename = file.name || "book";
  const ext = extname(filename).toLowerCase();

  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return c.json({ error: `Unsupported format: ${ext}. Use .pdf or .epub` }, 400);
  }

  // Write to temp file
  mkdirSync(tmpDir, { recursive: true });
  const tmpPath = resolve(tmpDir, `calibre-add-${Date.now()}${ext}`);

  try {
    const buffer = await file.arrayBuffer();
    writeFileSync(tmpPath, Buffer.from(buffer));

    // Run calibredb add — resolve the library at request time, so uploads land in
    // the same library the read paths serve.
    const result = spawnSync(CALIBRE_DB, [
      "add", tmpPath,
      "--library-path", getLibraryRoot(),
    ], {
      timeout: 30_000,
    });

    const stdout = result.stdout?.toString() ?? "";
    const stderr = result.stderr?.toString() ?? "";

    if (result.status !== 0) {
      return c.json({ error: stderr || stdout || "calibredb add failed" }, 500);
    }

    // Parse book ID from output like "Added book ids: 1234"
    const match = stdout.match(/Added book ids?:\s*(\d+)/);
    const bookId = match ? Number(match[1]) : null;

    return c.json({
      ok: true,
      bookId,
      filename,
      output: stdout.trim(),
    }, 201);
  } finally {
    try { unlinkSync(tmpPath); } catch {}
  }
});

export default app;
