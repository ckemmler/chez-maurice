/**
 * The read side of the article pipeline — what the Carnet reading section
 * pulls back: the list, one article's description, and its highlights.
 * Run with `bun test`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "maurice-garden-read-"));
process.env.MAURICE_GARDENS_DIR = path.join(TMP, "gardens");

// akita.db must be a throwaway — these tests write highlights. The path binds
// when articleHighlights is first imported, so set the env just for that
// import, then drop it: src/db (below) must keep resolving the developer's
// real maurice.db, which articles.test.ts borrows a member id from too.
process.env.MAURICE_DATA_DIR = path.join(TMP, "data");
fs.mkdirSync(process.env.MAURICE_DATA_DIR, { recursive: true });
const {
  listArticleHighlights,
  createArticleHighlight,
  updateArticleHighlight,
  deleteArticleHighlight,
  countArticleHighlights,
} = await import("../data-api/services/articleHighlights");
delete process.env.MAURICE_DATA_DIR;

const { saveArticleFiche, listArticles, describeArticle, readArticleBody, findArticleFiche } =
  await import("../data-api/services/gardenArticles");
const { gardenFor } = await import("../data-api/services/gardenFiche");

// Like articles.test.ts, borrow a real member id — never write to maurice.db:
// under `bun test` every file shares one process, so src/db may already be
// bound to the developer's own database by an earlier suite regardless of the
// env set above. The env still isolates what this suite *writes*: the garden
// (fresh MAURICE_GARDENS_DIR) and akita.db (fresh MAURICE_DATA_DIR, resolved
// when articleHighlights is first imported — which is here).
const MEMBER = (await import("../src/db")).default
  .query("SELECT id FROM users ORDER BY created_at LIMIT 1")
  .get() as { id: string };

const garden = () => gardenFor(MEMBER.id)!;

beforeAll(() => {
  const g = path.join(process.env.MAURICE_GARDENS_DIR!, garden().username);
  fs.mkdirSync(g, { recursive: true });
  for (const args of [["init", "-q"], ["config", "user.email", "t@t"], ["config", "user.name", "t"]]) {
    spawnSync("git", args, { cwd: g });
  }
});

afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

const page = `<!doctype html><html lang="fr"><head>
<title>Un article | Le Monde</title>
<meta property="og:title" content="Un article lisible">
<meta property="og:description" content="Le teaser.">
<meta property="og:site_name" content="Le Monde">
</head><body><article><p>${"Le corps de l'article. ".repeat(60)}</p></article></body></html>`;

describe("listArticles / describeArticle", () => {
  test("a captured article lists with has_text and its metadata", async () => {
    await saveArticleFiche(MEMBER.id, {
      url: "https://www.lemonde.fr/a/lisible.html",
      html: page,
      comment: "à relire",
    });
    const listed = listArticles(garden());
    const a = listed.find((x) => x.title === "Un article lisible");
    expect(a).toBeDefined();
    expect(a!.has_text).toBe(true);
    expect(a!.needs_capture).toBe(false);
    expect(a!.publication).toBe("Le Monde");
    expect(a!.word_count).toBeGreaterThan(0);
    expect(a!.fiche_path.startsWith("articles/")).toBe(true);
    expect(a!.fiche_web_path).toContain("/fiches/articles/");
  });

  test("a bookmark lists as needs_capture without text", async () => {
    // gatesnotes-style refusal is exercised in articles.test.ts; write the stub
    // shape directly through the same save path by refusing extraction — here
    // the simplest honest stand-in is a fiche saved earlier, hand-flagged.
    const g = garden();
    const dir = path.join(g.root, "articles", "fr");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "un-signet-fiche.md"),
      `---\ntitle: Un signet\nresource_collection: articles\nresource_id: un-signet\ndate: "2026-09-01"\ntags: []\nlocale: fr\nmeta:\n  url: https://example.org/signet\n  canonical_url: example.org/signet\n  publication: example.org\n  saved_at: "2026-09-01"\n  status: needs-capture\n  capture_error: "403"\n---\n\n## Commentaire\n\nà capturer\n`,
    );
    const a = listArticles(g).find((x) => x.slug === "un-signet");
    expect(a).toBeDefined();
    expect(a!.needs_capture).toBe(true);
    expect(a!.has_text).toBe(false);
    expect(a!.capture_error).toBe("403");
  });

  test("the body comes back with the comment", () => {
    const ref = findArticleFiche(garden(), "https://www.lemonde.fr/a/lisible.html")!;
    expect(readArticleBody(ref)).toContain("à relire");
    const d = describeArticle(garden(), ref);
    expect(d.excerpt).toBe("Le teaser.");
  });
});

describe("article highlights", () => {
  test("create → list → count → update → delete", () => {
    const h = createArticleHighlight(MEMBER.id, "fr", "un-article-lisible", {
      quote: "Le corps de l'article.",
      startOffset: 0,
      endOffset: 22,
      view: "full",
    });
    expect(h.id).toBeGreaterThan(0);
    expect(h.color).toBe("yellow");
    expect(h.view).toBe("full");

    const listed = listArticleHighlights(MEMBER.id, "fr", "un-article-lisible");
    expect(listed.length).toBe(1);
    expect(listed[0]!.quote).toBe("Le corps de l'article.");

    expect(countArticleHighlights(MEMBER.id).get("fr/un-article-lisible")).toBe(1);

    const up = updateArticleHighlight(MEMBER.id, h.id, { note: "important", color: "green" });
    expect(up!.note).toBe("important");
    expect(up!.color).toBe("green");

    expect(deleteArticleHighlight(MEMBER.id, h.id)).toBe(true);
    expect(listArticleHighlights(MEMBER.id, "fr", "un-article-lisible").length).toBe(0);
  });

  test("another member's highlights are invisible and untouchable", () => {
    const h = createArticleHighlight(MEMBER.id, "fr", "un-article-lisible", { quote: "q" });
    expect(listArticleHighlights("someone-else", "fr", "un-article-lisible").length).toBe(0);
    expect(updateArticleHighlight("someone-else", h.id, { note: "x" })).toBeNull();
    expect(deleteArticleHighlight("someone-else", h.id)).toBe(false);
    expect(deleteArticleHighlight(MEMBER.id, h.id)).toBe(true);
  });
});
