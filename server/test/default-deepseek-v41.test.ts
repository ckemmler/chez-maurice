/**
 * DeepSeek V4.1 Flash is the default everywhere since 29 October 2026
 * (db.ts, Scaleway roster generation 3). A household that ran on V4 Flash is
 * moved on its next start: its chat default and its side-task model, with
 * access for every member who could use V4 Flash. What a person chose for
 * themselves stays.
 *
 * The migration runs when src/db.ts is first imported, once per process, so
 * the household is opened by a child process on a database of its own.
 */

import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const OLD = "deepseek-v4-flash-0731";
const NEW = "deepseek-v4.1-flash";
const DB_MODULE = path.join(import.meta.dir, "../src/db.ts");

function start(dir: string): void {
  const run = Bun.spawnSync(["bun", "-e", `await import(${JSON.stringify(DB_MODULE)})`], {
    env: { ...process.env, MAURICE_DATA_DIR: dir, MAURICE_TEST_DATA_DIR: dir },
    stderr: "pipe",
  });
  if (run.exitCode !== 0) throw new Error(run.stderr.toString());
}

test("a household on V4 Flash wakes up on V4.1 Flash; a member's own choice stays", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maurice-v41-"));
  try {
    start(dir);
    const file = path.join(dir, "maurice.db");
    let db = new Database(file);
    db.run(`INSERT OR IGNORE INTO households (id, name) VALUES ('default', 'Home')`);
    // The household as it stood before this code: generation 2, on V4 Flash,
    // the seed's wording on both rows, a member allowed V4 Flash only and
    // choosing it as her own everyday model.
    db.run(`UPDATE households SET scaleway_roster_gen = 2, default_model = ?, ancillary_model = ? WHERE id = 'default'`, [OLD, OLD]);
    db.run(`UPDATE models SET descr = 'The everyday default: fast reasoning, a cached-input price. Text only.' WHERE id = ?`, [OLD]);
    db.run(`UPDATE models SET descr = 'The next Flash: fast reasoning, reads images, a cached-input price.' WHERE id = ?`, [NEW]);
    db.run(`INSERT INTO users (id, username, display_name, role) VALUES ('u-ines', 'ines', 'Inès', 'standard')`);
    db.run(`INSERT INTO user_model_access (user_id, model_id) VALUES ('u-ines', ?)`, [OLD]);
    db.run(`UPDATE users SET everyday_model = ? WHERE id = 'u-ines'`, [OLD]);
    db.close();

    start(dir);
    db = new Database(file);
    const hh = db.query(`SELECT default_model, ancillary_model, scaleway_roster_gen FROM households WHERE id = 'default'`).get() as any;
    expect(hh).toEqual({ default_model: NEW, ancillary_model: NEW, scaleway_roster_gen: 3 });
    const access = (db.query(`SELECT model_id FROM user_model_access WHERE user_id = 'u-ines' ORDER BY model_id`).all() as any[]).map((r) => r.model_id);
    expect(access).toEqual([OLD, NEW]);
    expect((db.query(`SELECT everyday_model FROM users WHERE id = 'u-ines'`).get() as any).everyday_model).toBe(OLD);
    const descr = (id: string) => (db.query(`SELECT descr FROM models WHERE id = ?`).get(id) as any).descr;
    expect(descr(NEW)).toStartWith("The everyday default");
    expect(descr(OLD)).toStartWith("The previous Flash");
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
