/**
 * reading_progress: the rekey migration, and the upsert it unblocks.
 *
 * The table arrived from akita with `book_id INTEGER PRIMARY KEY` — one reader,
 * one row per book — and `member_id` was later added by ALTER, which cannot
 * change a primary key. So `ON CONFLICT(member_id, book_id)` threw on every
 * write and no reading position ever reached the server. These tests pin both
 * halves: the old shape is rebuilt without losing a row, and two members can
 * then track the same book independently.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "maurice-progress-"));
process.env.MAURICE_DATA_DIR = TMP;
const DB = path.join(TMP, "akita.db");

// The pre-migration shape, written before the service ever opens the file.
beforeAll(() => {
  const db = new Database(DB);
  db.exec(`
    CREATE TABLE reading_progress (
      book_id INTEGER PRIMARY KEY,
      chapter_index INTEGER NOT NULL,
      chapter_slug TEXT NOT NULL,
      view TEXT NOT NULL DEFAULT 'summary',
      enabled INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    , member_id TEXT, scope TEXT NOT NULL DEFAULT 'personal', position REAL NOT NULL DEFAULT 0)
  `);
  db.run(
    `INSERT INTO reading_progress (book_id, chapter_index, chapter_slug, view, enabled, member_id, position, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [42, 7, "0008-Chapter-Seven", "summary", 1, "alice", 0.5, "2026-01-01 00:00:00"],
  );
  // A row from before members existed: nothing can reach it, but losing it
  // silently would be worse than carrying it across.
  db.run(
    `INSERT INTO reading_progress (book_id, chapter_index, chapter_slug, member_id) VALUES (?, ?, ?, ?)`,
    [43, 1, "0002-One", null],
  );
  db.close();
});

afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

const svc = await import("../data-api/services/bookmarks");

test("the old shape is rekeyed on (member_id, book_id), keeping every row", () => {
  // Opening the service runs the migration.
  const before = svc.getReadingProgress("alice", 42);
  expect(before?.chapter_slug).toBe("0008-Chapter-Seven");
  expect(before?.position).toBe(0.5);

  const db = new Database(DB, { readonly: true });
  const keyed = (db.query("PRAGMA table_info(reading_progress)").all() as Array<{ name: string; pk: number }>)
    .filter((c) => c.pk > 0)
    .map((c) => c.name)
    .sort();
  expect(keyed).toEqual(["book_id", "member_id"]);
  expect((db.query("SELECT COUNT(*) n FROM reading_progress").get() as { n: number }).n).toBe(2);
  // The memberless row survived, normalised to '' rather than NULL.
  expect((db.query("SELECT member_id FROM reading_progress WHERE book_id = 43").get() as { member_id: string }).member_id).toBe("");
  db.close();
});

test("the upsert works, and two members track the same book apart", () => {
  svc.updateReadingProgress("alice", 42, 9, "0010-Chapter-Nine", "full", 0);
  expect(svc.getReadingProgress("alice", 42)?.chapter_slug).toBe("0010-Chapter-Nine");
  expect(svc.getReadingProgress("alice", 42)?.view).toBe("full");

  svc.updateReadingProgress("bob", 42, 1, "0002-Chapter-One", "summary", 0);
  expect(svc.getReadingProgress("bob", 42)?.chapter_slug).toBe("0002-Chapter-One");
  // Bob's write left Alice where she was — the whole point of the composite key.
  expect(svc.getReadingProgress("alice", 42)?.chapter_slug).toBe("0010-Chapter-Nine");
});

test("a book nobody has opened has no progress", () => {
  expect(svc.getReadingProgress("alice", 999)).toBeNull();
});
