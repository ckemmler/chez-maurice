/**
 * The suite must never touch the household's real database. This pins the
 * preload's contract: when src/db.ts is imported here, it resolves under a
 * temp dir, and the live one is only reachable through MAURICE_LIVE_DATA_DIR.
 */
import { expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { getMauriceDbPath } from "../lib/appDir";

test("maurice.db resolves under a throwaway data dir, never the live one", () => {
  const live = process.env.MAURICE_LIVE_DATA_DIR!;
  const p = getMauriceDbPath();
  expect(live).toBeTruthy();
  expect(p.startsWith(os.tmpdir()) || p.startsWith(path.resolve(os.tmpdir()))).toBe(true);
  expect(p.startsWith(live)).toBe(false);
});
