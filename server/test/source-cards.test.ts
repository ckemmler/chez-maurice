// The source card (20 September 2026): what a search hands the client to draw.
// Both searches — the corpus and the web — collapse into one shape, because a
// search is a list of things to go and look at whichever index answered.
//
// The part worth pinning down is the cover. The garden's frontmatter names an
// image in four incompatible dialects, so the path is derived from collection,
// locale and slug instead, and only handed over when the file is really there:
// a card with a broken image is worse than a card with a letter in a box.

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

  test("the card is capped, and says how many there really were", () => {
    const many = Array.from({ length: 30 }, () => hit());
    const card = corpusSourceCard({ results: many })!;
    expect(card.results.length).toBe(12);
    expect(card.count).toBe(30);
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
