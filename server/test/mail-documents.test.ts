/**
 * The documents (services/mailDocuments.ts, lot 5 of specs/mail-import.md;
 * services/mailPeople.ts, lot 3 of specs/contacts.md): from the sealed
 * readings, a fiche in `people/` per person with two messages or more —
 * their addresses joined by the address book, the relation once in the
 * fiche, the interactions in fragments per address and mailbox, everything
 * pending until the member touches it — and a digest per thread with two or
 * more, as a note; every line ending with a link to its message, a line
 * without a source dropped; a hub note listing them; the artefacts recorded
 * on the source so what the member threw away is never written again and
 * what did not change is not rewritten; what the member corrected kept and
 * given back to the writer; the ledger as the member under the reading job;
 * the cap stopping the run before the call; nothing said to the member in
 * any conversation (10 October 2026); the erasing; and the admin routes.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";

const GARDENS = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "maurice-mail-docs-"));
process.env.MAURICE_GARDENS_DIR = GARDENS;

const db = (await import("../src/db")).default;
const docs = await import("../src/services/mailDocuments");
const people = await import("../src/services/mailPeople");
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
const peopleDir = path.join(gardenRoot, "people", "fr");

let material: any[] = [];
/** Headers in the store the reading never kept: in the exchanges, not in the material. */
let unread: any[] = [];
let exchangesDown = false;
let artefacts: any[] = [];
let calls: Array<{ tool: string; args: any }> = [];
let writes: Array<{ system: string; prompt: string }> = [];

const GMAIL = ["anna@gmail.com"];
const PROTON = ["anna@proton.me"];

const msg = (id: string, from: string, to: string[], date: string, subject: string, thread: string, summary: string, mailboxes = GMAIL) => ({
  id, message_id: `<${id}@x>`, from, from_address: from.match(/<([^>]+)>/)?.[1] ?? from, to, cc: [], date, subject, thread, mailboxes,
  reading: { summary, kind: "personal", people: [], said: [summary], promised: [], decided: [], asked: [], dates: [], open: [], thread: subject },
});

function seed() {
  material = [
    msg("m1", "Jean Derély <jean@x.org>", ["anna@gmail.com"], "2026-09-01T10:00:00+02:00", "Jeudi ?", "<t1@x>", "Jean propose jeudi."),
    msg("m2", "Anna <anna@gmail.com>", ["jean@x.org"], "2026-09-02T10:00:00+02:00", "Re: Jeudi ?", "<t1@x>", "Anna accepte jeudi.", ["anna@gmail.com", "anna@proton.me"]),
    msg("m3", "Jean Derély <jean@x.org>", ["anna@proton.me"], "2026-09-10T10:00:00+02:00", "Le livre", "<t3@x>", "Jean promet de rendre le livre avant octobre.", PROTON),
    msg("m4", "Erlend <e@y.org>", ["anna@gmail.com"], "2026-06-25T10:00:00+02:00", "Tabouret", "<t4@x>", "Erlend demande si le tabouret est disponible."),
    // Anna on her other address, writing to herself: not a correspondent.
    msg("m6", "Anna <anna@work.example>", ["anna@gmail.com"], "2026-04-15T10:00:00+02:00", "test", "<t6@x>", "Un test."),
    msg("m7", "Anna <anna@work.example>", ["anna@gmail.com"], "2026-04-16T10:00:00+02:00", "test 2", "<t7@x>", "Un autre test."),
    // A service with two notices: the writer declines it.
    msg("m8", "Atlas Team <team@atlas.example>", ["anna@gmail.com"], "2026-05-01T10:00:00+02:00", "Upgrade", "<t8@x>", "Votre cluster sera mis à niveau."),
    msg("m9", "Atlas Team <team@atlas.example>", ["anna@gmail.com"], "2026-06-01T10:00:00+02:00", "Security", "<t9@x>", "Avis de sécurité."),
  ];
  unread = [];
  exchangesDown = false;
  artefacts = [];
}

async function tool(_m: string, name: string, args: any) {
  calls.push({ tool: name, args });
  if (name === "reading_material") return { messages: material, artefacts };
  if (name === "reading_progress") return { job: { id: "job_r1", state: "done" }, progress: {}, capacity: null };
  if (name === "exchanges") {
    if (exchangesDown) throw new Error("the store is locked");
    // The header store holds what was read, and what the reading passed over.
    const mine = [...material, ...unread].filter((m) => args.addresses.some((a: string) => m.from_address === a || m.to.some((t: string) => t.includes(a))))
      .sort((a, b) => b.date.localeCompare(a.date));
    return { total: mine.length, first: mine.at(-1)?.date ?? null, last: mine[0]?.date ?? null, messages: mine.slice(0, args.limit).map((m) => ({ id: m.id, date: m.date, from: m.from, subject: m.subject, mailboxes: m.mailboxes })) };
  }
  if (name === "documents_record") {
    for (const w of args.written ?? []) {
      const i = artefacts.findIndex((a) => a.kind === w.kind && a.key === w.key);
      const row = { ...w, written_at: "now", deleted_at: null };
      if (i >= 0) artefacts[i] = row; else artefacts.push(row);
    }
    for (const d of args.deleted ?? []) { const a = artefacts.find((x) => x.kind === d.kind && x.key === d.key); if (a) a.deleted_at = "now"; }
    for (const d of args.declined ?? []) artefacts.push({ ...d, slug: "", locale: "", title: null, written_at: "now", deleted_at: "now" });
    for (const f of args.forgotten ?? []) artefacts = artefacts.filter((x) => !(x.kind === f.kind && x.key === f.key));
    return { recorded: { written: args.written?.length ?? 0, deleted: args.deleted?.length ?? 0, declined: args.declined?.length ?? 0 }, artefacts };
  }
  if (name === "documents_reset") {
    const before = artefacts.length;
    artefacts = artefacts.filter((a) => a.slug === "");
    return { reset: before - artefacts.length, artefacts };
  }
  throw new Error(`unexpected tool ${name}`);
}

const usage = () => ({ provider: "scaleway", model: NIGHT, rounds: 1, input: 1500, output: 300, cache_read: 0, cache_write: 0, cost: 0.002, cost_uncached: null });

const PERSON = "what their mail with one person says";

/** The index a message has in the prompt, as `[n]`, found by its subject. */
const cite = (prompt: string, subject: string): string => {
  const line = prompt.split("\n").find((l) => /^\[\d+\]/.test(l) && l.endsWith(`"${subject}"`));
  return line ? line.match(/^\[\d+\]/)![0] : "";
};

