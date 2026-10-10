/**
 * Writing on an entry: a note on the member's side, the body of the shared
 * side, publishing — each read back through the shelf, since that is the only
 * promise that matters: what is written is what is shown.
 * Run with `bun test`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "maurice-write-"));
process.env.MAURICE_GARDENS_DIR = path.join(TMP, "gardens");

const { addNote, noteBlock, withNote, writeShared, setPublished, setDeployRunner, deployState, requestDeploy, deleteEntry, archiveEntry, completeCard, completeCover, setCover, EntryWriteError } =
  await import("../data-api/services/gardenWrite");
const { getShelfEntry, listShelf } = await import("../data-api/services/gardenShelf");
const { searchLinkTargets } = await import("../data-api/services/gardenLinks");
const { MEMBER } = await import("./_member");
const { default: db } = await import("../src/db");

const garden = { root: path.join(process.env.MAURICE_GARDENS_DIR!, MEMBER.username), username: MEMBER.username };
const read = (rel: string) => fs.readFileSync(path.join(garden.root, rel), "utf-8");
function write(rel: string, content: string) {
  const full = path.join(garden.root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}
const entry = (c: string, l: string, s: string) => getShelfEntry(MEMBER.id, garden, c, l, s, []);
const log = () => spawnSync("git", ["log", "--format=%s"], { cwd: garden.root, encoding: "utf-8" }).stdout.trim().split("\n");

const CARD_FM = `---\ntitle: "While We're Young"\ndate_watched: 2026-03-09\ndirector: "Noah Baumbach"\ntags: ["comedy-drama", "a24"]\nlocale: "fr"\ntranslationKey: "while-were-young"\n---\n`;

beforeAll(() => {
  fs.mkdirSync(garden.root, { recursive: true });
  for (const args of [["init", "-q"], ["config", "user.email", "t@t"], ["config", "user.name", "t"]]) {
    spawnSync("git", args, { cwd: garden.root });
  }
  // A fiche with prose and a résonance, no notes yet.
  write("books/fr/humus-fiche.md",
    `---\ntitle: Humus\nresource_collection: books\nresource_id: humus\ndate: '2026-08-23'\ntags: []\nlocale: fr\nmeta:\n  author: Gaspard Kœnig\n---\n\nRoman de l'éco-anxiété.\n\n## Résonances\n\n2026-09-04 — de *Being You* :\n\nLe corps avant l'esprit.\n`);
  // A film with only a card, written by other hands.
  write("movies/fr/while-were-young.md", `${CARD_FM}\nTrès habile.\n`);
  // A series with a fiche and a card that only holds the synopsis.
  write("series/fr/sugar.md", `---\ntitle: Sugar\nflags: []\nlocale: fr\n---\nJohn Sugar, détective privé à Los Angeles, enquête sur une disparition.\n`);
  write("series/fr/sugar-fiche.md",
    `---\ntitle: Sugar\nresource_collection: series\nresource_id: sugar\ndate: '2026-08-15'\ntags: [tv]\nlocale: fr\nmeta:\n  overview: "John Sugar, détective privé à Los Angeles, enquête sur une disparition."\n  opened: false\n---\n`);
  // An article nobody has written on.
  write("articles/fr/soil-fiche.md",
    `---\ntitle: Soil\nresource_collection: articles\nresource_id: soil\ndate: '2026-09-30'\ntags: []\nlocale: fr\nmeta:\n  url: https://example.org/s\n  opened: false\n---\n\n> An excerpt.\n`);
  write("notes/fr/une-note.md", `---\ntitle: Une note\nlocale: fr\n---\nTexte.`);
  db.run(`UPDATE users SET notes_domain = 'candide.me' WHERE id = ?`, [MEMBER.id]);
});

afterAll(() => {
  setDeployRunner(null);
  db.run(`UPDATE users SET notes_domain = NULL WHERE id = ?`, [MEMBER.id]);
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe("the shape of a note", () => {
  test("one line, or a block when it has a quote, a place or several lines", () => {
    expect(noteBlock("2026-10-08", { text: " Arthur. " })).toBe("2026-10-08 — Arthur.");
    expect(noteBlock("2026-10-08", { text: "Vraiment ?", quote: "Le ver.\nSeul.", where: { page: "112" } }))
      .toBe("2026-10-08 — p. 112 :\n\n> Le ver.\n> Seul.\n\nVraiment ?");
    expect(noteBlock("2026-10-08", { text: "C'est tout.", where: { chapter_title: "Chapitre  VII" } }))
      .toBe("2026-10-08 — ch. Chapitre VII :\n\nC'est tout.");
    expect(noteBlock("2026-10-08", { text: "Un.\n\nDeux." })).toBe("2026-10-08 :\n\nUn.\n\nDeux.");
    // A line that would open a heading cannot close the section.
    expect(noteBlock("2026-10-08", { text: "## Titre\nsuite" })).toBe("2026-10-08 :\n\n\\## Titre\nsuite");
  });

  test("lands at the end of its section, before the résonances", () => {
    const body = "\nProse.\n\n## Commentaire\n\n2026-10-01 — Un.\n\n## Résonances\n\n2026-09-04 :\n\nR.\n";
    expect(withNote(body, "2026-10-08 — Deux."))
      .toBe("\nProse.\n\n## Commentaire\n\n2026-10-01 — Un.\n\n2026-10-08 — Deux.\n\n## Résonances\n\n2026-09-04 :\n\nR.\n");
    expect(withNote("\n", "2026-10-08 — Seul.")).toBe("\n## Commentaire\n\n2026-10-08 — Seul.\n");
  });
});

describe("my side", () => {
  test("a note is read back as a note, and leaves prose and résonances where they were", async () => {
    addNote(MEMBER.id, garden, { collection: "books", locale: "fr", slug: "humus" }, { text: "Arthur = caricature." }, 191);
    addNote(MEMBER.id, garden, { collection: "books", locale: "fr", slug: "humus" },
      { text: "C'est tout le livre.", quote: "en cessant d'enlever", where: { chapter_title: "Chapitre VII" } });
    const e = (await entry("books", "fr", "humus"))!;
    expect(e.mine!.prose).toBe("Roman de l'éco-anxiété.");
    const today = new Date().toISOString().slice(0, 10);
    expect(e.mine!.items.filter((i) => i.kind !== "resonance")).toEqual([
      { kind: "note", id: null, date: today, text: "Arthur = caricature.", quote: null, where: null },
      { kind: "quote", id: null, date: today, text: "C'est tout le livre.", quote: "en cessant d'enlever", where: { chapter_title: "Chapitre VII" } },
    ]);
    expect(e.mine!.items.filter((i) => i.kind === "resonance")).toHaveLength(1);
    // The book the shelf matched is recorded once and for all.
    expect(read("books/fr/humus-fiche.md")).toContain("calibre_id: 191");
    expect(log()[0]).toBe("Note on books/humus");
  });

  test("the same note sent twice is written once", () => {
    const ref = { collection: "books", locale: "fr", slug: "humus" };
    const before = read("books/fr/humus-fiche.md");
    addNote(MEMBER.id, garden, ref, { text: "Arthur = caricature." });
    expect(read("books/fr/humus-fiche.md")).toBe(before);
  });

  test("an entry with only a card gets its fiche; an unopened fiche is opened", async () => {
    addNote(MEMBER.id, garden, { collection: "movies", locale: "fr", slug: "while-were-young" }, { text: "Revoir." });
    const film = (await entry("movies", "fr", "while-were-young"))!;
    expect(film.mine).toMatchObject({ notes: 1, opened: true, file: "movies/fr/while-were-young-fiche.md" });
    expect(read("movies/fr/while-were-young-fiche.md")).toContain("resource_collection: movies");

    expect((await entry("articles", "fr", "soil"))!.mine!.opened).toBe(false);
    addNote(MEMBER.id, garden, { collection: "articles", locale: "fr", slug: "soil" }, { text: "Lu chez L." });
    const soil = (await entry("articles", "fr", "soil"))!;
    expect(soil.mine).toMatchObject({ notes: 1, opened: true });
    expect(read("articles/fr/soil-fiche.md")).not.toContain("opened");
  });

  test("refuses nothing to say, an unknown entry, a collection that is not one", () => {
    const ref = { collection: "books", locale: "fr", slug: "humus" };
    expect(() => addNote(MEMBER.id, garden, ref, { text: "  " })).toThrow(EntryWriteError);
    expect(() => addNote(MEMBER.id, garden, { ...ref, slug: "nope" }, { text: "x" })).toThrow("No such entry");
    expect(() => addNote(MEMBER.id, garden, { collection: "notes", locale: "fr", slug: "une-note" }, { text: "x" })).toThrow("Not an entry");
  });
});

describe("the shared side", () => {
  test("rewrites the body and leaves the frontmatter byte for byte", async () => {
    writeShared(MEMBER.id, garden, { collection: "movies", locale: "fr", slug: "while-were-young" },
      { body: "Cruel et juste.\n\nAvec [[humus-fiche|Humus]].", title: "Le pathétique" });
    expect(read("movies/fr/while-were-young.md"))
      .toBe(`${CARD_FM}\n# Le pathétique\n\nCruel et juste.\n\nAvec [[humus-fiche|Humus]].\n`);
    const e = (await entry("movies", "fr", "while-were-young"))!;
    expect(e.shared).toMatchObject({ state: "draft", title: "Le pathétique" });
    expect(e.shared!.links).toEqual([{ basename: "humus-fiche", label: "Humus", entry_id: "books/fr/humus", published_url: null }]);
  });

  test("creates the card as a draft when the entry had only a fiche", async () => {
    writeShared(MEMBER.id, garden, { collection: "books", locale: "fr", slug: "humus" }, { body: "Une satire tendre." });
    const raw = read("books/fr/humus.md");
    expect(raw).toContain("title: Humus");
    expect(raw).toContain("flags: []");
    expect(raw).toContain("author: Gaspard Kœnig");
    // Filed as a book is: read on a day, with a status — what its page formats.
    expect(raw).toMatch(/^date_read: ["']?\d{4}-\d{2}-\d{2}["']?$/m);
    expect(raw).toContain("status: read");
    expect((await entry("books", "fr", "humus"))!.shared).toMatchObject({ state: "draft", body: "Une satire tendre." });
  });

  test("a card is completed from its fiche: what it lacks is added, what it says is kept", async () => {
    // A series kept from a conversation: the fiche has the provider's word,
    // the cover is already in the garden, and the card was written bare.
    write("series/fr/creek-fiche.md",
      `---\ntitle: "Creek"\nresource_collection: series\nresource_id: creek\ndate: "2026-10-09"\ntags: []\nlocale: fr\nmeta:\n  tmdb_id: 1\n  poster_path: /x.jpg\n  platform: CBC Television\n  year: 2015\n---\n`);
    write("series/fr/creek.md", `---\ntitle: "Creek"\ndate: "2026-10-10"\nflags: [public]\ntags: []\nlocale: fr\n---\n\nMagnifique.\n`);
    write("images/resources/series/fr-creek.jpg", "jpg");
    const ref = { collection: "series", locale: "fr", slug: "creek" };

    const added = await completeCard(MEMBER.id, garden, ref);
    expect(added.sort()).toEqual(["date_watched", "image", "platform", "status", "translationKey"]);
    const raw = read("series/fr/creek.md");
    // The lines it had, where they were; the new ones after them; the body untouched.
    expect(raw.startsWith(`---\ntitle: "Creek"\ndate: "2026-10-10"\nflags: [public]\ntags: []\nlocale: fr\n`)).toBe(true);
    expect(raw.endsWith(`---\n\nMagnifique.\n`)).toBe(true);
    expect(raw).toMatch(/^date_watched: ["']?2026-10-10["']?$/m);   // the day it already said
    expect(raw).toContain("platform: CBC Television");
    expect(raw).toContain("status: watched");
    expect(raw).toContain("image: /images/" + MEMBER.username + "/resources/series/fr-creek.jpg");
    expect(log()[0]).toStartWith("Complete series/creek:");
    // The cover is committed with it, and the shelf shows it.
    expect(spawnSync("git", ["ls-files", "images"], { cwd: garden.root, encoding: "utf-8" }).stdout).toContain("fr-creek.jpg");
    expect((await entry("series", "fr", "creek"))!.image).toContain("fr-creek.jpg");

    // Whole now: asking again changes nothing.
    expect(await completeCard(MEMBER.id, garden, ref)).toEqual([]);
    expect(read("series/fr/creek.md")).toBe(raw);
    // No card, nothing to complete.
    expect(await completeCard(MEMBER.id, garden, { collection: "articles", locale: "fr", slug: "soil" })).toEqual([]);
  });

  test("an emptied body is a blank shared side again, the card and its identity kept", async () => {
    const ref = { collection: "series", locale: "fr", slug: "sugar" };
    writeShared(MEMBER.id, garden, ref, { body: "Mon avis." });
    expect((await entry("series", "fr", "sugar"))!.shared).toMatchObject({ state: "draft" });
    writeShared(MEMBER.id, garden, ref, { body: "  " });
    expect(read("series/fr/sugar.md")).toBe(`---\ntitle: Sugar\nflags: []\nlocale: fr\n---\n`);
    expect((await entry("series", "fr", "sugar"))!.shared).toBeNull();
  });
});

describe("publishing", () => {
  test("sets the flag, deploys once at a time, folds what is asked meanwhile", async () => {
    const runs: string[] = [];
    let release: () => void = () => {};
    setDeployRunner((g) => new Promise<void>((resolve) => { runs.push(g.username); release = resolve; }));

    const ref = { collection: "movies", locale: "fr", slug: "while-were-young" };
    expect(setPublished(MEMBER.id, garden, ref, true).status).toBe("running");
    expect(read("movies/fr/while-were-young.md")).toContain("flags: [public]");
    expect((await entry("movies", "fr", "while-were-young"))!.shared).toMatchObject({
      state: "published", public_url: "https://candide.me/fr/trouvailles/films/while-were-young",
    });
    // A citation of it is now a real link, and so is the picker's row.
    expect(searchLinkTargets(garden, "while", 20, "https://candide.me")[0]!.published_url)
      .toBe("https://candide.me/fr/trouvailles/films/while-were-young");

    // Two more requests while the first runs: one run follows, not two.
    expect(setPublished(MEMBER.id, garden, { collection: "books", locale: "fr", slug: "humus" }, true).status).toBe("queued");
    expect(requestDeploy(garden).status).toBe("queued");
    expect(runs).toHaveLength(1);
    release();
    await new Promise((r) => setTimeout(r, 5));
    expect(runs).toHaveLength(2);
    release();
    await new Promise((r) => setTimeout(r, 5));
    expect(runs).toHaveLength(2);
    expect(deployState(garden.username)).toMatchObject({ status: "idle", error: null });

    expect(setPublished(MEMBER.id, garden, ref, false).status).toBe("running");
    expect(read("movies/fr/while-were-young.md")).toContain("flags: []");
    release();
    await new Promise((r) => setTimeout(r, 5));
  });

  test("a failed deploy says so and does not block the next", async () => {
    setDeployRunner(() => Promise.reject(new Error("wrangler: not logged in")));
    requestDeploy(garden);
    await new Promise((r) => setTimeout(r, 5));
    expect(deployState(garden.username)).toMatchObject({ status: "failed", error: "wrangler: not logged in" });
    setDeployRunner(() => Promise.resolve());
    requestDeploy(garden);
    await new Promise((r) => setTimeout(r, 5));
    expect(deployState(garden.username).status).toBe("idle");
  });

  test("refused when nothing is written, and when the member has no site", () => {
    setDeployRunner(() => Promise.resolve());
    expect(() => setPublished(MEMBER.id, garden, { collection: "series", locale: "fr", slug: "sugar" }, true))
      .toThrow("Nothing is written");
    expect(() => setPublished(MEMBER.id, garden, { collection: "articles", locale: "fr", slug: "soil" }, true))
      .toThrow("Nothing is written");
    db.run(`UPDATE users SET notes_domain = NULL WHERE id = ?`, [MEMBER.id]);
    expect(() => setPublished(MEMBER.id, garden, { collection: "movies", locale: "fr", slug: "while-were-young" }, true))
      .toThrow("No site");
    db.run(`UPDATE users SET notes_domain = 'candide.me' WHERE id = ?`, [MEMBER.id]);
  });
});

describe("deleting", () => {
  const tracked = () => spawnSync("git", ["ls-files"], { cwd: garden.root, encoding: "utf-8" }).stdout.trim().split("\n");

  test("both faces go, with what hangs under the fiche, in one commit; nothing online, no deploy", async () => {
    const runs: string[] = [];
    setDeployRunner((g) => { runs.push(g.username); return Promise.resolve(); });
    // An article as the capture leaves it: its text is the fiche's first fragment.
    write("articles/fr/soil-fiche/_fragments/001.frag", `---\nsummary: Soil\n---\nThe captured text.\n`);
    write("articles/fr/soil-fiche/_cards/unit.md", `a flashcard, git-ignored in a real garden`);
    spawnSync("git", ["add", "-A"], { cwd: garden.root });
    spawnSync("git", ["commit", "-qm", "fixtures"], { cwd: garden.root });
    archiveEntry(MEMBER.id, garden, "articles/fr/soil", true);

    const out = deleteEntry(MEMBER.id, garden, { collection: "articles", locale: "fr", slug: "soil" });
    expect(out).toEqual({ deleted: ["articles/fr/soil"], deploy: null });
    expect(fs.existsSync(path.join(garden.root, "articles/fr/soil-fiche.md"))).toBe(false);
    expect(fs.existsSync(path.join(garden.root, "articles/fr/soil-fiche"))).toBe(false);
    expect(await entry("articles", "fr", "soil")).toBeNull();
    expect(tracked().filter((f) => f.includes("soil"))).toEqual([]);
    expect(log()[0]).toBe("Delete articles/soil");
    // Its place among what was put away goes with it.
    expect((await listShelf(MEMBER.id, garden, [], true)).entries).toEqual([]);
    expect(runs).toEqual([]);
    // The garden's history gives it back.
    expect(spawnSync("git", ["show", "HEAD~1:articles/fr/soil-fiche/_fragments/001.frag"], { cwd: garden.root, encoding: "utf-8" }).stdout)
      .toContain("The captured text.");
  });

  test("a subject goes in every locale, and what was online is taken off the site", async () => {
    const runs: string[] = [];
    setDeployRunner((g) => { runs.push(g.username); return Promise.resolve(); });
    write("movies/en/while-were-young.md",
      `---\ntitle: "While We're Young"\nflags: [public]\nlocale: "en"\ntranslationKey: "while-were-young"\n---\n\nVery deft.\n`);
    write("movies/en/unrelated.md", `---\ntitle: Unrelated\nflags: []\nlocale: en\n---\n\nStays.\n`);

    const out = deleteEntry(MEMBER.id, garden, { collection: "movies", locale: "fr", slug: "while-were-young" });
    expect(out.deleted.sort()).toEqual(["movies/en/while-were-young", "movies/fr/while-were-young"]);
    expect(out.deploy).toMatchObject({ status: "running" });
    expect(fs.existsSync(path.join(garden.root, "movies/en/while-were-young.md"))).toBe(false);
    expect(fs.existsSync(path.join(garden.root, "movies/fr/while-were-young.md"))).toBe(false);
    expect(fs.existsSync(path.join(garden.root, "movies/en/unrelated.md"))).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    expect(runs).toEqual([MEMBER.username]);
  });

  test("what is not an entry of the list is refused", () => {
    expect(() => deleteEntry(MEMBER.id, garden, { collection: "books", locale: "fr", slug: "nope" })).toThrow("No such entry");
    expect(() => deleteEntry(MEMBER.id, garden, { collection: "notes", locale: "fr", slug: "une-note" })).toThrow("Not an entry");
    expect(fs.existsSync(path.join(garden.root, "notes/fr/une-note.md"))).toBe(true);
  });
});

describe("a cover brought by the device", () => {
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);

  test("lands under the entry's name, is named by the fiche, and shows on the row", async () => {
    write("articles/fr/bare-fiche.md",
      `---\ntitle: Bare\nresource_collection: articles\nresource_id: bare\ndate: '2026-08-27'\ntags: []\nlocale: fr\nmeta:\n  url: https://example.org/bare\n  word_count: 228\n---\n\n> An excerpt.\n`);
    const ref = { collection: "articles", locale: "fr", slug: "bare" };
    expect((await entry("articles", "fr", "bare"))!.image).toBeNull();

    setCover(MEMBER.id, garden, ref, JPEG);
    expect(fs.readFileSync(path.join(garden.root, "images/resources/articles/fr-bare.jpg"))).toEqual(Buffer.from(JPEG));
    expect(read("articles/fr/bare-fiche.md")).toContain(`image: /images/${MEMBER.username}/resources/articles/fr-bare.jpg`);
    // The rest of the fiche is where it was.
    expect(read("articles/fr/bare-fiche.md")).toContain("word_count: 228");
    expect(read("articles/fr/bare-fiche.md")).toContain("> An excerpt.");
    expect((await entry("articles", "fr", "bare"))!.image).toBe(`/images/${MEMBER.username}/resources/articles/fr-bare.jpg`);
    expect(log()[0]).toBe("Cover for articles/bare");
    expect(spawnSync("git", ["status", "--porcelain"], { cwd: garden.root, encoding: "utf-8" }).stdout).not.toContain("bare");
  });

  test("an entry with only a fiche takes the cover already in the garden under its name", async () => {
    write("series/fr/kept-fiche.md",
      `---\ntitle: Kept\nresource_collection: series\nresource_id: kept\ndate: '2026-10-09'\ntags: []\nlocale: fr\nmeta:\n  tmdb_id: 2\n---\n`);
    const ref = { collection: "series", locale: "fr", slug: "kept" };
    // Nothing to take, nothing fetched: it says so and writes nothing.
    expect(await completeCover(MEMBER.id, garden, ref)).toBe(false);
    write("images/resources/series/fr-kept.jpg", "jpg");
    expect(await completeCover(MEMBER.id, garden, ref)).toBe(true);
    expect((await entry("series", "fr", "kept"))!.image).toBe(`/images/${MEMBER.username}/resources/series/fr-kept.jpg`);
    // And once it has one, it is left alone.
    const before = log().length;
    expect(await completeCover(MEMBER.id, garden, ref)).toBe(true);
    expect(log()).toHaveLength(before);
  });

  test("what is not a picture is refused, and nothing is written", () => {
    const ref = { collection: "books", locale: "fr", slug: "humus" };
    expect(() => setCover(MEMBER.id, garden, ref, new TextEncoder().encode("<html>not a picture</html>"))).toThrow("JPEG or a PNG");
    expect(() => setCover(MEMBER.id, garden, ref, new Uint8Array())).toThrow("No picture");
    expect(fs.existsSync(path.join(garden.root, "images/resources/books/fr-humus.jpg"))).toBe(false);
    expect(() => setCover(MEMBER.id, garden, { collection: "notes", locale: "fr", slug: "une-note" }, JPEG)).toThrow("Not an entry");
  });
});
