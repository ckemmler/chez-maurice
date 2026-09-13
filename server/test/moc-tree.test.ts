/**
 * The shape of a MOC's subtree in the composer: a note hangs under the node
 * nearest the root that links to it. Cross-linked notes — the system docs are
 * the live case — must come out as the index's own children, not as a chain
 * fourteen deep, and "exclude this subtree" must cut where the tree shows it.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "maurice-moc-"));
process.env.MAURICE_GARDENS_DIR = TMP;

const { MEMBER } = await import("./_member");
const { resolveSubtree } = await import("../src/services/composer/notes");

afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

function note(slug: string, links: string[], moc = false) {
  const dir = path.join(TMP, MEMBER.username, "notes", "en");
  fs.mkdirSync(dir, { recursive: true });
  const body = links.map((l) => `See [[${l}]].`).join("\n");
  fs.writeFileSync(path.join(dir, `${slug}.md`),
    `---\ntitle: ${slug}\nflags:${moc ? "\n- moc" : " []"}\nlocale: en\n---\n${body}\n`);
}

beforeAll(() => {
  // An index over four docs that all link each other, plus a leaf only one
  // doc reaches. Depth-first from the index would have chained a → b → c → d.
  note("index", ["a", "b", "c", "d"], true);
  note("a", ["b", "c", "d", "leaf"]);
  note("b", ["a", "c", "d"]);
  note("c", ["a", "b", "d"]);
  note("d", ["a", "b", "c"]);
  note("leaf", []);
});

test("the index owns its links; a cross-linked note appears once, nearest the root", () => {
  const r = resolveSubtree(MEMBER.id, "index", {})!;
  expect(r.tree.children.map((c) => c.id)).toEqual(["a", "b", "c", "d"]);
  const a = r.tree.children.find((c) => c.id === "a")!;
  expect(a.children.map((c) => c.id)).toEqual(["leaf"]);
  expect(r.resolved.count).toBe(6);
  expect(r.resolved.slugs.sort()).toEqual(["a", "b", "c", "d", "index", "leaf"]);
});

test("excluding a node cuts the subtree the tree shows, and nothing else", () => {
  const r = resolveSubtree(MEMBER.id, "index", { excluded: ["a"] })!;
  const a = r.tree.children.find((c) => c.id === "a")!;
  expect(a.excluded).toBe(true);
  // `leaf` is only reachable through a, so it goes with it; b, c, d stay.
  expect(r.resolved.slugs.sort()).toEqual(["b", "c", "d", "index"]);
});

test("a leaf root does not fan out unless asked", () => {
  expect(resolveSubtree(MEMBER.id, "a", {})!.resolved.count).toBe(1);
  // From a: b, c, d and leaf are reachable; nothing links back to the index.
  expect(resolveSubtree(MEMBER.id, "a", { recurse: true })!.resolved.count).toBe(5);
});
