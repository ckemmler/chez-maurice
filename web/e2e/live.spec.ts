/**
 * The garden is live: a file written, edited or removed shows on the next
 * request. No restart, no rebuild — the constraint the whole chantier keeps.
 */
import { test, expect, notes, garden } from "./helpers";
import { join } from "node:path";
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";

const G = "/g/theo";

test.afterEach(() => {
  notes.remove("live-note");
  notes.remove("note-vivante", "fr");
  try { unlinkSync(join(garden(), "books", "en", "live-book.md")); } catch {}
});

test("a new note is served on the next request", async ({ as }) => {
  const page = await as("theo");
  expect((await page.goto(`${G}/notes/live-note`))?.status()).toBe(404);
  notes.write("live-note", "A note written just now", "LIVE-MARKER-1 first version");
  const res = await page.goto(`${G}/notes/live-note`);
  expect(res?.status()).toBe(200);
  expect(await res!.text()).toContain("LIVE-MARKER-1");
  expect(await res!.text()).toContain("A note written just now");
});

test("an edited note shows its new title and body", async ({ as }) => {
  const page = await as("theo");
  notes.write("live-note", "Before the edit", "LIVE-MARKER-2 before");
  expect(await (await page.goto(`${G}/notes/live-note`))!.text()).toContain("Before the edit");
  notes.write("live-note", "After the edit", "LIVE-MARKER-2 after");
  const html = await (await page.goto(`${G}/notes/live-note`))!.text();
  expect(html).toContain("After the edit");
  expect(html).toContain("LIVE-MARKER-2 after");
  expect(html).not.toContain("LIVE-MARKER-2 before");
});

test("a removed note is gone from the detail page and the index", async ({ as }) => {
  const page = await as("theo");
  notes.write("live-note", "Soon removed", "LIVE-MARKER-3");
  expect((await page.goto(`${G}/notes/live-note`))?.status()).toBe(200);
  expect(await (await page.goto(`${G}/notes/`))!.text()).toContain("Soon removed");
  notes.remove("live-note");
  expect((await page.goto(`${G}/notes/live-note`))?.status()).toBe(404);
  expect(await (await page.goto(`${G}/notes/`))!.text()).not.toContain("Soon removed");
});

test("the French tree is live too", async ({ as }) => {
  const page = await as("theo");
  notes.write("note-vivante", "Une note vivante", "MARQUEUR-VIVANT", ["public"], "fr");
  const html = await (await page.goto(`${G}/fr/notes/note-vivante`))!.text();
  expect(html).toContain("Une note vivante");
  expect(html).toContain("MARQUEUR-VIVANT");
});

test("a new resource (book) appears in its list and detail without a restart", async ({ as }) => {
  const page = await as("theo");
  mkdirSync(join(garden(), "books", "en"), { recursive: true });
  writeFileSync(join(garden(), "books", "en", "live-book.md"),
    `---\ntitle: A book added live\nauthor: Nobody\ndate_read: 2024-09-01\nstatus: read\nflags: [public]\nlocale: en\n---\n\nLIVE-BOOK-MARKER\n`);
  await expect.poll(async () => (await (await page.goto(`${G}/resources/books/`))!.text()).includes("A book added live"), { timeout: 15_000 }).toBe(true);
  const html = await (await page.goto(`${G}/resources/books/live-book`))!.text();
  expect(html).toContain("LIVE-BOOK-MARKER");
});
