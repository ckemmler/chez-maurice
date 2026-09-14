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

// The base rewriter used to turn `/api/images/<name>` — what Maurice writes —
// into `/g/<member>/api/images/<name>`, which the engine answered 404: every
// note illustration was broken in a member's garden. `/api/` is the server's
// own root and is now left alone.
test("the note image (/api/images/…) loads under /g/<member>/", async ({ as }) => {
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

test("a resource links to its fiche, which is the garden's alone", async ({ as }) => {
  const page = await as("theo");
  const html = await (await page.goto(`${G}/resources/books/the-makioka-sisters`))!.text();
  // The fiche lives beside the book (books/en/…-fiche.md) and its link spans
  // the collection: /fiches/books/<slug>-fiche.
  expect(html).toContain("/fiches/books/the-makioka-sisters-fiche");
  const index = await (await page.request.get(`${G}/search-index.json`)).text();
  expect(index).toContain("The Makioka Sisters — fiche");
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

test("the theme its owner picked in the app is what the garden serves", async ({ as }) => {
  // `garden_settings.web_theme` is written by the app's picker and was read by
  // nobody: the engine chose from its own environment, so changing the theme
  // in Settings did nothing at all. The proxy now carries it.
  const page = await as("theo");
  await page.goto(`${G}/notes/`);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "botanical");
});

test("a reader trying a theme on still wins over the owner's", async ({ as }) => {
  const page = await as("theo");
  await page.goto(`${G}/notes/?theme=terminal`);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "terminal");
  await page.goto(`${G}/notes/nara-deer`);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "terminal");
});

test("a chosen theme sticks across pages, without the parameter", async ({ as }) => {
  const page = await as("theo");
  // How the app opens a garden: /login?token=…&theme=X redirects to
  // /g/<member>/?theme=X. The engine must set the cookie, and every page
  // after must honour it with no parameter of its own.
  await page.goto(`${G}/?theme=newsprint`);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "newsprint");
  const cookie = (await page.context().cookies()).find((c) => c.name === "theme");
  expect(cookie?.value, "the theme cookie").toBe("newsprint");

  await page.goto(`${G}/notes/`);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "newsprint");
  await page.goto(`${G}/notes/nara-deer`);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "newsprint");
  // And a different one replaces it.
  await page.goto(`${G}/notes/?theme=terminal`);
  await page.goto(`${G}/notes/nara-deer`);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "terminal");
});

test("every shipped theme renders the home and a note, and they differ", async ({ as }) => {
  const page = await as("theo");
  const bodies = new Map<string, string>();
  for (const theme of ["manuscript", "newsprint", "terminal", "botanical", "default"]) {
    for (const path of ["/", "/notes/nara-deer"]) {
      const res = await page.goto(`${G}${path}?theme=${theme}`);
      expect(res?.status(), `${theme} ${path}`).toBe(200);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      if (path === "/notes/nara-deer") bodies.set(theme, await res!.text());
    }
  }
  // `data-theme` is set from the request whether or not the theme exists, so
  // it proves nothing on its own: a theme missing from the registry renders
  // somebody else's layout under its own name. Compare what came back.
  // (Themes share the default's views by design — the difference is the
  // layout and its CSS, so compare documents, not component ids.)
  const rendered = [...bodies.values()];
  expect(new Set(rendered).size, "each theme renders its own page").toBe(rendered.length);
  // And each one carries the note itself, not just its own chrome.
  for (const [theme, html] of bodies) expect(html, theme).toContain("bow for crackers");
});

test("a draft is visible to its owner in every theme", async ({ as }) => {
  // The one regression a theme can hide: a view that still decides visibility
  // for itself. A theme with its own views (the private one does) can drop
  // every draft in every list while looking perfectly healthy.
  const page = await as("theo");
  for (const theme of ["manuscript", "newsprint", "terminal", "botanical", "default"]) {
    const html = await (await page.goto(`${G}/notes/?theme=${theme}`))!.text();
    expect(html, `${theme}: the owner's draft`).toContain("Draft packing list");
    const books = await (await page.goto(`${G}/resources/books/?theme=${theme}`))!.text();
    expect(books, `${theme}: the owner's unpublished book`).toContain("An unpublished book");
  }
});
