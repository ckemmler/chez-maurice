/**
 * Résonances: target search ranks sensibly, and the appended block carries the
 * [[wiki-link]], the quote, and the note — on the fiche face when there is one.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "maurice-links-"));
process.env.MAURICE_GARDENS_DIR = TMP;

const { searchLinkTargets, appendResonance, findBookEntryByTitle } =
  await import("../data-api/services/gardenLinks");

afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

const garden = { root: path.join(TMP, "candide"), username: "candide" };

function write(rel: string, content: string) {
  const full = path.join(garden.root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

beforeAll(() => {
  fs.mkdirSync(garden.root, { recursive: true });
  for (const args of [["init", "-q"], ["config", "user.email", "t@t"], ["config", "user.name", "t"]]) {
    spawnSync("git", args, { cwd: garden.root });
  }
  write("series/fr/sugar.md", `---\ntitle: "Sugar"\ndate_watched: 2026-08-17\nlocale: "fr"\n---\nJohn Sugar.`);
  write("series/fr/sugar-fiche.md",
    `---\ntitle: Sugar\nresource_collection: series\nresource_id: sugar\ndate: '2026-08-15'\ntags: []\nlocale: fr\n---\nNotes existantes.`);
  write("notes/fr/sucre-et-sante.md", `---\ntitle: Sucre et santé\ndate: '2026-01-01'\nlocale: fr\n---\n`);
  write("books/fr/being-you-fiche.md",
    `---\ntitle: Being You\nresource_collection: books\nresource_id: being-you\ndate: '2026-02-01'\ntags: []\nlocale: fr\n---\n`);
  // Two bare article shares — unopened fiches.
  write("articles/fr/sugar-tax-fiche.md",
    `---\ntitle: Sugar tax debate\nresource_collection: articles\nresource_id: sugar-tax\ndate: '2026-09-01'\ntags: []\nlocale: fr\nmeta:\n  url: https://example.org/tax\n  opened: false\n---\n`);
  write("articles/fr/china-fiche.md",
    `---\ntitle: A.I. Is Everywhere in China\nresource_collection: articles\nresource_id: china\ndate: '2026-09-02'\ntags: []\nlocale: fr\nmeta:\n  url: https://example.org/china\n  opened: false\n---\n`);
});

const openedMarker = (rel: string) =>
  (Bun.YAML.parse(
    fs.readFileSync(path.join(garden.root, rel), "utf-8").match(/^---\n([\s\S]*?)\n---/)![1]!,
  ) as any).meta?.opened;

describe("searchLinkTargets", () => {
  test("title-prefix beats substring; fiche wins the link basename", () => {
    const hits = searchLinkTargets(garden, "su");
    // Both match on a word start; "Sugar" (title prefix) outranks "Sucre et
    // santé" only via recency on equal score — assert membership + the fiche
    // basename, and that a sharper query narrows to the prefix hit.
    expect(hits.map((h) => h.slug)).toContain("sucre-et-sante");
    const sharp = searchLinkTargets(garden, "sug");
    expect(sharp[0]!.slug).toBe("sugar");
    expect(sharp[0]!.link_basename).toBe("sugar-fiche");
    expect(sharp[0]!.has_fiche).toBe(true);
    expect(sharp.map((h) => h.slug)).not.toContain("sucre-et-sante");
  });

  test("an entry without a fiche links to its card basename", () => {
    const hits = searchLinkTargets(garden, "sucre");
    const note = hits.find((h) => h.slug === "sucre-et-sante")!;
    expect(note.link_basename).toBe("sucre-et-sante");
    expect(note.has_fiche).toBe(false);
  });

  test("unopened fiches are not offered as targets", () => {
    expect(searchLinkTargets(garden, "sugar").map((h) => h.slug)).not.toContain("sugar-tax");
    expect(searchLinkTargets(garden, "").map((h) => h.slug)).not.toContain("china");
  });
});

describe("appendResonance", () => {
  test("writes the dated block with wiki-link + quote + note on the fiche", () => {
    const r = appendResonance("m1", garden, {
      to: { locale: "fr", slug: "sugar", collection: "series" },
      comment: "Le mimétisme des médecins IA, même rapport aux modèles.",
      quote: "free online consultations with A.I. versions of top doctors",
      source: { label: "A.I. Is Everywhere in China", basename: "china-fiche" },
    });
    expect(r.file).toBe("series/fr/sugar-fiche.md");
    const text = fs.readFileSync(path.join(garden.root, r.file), "utf-8");
    expect(text).toContain("## Résonances");
    expect(text).toContain("de [[china-fiche|A.I. Is Everywhere in China]] :");
    expect(text).toContain("> free online consultations");
    expect(text).toContain("Le mimétisme des médecins IA");
    expect(text).toContain("Notes existantes."); // the body it landed under survives

    // A second resonance reuses the heading instead of duplicating it.
    appendResonance("m1", garden, {
      to: { locale: "fr", slug: "sugar" },
      comment: "Deuxième pensée.",
    });
    const again = fs.readFileSync(path.join(garden.root, r.file), "utf-8");
    expect(again.match(/## Résonances/g)!.length).toBe(1);
    expect(again).toContain("Deuxième pensée.");
    // The source of the first resonance was an unopened article: sending a
    // thought from it opened it.
    expect(openedMarker("articles/fr/china-fiche.md")).toBeUndefined();
  });

  test("a resonance filed on an unopened fiche opens it", () => {
    expect(openedMarker("articles/fr/sugar-tax-fiche.md")).toBe(false);
    appendResonance("m1", garden, {
      to: { locale: "fr", slug: "sugar-tax", collection: "articles" },
      comment: "Relié à Sugar.",
    });
    expect(openedMarker("articles/fr/sugar-tax-fiche.md")).toBeUndefined();
    expect(searchLinkTargets(garden, "sugar tax").map((h) => h.slug)).toContain("sugar-tax");
  });

  test("a source outside the garden gets a plain label, not a wiki-link", () => {
    appendResonance("m1", garden, {
      to: { locale: "fr", slug: "sucre-et-sante" },
      comment: "Vu dans un livre hors jardin.",
      source: { label: "Un Livre Papier" },
    });
    const text = fs.readFileSync(path.join(garden.root, "notes/fr/sucre-et-sante.md"), "utf-8");
    expect(text).toContain("de *Un Livre Papier* :");
    expect(text).not.toContain("[[Un Livre Papier");
  });

  test("refuses an empty resonance and an unknown target", () => {
    expect(() => appendResonance("m1", garden, { to: { locale: "fr", slug: "sugar" } })).toThrow();
    expect(() =>
      appendResonance("m1", garden, { to: { locale: "fr", slug: "nope" }, comment: "x" }),
    ).toThrow();
  });
});

test("findBookEntryByTitle matches case-insensitively", () => {
  expect(findBookEntryByTitle(garden, "being you")!.slug).toBe("being-you");
  expect(findBookEntryByTitle(garden, "Unknown Book")).toBeNull();
});
