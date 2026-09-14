/**
 * Every collection renders, in both locales, through the proxy, as the owner.
 * Wikilinks resolve under the member's base; images load; the search index
 * knows the entry. This is the reference the server build must match.
 */
import { test, expect } from "./helpers";

const G = "/g/theo";

const pages: Array<[string, string, string]> = [
  // [path, expected in <h1> or body, marker]
  ["/", "Théo", ""],
  ["/notes/", "Kansai journal", ""],
  ["/notes/kansai-journal", "Kansai journal", "Two weeks in Kansai"],
  ["/notes/nara-deer", "Nara and the deer", "bow for crackers"],
  ["/fr/notes/journal-kansai", "Journal du Kansai", "Deux semaines"],
  ["/about", "About Théo", "ABOUT-MARKER"],
  ["/fr/a-propos", "À propos de Théo", ""],
  ["/blog/", "First post", ""],
  ["/blog/first-post", "First post", "BLOG-MARKER"],
  ["/essays/", "On pacing a trip", ""],
  ["/essays/on-pacing", "On pacing a trip", "ESSAY-MARKER"],
  ["/resources/", "", ""],
  ["/resources/books/", "The Makioka Sisters", ""],
  ["/resources/books/the-makioka-sisters", "The Makioka Sisters", "BOOK-MARKER"],
  ["/resources/articles/kansai-with-kids", "Kansai with kids", "ARTICLE-MARKER"],
  ["/resources/people/jun-ichiro-tanizaki", "Tanizaki", "PERSON-MARKER"],
  ["/resources/podcasts/kansai-radio", "Kansai radio", "PODCAST-MARKER"],
  ["/resources/movies/tampopo", "Tampopo", "MOVIE-MARKER"],
  ["/resources/series/midnight-diner", "Midnight Diner", "SERIES-MARKER"],
  ["/resources/games/animal-crossing", "Animal Crossing", "GAME-MARKER"],
  ["/fr/trouvailles/livres/", "Les sœurs Makioka", ""],
  ["/fr/trouvailles/livres/les-soeurs-makioka", "Les sœurs Makioka", "LIVRE-MARKER"],
];

/** The server's HTML as text, tags stripped: what the engine rendered, before
 *  any client script (the MOC-card script, see below) reshapes the page. */
function text(html: string): string {
  return html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/g, "").replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

for (const [path, title, marker] of pages) {
  test(`renders ${path}`, async ({ as }) => {
    const page = await as("theo");
    const res = await page.goto(`${G}${path}`);
    expect(res?.status(), `${path} status`).toBe(200);
    const body = text(await res!.text());
    if (title) expect(body).toContain(title);
    if (marker) expect(body).toContain(marker);
  });
}

test("wikilinks resolve under the member's base", async ({ as }) => {
  const page = await as("theo");
  await page.goto(`${G}/notes/nara-deer`);
  const hrefs = await page.locator("article a, main a, .prose a").evaluateAll((as) => as.map((a) => a.getAttribute("href")));
  expect(hrefs.some((h) => new RegExp(`^${G}/notes/kansai-journal/?$`).test(h ?? ""))).toBe(true);
});

// KNOWN BUG (documented, not yet fixed): the base-prefixing middleware turns a
// note image `/api/images/<name>` — what Maurice writes — into
// `/g/<member>/api/images/<name>`, which the engine answers 404. The image is
// broken in every member garden under /g/. Flip to a plain test when fixed.
test("the note image (/api/images/…) loads under /g/<member>/", async ({ as }) => {
  test.fail();
  const page = await as("theo");
  await page.goto(`${G}/notes/nara-deer`);
  const img = page.locator("img[alt='deer']");
  await expect(img).toHaveCount(1);
  const src = (await img.getAttribute("src"))!;
  const r = await page.request.get(src);
  expect(r.status(), `GET ${src}`).toBe(200);
  expect(r.headers()["content-type"]).toContain("png");
});

// KNOWN BUG: the MOC-card script (NoteDetail.astro, "mixed paragraph" branch)
// keeps only the text AFTER a wiki-link as the card's annotation; whatever
// came before the link in the same paragraph is dropped from the DOM. The
// server HTML is complete; the browser loses "Half a day is plenty…".
test("text before a wiki-link survives the MOC card script", async ({ as }) => {
  test.fail();
  const page = await as("theo");
  const res = await page.goto(`${G}/notes/nara-deer`);
  expect(await res!.text()).toContain("Half a day is plenty");
  await page.waitForTimeout(500);
  expect(await page.locator("article").innerText()).toContain("Half a day is plenty");
});

test("the MOC lists its children in order", async ({ as }) => {
  const page = await as("theo");
  await page.goto(`${G}/notes/kansai-journal`);
  const text = await page.locator("body").innerText();
  expect(text.indexOf("Nara and the deer")).toBeGreaterThan(-1);
  expect(text.indexOf("Nara and the deer")).toBeLessThan(text.indexOf("Kyoto with the kids"));
});

test("the search index carries every public entry", async ({ as }) => {
  const page = await as("theo");
  const r = await page.request.get(`${G}/search-index.json`);
  expect(r.status()).toBe(200);
  const text = await r.text();
  for (const needle of ["Kansai journal", "The Makioka Sisters", "First post", "On pacing a trip", "Tampopo", "Kansai radio"]) {
    expect(text, needle).toContain(needle);
  }
});

test("every shipped theme renders the home and a note", async ({ as }) => {
  const page = await as("theo");
  for (const theme of ["manuscript", "newsprint", "terminal", "botanical", "default"]) {
    for (const path of ["/", "/notes/nara-deer"]) {
      const res = await page.goto(`${G}${path}?theme=${theme}`);
      expect(res?.status(), `${theme} ${path}`).toBe(200);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    }
  }
});