const defaultAnswer = (req: any): string => {
  if (req.system.includes(PERSON)) {
    if (req.prompt.includes("Atlas Team")) return JSON.stringify({ is_person: false, why: "a service" });
    const lines = (xs: string[]) => xs.filter((l) => /\[\d+\]/.test(l));
    return JSON.stringify({
      title: "Jean Derély",
      relation: { text: `Jean, un ami de Bruxelles, t'écrit depuis septembre 2026 ${cite(req.prompt, "Jeudi ?")}.`, since: "2026-09", until: null },
      going_on: [...lines([`Un rendez-vous jeudi ${cite(req.prompt, "Re: Jeudi ?")}`]), "Une ligne sans source, à jeter"],
      promised: lines([`Jean a promis de rendre le livre avant octobre ${cite(req.prompt, "Le livre")}`]),
      open: [],
    });
  }
  return JSON.stringify({ title: "Jeudi", about: "Un rendez-vous fixé par mail [1][2].", timeline: ["2026-09-01 — Jean propose jeudi [1]", "2026-09-02 — Anna accepte [2]"], decided: ["Jeudi [2]"], open: [] });
};
let answer: (req: any) => string = defaultAnswer;

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
  db.run(`INSERT OR IGNORE INTO mail_accounts (id, member_id, address, secret) VALUES ('ma-anna-p', ?, 'anna@proton.me', 'v1:x')`, [ANNA]);
  addModel({ id: NIGHT, name: "DeepSeek V4 Flash", tier: "cloud", vendor: "deepseek", provider: "scaleway" });
  pinNewInvocations();
  bossAuth = `Bearer ${createSession(BOSS).token}`;
  docs.setMailDocumentsDeps({ call: tool, write, now: () => new Date("2026-09-26T22:00:00Z") });
});

afterAll(() => {
  docs.setMailDocumentsDeps(null);
  budget.setMemberDailyCap(ANNA, null);
  db.run(`DELETE FROM contact_accounts WHERE member_id = ?`, [ANNA]);
});

beforeEach(() => {
  calls = [];
  writes = [];
  answer = defaultAnswer;
  seed();
  fs.rmSync(gardenRoot, { recursive: true, force: true });
  fs.mkdirSync(notesDir, { recursive: true });
  db.run(`DELETE FROM spend_ledger WHERE user_id = ?`, [ANNA]);
  db.run(`DELETE FROM mail_reading_consent WHERE member_id = ?`, [ANNA]);
  db.run(`DELETE FROM contact_accounts WHERE member_id = ?`, [ANNA]);
  budget.setMemberDailyCap(ANNA, null);
});

const read = (slug: string) => fs.readFileSync(path.join(notesDir, `${slug}.md`), "utf8");
const fiche = (basename: string) => fs.readFileSync(path.join(peopleDir, `${basename}.md`), "utf8");
const frag = (basename: string, n: string) => fs.readFileSync(path.join(peopleDir, basename, "_fragments", `${n}.frag`), "utf8");
const frags = (basename: string) => {
  const dir = path.join(peopleDir, basename, "_fragments");
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
};

function addCard(card: { uid: string; full_name: string; emails: string[] }) {
  db.run(`INSERT OR IGNORE INTO contact_accounts (id, member_id, username, secret, state) VALUES ('ca-anna', ?, 'anna@icloud.com', 'v1:x', 'ok')`, [ANNA]);
  db.run(
    `INSERT INTO contact_cards (account_id, member_id, href, uid, full_name, emails) VALUES ('ca-anna', ?, ?, ?, ?, ?)`,
    [ANNA, `/${card.uid}.vcf`, card.uid, card.full_name, JSON.stringify(card.emails)],
  );
}

test("a fiche in people/ per person: the relation once, the interactions per address and mailbox, pending; a digest per thread; a hub", async () => {
  // The app follows the pass: its progress exists while it runs, not after.
  expect(docs.mailDocumentsProgress(ANNA)).toBeNull();
  const running = docs.writeMailDocuments(ANNA);
  const during = docs.mailDocumentsProgress(ANNA);
  expect(during).not.toBeNull();
  expect(during!.stage).toBe("preparing");
  const r = await running;
  expect(docs.mailDocumentsProgress(ANNA)).toBeNull();
  expect(r.outcome).toBe("written");
  expect(r.written.map((n) => [n.kind, n.slug])).toEqual([["hub", "mon-courrier"], ["person", "jean-derely-fiche"], ["thread", "jeudi"]]);
  expect(r.written[1]!.web_path).toBe(`/g/${ANNA}/fr/fiches/people/jean-derely-fiche`);
  expect(r.skipped).toEqual({ unchanged: 0, deleted: 0, too_few: 0, declined: 1 });
  // Erlend, one message: no fiche. Anna on her other address: not a correspondent. Atlas: asked once, declined.
  expect(writes).toHaveLength(3);
  expect(writes[0]!.system).toContain("in French, tu, never vous");
  expect(writes[0]!.system).toContain("do not assume Anna's gender");
  expect(writes[0]!.system).toContain("the child's music teacher");
  expect(fs.existsSync(path.join(notesDir, "jean-derely.md"))).toBe(false);

  const f = fiche("jean-derely-fiche");
  expect(f).toContain("resource_collection: people");
  expect(f).toContain("resource_id: jean-derely");
  expect(f).toMatch(/\nstatus: pending\n/); // born from mail alone
  expect(f).toMatch(/identities:\n\s+- address: jean@x\.org\n\s+mailboxes:\n\s+- anna@gmail\.com\n\s+- anna@proton\.me\n\s+status: pending\n\s+source: mail/);
  expect(f).toMatch(/relation:\n\s+status: pending\n\s+since: "2026-09"\n\s+until: null/);
  expect(f).toMatch(/opened: false/);
  expect(f).toMatch(/author: maurice/);
  expect(f).toMatch(/person_key: jean@x\.org/);
  expect(f).toContain("## La relation\n\nJean, un ami de Bruxelles, t'écrit depuis septembre 2026. — [1 sept. 2026, Jean Derély, « Jeudi ? » · Gmail](maurice-mail:m1)");
  expect(f).toContain("Une partie de cette note a été écrite par une machine lisant ton courrier.");
  expect(f).not.toContain("Ce qui est en cours"); // the interactions are in the fragments

  // Each line in the fragment of the mailbox its first source sits in.
  expect(frags("jean-derely-fiche")).toEqual(["001.frag", "002.frag"]);
  const gmail = frag("jean-derely-fiche", "001");
  expect(gmail).toContain("summary: Courrier · jean@x.org · Gmail · 2 sept. 2026\n");
  expect(gmail).toMatch(/origin: mail\nstatus: pending\naddress: jean@x\.org\nmailbox: anna@gmail\.com\nsources:\n\s+- m2/);
  expect(gmail).toContain("## Ce qui est en cours\n\n- Un rendez-vous jeudi — [2 sept. 2026, Anna, « Re: Jeudi ? » · Gmail + Proton](maurice-mail:m2)");
  expect(gmail).not.toContain("sans source");
  const proton = frag("jean-derely-fiche", "002");
  expect(proton).toContain("mailbox: anna@proton.me");
  expect(proton).toContain("## Ce qui a été promis\n\n- Jean a promis de rendre le livre avant octobre — [10 sept. 2026, Jean Derély, « Le livre » · Proton](maurice-mail:m3)");
  // The hash is the garden tool's.
  const body = proton.slice(proton.indexOf("\n---\n") + 5);
  expect(proton).toContain(`written_hash: ${people.fragmentHash(body)}`);

  const digest = read("jeudi");
  expect(digest).toMatch(/- thread/);
  expect(digest).toContain("## Chronologie\n\n- 2026-09-01 — Jean propose jeudi — [1 sept. 2026, Jean Derély, « Jeudi ? » · Gmail](maurice-mail:m1)");
  expect(digest).toContain("Boîtes : Gmail (2), Proton (1).");
  const hub = read("mon-courrier");
  expect(hub).toMatch(/flags:\n\s*- moc/);
  expect(hub).toContain("## Personnes\n\n- [[jean-derely-fiche|Jean Derély]]");
  expect(hub).toContain("## Fils\n\n- [[jeudi|Jeudi]]");
  // The artefacts, keyed on the person and every message covered; the ledger as Anna under the reading job.
  expect(artefacts.map((a) => [a.kind, a.key, a.slug])).toEqual([["person", "jean@x.org", "jean-derely-fiche"], ["thread", "<t1@x>", "jeudi"], ["hub", "hub", "mon-courrier"], ["person", "team@atlas.example", ""]]);
  expect(artefacts[0].sources).toEqual(["m1", "m2", "m3"]);
  const ledger = db.query(`SELECT job_id FROM spend_ledger WHERE user_id = ?`).all(ANNA) as any[];
  expect(ledger).toHaveLength(3);
  expect(ledger.every((l) => l.job_id === "job_r1")).toBe(true);
  expect(r.cost).toBeCloseTo(0.006, 6);
  expect(r).not.toHaveProperty("said"); // nothing is said of it anywhere
});

