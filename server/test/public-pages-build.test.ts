/**
 * What a published build may contain — the test a member's public pages stand
 * on. A garden is written with one of everything that must stay private, each
 * carrying a marker, and the real web engine builds it both ways it is ever
 * published: as a member's pages on the household's host (`/@<member>/`), and
 * as a site of its own. Then every file of the output is searched.
 *
 * It runs the engine (a few seconds each), so it needs web/node_modules; where
 * that is missing the suite says so and skips rather than pass for nothing.
 * Run with `bun test`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const WEB = path.resolve(import.meta.dir, "../../web");
const ASTRO = path.join(WEB, "node_modules", ".bin", "astro");
const canBuild = fs.existsSync(ASTRO);
if (!canBuild) console.warn("[public-pages-build] web/node_modules missing — the leak test is SKIPPED, not passed");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "maurice-leak-"));
const GARDENS = path.join(TMP, "gardens");
const DATA = path.join(TMP, "data");

/** Every marker of something that must never be published. */
const PRIVATE = {
  "a private note's text": "ZQPRIVNOTE",
  "a private note's title": "ZQPRIVTITLE",
  "a draft card's text": "ZQDRAFTCARD",
  "a draft card's title": "ZQDRAFTTITLE",
  "a fiche": "ZQFICHEBODY",
  "a fiche's fragment": "ZQFRAGMENT",
  "the fiche behind a published card": "ZQFICHEOFPUBLIC",
  "an unopened article fiche": "ZQARTICLEFICHE",
  "an article's captured text": "ZQFULLTEXT",
  "a person's fiche": "ZQPERSON",
  "an encrypted note, published without a password": "ZQENCRYPTED",
  "another member's published note": "ZQBOBPUBLIC",
  "another member's private note": "ZQBOBPRIVATE",
};
/** File names that must not be in the output. */
const PRIVATE_FILES = ["zq-note-art.jpg", "fr-zq-draft.jpg", "zq-bob-cover.jpg", "bob-sq.png"];
/** What was published, and must be there. */
const PUBLIC = ["ZQPUBNOTE", "ZQPUBCARD"];

