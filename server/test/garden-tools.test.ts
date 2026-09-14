/**
 * The toolbar's resolution rules, where they matter most: a URL from the
 * browser must never resolve outside the garden it belongs to, and the
 * frontmatter edits must leave a file a human wrote still readable.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "maurice-tools-"));
process.env.MAURICE_GARDENS_DIR = TMP;

const {
  resolveContentFile, confineToGarden, parseFlagsArray, parseFrontmatter,
  setFrontmatterField, publicState, togglePublic, deleteNote, reorderChildren,
} = await import("../src/services/gardenTools");

const garden = { root: path.join(TMP, "theo"), username: "theo" };

function write(rel: string, content: string) {
  const full = path.join(garden.root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

beforeAll(() => {
  write("notes/en/one.md", "---\ntitle: One\ndate: 2024-01-01\nflags: [public]\nlocale: en\n---\n\nBody. [[two]]\n");
  write("notes/en/two.md", "---\ntitle: Two\ndate: 2024-01-01\nflags: []\nlocale: en\n---\n\nIndex:\n\n[[two]]\nsee [[two]] inline\n");
  write("notes/fr/une.md", "---\ntitle: Une\ndate: 2024-01-01\nflags: []\nlocale: fr\n---\n\nCorps.\n");
  write("books/en/a-book.md", "---\ntitle: A book\nauthor: X\nflags: []\nlocale: en\n---\n\nBody.\n");
  write("pages/en/about.md", "---\ntitle: About\nlocale: en\n---\n\nAbout.\n");
  // A second garden, to prove one cannot reach into the other.
  fs.mkdirSync(path.join(TMP, "mei", "notes", "en"), { recursive: true });
  fs.writeFileSync(path.join(TMP, "mei", "notes", "en", "secret.md"), "---\ntitle: Secret\nflags: []\nlocale: en\n---\n\nMine.\n");
});
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

describe("resolving a URL", () => {
  test("strips the /g/<member> base and the locale", () => {
    expect(resolveContentFile(garden, "/g/theo/notes/one")?.filePath).toBe(path.join(garden.root, "notes/en/one.md"));
    expect(resolveContentFile(garden, "/notes/one")?.filePath).toBe(path.join(garden.root, "notes/en/one.md"));
    expect(resolveContentFile(garden, "/g/theo/fr/notes/une")?.filePath).toBe(path.join(garden.root, "notes/fr/une.md"));
    expect(resolveContentFile(garden, "/g/theo/notes/one?theme=terminal")?.filePath).toContain("one.md");
  });

  test("knows a resource, a standalone page, and an index that has no file", () => {
    expect(resolveContentFile(garden, "/resources/books/a-book")?.collection).toBe("books");
    expect(resolveContentFile(garden, "/fr/trouvailles/livres/a-book")).toBeNull(); // no fr book
    expect(resolveContentFile(garden, "/about")?.collection).toBe("pages");
    expect(resolveContentFile(garden, "/notes/")).toBeNull();
  });

  test("never resolves outside its own garden", () => {
    for (const p of [
      "/notes/../../mei/notes/en/secret",
      "/g/theo/notes/%2e%2e/%2e%2e/mei/notes/en/secret",
      "/notes/....//....//mei/notes/en/secret",
    ]) {
      expect(resolveContentFile(garden, p), p).toBeNull();
    }
    // The same note, asked for from the other garden's ref: not there.
    expect(resolveContentFile({ root: path.join(TMP, "mei"), username: "mei" }, "/g/theo/notes/one")).toBeNull();
  });

  test("confineToGarden refuses a path from outside", () => {
    expect(confineToGarden(garden, path.join(garden.root, "notes/en/one.md"))).toBeTruthy();
    expect(confineToGarden(garden, path.join(TMP, "mei/notes/en/secret.md"))).toBeNull();
    expect(confineToGarden(garden, "/etc/passwd")).toBeNull();
  });
});

describe("frontmatter", () => {
  test("reads flags in flow and block style", () => {
    expect(parseFlagsArray("flags: [public, moc]\n")).toEqual(["public", "moc"]);
    expect(parseFlagsArray("flags:\n  - public\n  - moc\n")).toEqual(["public", "moc"]);
    expect(parseFlagsArray("title: x\n")).toEqual([]);
  });

  test("reads quoted values", () => {
    expect(parseFrontmatter('---\ntitle: "A: colon"\nshared_twitter: true\n---\n').title).toBe("A: colon");
  });

  test("sets a field that exists and one that does not", () => {
    const before = "---\ntitle: One\n---\n\nBody.\n";
    expect(setFrontmatterField(before, "title", "Two")).toContain("title: Two");
    expect(setFrontmatterField(before, "shared_twitter", "true")).toContain("shared_twitter: true");
  });

  test("toggling public leaves the body untouched", () => {
    expect(publicState(garden, "/notes/one")?.public).toBe(true);
    expect(togglePublic(garden, "/notes/one")?.public).toBe(false);
    const after = fs.readFileSync(path.join(garden.root, "notes/en/one.md"), "utf8");
    expect(after).toContain("Body. [[two]]");
    expect(after).toContain("flags: []");
    expect(togglePublic(garden, "/notes/one")?.public).toBe(true);
  });

  test("a standalone page has no publication state", () => {
    expect(publicState(garden, "/about")).toBeNull();
  });
});

describe("destructive actions", () => {
  test("reorder only touches notes of this garden", () => {
    expect(reorderChildren(garden, [{ slug: "one", order: 10 }, { slug: "../../mei/notes/en/secret", order: 20 }]))
      .toMatchObject({ count: 1, updated: ["one"] });
    expect(fs.readFileSync(path.join(garden.root, "notes/en/one.md"), "utf8")).toMatch(/^order: 10$/m);
    expect(fs.readFileSync(path.join(TMP, "mei/notes/en/secret.md"), "utf8")).not.toMatch(/^order:/m);
  });

  test("delete takes the note and its index lines, not an inline mention", () => {
    expect(deleteNote(garden, "/notes/two")).toEqual({ deleted: "two" });
    expect(fs.existsSync(path.join(garden.root, "notes/en/two.md"))).toBe(false);
    const one = fs.readFileSync(path.join(garden.root, "notes/en/one.md"), "utf8");
    expect(one).toContain("Body. [[two]]"); // inline, kept
  });

  test("delete refuses what is not a note", () => {
    expect(deleteNote(garden, "/about")).toBeNull();
    expect(deleteNote(garden, "/resources/books/a-book")).toBeNull();
    expect(fs.existsSync(path.join(garden.root, "books/en/a-book.md"))).toBe(true);
  });
});
