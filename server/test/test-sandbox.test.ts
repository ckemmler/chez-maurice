// The sandbox guard (lib/appDir.ts). On 25 September 2026 a test run that
// skipped the preload opened the household's live maurice.db and rewrote it.
// Under bun test, a data directory outside the temp dir is now refused before
// anything is opened.

import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { assertTestSandbox, getAppDir } = await import("../lib/appDir");

test("the preload's temp dir is accepted", () => {
  expect(process.env.NODE_ENV).toBe("test");
  expect(() => getAppDir()).not.toThrow();
  const dir = mkdtempSync(join(tmpdir(), "sandbox-"));
  expect(() => assertTestSandbox(dir, "x")).not.toThrow();
});

test("a home directory is refused, whatever it is called", () => {
  const home = process.env.HOME || "/Users/someone";
  expect(() => assertTestSandbox(join(home, ".maurice"), "the app directory")).toThrow(/not a temp directory/);
  expect(() => assertTestSandbox("/srv/maurice/data", "the data directory")).toThrow(/Run the tests from server\//);
  // A path that merely starts with the temp dir's name is not inside it.
  expect(() => assertTestSandbox(tmpdir() + "-not-really", "x")).toThrow();
});

test("the explicit escape hatch lets a deliberate suite through", () => {
  process.env.MAURICE_TESTS_MAY_TOUCH_LIVE = "1";
  try {
    expect(() => assertTestSandbox("/srv/maurice/data", "x")).not.toThrow();
  } finally {
    delete process.env.MAURICE_TESTS_MAY_TOUCH_LIVE;
  }
});