test("the fiche lists the exchanges from the header store, between the relation and the provenance, and keeps them current without a model", async () => {
  // A message the reading passed over is still an exchange.
  unread = [msg("u1", "Anna <anna@gmail.com>", ["Jean Derély <jean@x.org>"], "2026-08-15T10:00:00+02:00", "Photos", "<tu1@x>", "")];
  await docs.writeMailDocuments(ANNA);
  const exchanges = calls.find((c) => c.tool === "exchanges")!;
  expect(exchanges.args).toEqual({ addresses: ["jean@x.org"], limit: people.EXCHANGES_SHOWN });
  let f = fiche("jean-derely-fiche");
  const section = "## Les échanges\n\n4 message(s) échangé(s) depuis le 15 août 2026 ; le dernier le 10 sept. 2026.\n\n"
    + "- [10 sept. 2026, Jean Derély, « Le livre » · Proton](maurice-mail:m3)\n"
    + "- [2 sept. 2026, Anna, « Re: Jeudi ? » · Gmail + Proton](maurice-mail:m2)\n"
    + "- [1 sept. 2026, Jean Derély, « Jeudi ? » · Gmail](maurice-mail:m1)\n"
    + "- [15 août 2026, Anna, « Photos » · Gmail](maurice-mail:u1)\n";
  expect(f).toContain(section);
  expect(f.indexOf("## La relation")).toBeLessThan(f.indexOf("## Les échanges"));
  expect(f.indexOf("## Les échanges")).toBeLessThan(f.indexOf("## D'où ça vient"));

  // Nothing new to read, nothing new in the store: the file is not touched.
  const before = fs.statSync(path.join(peopleDir, "jean-derely-fiche.md")).mtimeMs;
  writes = [];
  await docs.writeMailDocuments(ANNA);
  expect(fs.statSync(path.join(peopleDir, "jean-derely-fiche.md")).mtimeMs).toBe(before);

  // Jean writes, and the reading passes it over: no model call, the section moves on.
  unread.push(msg("u2", "Jean Derély <jean@x.org>", ["anna@proton.me"], "2026-09-22T10:00:00+02:00", "Bien arrivé", "<tu2@x>", "", PROTON));
  const again = await docs.writeMailDocuments(ANNA);
  expect(writes).toHaveLength(0);
  expect(again.skipped.unchanged).toBe(2);
  f = fiche("jean-derely-fiche");
  expect(f).toContain("5 message(s) échangé(s) depuis le 15 août 2026 ; le dernier le 22 sept. 2026.\n\n- [22 sept. 2026, Jean Derély, « Bien arrivé » · Proton](maurice-mail:u2)\n");
  expect(f.match(/## Les échanges/g)).toHaveLength(1);
  expect(f).toContain("## La relation\n\nJean, un ami de Bruxelles");
});

test("a store that cannot be read leaves the fiche without the section, and the pass goes on", async () => {
  exchangesDown = true;
  const r = await docs.writeMailDocuments(ANNA);
  expect(r.outcome).toBe("written");
  expect(fiche("jean-derely-fiche")).not.toContain("## Les échanges");
});

test("the exchanges section goes before the provenance, or at the end, and is replaced where it stands", () => {
  const body = "## La relation\n\nJean.\n\n## D'où ça vient\n\nUne machine.\n";
  const once = people.placeSection(body, "Les échanges", "2 messages.", "D'où ça vient");
  expect(once).toBe("## La relation\n\nJean.\n\n## Les échanges\n\n2 messages.\n\n## D'où ça vient\n\nUne machine.\n");
  expect(people.placeSection(once, "Les échanges", "3 messages.", "D'où ça vient")).toBe(once.replace("2 messages.", "3 messages."));
  expect(people.placeSection("## Mes notes\n\nÀ moi.\n", "Les échanges", "1 message.", "D'où ça vient")).toBe("## Mes notes\n\nÀ moi.\n\n## Les échanges\n\n1 message.\n");
});

const withConfirm = (req: any): string => {
  if (!req.system.includes(PERSON) || !req.prompt.includes("Jean confirme")) return defaultAnswer(req);
  const d = JSON.parse(defaultAnswer(req));
  const n = req.prompt.split("\n").find((l: string) => /^\[\d+\] 2026-09-20/.test(l))?.match(/^\[\d+\]/)?.[0];
  d.going_on = [...d.going_on.filter((l: string) => !l.startsWith("Jean confirme")), `Jean confirme ${n}`];
  return JSON.stringify(d);
};

test("a second run rewrites nothing unchanged; new mail rewrites the pending fragments; what was thrown away stays away", async () => {
  answer = withConfirm;
  await docs.writeMailDocuments(ANNA);
  writes = [];
  const again = await docs.writeMailDocuments(ANNA);
  expect(again.outcome).toBe("nothing");
  expect(again.skipped).toEqual({ unchanged: 2, deleted: 1, too_few: 0, declined: 0 }); // Atlas stays declined, never asked again
  expect(writes).toHaveLength(0);
  // The member throws the digest away; Jean writes again.
  fs.rmSync(path.join(notesDir, "jeudi.md"));
  material.push(msg("m5", "Jean Derély <jean@x.org>", ["anna@gmail.com"], "2026-09-20T10:00:00+02:00", "Re: Jeudi ?", "<t1@x>", "Jean confirme."));
  const third = await docs.writeMailDocuments(ANNA);
  expect(third.written.map((n) => n.kind)).toEqual(["hub", "person"]);
  expect(third.skipped.deleted).toBe(2); // the digest thrown away, and Atlas declined
  // The pending Gmail fragment rewritten in place, with the new line.
  expect(frags("jean-derely-fiche")).toEqual(["001.frag", "002.frag"]);
  expect(frag("jean-derely-fiche", "001")).toContain("- Jean confirme — [20 sept. 2026, Jean Derély, « Re: Jeudi ? » · Gmail](maurice-mail:m5)");
  expect(artefacts.find((a) => a.kind === "person")!.sources).toEqual(["m1", "m2", "m3", "m5"]);
  expect(read("mon-courrier")).not.toContain("[[jeudi|");
  const fourth = await docs.writeMailDocuments(ANNA);
  expect(fourth.written).toEqual([]);
  // The fiche thrown away: found gone, the hub refreshed, never written again.
  fs.rmSync(path.join(peopleDir, "jean-derely-fiche.md"));
  fs.rmSync(path.join(peopleDir, "jean-derely-fiche"), { recursive: true });
  const fifth = await docs.writeMailDocuments(ANNA);
  expect(fifth.written.map((n) => n.kind)).toEqual(["hub"]);
  expect(read("mon-courrier")).not.toContain("jean-derely-fiche");
  material.push(msg("m15", "Jean Derély <jean@x.org>", ["anna@gmail.com"], "2026-09-25T10:00:00+02:00", "Encore", "<t15@x>", "Jean encore."));
  const sixth = await docs.writeMailDocuments(ANNA);
  expect(sixth.written.filter((n) => n.kind === "person")).toEqual([]);
  expect(fs.existsSync(path.join(peopleDir, "jean-derely-fiche.md"))).toBe(false);
});

test("a fragment the member touched is confirmed and never rewritten; a relation they corrected is a fact, and the pending fragments are written again with it", async () => {
  answer = withConfirm;
  await docs.writeMailDocuments(ANNA);
  // Anna corrects the Gmail fragment.
  const gmailFile = path.join(peopleDir, "jean-derely-fiche", "_fragments", "001.frag");
  fs.writeFileSync(gmailFile, fs.readFileSync(gmailFile, "utf8").replace("- Un rendez-vous jeudi", "- Un rendez-vous jeudi, au Flagey"));
  material.push(msg("m5", "Jean Derély <jean@x.org>", ["anna@gmail.com"], "2026-09-20T10:00:00+02:00", "Re: Jeudi ?", "<t1@x>", "Jean confirme."));
  writes = [];
  await docs.writeMailDocuments(ANNA);
  const personPrompt = writes.find((w) => w.system.includes(PERSON))!;
  expect(personPrompt.prompt).not.toContain("Anna accepte jeudi."); // the confirmed fragment's message is not read again
  expect(personPrompt.prompt).toContain("Jean promet"); // the pending one's is
  expect(fs.readFileSync(gmailFile, "utf8")).toContain("au Flagey");
  expect(fs.readFileSync(gmailFile, "utf8")).toMatch(/\nstatus: confirmed\n/);
  expect(frags("jean-derely-fiche")).toEqual(["001.frag", "002.frag", "003.frag"]);
  expect(frag("jean-derely-fiche", "003")).toContain("Jean confirme");
  expect(frag("jean-derely-fiche", "003")).toContain("mailbox: anna@gmail.com");

  // Anna corrects the relation: no new mail, and yet the pending fragments go back to the writer, with it.
  const ficheFile = path.join(peopleDir, "jean-derely-fiche.md");
  fs.writeFileSync(ficheFile, fs.readFileSync(ficheFile, "utf8").replace(/Jean, un ami de Bruxelles[^\n]*/, "Le prof de solfège d'Adriano."));
  writes = [];
  const r = await docs.writeMailDocuments(ANNA);
  expect(r.written.map((n) => n.kind)).toContain("person");
  const again = writes.find((w) => w.system.includes(PERSON))!;
  expect(again.system).toContain("« Le prof de solfège d'Adriano. »");
  expect(again.system).not.toContain('"relation"');
  const f = fiche("jean-derely-fiche");
  expect(f).toContain("## La relation\n\nLe prof de solfège d'Adriano.");
  expect(f).toMatch(/relation:\n\s+status: confirmed/);
  // Confirmed, it is not asked about again without new mail.
  writes = [];
  expect((await docs.writeMailDocuments(ANNA)).written).toEqual([]);
  expect(writes).toHaveLength(0);
});

test("the address book joins a person's addresses, confirmed, on the member's own fiche; a contradiction or a rejected link stays pending or apart", async () => {
  addCard({ uid: "u-jean", full_name: "Jean Derély", emails: ["jean@x.org", "jean.d@gmail.com"] });
  material.push(msg("m20", "JD <jean.d@gmail.com>", ["anna@gmail.com"], "2026-09-15T10:00:00+02:00", "Photos", "<t20@x>", "Jean envoie des photos."));
  // Erlend is in the book too, but writes under another name.
  addCard({ uid: "u-erlend", full_name: "Erlend Berg", emails: ["e@y.org"] });
  material.push(msg("m21", "Kings of Convenience <e@y.org>", ["anna@gmail.com"], "2026-06-26T10:00:00+02:00", "Concert", "<t21@x>", "Un concert."));
  answer = (req) => req.system.includes(PERSON) && req.prompt.includes("Un concert")
    ? JSON.stringify({ title: "Erlend", relation: { text: "Un musicien [1]." }, going_on: ["Un concert [2]"], promised: [], open: [] })
    : defaultAnswer(req);
  // Anna's own fiche on Jean, written by her, with his card.
  fs.mkdirSync(peopleDir, { recursive: true });
  fs.writeFileSync(path.join(peopleDir, "jean-fiche.md"), `---\ntitle: Jean\nresource_collection: people\nresource_id: jean\ndate: '2026-04-29'\ntags: []\nlocale: fr\nmeta: {}\ncarddav_uid: u-jean\n---\n\n## Journal\n\n- Jean est venu dîner.\n`);
  const r = await docs.writeMailDocuments(ANNA);
  expect(r.written.map((n) => n.slug)).toEqual(["mon-courrier", "jean-fiche", "erlend-berg-fiche", "jeudi"]);
  const jeanPrompt = writes.find((w) => w.prompt.includes("Jean propose"))!;
  expect(jeanPrompt.system).toContain("This person is in Anna's address book");
  expect(jeanPrompt.prompt).toContain("Jean envoie des photos"); // both addresses, one person
  const f = fiche("jean-fiche");
  expect(f).toContain("title: Jean\n"); // her title, her body
  expect(f).toContain("## Journal\n\n- Jean est venu dîner.");
  expect(f.indexOf("## La relation")).toBeLessThan(f.indexOf("## Journal")); // the relation first
  expect(f).toMatch(/\nstatus: confirmed\n/);
  expect(f).toMatch(/- address: jean@x\.org\n[\s\S]*?status: confirmed\n\s+source: vcard/);
  expect(f).toMatch(/- address: jean\.d@gmail\.com\n[\s\S]*?status: confirmed\n\s+source: vcard/);
  expect(f).not.toContain("opened: false"); // her fiche is not a draft
  expect(f).toContain("person_key: vcard:u-jean");
  expect(f).not.toContain("Une partie de cette note"); // no disclaimer on her page
  expect(frags("jean-fiche").length).toBeGreaterThan(0);
  const erlend = fiche("erlend-berg-fiche");
  expect(erlend).toMatch(/status: pending\n\s+source: vcard\n\s+conflict: writes as « Kings of Convenience »/);
  expect(erlend).toMatch(/\nstatus: confirmed\n/); // the person is in the book; the link is what is in doubt
  expect(erlend).toContain("carddav_uid: u-erlend");

  // Anna rejects the Gmail address on her fiche: it is somebody else's.
  const file = path.join(peopleDir, "jean-fiche.md");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/(- address: jean\.d@gmail\.com\n(?:\s+.*\n)*?\s+status: )confirmed/, "$1rejected"));
  material.push(msg("m22", "JD <jean.d@gmail.com>", ["anna@gmail.com"], "2026-09-18T10:00:00+02:00", "Photos 2", "<t22@x>", "D'autres photos."));
  answer = (req) => req.system.includes(PERSON) && req.prompt.includes("photos")
    ? JSON.stringify({ title: "JD", relation: { text: "Quelqu'un qui envoie des photos [1]." }, going_on: ["Des photos [2]"], promised: [], open: [] })
    : defaultAnswer(req);
  const again = await docs.writeMailDocuments(ANNA);
  expect(again.written.map((n) => n.slug)).toContain("jd-fiche"); // the address alone, a person of its own
  expect(fiche("jd-fiche")).toMatch(/- address: jean\.d@gmail\.com\n[\s\S]*?status: pending\n\s+source: mail/);
  expect(fiche("jean-fiche")).toMatch(/- address: jean\.d@gmail\.com\n(?:\s+.*\n)*?\s+status: rejected/);
});

