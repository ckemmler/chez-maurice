/**
 * The Maurice application directory — the single definition of where app-owned
 * state lives: maurice.db, avatars/, images/, files/, uploads/.
 *
 * This is deliberately NOT the data-api's [paths] data_dir from config.toml,
 * which points somewhere else (life.db, compte.db, recommendations.db). The two
 * coincide only when MAURICE_DATA_DIR is set — as every test and the demo seed
 * do — which is why a mismatch between them survives the test suite and only
 * bites a config.toml-driven dev or prod setup.
 *
 * Keep this module free of side effects (no mkdir, no Database) so any caller
 * can ask where a file lives without booting a schema.
 */

import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";

/**
 * Under `bun test`, refuse any data directory outside the temp dir.
 *
 * test/_preload.ts points MAURICE_DATA_DIR at a throwaway before anything
 * opens a database, but only when Bun reads server/bunfig.toml — that is,
 * when the tests are started from server/. On 25 September 2026 a run started
 * from the repo root skipped the preload; every suite then opened the
 * household's live ~/.maurice/maurice.db and did what fixtures do: it replaced
 * the provider keys with `k-zai` and `k-scw`, emptied the spend ledger, the
 * domain briefs and proposals and the ancillary pins, and added 39 fake
 * members. The chat answered 401 until it was restored from the night's
 * backup. A test that cannot find its sandbox has to stop, not fall through
 * to the real one.
 *
 * `bun test` sets NODE_ENV=test. MAURICE_TESTS_MAY_TOUCH_LIVE=1 is the
 * explicit, deliberate way past this for a suite that means it.
 */
export function assertTestSandbox(dir: string, what: string): void {
  if (process.env.NODE_ENV !== "test" || process.env.MAURICE_TESTS_MAY_TOUCH_LIVE === "1") return;
  const roots = new Set<string>();
  for (const root of [tmpdir(), "/tmp"]) {
    roots.add(resolve(root));
    try { roots.add(realpathSync(root)); } catch { /* not on this system */ }
  }
  let target = resolve(dir);
  try { target = realpathSync(target); } catch { /* not created yet: judge the path as given */ }
  const inside = [...roots].some((root) => target === root || target.startsWith(root + sep));
  if (!inside) {
    throw new Error(
      `refusing to open ${what} at ${dir} under bun test: it is not a temp directory, so it may be ` +
      `the household's live data. Run the tests from server/ (bunfig.toml preloads test/_preload.ts), ` +
      `or set MAURICE_DATA_DIR to a temp dir.`,
    );
  }
}

/** Root of the application directory. Callers are responsible for creating it. */
export function getAppDir(): string {
  const dir = process.env.MAURICE_DATA_DIR || join(process.env.HOME || "/tmp", ".maurice");
  assertTestSandbox(dir, "the app directory (maurice.db)");
  return dir;
}

/** Path to maurice.db, wherever the app directory currently resolves to. */
export function getMauriceDbPath(): string {
  return join(getAppDir(), "maurice.db");
}
