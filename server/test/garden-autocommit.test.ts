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

test("a path git ignores does not leave the others staged without a commit", () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "maurice-commit-"));
  const git = (...a: string[]) => spawnSync("git", a, { cwd: root, encoding: "utf8" });
  git("init", "-q"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
  fs.writeFileSync(path.join(root, ".gitignore"), "*.sqlite\n");
  git("add", ".gitignore"); git("commit", "-qm", "init");
  fs.writeFileSync(path.join(root, "note.md"), "a note\n");
  fs.writeFileSync(path.join(root, "cache.sqlite"), "x");
  // `git add` stages note.md and exits 1 on the ignored path: the commit still happens.
  expect(autoCommit({ root, username: "t" }, [path.join(root, "note.md"), path.join(root, "cache.sqlite")], "work")).toBe(true);
  expect(git("show", "--name-only", "--format=", "HEAD").stdout.trim()).toBe("note.md");
  expect(git("diff", "--cached", "--name-only").stdout.trim()).toBe("");
  fs.rmSync(root, { recursive: true, force: true });
});

test("`only` commits its own paths and leaves what someone else staged", () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "maurice-commit-"));
  const git = (...a: string[]) => spawnSync("git", a, { cwd: root, encoding: "utf8" });
  git("init", "-q"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
  fs.writeFileSync(path.join(root, "a.md"), "a\n");
  git("add", "a.md"); git("commit", "-qm", "init");
  fs.writeFileSync(path.join(root, "theirs.md"), "staged by the garden tool\n");
  git("add", "theirs.md");
  fs.writeFileSync(path.join(root, "mine.md"), "mine\n");
  expect(autoCommit({ root, username: "t" }, [path.join(root, "mine.md")], "mine", { only: true, author: "X <x@x>" })).toBe(true);
  expect(git("show", "--name-only", "--format=%an", "HEAD").stdout.trim().split("\n")).toEqual(["X", "", "mine.md"]);
  expect(git("diff", "--cached", "--name-only").stdout.trim()).toBe("theirs.md");
  fs.rmSync(root, { recursive: true, force: true });
});
