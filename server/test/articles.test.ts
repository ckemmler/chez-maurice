/**
 * The article pipeline, end to end on a throwaway garden.
 *
 * Written after a code review found eleven defects in code that had passed a
 * suite living in a temp directory — which was then wiped. This one lives in
 * the repo. Run with `bun test`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "maurice-articles-"));
const GARDEN = path.join(TMP, "candide");
process.env.MAURICE_GARDENS_DIR = TMP;

const { canonicalizeUrl, decodeEntities, extractArticleFromHtml, slugify } =
  await import("../data-api/services/articleExtract");
const { dumpFrontmatter, parseFiche, writeFragment } =
  await import("../data-api/services/gardenFiche");
const { saveArticleFiche, scanArticleFiches, NEEDS_CAPTURE } =
  await import("../data-api/services/gardenArticles");

const { MEMBER } = await import("./_member");

beforeAll(() => {
  fs.mkdirSync(GARDEN, { recursive: true });
  for (const args of [["init", "-q"], ["config", "user.email", "t@t"], ["config", "user.name", "t"]]) {
    spawnSync("git", args, { cwd: GARDEN });
  }
});

afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

const page = (over: Record<string, string> = {}) => `<!doctype html><html lang="${over.lang ?? "fr"}"><head>
<title>${over.docTitle ?? "Fallback | Le Monde"}</title>
<meta property="og:title" content="${over.title ?? "Le titre de l'article"}">
<meta property="og:description" content="Le teaser.">
<meta property="og:site_name" content="Le Monde">
${over.canonical ? `<link rel="canonical" href="${over.canonical}">` : ""}
</head><body><article><p>${"Le corps de l'article. ".repeat(60)}</p></article></body></html>`;

describe("frontmatter survives what a real title contains", () => {
  // A title of the form "[Analyse] …" opened a YAML flow sequence and made the
  // whole fiche unparseable — silently out of dedup, out of the index, and out
  // of Astro's schema.
  const titles = [
    "[Analyse] Le nucléaire français",
    "{Tribune} Une opinion",
    "?Question ouverte",
    ",virgule liminaire",
    "- tiret liminaire",
    "Le titre de l'article",
    "Titre: deux points",
    "Oui, mais à quel prix",
    "2026-08-27 en tête",
    "Bilan 😀 de l'année",
    "true",
  ];
  for (const title of titles) {
    test(JSON.stringify(title), () => {
      const parsed = Bun.YAML.parse(dumpFrontmatter({ title })) as { title: string };
      expect(parsed.title).toBe(title);
    });
  }
});

test("a fragment summary cannot break out of its scalar", () => {
  const file = path.join(GARDEN, "articles", "fr", "frag-fiche.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const frag = writeFragment(file, 'Texte "intégral" — C:\\chemin\nsur deux lignes', "corps");
  const fm = fs.readFileSync(frag, "utf-8").match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
  expect(() => Bun.YAML.parse(fm)).not.toThrow();
  expect((Bun.YAML.parse(fm) as any).summary).toContain("intégral");
});

test("extraction prefers og:title over the document title", async () => {
  const saved = await saveArticleFiche(MEMBER.id, {
    url: "https://www.lemonde.fr/a/titre_1.html",
    html: page(),
    title: "Fallback | Le Monde", // what a browser clipper always sends
  });
  expect(saved.title).toBe("Le titre de l'article");
  expect(saved.slug).not.toContain("le-monde");
});

test("entities above the basic plane survive", () => {
  expect(decodeEntities("Bilan &#128512; 2026")).toBe("Bilan 😀 2026");
  expect(decodeEntities("Bilan &#x1F600; 2026")).toBe("Bilan 😀 2026");
  expect(decodeEntities("x&#9999999;y")).toBe("x&#9999999;y"); // out of range, left alone
});

test("a slug collision on a long title stays a valid slug", async () => {
  const long = "a".repeat(75) + " bbbbbbbb cccc";
  const first = await saveArticleFiche(MEMBER.id, {
    url: "https://www.lemonde.fr/a/long_1.html",
    html: page({ title: long }),
  });
  // A different article, same title — the collision path must not produce `--2`.
  const second = await saveArticleFiche(MEMBER.id, {
    url: "https://www.lemonde.fr/a/long_2.html",
    html: page({ title: long }),
  });
  expect(second.slug).not.toBe(first.slug);
  expect(second.slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
});

test("dedup follows the page's own canonical URL", async () => {
  const canonical = "https://www.lemonde.fr/a/canon.html";
  await saveArticleFiche(MEMBER.id, {
    url: canonical,
    html: page({ title: "Canonique", canonical }),
  });
  const viaTracking = await saveArticleFiche(MEMBER.id, {
    url: "https://www.lemonde.fr/a/canon.html?utm_source=x&s=09",
    html: page({ title: "Canonique", canonical }),
  });
  expect(viaTracking.duplicate).toBe(true);
});

describe("a site that refuses robots", () => {
  test("becomes a bookmark, keeping the comment", async () => {
    const stub = await saveArticleFiche(MEMBER.id, {
      url: "https://www.gatesnotes.com/work/make-ai-work-for-everyone/reader",
      comment: "Pour lundi.",
    });
    expect(stub.needs_capture).toBe(true);
    expect(stub.comment).toBe("Pour lundi.");
    const fm = parseFiche(fs.readFileSync(stub.file, "utf-8"))!.frontmatter;
    expect(fm.meta.status).toBe(NEEDS_CAPTURE);
    expect(String(fm.meta.capture_error)).toMatch(/403/);
    expect(stub.title).not.toMatch(/Forbidden/);
  });

  test("is completed in place, in its own locale", async () => {
    const url = "https://www.gatesnotes.com/work/completion/reader";
    const stub = await saveArticleFiche(MEMBER.id, { url, locale: "fr", comment: "D'abord." });
    expect(stub.needs_capture).toBe(true);

    // A clipper configured for `en` must not move the fiche out of `fr/`.
    const done = await saveArticleFiche(MEMBER.id, {
      url,
      html: page({ title: "Complété" }),
      locale: "en",
      comment: "Ensuite.",
    });
    expect(done.completed).toBe(true);
    expect(done.needs_capture).toBe(false);
    expect(done.fiche_path).toBe(stub.fiche_path);
    expect(done.locale).toBe("fr");
    expect(done.fiche_web_path).toContain("/fr/");

    const after = parseFiche(fs.readFileSync(done.file, "utf-8"))!;
    expect(after.frontmatter.locale).toBe("fr");
    expect(after.frontmatter.meta.status).toBe("inbox");
    expect(after.body).toContain("D'abord.");
    expect(after.body).toContain("Ensuite.");
  });

  test("a dead URL is an error, not a bookmark", async () => {
    expect(
      saveArticleFiche(MEMBER.id, {
        url: "https://www.theguardian.com/environment/2025/feb/11/nexistepas",
      }),
    ).rejects.toThrow(/404/);
  });
});

describe("an unopened fiche", () => {
  // A share without a comment is a weak signal: the file is written, but it
  // is not one of the member's fiches until they write on it.
  test("is what a bare share writes; a comment opens it", async () => {
    const url = "https://www.lemonde.fr/a/sans-mot.html";
    const bare = await saveArticleFiche(MEMBER.id, { url, html: page({ title: "Sans un mot" }) });
    expect(bare.opened).toBe(false);
    expect(parseFiche(fs.readFileSync(bare.file, "utf-8"))!.frontmatter.meta.opened).toBe(false);

    // Re-sharing with a thought is the opening gesture.
    const again = await saveArticleFiche(MEMBER.id, { url, comment: "Ça me parle." });
    expect(again.duplicate).toBe(true);
    expect(again.opened).toBe(true);
    const fm = parseFiche(fs.readFileSync(bare.file, "utf-8"))!.frontmatter;
    expect(fm.meta.opened).toBeUndefined(); // absence is the opened state
    expect(fm.meta.status).toBe("inbox");   // nothing else in meta was touched
  });

  test("a share with a comment is opened from the start", async () => {
    const saved = await saveArticleFiche(MEMBER.id, {
      url: "https://www.lemonde.fr/a/avec-mot.html",
      html: page({ title: "Avec un mot" }),
      comment: "À creuser.",
    });
    expect(saved.opened).toBe(true);
    expect(parseFiche(fs.readFileSync(saved.file, "utf-8"))!.frontmatter.meta.opened).toBeUndefined();
  });

  test("a bookmark follows the same rule, and completion keeps it", async () => {
    const url = "https://www.gatesnotes.com/work/unopened/reader";
    const stub = await saveArticleFiche(MEMBER.id, { url });
    expect(stub.needs_capture).toBe(true);
    expect(stub.opened).toBe(false);

    const done = await saveArticleFiche(MEMBER.id, { url, html: page({ title: "Rempli" }) });
    expect(done.completed).toBe(true);
    expect(done.opened).toBe(false);
  });
});

test("every fiche written here is readable back", () => {
  const refs = scanArticleFiches({ root: GARDEN, username: "candide" });
  expect(refs.length).toBeGreaterThan(0);
  for (const ref of refs) {
    expect(parseFiche(fs.readFileSync(ref.file, "utf-8"))).not.toBeNull();
  }
});

test("URL canonicalisation ignores how you got there", () => {
  expect(canonicalizeUrl("https://www.lemonde.fr/a/b?utm_source=x")).toBe("lemonde.fr/a/b");
  expect(canonicalizeUrl("http://lemonde.fr/a/b/")).toBe(canonicalizeUrl("https://www.lemonde.fr/a/b#x"));
  expect(canonicalizeUrl("https://x.com/a")).not.toBe(canonicalizeUrl("https://x.com/b"));
});

test("slugify folds accents and elisions", () => {
  expect(slugify("Où va l'Amérique ? — État des lieux")).toBe("ou-va-l-amerique-etat-des-lieux");
});

test("extraction reads JSON-LD @graph and article:published_time", () => {
  const a = extractArticleFromHtml(
    "https://x.com/p",
    `<html lang="en"><head>
     <meta property="article:published_time" content="2026-08-21T09:00:00Z">
     <script type="application/ld+json">{"@graph":[{"@type":"WebSite"},
       {"@type":"NewsArticle","alternativeHeadline":"Un sous-titre",
        "author":[{"@type":"Person","name":"Jean Dupont"}]}]}</script>
     </head><body><article><p>${"corps ".repeat(80)}</p></article></body></html>`,
  );
  expect(a.author).toBe("Jean Dupont");
  expect(a.subtitle).toBe("Un sous-titre");
  expect(a.published_at).toBe("2026-08-21");
  expect(a.lang).toBe("en");
});

describe("the captured text keeps its paragraphs, and loses the page's furniture", async () => {
  const { htmlToBlocks } = await import("../data-api/services/articleExtract");
  const { applyDropList, parseDropList, replaceFullText, readTextStyles, splitBlocks } =
    await import("../data-api/services/articleCleanup");
  const { readFullText } = await import("../data-api/services/articleSummary");
  const { createArticleHighlight } = await import("../data-api/services/articleHighlights");

  const para = (n: number) => `Paragraphe ${n}. ${"Une phrase du corps de l'article. ".repeat(20)}`.trim();
  const longPage = (title: string) => `<!doctype html><html lang="fr"><head>
<title>${title}</title><meta property="og:title" content="${title}">
<meta property="og:site_name" content="Le Monde"></head><body><article>
<h2>Un intertitre</h2><p>${para(1)}</p><p>${para(2)}</p><p>${para(3)}</p>
</article></body></html>`;

  test("one block per paragraph, heading and caption; a <br> stays inside its block", () => {
    expect(
      htmlToBlocks(
        `<div><header><span>The Interview</span><figcaption>Credit…<span>P. M.</span></figcaption></header>` +
        `<h1>Title</h1><p>First <em>para</em>graph.</p><p>Vers un<br>vers deux</p><ul><li>a</li><li>b</li></ul></div>`,
      ),
    ).toEqual(["The Interview", "Credit…P. M.", "Title", "First paragraph.", "Vers un\nvers deux", "a", "b"]);
  });

  test("an extracted article separates its paragraphs with a blank line", () => {
    const blocks = splitBlocks(extractArticleFromHtml("https://ex.test/blocs", longPage("Des blocs")).content);
    expect(blocks.length).toBeGreaterThanOrEqual(3);
    expect(blocks.some((b) => b.startsWith("Paragraphe 2."))).toBe(true);
  });

  test("the drop list is read out of the answer, and only real block numbers count", () => {
    expect(parseDropList('Here: {"drop": [0, 2, 2, 9, -1, "3", 1.5]}', 4)).toEqual([0, 2]);
    expect(parseDropList('{"drop": []}', 4)).toEqual([]);
    expect(parseDropList("no json", 4)).toBeNull();
    expect(parseDropList('{"keep": [1]}', 4)).toBeNull();
  });

  test("a paragraph is never dropped, and an answer that empties the text is refused", () => {
    const blocks = ["Advertisement", para(1), "Credit…X", para(2)];
    expect(applyDropList(blocks, [0, 1, 2])).toEqual([para(1), para(2)]);
    expect(applyDropList(["a", "b", "c", "d"], [0, 1, 2])).toBeNull();
  });

  test("sharing a flat capture again from the browser brings its paragraphs back", async () => {
    const url = "https://ex.test/reprise";
    const first = await saveArticleFiche(MEMBER.id, { url, html: longPage("Une reprise") });
    expect(first.duplicate).toBe(false);
    // As every save was stored before blocks were kept.
    replaceFullText(first.file, readFullText(first.file).replace(/\s+/g, " "));
    expect(readFullText(first.file)).not.toContain("\n\n");

    const again = await saveArticleFiche(MEMBER.id, { url, html: longPage("Une reprise") });
    expect(again.duplicate).toBe(true);
    expect(again.text_retaken).toBe(true);
    expect(splitBlocks(readFullText(first.file)).length).toBeGreaterThanOrEqual(3);

    // A text with paragraphs is left alone.
    expect((await saveArticleFiche(MEMBER.id, { url, html: longPage("Une reprise") })).text_retaken).toBe(false);
  });

  test("a highlighted text is never replaced: its offsets index the text it was made on", async () => {
    const url = "https://ex.test/surligne";
    const first = await saveArticleFiche(MEMBER.id, { url, html: longPage("Un surlignage") });
    const flat = readFullText(first.file).replace(/\s+/g, " ");
    replaceFullText(first.file, flat);
    createArticleHighlight(MEMBER.id, first.locale, first.slug, { quote: "Paragraphe 2", startOffset: 5, endOffset: 17 });

    const again = await saveArticleFiche(MEMBER.id, { url, html: longPage("Un surlignage") });
    expect(again.text_retaken).toBe(false);
    expect(readFullText(first.file)).toBe(flat);
  });
});

test("an author declared as the address of their page is not taken for a name", () => {
  const html = `<!doctype html><html lang="en"><head><title>T</title>
<meta property="og:title" content="A title">
<meta property="article:author" content="https://www.nytimes.com/by/someone">
<script type="application/ld+json">{"@type":"NewsArticle","headline":"A title","author":{"@type":"Person","name":"Lulu Garcia-Navarro"}}</script>
</head><body><article><p>${"Body of the article. ".repeat(60)}</p></article></body></html>`;
  expect(extractArticleFromHtml("https://ex.test/author", html).author).toBe("Lulu Garcia-Navarro");
});

describe("what the page set apart stays set apart", async () => {
  const { htmlToStyledBlocks } = await import("../data-api/services/articleExtract");
  const { readTextStyles, hasTextStyles } = await import("../data-api/services/articleCleanup");
  const { readFullText } = await import("../data-api/services/articleSummary");

  const answer = (n: number) => `Réponse ${n}. ${"Une phrase de la réponse, assez longue. ".repeat(18)}`.trim();
  const interview = (title: string) => `<!doctype html><html lang="fr"><head>
<title>${title}</title><meta property="og:title" content="${title}">
<meta property="og:site_name" content="Le Monde"></head><body><article>
<h2>Premier temps</h2>
<p><strong>Une question, posée en gras ?</strong></p><p>${answer(1)}</p>
<p><strong>Une autre question ?</strong></p><p>${answer(2)} Avec <em>un mot</em> en italique.</p>
</article></body></html>`;

  test("a block keeps its heading, its bold and its italic, by offsets in its own text", () => {
    expect(
      htmlToStyledBlocks(`<h2>Titre</h2><p><b>Q :</b>  et   <i>la <b>suite</b></i></p><p>rien</p>`),
    ).toEqual([
      { text: "Titre", heading: true, spans: [] },
      { text: "Q : et la suite", spans: [[0, 3, "strong"], [10, 15, "strong"], [7, 15, "em"]] },
      { text: "rien", spans: [] },
    ]);
  });

  test("a saved interview serves its questions as ranges in the text", async () => {
    const saved = await saveArticleFiche(MEMBER.id, { url: "https://ex.test/entretien", html: interview("Un entretien") });
    const text = readFullText(saved.file);
    const styles = readTextStyles(saved.file, text);
    const said = (kind: string) => styles.filter((s) => s.kind === kind).map((s) => text.slice(s.start, s.end));
    expect(said("strong")).toEqual(["Une question, posée en gras ?", "Une autre question ?"]);
    expect(said("em")).toEqual(["un mot"]);
    expect(said("heading")).toEqual(["Premier temps"]);
  });

  test("styles that no longer describe the text are not served", async () => {
    const saved = await saveArticleFiche(MEMBER.id, { url: "https://ex.test/entretien-2", html: interview("Un autre entretien") });
    expect(readTextStyles(saved.file, `Une ligne en plus.\n\n${readFullText(saved.file)}`)).toEqual([]);
  });

  test("a text captured before styles were kept takes them at the next share", async () => {
    const url = "https://ex.test/entretien-3";
    const saved = await saveArticleFiche(MEMBER.id, { url, html: interview("Un troisième entretien") });
    fs.rmSync(path.join(path.dirname(saved.file), `${saved.slug}-fiche`, "text-styles.json"));
    expect(hasTextStyles(saved.file)).toBe(false);

    expect((await saveArticleFiche(MEMBER.id, { url, html: interview("Un troisième entretien") })).text_retaken).toBe(true);
    expect(readTextStyles(saved.file, readFullText(saved.file)).length).toBeGreaterThan(0);
    expect((await saveArticleFiche(MEMBER.id, { url, html: interview("Un troisième entretien") })).text_retaken).toBe(false);
  });
});
