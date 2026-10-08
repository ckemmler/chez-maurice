/**
 * The shelf: one list of entries, each with its source, the member's side and
 * the shared side, read from where they live (markdown, life.db, the library).
 * Run with `bun test`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "maurice-shelf-"));
process.env.MAURICE_GARDENS_DIR = path.join(TMP, "gardens");

// Highlights and the reading position go to life.db in the preload's throwaway
// data dir. Not a dir of this suite's own: the modules are singletons shared
// with garden-articles-read.test.ts, and whichever suite bound them first
// would take the other's database away when it cleaned up.
const { createHighlight } = await import("../data-api/services/highlights");
const { createArticleHighlight } = await import("../data-api/services/articleHighlights");
const { updateReadingProgress } = await import("../data-api/services/bookmarks");

const { listShelf, getShelfEntry, isWritten } = await import("../data-api/services/gardenShelf");
const { MEMBER } = await import("./_member");
const { default: db } = await import("../src/db");

const garden = { root: path.join(process.env.MAURICE_GARDENS_DIR!, MEMBER.username), username: MEMBER.username };

function write(rel: string, content: string) {
  const full = path.join(garden.root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

const SYNOPSIS = "John Sugar, détective privé à Los Angeles, enquête sur la disparition d'Olivia Siegel.";

/** The household library, as Calibre would list it. */
const BOOKS = [
  { id: 7, title: "Humus", authors: ["Gaspard Kœnig"], tags: [], formats: ["EPUB"], series: null,
    description: null, bookPath: "Gaspard Koenig/Humus (7)", added: "2026-08-01T10:00:00+00:00" },
  { id: 9, title: "River Town", authors: ["Peter Hessler"], tags: ["china"], formats: ["EPUB"], series: null,
    description: null, bookPath: "Peter Hessler/River Town (9)", added: "2026-07-01T10:00:00+00:00" },
];

