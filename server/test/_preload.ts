/**
 * Runs before any suite is loaded (bunfig.toml → [test] preload).
 *
 * Point the data directory at a throwaway BEFORE anything can import
 * src/db.ts: that module opens maurice.db once per process, at first import,
 * from wherever MAURICE_DATA_DIR resolves to at that moment. Suites that set
 * their own temp dir keep doing so; the ones that used `??=` now inherit this
 * one instead of the real ~/.maurice; and the two integration suites that
 * genuinely need the live database (they talk to the running server) read
 * MAURICE_LIVE_DATA_DIR, which is what the environment said before we
 * redirected it.
 *
 * Gardens are deliberately left alone: every garden suite isolates itself,
 * and composer-isolation writes a fixture into the live gardensRoot() on
 * purpose, for the running server to find.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.MAURICE_LIVE_DATA_DIR =
  process.env.MAURICE_DATA_DIR ?? path.join(process.env.HOME || "/tmp", ".maurice");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "maurice-test-data-"));
process.env.MAURICE_DATA_DIR = tmp;
process.env.MAURICE_TEST_DATA_DIR = tmp;

process.on("exit", () => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});
