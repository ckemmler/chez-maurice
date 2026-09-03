/**
 * Highlights carry the view their offsets belong to.
 *
 * A chapter has two texts — the full one and its summary — and the same
 * chapter_slug with the same numbers means two different places in them. The
 * column was missing, so the reader refused to highlight a summary rather than
 * resolve the ambiguity. These check the resolution, including the migration
 * onto a table that predates the column.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "maurice-highlights-"));

/** The table as it was before `view` existed, so the migration has work to do. */
beforeAll(() => {
  const db = new Database(path.join(TMP, "akita.db"));
  db.exec(`
    CREATE TABLE highlights (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id TEXT NOT NULL DEFAULT '',
      book_id INTEGER NOT NULL,
      chapter_slug TEXT NOT NULL,
      quote TEXT NOT NULL,
      note TEXT,
      color TEXT NOT NULL DEFAULT 'yellow',
      start_offset INTEGER,
      end_offset INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.query(
    `INSERT INTO highlights (member_id, book_id, chapter_slug, quote, start_offset, end_offset)
     VALUES ('m1', 7, 'ch-1', 'une phrase déjà surlignée avant la colonne', 10, 40)`,
  ).run();
  db.close();
});

// The service captures its database path at import time, so the override has to
// be in place for exactly that moment — and only that moment. `bun test` runs
// every file in one process, and leaving MAURICE_DATA_DIR set pointed a sibling
// suite at this temp directory, where its tables do not exist.
const previousDataDir = process.env.MAURICE_DATA_DIR;
process.env.MAURICE_DATA_DIR = TMP;
const {
  asHighlightView,
  createHighlight,
  deleteHighlight,
  listHighlights,
  updateHighlight,
} = await import("../data-api/services/highlights");
if (previousDataDir === undefined) delete process.env.MAURICE_DATA_DIR;
else process.env.MAURICE_DATA_DIR = previousDataDir;

const M = "m1";
const BOOK = 7;

test("an install that predates the column keeps its highlights, as full-text ones", () => {
  const all = listHighlights(M, BOOK);
  expect(all).toHaveLength(1);
  expect(all[0]!.quote).toContain("déjà surlignée");
  // Everything stored before the column existed was necessarily on the full text.
  expect(all[0]!.view).toBe("full");
});

describe("the two texts of a chapter", () => {
  test("the same range in each is two highlights, not a collision", () => {
    const onFull = createHighlight(M, BOOK, {
      chapterSlug: "ch-2",
      quote: "le passage du texte intégral",
      startOffset: 100,
      endOffset: 128,
      view: "full",
    });
    const onSummary = createHighlight(M, BOOK, {
      chapterSlug: "ch-2",
      quote: "le passage du résumé",
      startOffset: 100, // identical offsets, different document
      endOffset: 128,
      view: "summary",
    });
    expect(onFull.view).toBe("full");
    expect(onSummary.view).toBe("summary");
    expect(onFull.id).not.toBe(onSummary.id);

    expect(listHighlights(M, BOOK, "summary").map((h) => h.id)).toEqual([onSummary.id]);
    expect(listHighlights(M, BOOK, "full").map((h) => h.id)).toContain(onFull.id);
    expect(listHighlights(M, BOOK, "full").map((h) => h.id)).not.toContain(onSummary.id);
  });

  test("unfiltered returns both — the reader loads once and picks per view", () => {
    const views = new Set(listHighlights(M, BOOK).map((h) => h.view));
    expect(views).toEqual(new Set(["full", "summary"]));
  });
});

test("a highlight on a summary keeps its note through an edit", () => {
  const h = createHighlight(M, BOOK, {
    chapterSlug: "ch-3",
    quote: "ce que le résumé dit de Phi",
    view: "summary",
  });
  const edited = updateHighlight(M, h.id, { note: "à relier à la fiche Being You", color: "green" });
  expect(edited?.note).toBe("à relier à la fiche Being You");
  expect(edited?.color).toBe("green");
  // The edit must not quietly move it to the other text.
  expect(edited?.view).toBe("summary");
});

test("an unknown view falls back to full rather than being stored as garbage", () => {
  expect(asHighlightView("summary")).toBe("summary");
  expect(asHighlightView("full")).toBe("full");
  expect(asHighlightView("resume")).toBe("full");
  expect(asHighlightView(undefined)).toBe("full");
  expect(asHighlightView(null)).toBe("full");
  const h = createHighlight(M, BOOK, {
    chapterSlug: "ch-4",
    quote: "x",
    view: "nonsense" as never,
  });
  expect(h.view).toBe("full");
});

test("another member sees none of it", () => {
  expect(listHighlights("m2", BOOK)).toHaveLength(0);
  expect(listHighlights("m2", BOOK, "summary")).toHaveLength(0);
});

test("deleting one leaves the other text's alone", () => {
  const summary = listHighlights(M, BOOK, "summary");
  const before = listHighlights(M, BOOK, "full").length;
  expect(deleteHighlight(M, summary[0]!.id)).toBe(true);
  expect(listHighlights(M, BOOK, "full")).toHaveLength(before);
  expect(listHighlights(M, BOOK, "summary").map((h) => h.id)).not.toContain(summary[0]!.id);
});