function write(member: string, rel: string, content: string | Buffer) {
  const full = path.join(GARDENS, member, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

beforeAll(() => {
  // anna — the member whose pages are built.
  write("anna", "notes/fr/note-publique.md",
    `---\ntitle: Note publique\ndate: 2026-10-01\nflags:\n  - public\nlocale: fr\n---\nZQPUBNOTE, et un renvoi vers [[note-secrete]] et vers [[brouillon-fiche]].\n`);
  write("anna", "notes/fr/note-secrete.md",
    `---\ntitle: ZQPRIVTITLE\ndate: 2026-10-02\nflags: []\nimage: /images/anna/notes/zq-note-art.jpg\nlocale: fr\n---\nZQPRIVNOTE\n`);
  write("anna", "notes/fr/note-chiffree.md",
    `---\ntitle: Note chiffrée\ndate: 2026-10-03\nflags:\n  - public\n  - encrypted\nlocale: fr\n---\nZQENCRYPTED\n`);
  write("anna", "movies/fr/film-publie.md",
    `---\ntitle: Film publié\ndate_watched: 2026-09-03\ndirector: X\nflags:\n  - public\nimage: /images/anna/resources/movies/fr-film-publie.jpg\nlocale: fr\n---\nZQPUBCARD\n`);
  write("anna", "movies/fr/film-publie-fiche.md",
    `---\ntitle: Film publié\nresource_collection: movies\nresource_id: film-publie\ndate: '2026-09-03'\ntags: []\nlocale: fr\n---\nZQFICHEOFPUBLIC\n`);
  write("anna", "books/fr/brouillon.md",
    `---\ntitle: ZQDRAFTTITLE\ndate_read: 2026-08-01\nflags: []\nimage: /images/anna/resources/books/fr-zq-draft.jpg\nlocale: fr\n---\nZQDRAFTCARD\n`);
  write("anna", "books/fr/brouillon-fiche.md",
    `---\ntitle: ZQDRAFTTITLE\nresource_collection: books\nresource_id: brouillon\ndate: '2026-08-01'\ntags: []\nlocale: fr\n---\nZQFICHEBODY\n\n## Commentaire\n\n2026-10-08 — ZQFICHEBODY encore.\n`);
  write("anna", "books/fr/brouillon-fiche/_fragments/001.frag", `---\nsummary: "ZQFRAGMENT"\n---\nZQFRAGMENT\n`);
  write("anna", "articles/fr/un-article-fiche.md",
    `---\ntitle: Un article\nresource_collection: articles\nresource_id: un-article\ndate: '2026-10-07'\ntags: []\nlocale: fr\nmeta:\n  url: https://example.org/a\n  excerpt: ZQARTICLEFICHE\n  opened: false\n---\n\n> ZQARTICLEFICHE\n`);
  write("anna", "articles/fr/un-article-fiche/_fragments/001.frag", `---\nsummary: "Texte intégral"\n---\nZQFULLTEXT\n`);
  write("anna", "people/fr/quelqu-un-fiche.md",
    `---\ntitle: Quelqu'un\nresource_collection: people\nresource_id: quelqu-un\ndate: '2026-10-07'\ntags: []\nlocale: fr\nstatus: pending\nmeta:\n  opened: false\n---\nZQPERSON\n`);
  write("anna", "images/notes/zq-note-art.jpg", JPG);
  write("anna", "images/resources/books/fr-zq-draft.jpg", JPG);
  write("anna", "images/resources/movies/fr-film-publie.jpg", JPG);

  // bob — the same household; nothing of his belongs in anna's pages.
  write("bob", "notes/fr/bob-publie.md",
    `---\ntitle: Bob publie\ndate: 2026-10-01\nflags:\n  - public\nimage: /images/bob/resources/movies/zq-bob-cover.jpg\nlocale: fr\n---\nZQBOBPUBLIC\n`);
  write("bob", "notes/fr/bob-prive.md", `---\ntitle: Bob privé\ndate: 2026-10-01\nflags: []\nlocale: fr\n---\nZQBOBPRIVATE\n`);
  write("bob", "images/resources/movies/zq-bob-cover.jpg", JPG);

  fs.writeFileSync(path.join(GARDENS, "gardens.json"), JSON.stringify({
    anna: { base: "/g/anna", title: "Anna", name: "Anna", avatar: "/api/avatars/anna-sq.png" },
    bob: { base: "/g/bob", title: "Bob", name: "Bob", avatar: "/api/avatars/bob-sq.png" },
  }));
  fs.mkdirSync(path.join(TMP, "avatars"), { recursive: true });
  fs.writeFileSync(path.join(TMP, "avatars", "anna-sq.png"), JPG);
  fs.writeFileSync(path.join(TMP, "avatars", "bob-sq.png"), JPG);
  fs.mkdirSync(DATA, { recursive: true });
});

afterAll(() => {
  // The engine links the gardens' images and avatars into web/public while it
  // builds; take back the links that point into this suite's folder.
  for (const dir of ["images", "avatars"]) {
    const base = path.join(WEB, "public", dir);
    for (const name of fs.existsSync(base) ? fs.readdirSync(base) : []) {
      const link = path.join(base, name);
      try {
        if (fs.lstatSync(link).isSymbolicLink() && fs.readlinkSync(link).startsWith(TMP)) fs.rmSync(link);
      } catch { /* not ours */ }
    }
  }
  fs.rmSync(TMP, { recursive: true, force: true });
});

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
}

/** Every private thing found in an output folder, as readable lines. */
function leaks(out: string): string[] {
  const found: string[] = [];
  for (const file of walk(out)) {
    const rel = path.relative(out, file);
    if (PRIVATE_FILES.includes(path.basename(file))) found.push(`${rel} is in the output`);
    const text = fs.readFileSync(file).toString("latin1");
    for (const [what, marker] of Object.entries(PRIVATE)) {
      if (text.includes(marker)) found.push(`${what} (${marker}) in ${rel}`);
    }
  }
  return found;
}

function everything(out: string): string {
  return walk(out).map((f) => fs.readFileSync(f).toString("latin1")).join("\n");
}

const BUILD_TIMEOUT = 120_000;

describe.skipIf(!canBuild)("a published build holds nothing private", () => {
  test("a member's pages on the household's host", async () => {
    const saved = { ...process.env };
    process.env.MAURICE_GARDENS_DIR = GARDENS;
    process.env.MAURICE_DATA_DIR = DATA;
    process.env.MAURICE_PUBLIC_HOST = "magik.chezmaurice.eu";
    process.env.MAURICE_PUBLIC_PAGES = "1";
    // What a hosted container sets for the engine; the build must not inherit it.
    process.env.WEB_SSR = "1";
    process.env.GARDEN_OWNER = "1";
    delete process.env.PRIVATE_CONTENT_PASSWORD;
    try {
      const { buildPublicPages, publicPagesDir, resolvePublicFile } = await import("../data-api/services/publicPages");
      await buildPublicPages({ root: path.join(GARDENS, "anna"), username: "anna" });
      const out = publicPagesDir("anna");

      expect(leaks(out)).toEqual([]);
      const all = everything(out);
      for (const marker of PUBLIC) expect(all).toContain(marker);
      expect(walk(out).some((f) => f.endsWith("fr-film-publie.jpg"))).toBe(true);
      // No address for what is private either.
      expect(resolvePublicFile("/@anna/fr/notes/note-secrete")).toBeNull();
      expect(resolvePublicFile("/@anna/fr/fiches/books/brouillon-fiche")).toBeNull();
      expect(resolvePublicFile("/@anna/fr/notes/note-publique")).not.toBeNull();

      // The home is what was published, each item linking under the prefix —
      // and the page asks nothing of the owner's side of the server.
      const home = fs.readFileSync(resolvePublicFile("/@anna/fr/")!, "utf-8");
      expect(home).toContain('href="/@anna/fr/trouvailles/films/film-publie"');
      expect(home).toContain('href="/@anna/fr/notes/note-publique"');
      // Its own absolute addresses (canonical, alternates) carry the prefix too.
      expect(home).toContain("https://magik.chezmaurice.eu/@anna/");
      expect(home).not.toMatch(/="https:\/\/magik\.chezmaurice\.eu\/(?!@anna)/);
      expect(all).not.toContain("garden-tools/events");
      expect(resolvePublicFile("/@anna/fiches")).toBeNull();
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  }, BUILD_TIMEOUT);

  test("a site of one's own, as the publish script builds it", () => {
    const out = path.join(TMP, "site");
    const { WEB_SSR: _s, GARDEN_OWNER: _o, PUBLIC_STATIC: _p, GARDEN_BASE: _b, PRIVATE_CONTENT_PASSWORD: _k, ...env } = process.env;
    const run = spawnSync(ASTRO, ["build", "--outDir", out], {
      cwd: WEB,
      env: { ...env, NODE_ENV: "production", GARDEN: "anna", THEME: "default", MAURICE_GARDENS_DIR: GARDENS },
      encoding: "utf-8",
    });
    expect(run.status).toBe(0);
    expect(leaks(out)).toEqual([]);
    const all = everything(out);
    for (const marker of PUBLIC) expect(all).toContain(marker);
    // The encrypted note's page is there, and says nothing.
    const page = fs.readFileSync(path.join(out, "fr/notes/note-chiffree.html"), "utf-8");
    expect(page).toContain("This note is private.");
    expect(page).not.toContain("Note chiffrée");
  }, BUILD_TIMEOUT);

  test("with a password, an encrypted note is published as a cipher", () => {
    const out = path.join(TMP, "site-locked");
    const { WEB_SSR: _s, GARDEN_OWNER: _o, PUBLIC_STATIC: _p, GARDEN_BASE: _b, ...env } = process.env;
    const run = spawnSync(ASTRO, ["build", "--outDir", out], {
      cwd: WEB,
      env: { ...env, NODE_ENV: "production", GARDEN: "anna", THEME: "default", MAURICE_GARDENS_DIR: GARDENS,
             PRIVATE_CONTENT_PASSWORD: "correct horse" },
      encoding: "utf-8",
    });
    expect(run.status).toBe(0);
    expect(leaks(out)).toEqual([]);
    const page = fs.readFileSync(path.join(out, "fr/notes/note-chiffree.html"), "utf-8");
    expect(page).toContain('type="application/encrypted"');
    expect(page).not.toContain("This note is private.");
  }, BUILD_TIMEOUT);
});
