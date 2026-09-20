// The source card (20 September 2026): what a search hands the client to draw.
// Both searches — the corpus and the web — collapse into one shape, because a
// search is a list of things to go and look at whichever index answered.
//
// Two things are worth pinning down. The cover, because the garden's
// frontmatter names an image in four incompatible dialects: the resolvable one
// is used when it is there, the conventional name is tried otherwise, and
// either way the file is stat-ed — a card with a broken image is worse than a
// card with an icon in a box. And the de-duplication, because a search returns
// chunks: one Guardian article came back four times in the first real run, and
// four cards for one article is not four sources.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let root = "";
const prevEnv = process.env.MAURICE_GARDENS_DIR;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "cards-"));
  process.env.MAURICE_GARDENS_DIR = root;
  mkdirSync(join(root, "anna", "images", "resources", "books"), { recursive: true });
  writeFileSync(join(root, "anna", "images", "resources", "books", "fr-humus.jpg"), "jpeg");
});

afterAll(() => {
  if (prevEnv === undefined) delete process.env.MAURICE_GARDENS_DIR;
  else process.env.MAURICE_GARDENS_DIR = prevEnv;
  rmSync(root, { recursive: true, force: true });
});

const { corpusSourceCard, webSourceCard, domainOf } = await import("../src/services/sourceCards");

function hit(extra: Record<string, unknown> = {}) {
  return {
    file_path: join(root, "anna", "books", "fr", "humus-fiche.md"),
    source_type: "fiche",
    resource_collection: "books",
    resource_id: "humus",
    locale: "fr",
    title: "Humus",
    author: "Gaspard Koenig",
    year: 2023,
    text: "  Le roman suit deux ingénieurs agronomes   et leurs vers de terre. ",
    score: 0.6214159,
    ...extra,
  };
}