test("an alias of the member is not a correspondent, even one the app knows nothing about", async () => {
  material.push(msg("m10", "Anna <anna@alias.example>", ["anna@gmail.com"], "2026-03-01T10:00:00+02:00", "Pour moi", "<t10@x>", "Anna se transfère un mot."));
  material.push(msg("m11", "Anna <anna@gmail.com>", ["anna@alias.example"], "2026-03-02T10:00:00+02:00", "Encore", "<t11@x>", "Anna se transfère un autre mot."));
  material.push(msg("m12", "Anna <anna@gmail.com>", ["anna@alias.example"], "2026-03-03T10:00:00+02:00", "Et encore", "<t12@x>", "Et un troisième."));
  const r = await docs.writeMailDocuments(ANNA);
  expect(r.written.map((n) => n.slug)).toEqual(["mon-courrier", "jean-derely-fiche", "jeudi"]);
  expect(writes.some((wr) => wr.prompt.includes("anna@alias.example"))).toBe(false);
  expect(writes[0]!.system).toContain("neither is Anna themselves on another address of theirs");
});

test("the member's own card in the address book: every address and name on it is the member's, never a person", async () => {
  // Anna's own card holds her Gmail — a connected mailbox — and an alias that is not one.
  addCard({ uid: "u-anna", full_name: "Anna Lindqvist", emails: ["anna@gmail.com", "anna@studio.example"] });
  addCard({ uid: "u-anna-2", full_name: "Lindqvist Anna", emails: ["anna@studio.example"] });
  // From the alias, under her full name, to Mélanie at the accountant's.
  material.push(msg("m40", "Anna Lindqvist <anna@studio.example>", ["melanie@partfin.example"], "2026-07-16T10:00:00+02:00", "Rémunération", "<t40@x>", "Anna demande une augmentation."));
  material.push(msg("m41", "Anna Lindqvist <anna@studio.example>", ["melanie@partfin.example"], "2026-09-10T10:00:00+02:00", "Winbooks", "<t41@x>", "Anna parle de Winbooks."));
  answer = (req) => req.system.includes(PERSON) && req.prompt.includes("Winbooks")
    ? JSON.stringify({ title: "Mélanie", relation: { text: "Ta comptable chez Partfin [1]." }, going_on: ["Winbooks [2]"], promised: [], open: [] })
    : defaultAnswer(req);
  const r = await docs.writeMailDocuments(ANNA);
  expect(r.written.map((n) => n.slug)).toContain("melanie-fiche"); // the other party, not Anna
  expect(fs.existsSync(path.join(peopleDir, "anna-lindqvist-fiche.md"))).toBe(false);
  const melanie = fiche("melanie-fiche");
  expect(melanie).toContain("- address: melanie@partfin.example");
  expect(melanie).not.toContain("anna@studio.example");
  expect(writes.some((w) => w.system.includes("This person is in Anna's address book") && w.prompt.includes("Winbooks"))).toBe(false);
});

