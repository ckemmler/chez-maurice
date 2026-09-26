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
 * the cap stopping the run before the call; Maurice's word in the mail
 * conversation; the erasing; and the admin routes.
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
const peopleDir = path.join(gardenRoot, "people", "fr");

let material: any[] = [];
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
  db.run(`DELETE FROM mail_conversations WHERE member_id = ?`, [ANNA]);
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
  const r = await docs.writeMailDocuments(ANNA);
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
  expect(f).toMatch(/relation:\n\s+status: pending\n\s+since: 2026-09\n\s+until: null/);
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
  expect(r.said).toBeNull(); // no mail conversation yet
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
  expect(writes).toHaveLength(1);
  expect(r.written.map((n) => n.kind)).toEqual(["hub", "person"]); // the first went; the second was refused
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

test("Maurice says in the mail conversation what he wrote, with the hub's path and the fiches' titles", async () => {
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
  const e = await docs.eraseMailDocuments(ANNA);
  expect(e.error).toBeNull();
  expect(fs.existsSync(path.join(peopleDir, "chloe-fiche.md"))).toBe(false);
  expect(fs.existsSync(path.join(peopleDir, "chloe-fiche"))).toBe(false);
  expect(fs.existsSync(path.join(notesDir, "jeudi.md"))).toBe(false);
  expect(fs.existsSync(path.join(notesDir, "mon-courrier.md"))).toBe(false);
  expect(fiche("jean-fiche")).toContain("- Jean est venu dîner.");
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
