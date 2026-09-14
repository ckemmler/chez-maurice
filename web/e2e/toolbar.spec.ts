/**
 * The owner's toolbar actions, as the engine implements them today (the
 * /_dev/* routes reached through the proxy under the member's base). Phase 2
 * moves them to the Bun API; these tests then change their URL, not their
 * expectations: the file on disk is what they check.
 */
import { test, expect, api, notes, garden } from "./helpers";
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const G = "/g/theo";

function post(path: string, body: unknown) {
  return api("theo", `${G}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}
function commits(): number {
  const r = spawnSync("git", ["rev-list", "--count", "HEAD"], { cwd: garden(), encoding: "utf8" });
  return Number(r.stdout.trim() || 0);
}
function flags(slug: string): string[] {
  const m = notes.read(slug).match(/^flags:\s*\[(.*)\]/m);
  return m ? m[1]!.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

test.beforeEach(() => {
  notes.write("toolbar-note", "Toolbar note", "TOOLBAR-MARKER links to [[nara-deer]].", []);
  spawnSync("git", ["add", "-A"], { cwd: garden() });
  spawnSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@example.com", "commit", "-q", "-m", "toolbar fixture"], { cwd: garden() });
});
test.afterEach(() => {
  notes.remove("toolbar-note");
});

test("public-state reports the flag", async () => {
  const r = await post("/_dev/public-state", { path: "/notes/toolbar-note" });
  expect(r.status).toBe(200);
  expect(await r.json()).toMatchObject({ public: false });
  const r2 = await post("/_dev/public-state", { path: "/notes/nara-deer" });
  expect(await r2.json()).toMatchObject({ public: true });
});

test("toggle-public flips the flag on disk and commits", async () => {
  const before = commits();
  const r = await post("/_dev/toggle-public", { path: "/notes/toolbar-note" });
  expect(r.status).toBe(200);
  expect(await r.json()).toMatchObject({ public: true });
  expect(flags("toolbar-note")).toContain("public");
  expect(commits()).toBe(before + 1);
  const back = await post("/_dev/toggle-public", { path: "/notes/toolbar-note" });
  expect(await back.json()).toMatchObject({ public: false });
  expect(flags("toolbar-note")).not.toContain("public");
});

test("toggle-private flips the encrypted flag", async () => {
  expect((await (await post("/_dev/private-state", { path: "/notes/toolbar-note" })).json())).toMatchObject({ private: false });
  const r = await post("/_dev/toggle-private", { path: "/notes/toolbar-note" });
  expect(r.status).toBe(200);
  expect(await r.json()).toMatchObject({ private: true });
  expect(flags("toolbar-note")).toContain("encrypted");
  await post("/_dev/toggle-private", { path: "/notes/toolbar-note" });
  expect(flags("toolbar-note")).not.toContain("encrypted");
});

test("content-path resolves a URL to the garden file", async () => {
  const r = await post("/_dev/content-path", { path: "/notes/toolbar-note" });
  expect(r.status).toBe(200);
  const body = await r.json();
  expect(body.contentPath).toBe("notes/en/toolbar-note.md");
});

// Today only a wiki-link standing alone on its line (a MOC index entry) is
// stripped; an inline mention stays. Pinned as is.
test("delete-note removes the file, its index lines, and commits", async () => {
  notes.write("doomed", "Doomed note", "Gone soon.", ["public"]);
  notes.write("toolbar-note", "Toolbar note", "Index:\n\n[[doomed]]\n[[nara-deer]]\n\nInline mention of [[doomed]] stays.", []);
  // Notes are committed on write in a real garden. (An UNtracked note deleted
  // through the toolbar makes `git add -A -- <gone path>` fail and the whole
  // commit is skipped — best-effort by design, but worth knowing.)
  spawnSync("git", ["add", "-A"], { cwd: garden() });
  spawnSync("git", ["commit", "-q", "-m", "doomed"], { cwd: garden() });
  const before = commits();
  const r = await post("/_dev/delete-note", { path: "/notes/doomed" });
  expect(r.status).toBe(200);
  expect(notes.exists("doomed")).toBe(false);
  const body = notes.read("toolbar-note");
  expect(body).not.toMatch(/^\[\[doomed\]\]$/m);
  expect(body).toContain("[[nara-deer]]");
  expect(body).toContain("Inline mention of [[doomed]] stays.");
  expect(commits()).toBe(before + 1);
});

test("delete-note refuses anything that is not a note", async () => {
  const r = await post("/_dev/delete-note", { path: "/about" });
  expect(r.status).toBe(404);
  expect(existsSync(join(garden(), "pages", "en", "about.md"))).toBe(true);
});

// KNOWN BUG: reorder-children resolves slugs under web/src/content (empty
// since the gardens moved out), so it answers success and writes nothing.
test("reorder-children writes `order:` into the children", async () => {
  test.fail();
  const r = await post("/_dev/reorder-children", { items: [{ slug: "kyoto-kids", order: 10 }, { slug: "nara-deer", order: 20 }] });
  expect(r.status).toBe(200);
  expect(notes.read("kyoto-kids")).toMatch(/^order: 10$/m);
  expect(notes.read("nara-deer")).toMatch(/^order: 20$/m);
});

test.afterAll(() => {
  // reorder may have touched these; put the seed order back
  for (const [slug, order] of [["nara-deer", 1], ["kyoto-kids", 2]] as const) {
    const f = join(garden(), "notes", "en", `${slug}.md`);
    writeFileSync(f, readFileSync(f, "utf8").replace(/^order: \d+$/m, `order: ${order}`));
  }
});

// KNOWN BUG: the toolbar's own fetches go to root-absolute /_dev/* (no base),
// which the proxy hands to the DEFAULT garden's engine, not this member's.
// Clicking the public switch in Théo's garden therefore fails. Phase 2 fixes
// this by construction (the API is base-aware).
test("the public switch in the page flips the flag", async ({ as }) => {
  test.fail();
  const page = await as("theo");
  await page.goto(`${G}/notes/toolbar-note`);
  const sw = page.locator("#dev-public");
  await expect(sw).toBeVisible();
  await sw.click();
  await expect.poll(() => flags("toolbar-note").includes("public"), { timeout: 5000 }).toBe(true);
});