test("a second pass that names a thread otherwise moves the digest and keeps what the member did to it", async () => {
  await docs.writeMailDocuments(ANNA);
  const file = path.join(notesDir, "jeudi.md");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/\n\s{2}opened: false/, ""));
  material.push(msg("m5", "Jean Derély <jean@x.org>", ["anna@gmail.com"], "2026-09-20T10:00:00+02:00", "Re: Jeudi ?", "<t1@x>", "Jean confirme."));
  answer = (req) => req.system.includes(PERSON) ? defaultAnswer(req)
    : JSON.stringify({ title: "Le dîner de jeudi", about: "Un dîner [1].", timeline: [], decided: [], open: [] });
  const r = await docs.writeMailDocuments(ANNA);
  expect(r.written.map((n) => [n.kind, n.slug])).toEqual([["hub", "mon-courrier"], ["person", "jean-derely-fiche"], ["thread", "le-diner-de-jeudi"]]);
  expect(fs.existsSync(file)).toBe(false);
  const moved = read("le-diner-de-jeudi");
  expect(moved).toContain("key: <t1@x>");
  expect(moved).not.toContain("opened: false");
  expect(read("mon-courrier")).toContain("[[le-diner-de-jeudi|Le dîner de jeudi]]");
});

test("the member's cap stops the run before the call; a model answer with no sources writes nothing", async () => {
  budget.setMemberDailyCap(ANNA, 0.001);
  const r = await docs.writeMailDocuments(ANNA);
  expect(r.outcome).toBe("capped");
  // The workers that passed the check before the first spend landed may
  // each make their call — never more than there are workers; the rest are
  // refused before the call.
  expect(writes.length).toBeGreaterThanOrEqual(1);
  expect(writes.length).toBeLessThanOrEqual(docs.DOC_CONCURRENCY);
  expect(r.written[0]!.kind).toBe("hub");
  expect(r.written.filter((n) => n.kind === "person").length).toBeGreaterThanOrEqual(1);
  budget.setMemberDailyCap(ANNA, null);
  fs.rmSync(gardenRoot, { recursive: true, force: true }); fs.mkdirSync(notesDir, { recursive: true });
  artefacts = [];
  answer = () => JSON.stringify({ is_person: true, title: "x", relation: { text: "no source here" }, going_on: ["nor here"], about: "none", timeline: [] });
  const none = await docs.writeMailDocuments(ANNA);
  expect(none.outcome).toBe("nothing");
  expect(none.written).toEqual([]);
  expect(fs.readdirSync(notesDir)).toEqual([]);
  expect(fs.existsSync(peopleDir)).toBe(false);
});

test("the pass says nothing to the member: no conversation of Maurice's, no message in one they have, a run with no word to carry", async () => {
  // A conversation Maurice once opened about the mail, kept as an ordinary one.
  const old = createConversation(ANNA, null, { openedBy: "maurice" }).id;
  const own = createConversation(ANNA, null).id;
  db.run(`INSERT INTO mail_reading_consent (member_id, reading) VALUES (?, 'approved')`, [ANNA]);
  const counts = () => ({
    opened: (db.query(`SELECT COUNT(*) AS n FROM conversations WHERE user_id = ? AND opened_by = 'maurice'`).get(ANNA) as { n: number }).n,
    said: (db.query(`SELECT COUNT(*) AS n FROM messages WHERE role = 'assistant' AND conversation_id IN (SELECT id FROM conversations WHERE user_id = ?)`).get(ANNA) as { n: number }).n,
  });
  const before = counts();
  const r = await docs.writeMailDocuments(ANNA);
  expect(r.outcome).toBe("written");
  expect(r.written.filter((n) => n.kind !== "hub").length).toBeGreaterThanOrEqual(2);
  expect(r).not.toHaveProperty("said");
  expect(counts()).toEqual(before);
  expect(getMessages(old)).toHaveLength(0);
  expect(getMessages(own)).toHaveLength(0);
  // What was written is where the member finds it: the hub, in their garden.
  expect(read("mon-courrier")).toContain("[[jean-derely-fiche|Jean Derély]]");
  expect((docs as any).sayDocumentsWritten).toBeUndefined();
});

