/**
 * The documents (services/mailDocuments.ts, lot 5 of specs/mail-import.md):
 * from the sealed readings, a fiche per person with two messages or more and
 * a digest per thread with two or more, as drafts in the member's garden —
 * marked unreviewed, written by Maurice, every line ending with the pointer
 * to its message and the ids in the frontmatter, a line without a source
 * dropped; a hub note listing them; the artefacts recorded on the source so
 * a note thrown away is never written again and an unchanged one is not
 * rewritten; the ledger rows as the member under the reading job; the cap
 * stopping the run before the call; Maurice's word in the mail
 * conversation; and the admin route.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";

const GARDENS = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "maurice-mail-docs-"));
process.env.MAURICE_GARDENS_DIR = GARDENS;

const db = (await import("../src/db")).default;
const docs = await import("../src/services/mailDocuments");
const approval = await import("../src/services/mailApproval");
const budget = await import("../src/services/budget");
const { addModel } = await import("../src/services/models");
const { pinNewInvocations } = await import("../src/services/ancillary");
const { createSession } = await import("../src/services/auth");
const { createConversation, getMessages } = await import("../src/services/conversations");
const { isServerOnlyTool } = await import("../src/services/toolFamilies");
const admin = (await import("../src/routes/admin")).default;

const ANNA = "md-anna";
const BOSS = "md-admin";
const NIGHT = "deepseek-v4-flash-0731";
const gardenRoot = path.join(GARDENS, ANNA);
const notesDir = path.join(gardenRoot, "notes", "fr");

let material: any[] = [];
let artefacts: any[] = [];
let calls: Array<{ tool: string; args: any }> = [];
let writes: Array<{ system: string; prompt: string }> = [];

const msg = (id: string, from: string, to: string[], date: string, subject: string, thread: string, summary: string) => ({
  id, message_id: `<${id}@x>`, from, from_address: from.match(/<([^>]+)>/)?.[1] ?? from, to, cc: [], date, subject, thread,
  reading: { summary, kind: "personal", people: [], said: [summary], promised: [], decided: [], asked: [], dates: [], open: [], thread: subject },
});

function seed() {
  material = [
    msg("m1", "Jean Derély <jean@x.org>", ["anna@gmail.com"], "2026-09-01T10:00:00+02:00", "Jeudi ?", "<t1@x>", "Jean propose jeudi."),
    msg("m2", "Anna <anna@gmail.com>", ["jean@x.org"], "2026-09-02T10:00:00+02:00", "Re: Jeudi ?", "<t1@x>", "Anna accepte jeudi."),
    msg("m3", "Jean Derély <jean@x.org>", ["anna@gmail.com"], "2026-09-10T10:00:00+02:00", "Le livre", "<t3@x>", "Jean promet de rendre le livre avant octobre."),
    msg("m4", "Erlend <e@y.org>", ["anna@gmail.com"], "2026-06-25T10:00:00+02:00", "Tabouret", "<t4@x>", "Erlend demande si le tabouret est disponible."),
    // Anna on her other address, writing to herself: not a correspondent.
    msg("m6", "Anna <anna@work.example>", ["anna@gmail.com"], "2026-04-15T10:00:00+02:00", "test", "<t6@x>", "Un test."),
    msg("m7", "Anna <anna@work.example>", ["anna@gmail.com"], "2026-04-16T10:00:00+02:00", "test 2", "<t7@x>", "Un autre test."),
    // A service with two notices: the writer declines it.
    msg("m8", "Atlas Team <team@atlas.example>", ["anna@gmail.com"], "2026-05-01T10:00:00+02:00", "Upgrade", "<t8@x>", "Votre cluster sera mis à niveau."),
    msg("m9", "Atlas Team <team@atlas.example>", ["anna@gmail.com"], "2026-06-01T10:00:00+02:00", "Security", "<t9@x>", "Avis de sécurité."),
  ];
  artefacts = [];
}

async function tool(_m: string, name: string, args: any) {
  calls.push({ tool: name, args });
  if (name === "reading_material") return { messages: material, artefacts };
  if (name === "reading_progress") return { job: { id: "job_r1", state: "done" }, progress: {}, capacity: null };
  if (name === "documents_record") {
    for (const w of args.written ?? []) {
      const i = artefacts.findIndex((a) => a.kind === w.kind && a.key === w.key);
      const row = { ...w, written_at: "now", deleted_at: null };
      if (i >= 0) artefacts[i] = row; else artefacts.push(row);
    }
    for (const d of args.deleted ?? []) { const a = artefacts.find((x) => x.kind === d.kind && x.key === d.key); if (a) a.deleted_at = "now"; }
    for (const d of args.declined ?? []) artefacts.push({ ...d, slug: "", locale: "", title: null, written_at: "now", deleted_at: "now" });
    return { recorded: { written: args.written?.length ?? 0, deleted: args.deleted?.length ?? 0, declined: args.declined?.length ?? 0 }, artefacts };
  }
  throw new Error(`unexpected tool ${name}`);
}

const usage = () => ({ provider: "scaleway", model: NIGHT, rounds: 1, input: 1500, output: 300, cache_read: 0, cache_write: 0, cost: 0.002, cost_uncached: null });

let answer: (req: any) => string = (req) => {
  if (req.system.includes("a fiche on one person")) {
    if (req.prompt.includes("Atlas Team")) return JSON.stringify({ is_person: false, why: "a service" });
    return JSON.stringify({
      title: "Jean Derély",
      relationship: "Jean t'écrit depuis septembre 2026 ; vous vous voyez à Bruxelles [1][2].",
      going_on: ["Un rendez-vous jeudi [2]", "Une ligne sans source, à jeter"],
      promised: ["Jean a promis de rendre le livre avant octobre [3]"],
      open: [],
    });
  }
  return JSON.stringify({ title: "Jeudi", about: "Un rendez-vous fixé par mail [1][2].", timeline: ["2026-09-01 — Jean propose jeudi [1]", "2026-09-02 — Anna accepte [2]"], decided: ["Jeudi [2]"], open: [] });
};

async function write(req: any) {
  writes.push({ system: req.system, prompt: req.prompt });
  return { text: answer(req), model: NIGHT, provider: "scaleway", stop: "end" as const, usage: usage() };
}

let bossAuth = "";

beforeAll(() => {
  db.run(`INSERT OR IGNORE INTO households (id, name) VALUES ('default', 'Home')`);
  db.run(`UPDATE households SET scaleway_api_key = 'k' WHERE id = 'default'`);
  db.run(`INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES (?, ?, ?, 'standard')`, [ANNA, ANNA, "Anna"]);
  db.run(`INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES (?, ?, ?, 'admin')`, [BOSS, BOSS, "Boss"]);
  db.run(`INSERT OR IGNORE INTO user_preferences (user_id, locale) VALUES (?, 'fr')`, [ANNA]);
  db.run(`UPDATE user_preferences SET locale = 'fr' WHERE user_id = ?`, [ANNA]);
  db.run(`INSERT OR IGNORE INTO mail_accounts (id, member_id, address, secret) VALUES ('ma-anna', ?, 'anna@gmail.com', 'v1:x')`, [ANNA]);
  addModel({ id: NIGHT, name: "DeepSeek V4 Flash", tier: "cloud", vendor: "deepseek", provider: "scaleway" });
  pinNewInvocations();
  bossAuth = `Bearer ${createSession(BOSS).token}`;
  docs.setMailDocumentsDeps({ call: tool, write, now: () => new Date("2026-09-26T22:00:00Z") });
});

afterAll(() => {
  docs.setMailDocumentsDeps(null);
  budget.setMemberDailyCap(ANNA, null);
});

beforeEach(() => {
  calls = [];
  writes = [];
  seed();
  fs.rmSync(gardenRoot, { recursive: true, force: true });
  fs.mkdirSync(notesDir, { recursive: true });
  db.run(`DELETE FROM spend_ledger WHERE user_id = ?`, [ANNA]);
  db.run(`DELETE FROM mail_conversations WHERE member_id = ?`, [ANNA]);
  budget.setMemberDailyCap(ANNA, null);
});

const read = (slug: string) => fs.readFileSync(path.join(notesDir, `${slug}.md`), "utf8");

test("a fiche for the person with two messages, a digest for the thread with two, a hub; every line sourced, the rest dropped", async () => {
  const r = await docs.writeMailDocuments(ANNA);
  expect(r.outcome).toBe("written");
  expect(r.written.map((n) => [n.kind, n.slug])).toEqual([["hub", "mon-courrier"], ["person", "jean-derely"], ["thread", "jeudi"]]);
  expect(r.skipped).toEqual({ unchanged: 0, deleted: 0, too_few: 0, declined: 1 });
  // Erlend, one message: no fiche. Anna on her other address: not a correspondent. Atlas: asked once, declined.
  expect(writes).toHaveLength(3);
  expect(writes[0]!.system).toContain("in French, tu, never vous");
  expect(writes[0]!.prompt).toContain("[3] 2026-09-10");
  expect(writes[0]!.system).toContain("do not assume Anna's gender");
  const fiche = read("jean-derely");
  expect(fiche).toContain("title: Jean Derély");
  expect(fiche).toContain("parent: mon-courrier");
  expect(fiche).toMatch(/tags:\n\s*- mail\n\s*- correspondent/);
  expect(fiche).toMatch(/opened: false/);
  expect(fiche).toMatch(/author: maurice/);
  expect(fiche).toMatch(/key: jean@x\.org/);
  expect(fiche).toMatch(/sources:\n\s*- m1\n\s*- m2\n\s*- m3/);
  expect(fiche).toContain("## La relation");
  expect(fiche).toContain("Jean t'écrit depuis septembre 2026 ; vous vous voyez à Bruxelles. — (1 sept. 2026, Jean Derély, « Jeudi ? » ; 2 sept. 2026, Anna, « Re: Jeudi ? »)");
  expect(fiche).toContain("- Un rendez-vous jeudi — (2 sept. 2026, Anna, « Re: Jeudi ? »)");
  expect(fiche).not.toContain("sans source");
  expect(fiche).toContain("## Ce qui a été promis\n\n- Jean a promis de rendre le livre avant octobre — (10 sept. 2026, Jean Derély, « Le livre »)");
  expect(fiche).toContain("## D'où ça vient");
  expect(fiche).toContain("Une partie de cette note a été écrite par une machine lisant ton courrier.");
  expect(fiche).toContain("Écrit par Maurice le 26 septembre 2026 à partir de 3 message(s)");
  const digest = read("jeudi");
  expect(digest).toMatch(/- thread/);
  expect(digest).toContain("## Chronologie\n\n- 2026-09-01 — Jean propose jeudi — (1 sept. 2026, Jean Derély, « Jeudi ? »)");
  const hub = read("mon-courrier");
  expect(hub).toMatch(/flags:\n\s*- moc/);
  expect(hub).toContain("## Personnes\n\n- [[jean-derely|Jean Derély]]");
  expect(hub).toContain("## Fils\n\n- [[jeudi|Jeudi]]");
  // The artefacts, keyed on the source; the ledger as Anna under the reading job.
  expect(calls.filter((c) => c.tool === "documents_record")).toHaveLength(1);
  expect(artefacts.map((a) => [a.kind, a.key, a.slug])).toEqual([["person", "jean@x.org", "jean-derely"], ["thread", "<t1@x>", "jeudi"], ["hub", "hub", "mon-courrier"], ["person", "team@atlas.example", ""]]);
  const ledger = db.query(`SELECT job_id FROM spend_ledger WHERE user_id = ?`).all(ANNA) as any[];
  expect(ledger).toHaveLength(3);
  expect(ledger.every((l) => l.job_id === "job_r1")).toBe(true);
  expect(r.cost).toBeCloseTo(0.006, 6);
  expect(r.said).toBeNull(); // no mail conversation yet
});

test("a second run rewrites nothing unchanged, a thrown-away note is never written again, a new message rewrites its fiche", async () => {
  await docs.writeMailDocuments(ANNA);
  writes = [];
  const again = await docs.writeMailDocuments(ANNA);
  expect(again.outcome).toBe("nothing");
  expect(again.written).toEqual([]);
  expect(again.skipped).toEqual({ unchanged: 2, deleted: 1, too_few: 0, declined: 0 }); // Atlas stays declined, never asked again
  expect(writes).toHaveLength(0);
  // The member throws the digest away: found missing once, marked, left alone.
  fs.rmSync(path.join(notesDir, "jeudi.md"));
  material.push(msg("m5", "Jean Derély <jean@x.org>", ["anna@gmail.com"], "2026-09-20T10:00:00+02:00", "Re: Jeudi ?", "<t1@x>", "Jean confirme."));
  const third = await docs.writeMailDocuments(ANNA);
  expect(third.written.map((n) => n.kind)).toEqual(["hub", "person"]); // the fiche has a new source; the digest is not rewritten
  expect(third.skipped.deleted).toBe(2); // the digest thrown away, and Atlas declined
  expect(fs.existsSync(path.join(notesDir, "jeudi.md"))).toBe(false);
  expect(artefacts.find((a) => a.kind === "thread")!.deleted_at).toBeTruthy();
  // The new message is in the provenance; the frontmatter's sources stay what the model cited.
  expect(read("jean-derely")).toContain("- 20 sept. 2026, Jean Derély, « Re: Jeudi ? »");
  const hub = read("mon-courrier");
  expect(hub).not.toContain("[[jeudi|");
  const fourth = await docs.writeMailDocuments(ANNA);
  expect(fourth.skipped).toEqual({ unchanged: 1, deleted: 2, too_few: 0, declined: 0 });
  expect(fourth.written).toEqual([]); // nothing new, nothing newly gone: the hub is left alone
  // The fiche thrown away too: found gone, the hub is refreshed to say so, and Maurice says nothing.
  fs.rmSync(path.join(notesDir, "jean-derely.md"));
  const fifth = await docs.writeMailDocuments(ANNA);
  expect(fifth.written.map((n) => n.kind)).toEqual(["hub"]);
  expect(fifth.said).toBeNull();
  expect(read("mon-courrier")).not.toContain("[[jean-derely|");
  expect(fifth.skipped.deleted).toBe(3);
});

test("the member's cap stops the run before the call; a model answer with no sources writes nothing", async () => {
  budget.setMemberDailyCap(ANNA, 0.001);
  const r = await docs.writeMailDocuments(ANNA);
  expect(r.outcome).toBe("capped");
  expect(writes).toHaveLength(1);
  expect(r.written.map((n) => n.kind)).toEqual(["hub", "person"]); // the first went; the second was refused
  budget.setMemberDailyCap(ANNA, null);
  fs.rmSync(gardenRoot, { recursive: true, force: true }); fs.mkdirSync(notesDir, { recursive: true });
  artefacts = [];
  answer = () => JSON.stringify({ is_person: true, title: "x", relationship: "no source here", going_on: ["nor here"], about: "none", timeline: [] });
  const none = await docs.writeMailDocuments(ANNA);
  expect(none.outcome).toBe("nothing");
  expect(none.written).toEqual([]);
  expect(fs.readdirSync(notesDir)).toEqual([]);
});

test("Maurice says in the mail conversation what he wrote, with the hub's path and the notes' titles", async () => {
  answer = (req) => req.system.includes("a fiche on one person")
    ? req.prompt.includes("Atlas Team") ? JSON.stringify({ is_person: false }) : JSON.stringify({ title: "Jean Derély", relationship: "Un ami [1].", going_on: [], promised: [], open: [] })
    : JSON.stringify({ title: "Jeudi", about: "Un rendez-vous [1].", timeline: [], decided: [], open: [] });
  const c = createConversation(ANNA, null, { openedBy: "maurice" }).id;
  approval.linkMailConversation(ANNA, c);
  const r = await docs.writeMailDocuments(ANNA);
  expect(r.said).toBeTruthy();
  const last = getMessages(c).at(-1)!;
  expect(last.role).toBe("assistant");
  expect(last.content).toContain("j'ai écrit 1 fiche(s) sur les personnes qui comptent et 1 digest(s) des fils");
  expect(last.content).toContain(`/g/${ANNA}/fr/notes/mon-courrier`);
  expect(last.content).toContain("- Jean Derély");
  expect(last.content).not.toMatch(/€|euro/i);
});

test("the admin route writes by hand; the three tool words are the server's", async () => {
  const req = (p: string, init: RequestInit = {}) => admin.request(p, { ...init, headers: { Authorization: bossAuth, "Content-Type": "application/json" } });
  const res = await req("/mail/documents/run", { method: "POST", body: JSON.stringify({ username: ANNA, wait: true }) });
  expect(res.status).toBe(200);
  expect((await res.json()).written.length).toBeGreaterThan(0);
  expect((await (await req(`/mail/documents/${ANNA}`)).json()).last.outcome).toBe("written");
  expect((await req("/mail/documents/run", { method: "POST", body: JSON.stringify({ username: "nobody" }) })).status).toBe(404);
  for (const t of ["reading_material", "reading_reset", "documents_record"]) expect(isServerOnlyTool(`email__${t}`)).toBe(true);
  expect(isServerOnlyTool("email__get_by_id")).toBe(false);
});
