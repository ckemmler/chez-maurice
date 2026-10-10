/**
 * The word a member gave in the conversation Maurice used to open about
 * their mail is carried to `mail_reading_consent` when the server boots
 * (src/db.ts, 10 October 2026): a yes or a no on `mail_conversations` becomes
 * the member's row, dated as it was given; a question left unanswered, or a
 * row whose member is gone, carries nothing; and a word given since, on the
 * card, is never overwritten by the old one at a later boot.
 *
 * db.ts opens its database once per process, so each boot here is a process
 * of its own, on a throwaway data directory that is this suite's alone.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "bun:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maurice-consent-migration-"));
const dbModule = path.join(import.meta.dir, "..", "src", "db.ts");

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

/** Boot db.ts in a process of its own on `dir`, run `body` with `db`, and
 *  return what it prints as JSON. */
function boot(body: string): any {
  const script = `const db = (await import(${JSON.stringify(dbModule)})).default;\n${body}`;
  const r = Bun.spawnSync([process.execPath, "-e", script], {
    cwd: path.join(import.meta.dir, ".."),
    env: { PATH: process.env.PATH ?? "", HOME: dir, TMPDIR: process.env.TMPDIR ?? "", NODE_ENV: "test", MAURICE_DATA_DIR: dir },
  });
  if (r.exitCode !== 0) throw new Error(`boot failed: ${r.stderr.toString()}`);
  const out = r.stdout.toString().trim().split("\n").at(-1) ?? "null";
  return JSON.parse(out);
}

const CONSENT = `console.log(JSON.stringify(db.query("SELECT member_id, reading, decided_at FROM mail_reading_consent ORDER BY member_id").all()));`;

test("a boot carries the yes and the no of the old conversations, dated as given, and nothing else", () => {
  // A household as it stood before: the answers on the conversations' rows.
  const first = boot(`
    db.run("INSERT OR IGNORE INTO households (id, name) VALUES ('default', 'Home')");
    for (const id of ["mc-yes", "mc-no", "mc-asked", "mc-undated"]) db.run("INSERT INTO users (id, username, display_name, role) VALUES (?, ?, ?, 'standard')", [id, id, id]);
    db.run("DELETE FROM mail_reading_consent");
    db.run("INSERT INTO mail_conversations (member_id, conversation_id, opened_at, reading, decided_at) VALUES ('mc-yes', 'c1', '2026-09-26 13:52:00', 'approved', '2026-09-27 08:00:00')");
    db.run("INSERT INTO mail_conversations (member_id, conversation_id, opened_at, reading, decided_at) VALUES ('mc-no', 'c2', '2026-09-26 13:52:00', 'declined', '2026-09-28 09:30:00')");
    db.run("INSERT INTO mail_conversations (member_id, conversation_id, opened_at, reading) VALUES ('mc-asked', 'c3', '2026-09-26 13:52:00', 'pending')");
    db.run("INSERT INTO mail_conversations (member_id, conversation_id, opened_at, reading) VALUES ('mc-undated', 'c4', '2026-09-29 03:05:00', 'approved')");
    db.run("INSERT INTO mail_conversations (member_id, conversation_id, opened_at, reading, decided_at) VALUES ('mc-gone', 'c5', '2026-09-26 13:52:00', 'approved', '2026-09-27 08:00:00')");
    ${CONSENT}
  `);
  expect(first).toEqual([]);

  expect(boot(CONSENT)).toEqual([
    { member_id: "mc-no", reading: "declined", decided_at: "2026-09-28 09:30:00" },
    // An answer with no date of its own takes the conversation's.
    { member_id: "mc-undated", reading: "approved", decided_at: "2026-09-29 03:05:00" },
    { member_id: "mc-yes", reading: "approved", decided_at: "2026-09-27 08:00:00" },
  ]);
});

test("a word given since on the card is the member's: a later boot does not put the old one back", () => {
  // The yes of the conversation, withdrawn on the card; the no, turned into a yes.
  boot(`
    db.run("UPDATE mail_reading_consent SET reading = 'declined', decided_at = '2026-10-10 10:00:00' WHERE member_id = 'mc-yes'");
    db.run("UPDATE mail_reading_consent SET reading = 'approved', decided_at = '2026-10-10 10:05:00' WHERE member_id = 'mc-no'");
    console.log("null");
  `);
  const after = boot(CONSENT) as Array<{ member_id: string; reading: string; decided_at: string }>;
  expect(after.find((r) => r.member_id === "mc-yes")).toEqual({ member_id: "mc-yes", reading: "declined", decided_at: "2026-10-10 10:00:00" });
  expect(after.find((r) => r.member_id === "mc-no")).toEqual({ member_id: "mc-no", reading: "approved", decided_at: "2026-10-10 10:05:00" });
  expect(after).toHaveLength(3);
  // The old rows are left as the record of which conversation it was.
  expect(boot(`console.log(JSON.stringify(db.query("SELECT COUNT(*) AS n FROM mail_conversations").get()));`)).toEqual({ n: 5 });
});
