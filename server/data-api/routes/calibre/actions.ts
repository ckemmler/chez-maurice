/**
 * Calibre book processing action endpoints.
 *
 * POST /:bookId/extract    — extract chapters from EPUB
 * POST /:bookId/summarize  — generate AI summaries for chapters
 * POST /:bookId/index      — index summaries to Qdrant
 * GET  /:bookId/status     — processing status (chapter/summary counts)
 */

import { openSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

import { Hono } from "hono";

import { getBookMetadata, getChapterStats, getLibraryRoot } from "../../services/calibre";

const actions = new Hono();

const repoRoot = resolve(import.meta.dir, "../../../..");
const cliPath = resolve(repoRoot, "tools/calibre/cli.py");
const logDir = resolve(repoRoot, "logs");

/** True if this interpreter can load `pyexpat` — Homebrew's python@3.14 ships a
 *  broken one (libexpat symbol mismatch) that crashes EPUB parsing. */
function pythonHasExpat(py: string): boolean {
  try {
    return spawnSync(py, ["-c", "import xml.parsers.expat"], { timeout: 5000 }).status === 0;
  } catch {
    return false;
  }
}

/** Pick the Calibre CLI interpreter: an explicit override, then the dedicated
 *  `.venv-calibre` (created by scripts/setup-calibre-venv.sh), then `.venv` —
 *  preferring the first whose pyexpat works so a broken default doesn't silently
 *  fail every extraction. */
function resolveCalibrePython(): string {
  const candidates = [
    process.env.CALIBRE_PYTHON,
    resolve(repoRoot, ".venv-calibre/bin/python"),
    resolve(repoRoot, ".venv/bin/python"),
  ].filter((p): p is string => !!p && existsSync(p));

  const working = candidates.find(pythonHasExpat);
  if (working) return working;

  const fallback = candidates[0] ?? resolve(repoRoot, ".venv/bin/python");
  console.warn(
    `[calibre] No Python with a working pyexpat found (checked: ${candidates.join(", ") || "none"}). ` +
      `Chapter extraction will fail — run scripts/setup-calibre-venv.sh. Falling back to ${fallback}.`,
  );
  return fallback;
}

function spawnCalibreAction(action: string, bookId: number, sync: boolean) {
  // Resolved per invocation (not at startup) so running setup-calibre-venv.sh
  // takes effect on the next action — no server restart needed. The check is a
  // ~50ms spawn, negligible next to extraction/summarization.
  const pythonBin = resolveCalibrePython();
  const args = [cliPath, action, String(bookId)];
  mkdirSync(logDir, { recursive: true });
  const logFile = resolve(logDir, "calibre_actions.log");

  // The CLI has no request/member context, so hand it the library the API
  // already resolved — otherwise it reports "no_library" and every action fails.
  const libraryRoot = getLibraryRoot();
  const childEnv = { ...process.env, CALIBRE_LIBRARY: libraryRoot, CALIBRE_LIBRARY_PATH: libraryRoot };

  if (sync) {
    const result = spawnSync(pythonBin, args, {
      cwd: resolve(repoRoot, "tools/calibre"),
      env: childEnv,
      timeout: 600_000, // 10 minutes
    });
    const stdout = result.stdout?.toString() ?? "";
    const stderr = result.stderr?.toString() ?? "";
    if (result.status !== 0) {
      return { ok: false, error: stderr || stdout || "Process failed" };
    }
    try {
      return { ok: true, result: JSON.parse(stdout) };
    } catch {
      return { ok: true, result: { output: stdout } };
    }
  }

  // Async (fire-and-forget)
  const fd = openSync(logFile, "a");
  console.log(`[calibre] Spawning: ${pythonBin} ${args.join(" ")}`);
  const proc = spawn(pythonBin, args, {
    cwd: resolve(repoRoot, "tools/calibre"),
    env: childEnv,
    stdio: ["ignore", fd, fd],
    detached: true,
  });
  const pid = proc.pid;
  proc.on("exit", (code) => {
    console.log(`[calibre] PID ${pid} exited with code ${code}`);
  });
  proc.on("error", (err) => {
    console.error(`[calibre] PID ${pid} error:`, err);
  });
  proc.unref();
  return { ok: true, pid };
}

// --- Status endpoint ---

actions.get("/:bookId/status", async (c) => {
  const bookId = Number(c.req.param("bookId"));
  if (Number.isNaN(bookId)) {
    return c.json({ error: "Invalid book id" }, 400);
  }

  const metadata = await getBookMetadata(bookId);
  if (!metadata) {
    return c.json({ error: "Book not found" }, 404);
  }

  const stats = await getChapterStats(metadata.bookPath);
  return c.json({
    bookId,
    chapters: stats.chapters,
    summarized: stats.summarized,
    indexed: stats.indexed,
  });
});

// --- Action endpoints ---

for (const action of ["extract", "summarize", "index"] as const) {
  actions.post(`/:bookId/${action}`, async (c) => {
    const bookId = Number(c.req.param("bookId"));
    if (Number.isNaN(bookId)) {
      return c.json({ error: "Invalid book id" }, 400);
    }

    const metadata = await getBookMetadata(bookId);
    if (!metadata) {
      return c.json({ error: "Book not found" }, 404);
    }

    const sync = c.req.query("sync") === "true";
    const result = spawnCalibreAction(action, bookId, sync);

    if (sync) {
      if (!result.ok) {
        return c.json({ error: result.error }, 500);
      }
      // CLI may return { error: "..." } inside the JSON result
      if (result.result?.error) {
        return c.json({ error: result.result.error }, 422);
      }
      return c.json({ status: "completed", result: result.result });
    }

    return c.json({ status: "started", pid: result.pid }, 202);
  });
}

export default actions;