test("erasing removes what the pass wrote, keeps the member's own fiche without its mail fragments, and forgets all but the refusals", async () => {
  addCard({ uid: "u-jean", full_name: "Jean Derély", emails: ["jean@x.org"] });
  fs.mkdirSync(peopleDir, { recursive: true });
  fs.writeFileSync(path.join(peopleDir, "jean-fiche.md"), `---\ntitle: Jean\nresource_collection: people\nresource_id: jean\ncarddav_uid: u-jean\nlocale: fr\n---\n\n## Journal\n\n- Jean est venu dîner.\n`);
  fs.mkdirSync(path.join(peopleDir, "jean-fiche", "_fragments"), { recursive: true });
  fs.writeFileSync(path.join(peopleDir, "jean-fiche", "_fragments", "001.frag"), `---\nsummary: "Une conversation"\n---\nÀ moi.\n`);
  material.push(msg("m30", "Chloé <chloe@z.org>", ["anna@gmail.com"], "2026-09-11T10:00:00+02:00", "Salut", "<t30@x>", "Chloé dit bonjour."));
  material.push(msg("m31", "Chloé <chloe@z.org>", ["anna@gmail.com"], "2026-09-12T10:00:00+02:00", "Re: Salut", "<t30@x>", "Chloé redit bonjour."));
  answer = (req) => req.system.includes(PERSON) && req.prompt.includes("Chloé")
    ? JSON.stringify({ title: "Chloé", relation: { text: "Une amie [1]." }, going_on: ["Elle dit bonjour [2]"], promised: [], open: [] })
    : defaultAnswer(req);
  await docs.writeMailDocuments(ANNA);
  expect(fs.existsSync(path.join(peopleDir, "chloe-fiche.md"))).toBe(true);
  expect(frags("jean-fiche").length).toBe(3); // hers, and two from the mail
  expect(fiche("jean-fiche")).toContain("## Les échanges");
  const e = await docs.eraseMailDocuments(ANNA);
  expect(e.error).toBeNull();
  expect(fs.existsSync(path.join(peopleDir, "chloe-fiche.md"))).toBe(false);
  expect(fs.existsSync(path.join(peopleDir, "chloe-fiche"))).toBe(false);
  expect(fs.existsSync(path.join(notesDir, "jeudi.md"))).toBe(false);
  expect(fs.existsSync(path.join(notesDir, "mon-courrier.md"))).toBe(false);
  expect(fiche("jean-fiche")).toContain("- Jean est venu dîner.");
  expect(fiche("jean-fiche")).not.toContain("## Les échanges");
  expect(frags("jean-fiche")).toEqual(["001.frag"]); // hers stays
  expect(artefacts.map((a) => a.key)).toEqual(["team@atlas.example"]);
  // And the next pass writes everything again.
  const again = await docs.writeMailDocuments(ANNA);
  expect(again.written.map((n) => n.slug)).toEqual(["mon-courrier", "jean-fiche", "chloe-fiche", "jeudi", "jeudi-2"]);
});

test("the admin routes write and erase by hand; the tool words are the server's", async () => {
  const req = (p: string, init: RequestInit = {}) => admin.request(p, { ...init, headers: { Authorization: bossAuth, "Content-Type": "application/json" } });
  const res = await req("/mail/documents/run", { method: "POST", body: JSON.stringify({ username: ANNA, wait: true }) });
  expect(res.status).toBe(200);
  expect((await res.json()).written.length).toBeGreaterThan(0);
  expect((await (await req(`/mail/documents/${ANNA}`)).json()).last.outcome).toBe("written");
  expect((await req("/mail/documents/run", { method: "POST", body: JSON.stringify({ username: "nobody" }) })).status).toBe(404);
  const preview = await (await req(`/mail/documents/${ANNA}/people`)).json();
  expect(preview.people.map((p: any) => [p.key, p.messages])).toEqual([["jean@x.org", 3], ["team@atlas.example", 2]]);
  const erased = await (await req("/mail/documents/reset", { method: "POST", body: JSON.stringify({ username: ANNA }) })).json();
  expect(erased.removed).toBeGreaterThan(0);
  expect(erased.error).toBeNull();
  for (const t of ["reading_material", "reading_reset", "documents_record", "documents_reset"]) expect(isServerOnlyTool(`email__${t}`)).toBe(true);
  expect(isServerOnlyTool("email__get_by_id")).toBe(false);
});

test("an address spells a name: its words are the name's, or the name run together", () => {
  expect(people.spellsName("paola.magi@pm.me", "magi paola")).toBe(true);
  expect(people.spellsName("magipaola@hotmail.com", "magi paola")).toBe(true);
  expect(people.spellsName("brosse@axeco.immo", "brosse jonathan")).toBe(true);
  expect(people.spellsName("contact@shop.example", "brosse jonathan")).toBe(false);
  expect(people.spellsName("pmagi75@x.org", "magi paola")).toBe(true);
  expect(people.spellsName("j@x.org", "brosse jonathan")).toBe(false);
});

const JB = (n: number, addr: string, name: string, thread: string, mailboxes = GMAIL) =>
  msg(`jb${n}-${addr}`, `${name} <${addr}>`, ["anna@gmail.com"], `2026-0${n}-10T10:00:00+02:00`, `Dossier ${n}`, thread, `Jonathan parle du dossier ${n}.`, mailboxes);

