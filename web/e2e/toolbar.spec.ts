/**
 * The owner's toolbar: the actions it performs, and the guarantee that they
 * only ever touch the caller's own garden.
 *
 * Since phase 2 these are authenticated routes on the Maurice server
 * (`/api/v1/garden-tools/*`), not dev-server middlewares. The member is the
 * session's, never the URL's — so the tests send the realistic path the
 * browser sends (`/g/theo/notes/…`) and check the file on disk.
 */
import { test, expect, api, notes, garden, type Member } from "./helpers";
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const G = "/g/theo";

function call(who: Member, route: string, body: unknown) {
  return api(who, `/api/v1/garden-tools/${route}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}
const post = (route: string, body: unknown) => call("theo", route, body);

function commits(member = "theo"): number {
  const r = spawnSync("git", ["rev-list", "--count", "HEAD"], { cwd: garden(member), encoding: "utf8" });
  return Number(r.stdout.trim() || 0);
}
function flags(slug: string): string[] {
  const m = notes.read(slug).match(/^flags:\s*\[(.*)\]/m);
  return m ? m[1]!.split(",").map((s) => s.trim()).filter(Boolean) : [];
}
function commitAll(message = "fixture") {
  spawnSync("git", ["add", "-A"], { cwd: garden() });
  spawnSync("git", ["commit", "-q", "-m", message], { cwd: garden() });
}

test.beforeEach(() => {
  notes.write("toolbar-note", "Toolbar note", "TOOLBAR-MARKER links to [[nara-deer]].", []);
  commitAll("toolbar fixture");
});
test.afterEach(() => {
  notes.remove("toolbar-note");
});

test("public-state reports the flag", async () => {
  const r = await post("public-state", { path: `${G}/notes/toolbar-note` });
  expect(r.status).toBe(200);
  expect(await r.json()).toMatchObject({ public: false });
  expect(await (await post("public-state", { path: `${G}/notes/nara-deer` })).json()).toMatchObject({ public: true });
});

test("public-state has nothing to say about a standalone page", async () => {
  expect((await post("public-state", { path: `${G}/about` })).status).toBe(404);
});

test("toggle-public flips the flag on disk and commits", async () => {
  const before = commits();
  const r = await post("toggle-public", { path: `${G}/notes/toolbar-note` });
  expect(r.status).toBe(200);
  expect(await r.json()).toMatchObject({ public: true });
  expect(flags("toolbar-note")).toContain("public");
  expect(commits()).toBe(before + 1);
  expect(await (await post("toggle-public", { path: `${G}/notes/toolbar-note` })).json()).toMatchObject({ public: false });
  expect(flags("toolbar-note")).not.toContain("public");
});

test("toggle-private flips the encrypted flag", async () => {
  expect(await (await post("private-state", { path: `${G}/notes/toolbar-note` })).json()).toMatchObject({ private: false });
  const r = await post("toggle-private", { path: `${G}/notes/toolbar-note` });
  expect(r.status).toBe(200);
  expect(await r.json()).toMatchObject({ private: true });
  expect(flags("toolbar-note")).toContain("encrypted");
  await post("toggle-private", { path: `${G}/notes/toolbar-note` });
  expect(flags("toolbar-note")).not.toContain("encrypted");
});

test("content-path resolves a URL to the garden file", async () => {
  const r = await post("content-path", { path: `${G}/notes/toolbar-note` });
  expect(r.status).toBe(200);
  const body = await r.json();
  expect(body.contentPath).toBe("notes/en/toolbar-note.md");
  expect(body.absPath).toBe(join(garden(), "notes", "en", "toolbar-note.md"));
});

// A wiki-link alone on its line is an index entry and goes with the note; an
// inline mention is prose and stays.
test("delete-note removes the file, its index lines, and commits", async () => {
  notes.write("doomed", "Doomed note", "Gone soon.", ["public"]);
  notes.write("toolbar-note", "Toolbar note", "Index:\n\n[[doomed]]\n[[nara-deer]]\n\nInline mention of [[doomed]] stays.", []);
  commitAll("doomed");
  const before = commits();
  const r = await post("delete-note", { path: `${G}/notes/doomed` });
  expect(r.status).toBe(200);
  expect(notes.exists("doomed")).toBe(false);
  const body = notes.read("toolbar-note");
  expect(body).not.toMatch(/^\[\[doomed\]\]$/m);
  expect(body).toContain("[[nara-deer]]");
  expect(body).toContain("Inline mention of [[doomed]] stays.");
  expect(commits()).toBe(before + 1);
});

test("delete-note refuses anything that is not a note", async () => {
  expect((await post("delete-note", { path: `${G}/about` })).status).toBe(404);
  expect(existsSync(join(garden(), "pages", "en", "about.md"))).toBe(true);
});

test("reorder-children writes `order:` into the children", async () => {
  const r = await post("reorder-children", { items: [{ slug: "kyoto-kids", order: 10 }, { slug: "nara-deer", order: 20 }] });
  expect(r.status).toBe(200);
  expect(await r.json()).toMatchObject({ count: 2 });
  expect(notes.read("kyoto-kids")).toMatch(/^order: 10$/m);
  expect(notes.read("nara-deer")).toMatch(/^order: 20$/m);
});

test("reorder-children ignores a slug that is not in the garden", async () => {
  const r = await post("reorder-children", { items: [{ slug: "../../escape", order: 1 }, { slug: "no-such-note", order: 2 }] });
  expect(r.status).toBe(200);
  expect(await r.json()).toMatchObject({ count: 0 });
});

test.afterAll(() => {
  // reorder may have touched these; put the seed order back
  for (const [slug, order] of [["nara-deer", 1], ["kyoto-kids", 2]] as const) {
    const f = join(garden(), "notes", "en", `${slug}.md`);
    writeFileSync(f, readFileSync(f, "utf8").replace(/^order: \d+$/m, `order: ${order}`));
  }
});

test.describe("the toolbar in the page", () => {
  test("the public switch flips the flag", async ({ as }) => {
    const page = await as("theo");
    await page.goto(`${G}/notes/toolbar-note`);
    // The checkbox itself is `display: none`; the switch is its label.
    const sw = page.locator("#dev-public-wrap");
    await expect(sw).toBeVisible();
    await expect(page.locator("#dev-public")).not.toBeChecked();
    await sw.click();
    await expect.poll(() => flags("toolbar-note").includes("public"), { timeout: 5000 }).toBe(true);
    await sw.click();
    await expect.poll(() => flags("toolbar-note").includes("public"), { timeout: 5000 }).toBe(false);
  });

  test("the delete button is offered on a note and not on a page", async ({ as }) => {
    const page = await as("theo");
    await page.goto(`${G}/notes/toolbar-note`);
    await expect(page.locator("#dev-delete")).toBeVisible();
    await page.goto(`${G}/about`);
    await expect(page.locator("#dev-delete")).toBeHidden();
  });
});

test.describe("another member", () => {
  test("cannot reach into this garden, whatever path they send", async () => {
    const before = notes.read("nara-deer");
    for (const route of ["toggle-public", "toggle-private", "delete-note"]) {
      const r = await call("mei", route, { path: `${G}/notes/nara-deer` });
      // Resolved in MEI's own garden, where no such note exists.
      expect(r.status, route).toBe(404);
    }
    expect(notes.read("nara-deer")).toBe(before);
    expect(notes.exists("nara-deer")).toBe(true);
  });

  test("acts on their own garden instead", async () => {
    const r = await call("mei", "public-state", { path: "/g/mei/notes/hello" });
    expect(r.status).toBe(200);
    expect((await r.json()).file).toContain(join("gardens", "mei"));
  });
});

test("a guest has no garden to edit", async () => {
  expect((await call("visitor", "public-state", { path: `${G}/notes/nara-deer` })).status).toBe(403);
});

test("an anonymous caller is refused", async () => {
  const r = await api(null, "/api/v1/garden-tools/toggle-public", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: `${G}/notes/nara-deer` }),
  });
  expect(r.status).toBe(401);
});