describe("a corpus search becomes a card", () => {
  test("the cover is derived and only offered when the file exists", () => {
    const card = corpusSourceCard({ results: [hit()] }, "les vers de terre")!;
    expect(card.card).toBe("sources");
    expect(card.origin).toBe("corpus");
    expect(card.query).toBe("les vers de terre");
    const [item] = card.results;
    expect(item.image).toBe("/api/garden-images/anna/books/fr-humus.jpg");
    // Same row, a slug with no file on disk: no image rather than a broken one.
    const missing = corpusSourceCard({ results: [hit({ resource_id: "nowhere" })] })!;
    expect(missing.results[0].image).toBeUndefined();
  });

  test("title, subtitle, snippet and score are what a card needs", () => {
    const [item] = corpusSourceCard({ results: [hit()] })!.results;
    expect(item.title).toBe("Humus");
    expect(item.subtitle).toBe("Gaspard Koenig · 2023");
    expect(item.kind).toBe("fiche");
    expect(item.snippet).toBe("Le roman suit deux ingénieurs agronomes et leurs vers de terre.");
    expect(item.score).toBe(0.621);
  });

  test("a conversation hit falls back to its own fields", () => {
    const [item] = corpusSourceCard({
      results: [
        {
          file_path: join(root, "anna", "conversations", "x"),
          source_type: "conversation",
          conversation_title: "Travail après la Chaconne",
          date: "2026-06-11T08:00:00Z",
          text: "On reprend les doubles cordes.",
        },
      ],
    })!.results;
    expect(item.title).toBe("Travail après la Chaconne");
    expect(item.kind).toBe("conversation");
    expect(item.subtitle).toBe("2026-06-11");
    expect(item.image).toBeUndefined();
  });

  test("a hit with no title at all is named by its file", () => {
    const [item] = corpusSourceCard({
      results: [{ file_path: join(root, "anna", "notes", "en", "le-violon-a-l-hotel.md"), source_type: "note" }],
    })!.results;
    expect(item.title).toBe("le-violon-a-l-hotel");
  });

  test("an unrecognised payload is refused, so the caller keeps the raw one", () => {
    expect(corpusSourceCard({ results: [] })).toBeNull();
    expect(corpusSourceCard({ rows: [hit()] })).toBeNull();
    expect(corpusSourceCard("not json at all")).toBeNull();
    expect(corpusSourceCard(null)).toBeNull();
  });

  test("the card is capped, and says how many sources there really were", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      hit({ file_path: join(root, "anna", "books", "fr", `book-${i}-fiche.md`), resource_id: `book-${i}` }));
    const card = corpusSourceCard({ results: many })!;
    expect(card.results.length).toBe(12);
    expect(card.count).toBe(30);
  });

  test("a long article is one source, not one per chunk", () => {
    // What a real search returns: the same Guardian piece four times over,
    // best passage first. Four cards for one article is not four sources.
    const chunks = [0, 1, 2, 3].map((i) =>
      hit({ chunk_index: i, chunk_id: `c${i}`, score: 0.4 - i / 100, text: `passage ${i}` }));
    const card = corpusSourceCard({ results: [...chunks, hit({ file_path: join(root, "anna", "notes", "fr", "autre.md"), title: "Autre" })] })!;
    expect(card.count).toBe(2);
    expect(card.results.length).toBe(2);
    // The first hit of the file wins, which is the highest-scoring passage.
    expect(card.results[0].snippet).toBe("passage 0");
    expect(card.results[1].title).toBe("Autre");
  });

  test("a conversation is one source however many passages matched", () => {
    // A conversation has no file path, so it identifies by conversation_id.
    // Without that, the same thread came back three times in a real search.
    const turns = [0, 1, 2].map((i) => ({
      chunk_id: `k${i}`,
      conversation_id: "convo-7",
      conversation_title: "American political polarization",
      source_type: "conversation",
      date: "2026-03-12",
      text: `tour ${i}`,
      score: 0.62 - i / 100,
    }));
    const card = corpusSourceCard({ results: turns })!;
    expect(card.count).toBe(1);
    expect(card.results[0].snippet).toBe("tour 0");
  });

  test("a garden article keeps the link it was read at", () => {
    const [item] = corpusSourceCard({
      results: [hit({ url: "https://www.theguardian.com/x", publication: "the Guardian" })],
    })!.results;
    expect(item.url).toBe("https://www.theguardian.com/x");
    // A relative or junk value is not a link.
    const [none] = corpusSourceCard({ results: [hit({ url: "/local/path" })] })!.results;
    expect(none.url).toBeUndefined();
  });

  test("the frontmatter's own image is used when it resolves", () => {
    const [item] = corpusSourceCard({
      results: [
        hit({
          resource_id: "",
          slug: "",
          image: "/images/anna/resources/books/fr-humus.jpg",
        }),
      ],
    })!.results;
    expect(item.image).toBe("/api/garden-images/anna/books/fr-humus.jpg");
  });
});

describe("a web search becomes the same card", () => {
  test("the domain stands in for the missing favicon", () => {
    const card = webSourceCard(
      {
        answer: "Un septembre record.",
        results: [
          { title: "Vers un septembre exceptionnel", url: "https://www.meteosuisse.admin.ch/a/b", content: "Les températures…" },
          { title: "", url: "https://lejma.be/edito", content: "" },
        ],
      },
      "septembre 2026 chaleur",
    )!;
    expect(card.origin).toBe("web");
    expect(card.count).toBe(2);
    expect(card.results[0].subtitle).toBe("meteosuisse.admin.ch");
    expect(card.results[0].url).toBe("https://www.meteosuisse.admin.ch/a/b");
    expect(card.results[0].kind).toBe("web");
    // No title from the search: the domain is the honest fallback.
    expect(card.results[1].title).toBe("lejma.be");
    expect(card.results[1].snippet).toBeUndefined();
  });

  test("no results, no card", () => {
    expect(webSourceCard({ results: [] })).toBeNull();
  });

  test("a malformed url costs the subtitle, not the card", () => {
    expect(domainOf("not a url")).toBe("");
    const card = webSourceCard({ results: [{ title: "Sans URL", url: "not a url", content: "x" }] })!;
    expect(card.results[0].title).toBe("Sans URL");
    expect(card.results[0].subtitle).toBeUndefined();
  });
});
