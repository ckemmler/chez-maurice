// autoCommit in a real repo: a path written and removed within the same
// piece of work (never tracked, no longer on disk) must not make `git add`
// refuse the whole list — the mail pass moves a fragment and then rewrites
// it away, and the first real merging run committed nothing because of it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { expect, test } from "bun:test";
import { autoCommit } from "../data-api/services/gardenFiche";

test("a path gone and never tracked is left out; the rest is committed, deletions included", () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "maurice-commit-"));
  const git = (...a: string[]) => spawnSync("git", a, { cwd: root, encoding: "utf8" });
  git("init", "-q"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
  fs.writeFileSync(path.join(root, "old.md"), "old\n");
  git("add", "old.md"); git("commit", "-qm", "init");
  fs.rmSync(path.join(root, "old.md"));
  fs.writeFileSync(path.join(root, "new.md"), "new\n");
  const ghost = path.join(root, "ghost.frag"); // written and removed: never tracked, not on disk
  autoCommit({ root, username: "t" }, [path.join(root, "old.md"), path.join(root, "new.md"), ghost], "work");
  expect(git("log", "--oneline").stdout.split("\n").filter(Boolean)).toHaveLength(2);
  expect(git("status", "--short").stdout.trim()).toBe("");
  fs.rmSync(root, { recursive: true, force: true });
});