beforeAll(() => {
  // A book read in the app: a card that is only identity, a fiche with prose,
  // a dated note, a quote with its page, and a résonance.
  write("books/fr/humus.md",
    `---\ntitle: Humus\nauthor: Gaspard Koenig\ndate_read: '2026-08-23'\nstatus: abandoned\nflags: []\nrating: 2\nlocale: fr\n---\n`);
  write("books/fr/humus-fiche.md",
    `---\ntitle: Humus\nresource_collection: books\nresource_id: humus\ndate: '2026-08-23'\ntags: []\nlocale: fr\nmeta:\n  author: Gaspard Kœnig\n---\n\n**Verdict — abandonné**\n\n## Ce que la lecture éclaire\n\nDu sol.\n\n## Commentaire\n\n2026-09-28 — Arthur = caricature, mais tendre.\n\n2026-10-02 — p. 112 :\n\n> Le ver de terre est le seul révolutionnaire.\n\nVraiment ?\n\n## Résonances\n\n2026-09-04 — de [[being-you-fiche|Being You]] :\n\n> Le corps avant l'esprit.\n\nChez les deux.\n`);
  write("books/fr/humus-fiche/_fragments/001.frag", `---\nsummary: "Clés du chapitre 1"\n---\n## Clés\n\nLe sol.`);

  // A book read on paper, written about and published.
  write("books/en/being-you.md",
    `---\ntitle: Being You\nauthor: Anil Seth\nflags:\n  - public\nrating: 5\nlocale: en\n---\n# Predicting ourselves\n\nSeth, with [[humus-fiche|Humus]] in mind and [[sugar|Sugar]] too.\n`);

  // A series whose card holds the provider's synopsis and nothing else.
  write("series/fr/sugar.md", `---\ntitle: Sugar\nflags: []\nlocale: fr\n---\n${SYNOPSIS}\n`);
  write("series/fr/sugar-fiche.md",
    `---\ntitle: Sugar\nresource_collection: series\nresource_id: sugar\ndate: '2026-08-15'\ntags: []\nlocale: fr\nmeta:\n  overview: "${SYNOPSIS}"\n---\n\nNotes.\n`);

  // A film with a draft: no source, the two faces only.
  write("movies/fr/perfect-days.md",
    `---\ntitle: Perfect Days\ndirector: Wim Wenders\nflags: []\nlocale: fr\n---\nUn homme nettoie des toilettes.\n`);

  // An article captured and untouched; a bookmark the site refused.
  write("articles/fr/microrobots-fiche.md",
    `---\ntitle: Microrobots\nresource_collection: articles\nresource_id: microrobots\ndate: '2026-10-07'\ntags: []\nlocale: fr\nmeta:\n  url: https://example.org/m\n  publication: The New York Times\n  word_count: 1085\n  excerpt: Atomic Machines.\n  opened: false\n---\n\n> Atomic Machines.\n`);
  write("articles/fr/microrobots-fiche/_fragments/001.frag", `---\nsummary: "Texte intégral — The New York Times"\n---\nThe text.`);
  write("articles/fr/soil-fiche.md",
    `---\ntitle: Soil\nresource_collection: articles\nresource_id: soil\ndate: '2026-09-30'\ntags: []\nlocale: fr\nmeta:\n  url: https://example.org/s\n  status: needs-capture\n---\n\n> An excerpt.\n\n## Commentaire\n\nLu chez L.\n`);

  // One film in two locales, under two slugs: one subject.
  write("movies/fr/la-cite-perdue-de-z.md",
    `---\ntitle: La Cité perdue de Z\ndirector: James Gray\nflags: []\nlocale: fr\ntranslationKey: the-lost-city-of-z\n---\nLent et beau.\n`);
  write("movies/en/the-lost-city-of-z.md",
    `---\ntitle: The Lost City of Z\ndirector: James Gray\nflags:\n  - public\nlocale: en\ntranslationKey: the-lost-city-of-z\n---\nSlow and beautiful.\n`);

  // An album: nothing to read, an artist for a byline, a listening date.
  write("music/fr/kind-of-blue.md",
    `---\ntitle: Kind of Blue\nartist: Miles Davis\ndate_listened: '2026-10-05'\nflags: []\nrating: 5\nlocale: fr\n---\nLe disque qu'on met quand on ne sait pas quoi mettre.\n`);

  // What the shelf leaves out.
  write("notes/fr/une-note.md", `---\ntitle: Une note\nlocale: fr\n---\nTexte.`);
  write("people/fr/arnaud-fiche.md", `---\ntitle: Arnaud\nresource_collection: people\nlocale: fr\n---\n`);
  write("blog/fr/mailfence.md", `---\ntitle: Pourquoi je quitte Mailfence\ndate: 2026-10-01\nflags:\n  - public\nlocale: fr\n---\nParce que.`);

  createHighlight(MEMBER.id, 7, { chapterSlug: "0008-chapitre-vii", quote: "en cessant d'enlever", note: "C'est tout le livre.", startOffset: 1, endOffset: 9 });
  createArticleHighlight(MEMBER.id, "fr", "microrobots", { quote: "a matter compiler", startOffset: 1, endOffset: 9 });
  updateReadingProgress(MEMBER.id, 7, 8, "0008-chapitre-vii", "full", 0.4);
  db.run(`UPDATE users SET notes_domain = 'candide.me' WHERE id = ?`, [MEMBER.id]);
});