test("the same full name and every address spelling it make one person; the name alone does not; the old fiches fold into one", async () => {
  // First, Jonathan's second address signs otherwise: two people, two fiches.
  material.push(JB(1, "brosse@axeco.immo", "Jonathan Brosse", "<j1@x>"), JB(2, "brosse@axeco.immo", "Jonathan Brosse", "<j2@x>"), JB(6, "brosse@axeco.immo", "Jonathan Brosse", "<j6@x>"));
  material.push(JB(3, "brosse@jiceco.be", "JB Immo", "<j3@x>", PROTON), JB(4, "brosse@jiceco.be", "JB Immo", "<j4@x>", PROTON));
  // A homonym whose address says nothing: never joined.
  material.push(msg("h1", "Jonathan Brosse <contact@shop.example>", ["anna@gmail.com"], "2026-05-01T10:00:00+02:00", "Commande", "<h1@x>", "Une commande."));
  material.push(msg("h2", "Jonathan Brosse <contact@shop.example>", ["anna@gmail.com"], "2026-05-02T10:00:00+02:00", "Livraison", "<h2@x>", "Une livraison."));
  answer = (req) => {
    if (!req.system.includes(PERSON) || !req.prompt.includes("Jonathan")) return defaultAnswer(req);
    const lines = req.prompt.split("\n").filter((l: string) => /^\[\d+\]/.test(l)).map((l: string) => `Un échange ${l.match(/^\[\d+\]/)![0]}`);
    return JSON.stringify({ title: "Jonathan Brosse", relation: { text: "Ton agent immobilier [1]." }, going_on: lines, promised: [], open: [] });
  };
  await docs.writeMailDocuments(ANNA);
  expect(fs.readdirSync(peopleDir).filter((f) => f.startsWith("jonathan-brosse") && f.endsWith(".md")).sort()).toEqual(["jonathan-brosse-2-fiche.md", "jonathan-brosse-3-fiche.md", "jonathan-brosse-fiche.md"]);
  // Then he signs his second address with his name: the two are one.
  material = material.map((m) => (m.from_address === "brosse@jiceco.be" ? { ...m, from: "Jonathan Brosse <brosse@jiceco.be>" } : m));
  const r = await docs.writeMailDocuments(ANNA);
  const left = fs.readdirSync(peopleDir).filter((f) => f.startsWith("jonathan-brosse") && f.endsWith(".md")).sort();
  expect(left).toHaveLength(2); // one Jonathan, and the homonym
  const one = left.map((f) => fs.readFileSync(path.join(peopleDir, f), "utf8")).find((t) => t.includes("brosse@jiceco.be"))!;
  expect(one).toContain("- address: brosse@axeco.immo");
  expect(one).toMatch(/- address: brosse@jiceco\.be\n[\s\S]*?status: pending\n\s+source: guess[\s\S]*?guess: same name « brosse jonathan » and every address spells it/);
  expect(one).not.toContain("contact@shop.example");
  const base = left.find((f) => fs.readFileSync(path.join(peopleDir, f), "utf8").includes("brosse@jiceco.be"))!.slice(0, -3);
  const mailboxes = frags(base).map((f) => frag(base, f.slice(0, 3)).match(/mailbox: (\S+)/)![1]).sort();
  expect(mailboxes).toEqual(["anna@gmail.com", "anna@proton.me"]); // both addresses' fragments, in one fiche
  // The absorbed key is forgotten in the store, not marked thrown away.
  expect(artefacts.some((a) => a.key === "brosse@jiceco.be")).toBe(false);
  expect(calls.find((c) => c.tool === "documents_record" && c.args.forgotten?.length)!.args.forgotten).toEqual([{ kind: "person", key: "brosse@jiceco.be" }]);
  expect(r.outcome).not.toBe("failed");

  // Anna rejects the guessed address: it splits back out, its fragments with it, and stays apart.
  const ficheLocale = "fr";
  const { review } = await import("../src/services/personReview");
  review(ANNA, { root: gardenRoot, username: ANNA }, ficheLocale, base, { target: "identity", action: "reject", id: "brosse@jiceco.be" });
  const split = fs.readdirSync(peopleDir).filter((f) => f.endsWith(".md")).map((f) => fs.readFileSync(path.join(peopleDir, f), "utf8")).find((t) => t.includes("person_key: brosse@jiceco.be"))!;
  expect(split).toBeTruthy();
  expect(frags(base).map((f) => frag(base, f.slice(0, 3)).match(/mailbox: (\S+)/)![1])).toEqual(["anna@gmail.com"]);
  material.push(JB(5, "brosse@jiceco.be", "Jonathan Brosse", "<j5@x>", PROTON));
  await docs.writeMailDocuments(ANNA);
  expect(fiche(base)).toMatch(/- address: brosse@jiceco\.be\n(?:\s+.*\n)*?\s+status: rejected/);
  expect(frags(base).length).toBe(1); // the new mail went to the split fiche, not here
});

test("a person named as the member's own fiche with a card of that name is written into it", async () => {
  addCard({ uid: "u-paola-2", full_name: "Paola Magi", emails: [] });
  fs.mkdirSync(peopleDir, { recursive: true });
  fs.writeFileSync(path.join(peopleDir, "paola-magi-fiche.md"), `---\ntitle: Paola Magi\nresource_collection: people\nresource_id: paola-magi\nlocale: fr\ncarddav_uid: u-paola-2\n---\n\n## Journal\n\n- Anniversaire le 4 mai.\n`);
  material.push(msg("p1", "Paola Magi <paola.magi@pm.me>", ["anna@gmail.com"], "2026-09-03T10:00:00+02:00", "École", "<p1@x>", "Paola parle de l'école."));
  material.push(msg("p2", "Paola Magi <paola.magi@pm.me>", ["anna@gmail.com"], "2026-09-04T10:00:00+02:00", "Médecin", "<p2@x>", "Paola parle du médecin."));
  answer = (req) => req.system.includes(PERSON) && req.prompt.includes("Paola")
    ? JSON.stringify({ title: "Paola", relation: { text: "La mère de tes enfants [1]." }, going_on: ["L'école [1]", "Le médecin [2]"], promised: [], open: [] })
    : defaultAnswer(req);
  const r = await docs.writeMailDocuments(ANNA);
  expect(r.written.map((n) => n.slug)).toContain("paola-magi-fiche");
  expect(fs.existsSync(path.join(peopleDir, "paola-fiche.md"))).toBe(false);
  const f = fiche("paola-magi-fiche");
  expect(f).toContain("- Anniversaire le 4 mai.");
  expect(f).toContain("person_key: paola.magi@pm.me");
  expect(frags("paola-magi-fiche").length).toBe(1);
});

test("a fiche Maurice made folds into the member's own fiche on that name, with its relation and fragments", async () => {
  addCard({ uid: "u-p1", full_name: "Magi Paola", emails: ["magipaola@hotmail.com"] });
  addCard({ uid: "u-p2", full_name: "Paola Magi", emails: [] });
  material.push(msg("q1", "paola magi <magipaola@hotmail.com>", ["anna@gmail.com"], "2026-09-03T10:00:00+02:00", "École", "<q1@x>", "Paola parle de l'école."));
  material.push(msg("q2", "paola magi <magipaola@hotmail.com>", ["anna@gmail.com"], "2026-09-04T10:00:00+02:00", "Médecin", "<q2@x>", "Paola parle du médecin."));
  answer = (req) => req.system.includes(PERSON) && req.prompt.includes("Paola")
    ? JSON.stringify({ title: "Paola", relation: { text: "La mère de tes enfants [1]." }, going_on: req.prompt.split("\n").filter((l: string) => /^\[\d+\]/.test(l)).map((l: string) => `Un échange ${l.match(/^\[\d+\]/)![0]}`), promised: [], open: [] })
    : defaultAnswer(req);
  await docs.writeMailDocuments(ANNA);
  expect(fs.existsSync(path.join(peopleDir, "magi-paola-fiche.md"))).toBe(true);
  // Anna has her own fiche on Paola, on the other card.
  fs.writeFileSync(path.join(peopleDir, "paola-magi-fiche.md"), `---\ntitle: Paola Magi\nresource_collection: people\nresource_id: paola-magi\nlocale: fr\ncarddav_uid: u-p2\n---\n\n## Journal\n\n- Anniversaire le 4 mai.\n`);
  material.push(msg("q3", "paola magi <magipaola@hotmail.com>", ["anna@gmail.com"], "2026-09-05T10:00:00+02:00", "Vacances", "<q3@x>", "Paola parle des vacances."));
  await docs.writeMailDocuments(ANNA);
  expect(fs.existsSync(path.join(peopleDir, "magi-paola-fiche.md"))).toBe(false);
  const f = fiche("paola-magi-fiche");
  expect(f).toContain("- Anniversaire le 4 mai.");
  expect(f).toContain("## La relation\n\nLa mère de tes enfants.");
  expect(f).toContain("person_key: vcard:u-p1");
  expect(f).toContain("- address: magipaola@hotmail.com");
  expect(frags("paola-magi-fiche").length).toBeGreaterThan(0);
  expect(frags("paola-magi-fiche").map((x) => frag("paola-magi-fiche", x.slice(0, 3))).join("")).toContain("Vacances");
});

