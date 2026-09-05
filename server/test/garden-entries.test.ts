/**
 * The garden-entries scan: card + fiche of the same subject pair into one
 * entry, each face carrying its web path and repo-relative file.
 */

import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "maurice-entries-"));
process.env.MAURICE_GARDENS_DIR = TMP;

const { listGardenEntries } = await import("../data-api/services/gardenEntries");

afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

const garden = { root: path.join(TMP, "candide"), username: "candide" };

function write(rel: string, content: string) {
  const full = path.join(garden.root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

test("card and fiche pair into one entry; lone faces stand alone", () => {
  write(
    "series/fr/sugar.md",
    `---\ntitle: "Sugar"\ndate_watched: 2026-08-17\nimage: "/images/candide/resources/series/fr-sugar.jpg"\nlocale: "fr"\n---\nJohn Sugar.`,
  );
  write(
    "series/fr/sugar-fiche.md",
    `---\ntitle: Sugar\nresource_collection: series\nresource_id: sugar\ndate: '2026-08-15'\ntags: [tv]\nlocale: fr\nmeta:\n  year: 2024\n---\nNotes.`,
  );
  write(
    "series/fr/pluribus-fiche.md",
    `---\ntitle: Pluribus\nresource_collection: series\nresource_id: pluribus\ndate: '2026-08-31'\ntags: []\nlocale: fr\n---\n`,
  );
  write(
    "blog/fr/chine-2026.md",
    `---\ntitle: Voyage en Chine\ndate: 2026-08-19\ntags:\n  - trip\nlocale: fr\n---\nTexte.`,
  );
  write("pages/fr/accueil.md", `---\ntitle: Accueil\nlocale: fr\n---\n`);
  // An article share wrote this; nobody has written on it.
  write(
    "articles/fr/un-partage-fiche.md",
    `---\ntitle: Un partage\nresource_collection: articles\nresource_id: un-partage\ndate: '2026-09-01'\ntags: []\nlocale: fr\nmeta:\n  url: https://example.org/p\n  opened: false\n---\n`,
  );
  // An unopened fiche behind a published card: the card is a position taken.
  write(
    "articles/fr/promu.md",
    `---\ntitle: Promu\ndate: 2026-09-02\nlocale: fr\n---\nVerdict.`,
  );
  write(
    "articles/fr/promu-fiche.md",
    `---\ntitle: Promu\nresource_collection: articles\nresource_id: promu\ndate: '2026-09-01'\ntags: []\nlocale: fr\nmeta:\n  opened: false\n---\n`,
  );

  const entries = listGardenEntries(garden);

  // Opened unless the entry is nothing but an unopened fiche; a fiche without
  // the marker (everything written before it existed) is opened.
  expect(entries.find((e) => e.slug === "un-partage")!.opened).toBe(false);
  expect(entries.find((e) => e.slug === "promu")!.opened).toBe(true);
  expect(entries.find((e) => e.slug === "pluribus")!.opened).toBe(true);
  expect(entries.find((e) => e.slug === "chine-2026")!.opened).toBe(true);

  const sugar = entries.find((e) => e.slug === "sugar")!;
  expect(sugar.collection).toBe("series");
  // The card is the published face: its title and date win over the fiche's.
  expect(sugar.date).toBe("2026-08-17");
  expect(sugar.image).toContain("fr-sugar.jpg");
  // The fiche's tags survive when the card has none.
  expect(sugar.tags).toEqual(["tv"]);
  expect(sugar.card!.web_path).toBe("/g/candide/fr/trouvailles/series/sugar");
  expect(sugar.card!.file).toBe("series/fr/sugar.md");
  expect(sugar.fiche!.web_path).toBe("/g/candide/fr/fiches/series/sugar-fiche");
  expect(sugar.fiche!.file).toBe("series/fr/sugar-fiche.md");

  const pluribus = entries.find((e) => e.slug === "pluribus")!;
  expect(pluribus.card).toBeNull();
  expect(pluribus.fiche).not.toBeNull();

  const blog = entries.find((e) => e.slug === "chine-2026")!;
  expect(blog.card!.web_path).toBe("/g/candide/fr/blog/chine-2026");
  expect(blog.fiche).toBeNull();

  // Pages have no advertised URL — reachable through their file only.
  const page = entries.find((e) => e.slug === "accueil")!;
  expect(page.card!.web_path).toBeNull();
  expect(page.card!.file).toBe("pages/fr/accueil.md");

  // Newest first.
  const dates = entries.map((e) => e.date);
  expect(dates).toEqual([...dates].sort().reverse());
});