afterAll(() => {
  db.run(`UPDATE users SET notes_domain = NULL WHERE id = ?`, [MEMBER.id]);
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe("the list", () => {
  test("holds the kinds the shelf shows, and the books nothing is written on", async () => {
    const { kinds, entries } = await listShelf(MEMBER.id, garden, BOOKS as any);
    const ids = entries.map((e) => e.id);
    expect(ids).toContain("books/fr/humus");
    expect(ids).toContain("calibre/9");           // River Town: in the library, no entry
    expect(ids).not.toContain("calibre/7");       // Humus is the garden entry
    expect(ids.some((i) => i.startsWith("notes/") || i.startsWith("people/"))).toBe(false);
    expect(entries.find((e) => e.id === "blog/fr/mailfence")!.kind).toBe("posts");
    expect(kinds.find((k) => k.kind === "books")!.count).toBe(3);
    expect(kinds.some((k) => k.kind === "games")).toBe(false);
  });

  test("a book in the library carries its source and where the member is", async () => {
    const { entries } = await listShelf(MEMBER.id, garden, BOOKS as any);
    const humus = entries.find((e) => e.id === "books/fr/humus")!;
    expect(humus.source).toMatchObject({ type: "book", book_id: 7 });
    expect((humus.source as any).progress.chapter_slug).toBe("0008-chapitre-vii");
    expect(humus.byline).toBe("Gaspard Koenig");
    expect(humus.rating).toBe(2);
    expect(humus.status).toBe("abandoned");
    // prose + note + quote + résonance + one fragment + one highlight
    expect(humus.mine).toEqual({ notes: 6, opened: true });
    // The card is identity: nothing is written on the shared side.
    expect(humus.shared).toBeNull();

    const river = entries.find((e) => e.id === "calibre/9")!;
    expect(river).toMatchObject({ collection: null, slug: null, title: "River Town", byline: "Peter Hessler", mine: null, shared: null });
    expect(river.source).toMatchObject({ type: "book", book_id: 9, progress: null });
  });

  test("the shared side starts when the member writes, not when the card exists", async () => {
    const { entries } = await listShelf(MEMBER.id, garden, BOOKS as any);
    const by = (id: string) => entries.find((e) => e.id === id)!;
    expect(by("series/fr/sugar").shared).toBeNull();                       // the provider's synopsis
    expect(by("series/fr/sugar").mine).toEqual({ notes: 1, opened: true });
    expect(by("movies/fr/perfect-days").shared).toEqual({ state: "draft" });
    expect(by("movies/fr/perfect-days").source).toBeNull();
    expect(by("movies/fr/perfect-days").byline).toBe("Wim Wenders");
    expect(by("books/en/being-you").shared).toEqual({ state: "published" });
    expect(by("books/en/being-you").source).toBeNull();                    // read on paper
  });

  test("an article is captured or a link only; an untouched one holds no notes but its highlights", async () => {
    const { entries } = await listShelf(MEMBER.id, garden, BOOKS as any);
    const micro = entries.find((e) => e.id === "articles/fr/microrobots")!;
    expect(micro.source).toEqual({ type: "article", url: "https://example.org/m", captured: true, word_count: 1085, reading_minutes: 5 });
    expect(micro.mine).toEqual({ notes: 1, opened: false });
    expect(micro.byline).toBe("The New York Times");
    const soil = entries.find((e) => e.id === "articles/fr/soil")!;
    expect((soil.source as any).captured).toBe(false);
    expect(soil.mine).toEqual({ notes: 1, opened: true });               // the note; the excerpt is not the member's
  });
});

test("an album is an entry like the others", async () => {
  const { kinds, entries } = await listShelf(MEMBER.id, garden, BOOKS as any);
  expect(entries.find((e) => e.id === "music/fr/kind-of-blue")).toMatchObject({
    kind: "music", byline: "Miles Davis", date: "2026-10-05", rating: 5,
    source: null, mine: null, shared: { state: "draft" },
  });
  expect(kinds.map((k) => k.kind)).toContain("music");
});

describe("translations", () => {
  test("a subject in two locales is one row, in the member's language, the other riding along", async () => {
    const { updateUserPreferences } = await import("../src/services/users");
    updateUserPreferences(MEMBER.id, { locale: "fr" });
    const { kinds, entries } = await listShelf(MEMBER.id, garden, BOOKS as any);
    const z = entries.filter((e) => e.title.includes("perdue") || e.title.includes("Lost City"));
    expect(z).toHaveLength(1);
    expect(z[0]).toMatchObject({
      id: "movies/fr/la-cite-perdue-de-z", locale: "fr", shared: { state: "draft" },
      translations: [{ id: "movies/en/the-lost-city-of-z", locale: "en", shared: { state: "published" } }],
    });
    expect(kinds.find((k) => k.kind === "movies")!.count).toBe(2);   // Perfect Days, and Z once

    updateUserPreferences(MEMBER.id, { locale: "en" });
    const again = (await listShelf(MEMBER.id, garden, BOOKS as any)).entries;
    expect(again.find((e) => e.id === "movies/en/the-lost-city-of-z")!.translations)
      .toEqual([{ id: "movies/fr/la-cite-perdue-de-z", locale: "fr", shared: { state: "draft" } }]);
    expect(again.some((e) => e.id === "movies/fr/la-cite-perdue-de-z")).toBe(false);
  });

  test("the page of one locale names the others", async () => {
    const e = (await getShelfEntry(MEMBER.id, garden, "movies", "fr", "la-cite-perdue-de-z", BOOKS as any))!;
    expect(e.translations).toEqual([{ id: "movies/en/the-lost-city-of-z", locale: "en", shared: { state: "published" } }]);
    expect((await getShelfEntry(MEMBER.id, garden, "books", "fr", "humus", BOOKS as any))!.translations).toEqual([]);
  });
});

describe("one entry", () => {
  test("my side: prose, dated items newest first, then what carries no date", async () => {
    const e = (await getShelfEntry(MEMBER.id, garden, "books", "fr", "humus", BOOKS as any))!;
    expect(e.mine!.prose).toBe("**Verdict — abandonné**\n\n## Ce que la lecture éclaire\n\nDu sol.");
    expect(e.mine!.file).toBe("books/fr/humus-fiche.md");
    const items = e.mine!.items;
    expect(items.map((i) => i.kind)).toEqual(["highlight", "quote", "note", "resonance", "fragment"]);
    expect(items[0]).toMatchObject({ quote: "en cessant d'enlever", text: "C'est tout le livre.", where: { chapter_slug: "0008-chapitre-vii", view: "full" } });
    expect(items[1]).toMatchObject({ date: "2026-10-02", quote: "Le ver de terre est le seul révolutionnaire.", text: "Vraiment ?", where: { page: "112" } });
    expect(items[2]).toMatchObject({ date: "2026-09-28", text: "Arthur = caricature, mais tendre.", quote: null });
    expect(items[3]).toMatchObject({
      date: "2026-09-04", quote: "Le corps avant l'esprit.", text: "Chez les deux.",
      from: { label: "Being You", entry_id: "books/en/being-you", published_url: "https://candide.me/resources/books/being-you" },
    });
    expect(items[4]).toMatchObject({ id: "f:001", summary: "Clés du chapitre 1" });
    expect(e.shared).toBeNull();
  });

  test("shared side: the body, its address, and which citations are real links", async () => {
    const e = (await getShelfEntry(MEMBER.id, garden, "books", "en", "being-you", BOOKS as any))!;
    expect(e.shared).toMatchObject({
      state: "published", file: "books/en/being-you.md", title: "Predicting ourselves",
      public_url: "https://candide.me/resources/books/being-you",
    });
    expect(e.shared!.links).toEqual([
      // Humus has no published page: a private reference.
      { basename: "humus-fiche", label: "Humus", entry_id: "books/fr/humus", published_url: null },
      { basename: "sugar", label: "Sugar", entry_id: "series/fr/sugar", published_url: null },
    ]);
    expect(e.mine).toBeNull();
  });

  test("an article's captured text is its source, not an item; unknown entries are null", async () => {
    const e = (await getShelfEntry(MEMBER.id, garden, "articles", "fr", "microrobots", BOOKS as any))!;
    expect(e.mine!.items.map((i) => i.kind)).toEqual(["highlight"]);
    expect(e.mine!.prose).toBe("");
    const soil = (await getShelfEntry(MEMBER.id, garden, "articles", "fr", "soil", BOOKS as any))!;
    expect(soil.mine!.items).toEqual([{ kind: "note", id: null, date: null, text: "Lu chez L.", quote: null, where: null }]);
    expect(await getShelfEntry(MEMBER.id, garden, "books", "fr", "nope", BOOKS as any)).toBeNull();
    expect(await getShelfEntry(MEMBER.id, garden, "notes", "fr", "une-note", BOOKS as any)).toBeNull();
  });
});

test("isWritten: empty, synopsis and scraped article are not the member's words", () => {
  const face = (fm: any, body: string) => ({ fm, meta: fm.meta ?? {}, body });
  expect(isWritten("books", null, null)).toBe(false);
  expect(isWritten("books", face({}, "  \n"), null)).toBe(false);
  expect(isWritten("series", face({}, SYNOPSIS), face({ meta: { overview: SYNOPSIS } }, ""))).toBe(false);
  expect(isWritten("articles", face({ url: "https://x" }, "The article."), null)).toBe(false);
  expect(isWritten("movies", face({}, "Mon avis."), face({ meta: { overview: SYNOPSIS } }, ""))).toBe(true);
});