test("a mailbox is called by the account's name, else its provider, else its address; two alike fall back to the addresses", () => {
  const labels = docs.mailboxLabels([
    { address: "Anna@Gmail.com" },
    { address: "anna@protonmail.com" },
    { address: "anna@work.example" },
    { address: "a@fastmail.com", name: "Travail" },
    { address: "a@custom.example", provider: "icloud" },
  ]);
  expect([...labels]).toEqual([
    ["anna@gmail.com", "Gmail"], ["anna@protonmail.com", "Proton"], ["anna@work.example", "anna@work.example"],
    ["a@fastmail.com", "Travail"], ["a@custom.example", "iCloud"],
  ]);
  const two = docs.mailboxLabels([{ address: "a@gmail.com" }, { address: "b@gmail.com" }]);
  expect([...two.values()]).toEqual(["a@gmail.com", "b@gmail.com"]);
  expect(docs.mailHref("fp:57bb")).toBe("maurice-mail:fp:57bb");
  expect(docs.mailHref("oid:a b)")).toBe("maurice-mail:oid:a%20b)");
});

test("the relation section is read and replaced in place, or put first", () => {
  const body = "## Journal\n\n- un\n";
  const withRel = people.withSection(body, "La relation", "Un ami.");
  expect(withRel).toBe("## La relation\n\nUn ami.\n\n## Journal\n\n- un\n");
  expect(people.sectionOf(withRel, "La relation")).toBe("Un ami.");
  expect(people.withSection(withRel, "La relation", "Une amie.")).toBe("## La relation\n\nUne amie.\n\n## Journal\n\n- un\n");
  expect(people.sectionOf(body, "La relation")).toBeNull();
});

test("two launches at the same moment are one pass: the night and a reading started from the app both write after it", async () => {
  // What both do when the reading they share ends (routes/mailAccounts.ts,
  // services/mailScan.ts): the second joins the first, nothing is asked twice.
  writes = [];
  const fromTheApp = docs.startMailDocuments(ANNA);
  const fromTheNight = docs.startMailDocuments(ANNA);
  expect(fromTheNight).toBe(fromTheApp);
  expect(docs.mailDocumentsStatus(ANNA).running).toBe(true);
  const r = await fromTheApp;
  expect(await fromTheNight).toBe(r);
  expect(docs.mailDocumentsStatus(ANNA)).toMatchObject({ running: false, last: r });
  // And the two callers are wired to it, not to the pass itself.
  const fs2 = await import("fs");
  for (const f of ["../src/routes/mailAccounts.ts", "../src/services/mailScan.ts"]) {
    const src = fs2.readFileSync(new URL(f, import.meta.url), "utf8");
    expect(src).not.toMatch(/\bwriteMailDocuments\(/);
    expect(src).toMatch(/\bstartMailDocuments\(/);
  }
});

test("a note is written in the language of its messages, and filed in the member's locale; several languages, and it is the member's", async () => {
  expect(docs.noteLanguage([{ reading: { language: "en" } }, { reading: { language: "EN" } }] as any, "fr")).toBe("en");
  expect(docs.noteLanguage([{ reading: { language: "en" } }, { reading: { language: "fr" } }] as any, "fr")).toBe("fr");
  expect(docs.noteLanguage([{ reading: { language: "en" } }, { reading: {} }] as any, "fr")).toBe("fr");   // a reading from before: not known
  expect(docs.noteLanguage([{ reading: { language: "ja" } }] as any, "fr")).toBe("fr");                      // no words for it
  expect(docs.noteLanguage([], "fr")).toBe("fr");

  // Jean writes to Anna in English: three messages, one thread of two.
  seed();
  for (const m of material) m.reading.language = m.from.includes("jean") || m.subject.includes("Jeudi") ? "en" : "fr";
  writes = [];
  await docs.writeMailDocuments(ANNA);
  const person = writes.find((w) => w.system.includes(PERSON) && w.prompt.includes("Jean"))!;
  expect(person.system).toContain("Write in English");
  const thread = writes.find((w) => !w.system.includes(PERSON))!;
  expect(thread.system).toContain("Write in English");
  const digest = fs.readFileSync(path.join(notesDir, "jeudi.md"), "utf8");
  expect(digest).toContain("## What it is about");
  expect(digest).toContain("## Where it comes from");
  expect(digest).toMatch(/locale: fr/);
  expect(digest).toMatch(/language: en/);
  const fiche = fs.readFileSync(path.join(peopleDir, "jean-derely-fiche.md"), "utf8");
  expect(fiche).toContain("## The relationship");
  expect(fiche).toMatch(/language: en/);
  // The index stays in Anna's language, and Atlas — French notices — was asked in French.
  expect(fs.readFileSync(path.join(notesDir, "mon-courrier.md"), "utf8")).toContain("## Personnes");
  expect(writes.find((w) => w.prompt.includes("Atlas Team"))!.system).toContain("Write in French");

  // A second pass with one more message keeps the fiche's language, whatever the new message's.
  material.push({ ...msg("m10", "Jean Derély <jean@x.org>", ["anna@gmail.com"], "2026-09-20T10:00:00+02:00", "Suite", "<t10@x>", "Jean écrit en français cette fois."), reading: { ...msg("x", "a", [], "", "", "", "Jean écrit en français.").reading, language: "fr" } });
  writes = [];
  await docs.writeMailDocuments(ANNA);
  expect(writes.find((w) => w.system.includes(PERSON))!.system).toContain("Write in English");
  expect(fs.readFileSync(path.join(peopleDir, "jean-derely-fiche.md"), "utf8")).toContain("## The relationship");
});

test("a provider's passing error costs one note, not the pass; the note is written by the next one", async () => {
  seed();
  let failed = 0;
  answer = (req) => {
    if (req.system.includes(PERSON) && req.prompt.includes("Jean") && failed++ === 0) throw new Error("scaleway error: Provider error 504: ");
    return defaultAnswer(req);
  };
  try {
    const first = await docs.writeMailDocuments(ANNA);
    // The digest and the index are there; Jean's fiche is not, and nothing says it was written.
    expect(first.outcome).toBe("written");
    expect(first.error).toBeNull();
    expect(first.written.map((n) => n.kind).sort()).toEqual(["hub", "thread"]);
    expect(artefacts.some((a) => a.kind === "person" && a.slug)).toBe(false);
    const second = await docs.writeMailDocuments(ANNA);
    expect(second.written.filter((n) => n.kind === "person").map((n) => n.slug)).toEqual(["jean-derely-fiche"]);
    // A provider that is down — every note failing — ends the pass on its error.
    seed();
    answer = () => { throw new Error("scaleway error: Provider error 504: "); };
    material = Array.from({ length: 12 }, (_, i) => [
      msg(`a${i}`, `P${i} <p${i}@x.org>`, ["anna@gmail.com"], "2026-09-01T10:00:00+02:00", `S${i}`, `<s${i}@x>`, "un"),
      msg(`b${i}`, `P${i} <p${i}@x.org>`, ["anna@gmail.com"], "2026-09-02T10:00:00+02:00", `S${i}`, `<s${i}@x>`, "deux"),
    ]).flat();
    const down = await docs.writeMailDocuments(ANNA);
    expect(down.outcome).toBe("failed");
    expect(down.error).toContain("504");
  } finally {
    answer = defaultAnswer;
  }
});
