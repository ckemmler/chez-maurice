/**
 * An article shared with Maurice from the share sheet: read from the page
 * Safari rendered, nothing saved. Run with `bun test`.
 */
import { describe, expect, test } from "bun:test";

const { readSharedArticle, ArticleReadError } = await import("../data-api/services/articleRead");

const page = `<!doctype html><html lang="fr"><head>
<title>Un article | Le Monde</title>
<meta property="og:title" content="Un article lisible">
<meta property="og:site_name" content="Le Monde">
<meta name="author" content="Jeanne Martin">
</head><body><nav>Menu</nav><article><h1>Un article lisible</h1>
<p>${"Le premier paragraphe de l'article. ".repeat(30)}</p>
<p>${"Le second paragraphe. ".repeat(30)}</p></article></body></html>`;

describe("readSharedArticle", () => {
  test("reads the rendered page: text in paragraphs, card metadata", async () => {
    const read = await readSharedArticle({ url: "https://www.lemonde.fr/a/lisible.html", html: page });
    expect(read.title).toBe("Un article lisible");
    expect(read.site_name).toBe("Le Monde");
    expect(read.author).toBe("Jeanne Martin");
    expect(read.lang).toBe("fr");
    expect(read.url).toBe("https://www.lemonde.fr/a/lisible.html");
    expect(read.text).toContain("Le premier paragraphe");
    expect(read.text).toContain("\n\nLe second paragraphe");
    expect(read.text).not.toContain("Menu");
    expect(read.word_count).toBeGreaterThan(100);
  });

  test("refuses what is not an http(s) address", async () => {
    for (const url of ["", "file:///etc/passwd", "javascript:alert(1)"]) {
      const err = await readSharedArticle({ url, html: page }).catch((e) => e);
      expect(err).toBeInstanceOf(ArticleReadError);
      expect(err.status).toBe(400);
    }
  });

  test("a page with no text in it is an error, not an empty card", async () => {
    const err = await readSharedArticle({
      url: "https://example.com/vide",
      html: "<!doctype html><html><head><title>Vide</title></head><body></body></html>",
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ArticleReadError);
    expect(err.status).toBe(422);
  });

  test("an oversized DOM is refused before parsing", async () => {
    const err = await readSharedArticle({ url: "https://example.com/x", html: "x".repeat(8 * 1024 * 1024 + 1) })
      .catch((e) => e);
    expect(err.status).toBe(413);
  });
});
