// Forgetting a mailbox (lot 6 of specs/contacts.md; services/mailForget.ts,
// scripts/garden_prune_history.py). What is held down: a line whose links
// all point at forgotten mail goes, a forgotten link leaves a line with
// others, the "Mailboxes" line loses the mailbox; a note, fragment,
// relation or fiche Maurice wrote and nobody touched goes when it has
// nothing left, while what the member touched is pruned, never removed;
// the hashes move with the text; the hub lists what is left; every past
// version is pruned when asked, and the remote with it; and the route
// forgets the store, then the garden, then the account.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";

const GARDENS = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "maurice-forget-"));
process.env.MAURICE_GARDENS_DIR = GARDENS;

const db = (await import("../src/db")).default;
const forget = await import("../src/services/mailForget");
const { fragmentHash } = await import("../src/services/mailPeople");
const scan = await import("../src/services/mailScan");
const routes = (await import("../src/routes/mailAccounts")).default;
const { createSession } = await import("../src/services/auth");

const ANNA = "mf-anna";
const root = path.join(GARDENS, ANNA);
const notes = path.join(root, "notes", "fr");
const people = path.join(root, "people", "fr");
const gone = new Set(["g1", "g2"]);
const L = (id: string, box: string) => `[1 sept. 2026, Jean, « Sujet » · ${box}](maurice-mail:${id})`;

function seed() {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(notes, { recursive: true });
  fs.mkdirSync(path.join(people, "jean-fiche", "_fragments"), { recursive: true });
  fs.mkdirSync(path.join(people, "anna-b-fiche", "_fragments"), { recursive: true });
  fs.mkdirSync(path.join(people, "paola-fiche", "_fragments"), { recursive: true });
  fs.writeFileSync(path.join(notes, "jeudi.md"), `---\ntitle: Jeudi\nmeta:\n  opened: false\n  author: maurice\n  origin: mail\n  kind: thread\n  sources:\n    - g1\n    - k1\n  mailboxes:\n    - anna@gmail.com\n    - anna@proton.me\n---\n\n## Chronologie\n\n- Jean propose — ${L("g1", "Gmail")}\n- Anna accepte — ${L("k1", "Proton")}\n- Les deux — ${L("g1", "Gmail")} ; ${L("k1", "Proton")}\n\n## Décidé\n\n- Jeudi — ${L("g2", "Gmail")}\n\n## D'où ça vient\n\nBoîtes : Gmail (2), Proton (1).\n`);
  fs.writeFileSync(path.join(notes, "gmail-only.md"), `---\ntitle: Seul\nmeta:\n  opened: false\n  author: maurice\n  origin: mail\n  kind: thread\n---\n\n## Chronologie\n\n- Rien d'autre — ${L("g2", "Gmail")}\n`);
  fs.writeFileSync(path.join(notes, "mon-courrier.md"), `---\ntitle: Mon courrier\nmeta:\n  author: maurice\n  origin: mail\n  kind: hub\n---\n\nIntro.\n\n## Fils\n\n- [[jeudi|Jeudi]]\n- [[gmail-only|Seul]]\n\n## Personnes\n\n- [[jean-fiche|Jean]]\n- [[paola-fiche|Paola]]\n`);
  // A person Maurice made, only from Gmail: goes.
  fs.writeFileSync(path.join(people, "jean-fiche.md"), `---\ntitle: Jean\nstatus: pending\nidentities:\n  - address: jean@x.org\n    mailboxes:\n      - anna@gmail.com\n    status: pending\n    source: mail\nrelation:\n  status: pending\n  written_hash: ${fragmentHash(`Un ami. — ${L("g1", "Gmail")}`)}\nmeta:\n  author: maurice\n  origin: mail\n  person_key: jean@x.org\n---\n\n## La relation\n\nUn ami. — ${L("g1", "Gmail")}\n`);
  const jf = `## Ce qui est en cours\n\n- Jeudi — ${L("g1", "Gmail")}\n`;
  fs.writeFileSync(path.join(people, "jean-fiche", "_fragments", "001.frag"), `---\nsummary: Courrier · jean@x.org · Gmail\norigin: mail\nstatus: pending\nmailbox: anna@gmail.com\nsources:\n  - g1\nwritten_hash: ${fragmentHash(jf)}\n---\n${jf}`);
  // The member's own fiche, fed by both mailboxes: pruned, kept.
  const rel = `La mère de tes enfants. — ${L("g2", "Gmail")} ; ${L("k1", "Proton")}`;
  fs.writeFileSync(path.join(people, "paola-fiche.md"), `---\ntitle: Paola\ncarddav_uid: u-p\nidentities:\n  - address: p@hotmail.com\n    mailboxes:\n      - anna@gmail.com\n      - anna@proton.me\n    status: confirmed\n    source: vcard\n  - address: p@old.example\n    mailboxes:\n      - anna@gmail.com\n    status: pending\n    source: guess\nrelation:\n  status: pending\n  sources:\n    - g2\n    - k1\n  written_hash: ${fragmentHash(rel)}\nmeta:\n  person_key: vcard:u-p\n---\n\n## La relation\n\n${rel}\n\n## Journal\n\n- Anniversaire le 4 mai.\n`);
  const pg = `## Ce qui est en cours\n\n- Les abricotiers — ${L("g1", "Gmail")}\n`;
  fs.writeFileSync(path.join(people, "paola-fiche", "_fragments", "001.frag"), `---\nsummary: Courrier · Gmail\norigin: mail\nstatus: pending\nmailbox: anna@gmail.com\nsources:\n  - g1\nwritten_hash: ${fragmentHash(pg)}\n---\n${pg}`);
  // One she corrected, from Gmail only: pruned to nothing, but hers — kept.
  const touched = `## Resté ouvert\n\n- Le devis — ${L("g2", "Gmail")}\n- Et j'ajoute : appeler le syndic.\n`;
  fs.writeFileSync(path.join(people, "paola-fiche", "_fragments", "002.frag"), `---\nsummary: Courrier · Gmail\norigin: mail\nstatus: confirmed\nmailbox: anna@gmail.com\nsources:\n  - g2\nwritten_hash: somethingelse\n---\n${touched}`);
  const pp = `## Ce qui est en cours\n\n- L'école — ${L("k1", "Proton")}\n`;
  fs.writeFileSync(path.join(people, "paola-fiche", "_fragments", "003.frag"), `---\nsummary: Courrier · Proton\norigin: mail\nstatus: pending\nmailbox: anna@proton.me\nsources:\n  - k1\nwritten_hash: ${fragmentHash(pp)}\n---\n${pp}`);
}

beforeAll(() => {
  db.run(`INSERT OR IGNORE INTO households (id, name) VALUES ('default', 'Home')`);
  db.run(`INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES (?, ?, ?, 'standard')`, [ANNA, ANNA, "Anna"]);
});
beforeEach(seed);
afterAll(() => { scan.setMailScanDeps(null); fs.rmSync(GARDENS, { recursive: true, force: true }); });

test("a line goes when all its sources are forgotten, loses a forgotten link otherwise; the mailbox leaves the Mailboxes line", () => {
  const r = forget.pruneText(`- a — ${L("g1", "Gmail")}\n- b — ${L("g1", "Gmail")} ; ${L("k1", "Proton")}\n- c, mine\nBoîtes : Gmail (2), Proton (1).`, gone, "Gmail");
  expect(r.text).toBe(`- b — ${L("k1", "Proton")}\n- c, mine\nBoîtes : Proton (1).`);
  expect(r.sourced).toBe(1);
  expect(r.changed).toBe(true);
});

test("the garden pruned: what Maurice alone wrote from the mailbox goes, what the member touched stays, hashes follow, the hub lists what is left", () => {
  const g = { root, username: ANNA };
  const r = forget.pruneGarden(g, "fr", gone, "anna@gmail.com", "Gmail");
  const rel = (p: string) => path.relative(root, p);
  expect(r.removed.map(rel).sort()).toEqual(["notes/fr/gmail-only.md", "people/fr/jean-fiche.md", "people/fr/jean-fiche/_fragments/001.frag", "people/fr/paola-fiche/_fragments/001.frag"]);
  expect(fs.existsSync(path.join(people, "jean-fiche"))).toBe(false);
  const jeudi = fs.readFileSync(path.join(notes, "jeudi.md"), "utf8");
  expect(jeudi).not.toContain("maurice-mail:g1");
  expect(jeudi).toContain(`- Les deux — ${L("k1", "Proton")}`);
  expect(jeudi).not.toContain("## Décidé"); // emptied: gone
  expect(jeudi).toContain("Boîtes : Proton (1).");
  expect(jeudi).toMatch(/sources:\n\s+- k1\n/);
  expect(jeudi).toMatch(/mailboxes:\n\s+- anna@proton\.me\n/);
  const hub = fs.readFileSync(path.join(notes, "mon-courrier.md"), "utf8");
  expect(hub).toContain("[[jeudi|Jeudi]]");
  expect(hub).not.toContain("gmail-only");
  expect(hub).not.toContain("jean-fiche");
  const paola = fs.readFileSync(path.join(people, "paola-fiche.md"), "utf8");
  expect(paola).toContain(`## La relation\n\nLa mère de tes enfants. — ${L("k1", "Proton")}`);
  expect(paola).toContain(`written_hash: ${fragmentHash(`La mère de tes enfants. — ${L("k1", "Proton")}`)}`);
  expect(paola).toContain("- Anniversaire le 4 mai.");
  expect(paola).toMatch(/- address: p@hotmail\.com\n\s+mailboxes:\n\s+- anna@proton\.me\n/);
  expect(paola).not.toContain("p@old.example"); // a guessed address left with no mailbox goes
  const touched = fs.readFileSync(path.join(people, "paola-fiche", "_fragments", "002.frag"), "utf8");
  expect(touched).toContain("- Et j'ajoute : appeler le syndic.");
  expect(touched).not.toContain("maurice-mail:g2");
  expect(touched).toContain("written_hash: somethingelse"); // hers: the hash is not moved
  expect(fs.existsSync(path.join(people, "paola-fiche", "_fragments", "003.frag"))).toBe(true);
});

test("every past version pruned when asked, the remote with it; the rest of the history kept", () => {
  const bare = path.join(GARDENS, "remote.git");
  const git = (cwd: string, ...a: string[]) => spawnSync("git", a, { cwd, encoding: "utf8" });
  git(GARDENS, "init", "-q", "--bare", bare);
  git(root, "init", "-q", "-b", "main"); git(root, "config", "user.email", "t@t"); git(root, "config", "user.name", "t");
  git(root, "remote", "add", "origin", bare);
  git(root, "add", "-A"); git(root, "commit", "-qm", "v1");
  fs.appendFileSync(path.join(root, "notes", "fr", "jeudi.md"), `- Encore — ${L("g2", "Gmail")}\n- Garde — ${L("k1", "Proton")}\n`);
  git(root, "add", "-A"); git(root, "commit", "-qm", "v2");
  git(root, "push", "-q", "origin", "main");
  const r = forget.pruneGarden({ root, username: ANNA }, "fr", gone, "anna@gmail.com", "Gmail");
  git(root, "add", "-A"); git(root, "commit", "-qm", "pruned");
  expect(r.removed.length).toBeGreaterThan(0);
  expect(forget.pruneHistory({ root, username: ANNA }, gone)).toBeNull();
  const everything = git(root, "log", "--all", "-p").stdout;
  expect(everything).not.toContain("maurice-mail:g1");
  expect(everything).not.toContain("maurice-mail:g2");
  expect(everything).toContain("maurice-mail:k1");
  expect(git(root, "log", "--oneline").stdout.split("\n").filter(Boolean)).toHaveLength(3);
  expect(git(bare, "log", "--all", "-p").stdout).not.toContain("maurice-mail:g1");
  expect(git(root, "status", "--porcelain").stdout.trim()).toBe("");
});

test("the route forgets the store, then the garden, then the account", async () => {
  const auth = `Bearer ${createSession(ANNA).token}`;
  db.run(`DELETE FROM mail_accounts WHERE member_id = ?`, [ANNA]);
  db.run(`INSERT INTO mail_accounts (id, member_id, address, secret) VALUES ('mf-acc', ?, 'anna@gmail.com', 'v1:x')`, [ANNA]);
  const calls: any[] = [];
  scan.setMailScanDeps({ call: async (_m: string, tool: string, args: any) => { calls.push({ tool, args }); return { address: args.address, gone: ["g1", "g2"], kept: 3, locations: 5 }; } });
  const res = await routes.request("/mf-acc/forget", { method: "POST", headers: { Authorization: auth, "Content-Type": "application/json" }, body: JSON.stringify({}) });
  expect(res.status).toBe(200);
  const out = await res.json() as any;
  expect(out).toMatchObject({ address: "anna@gmail.com", gone: 2, kept: 3, history: "kept" });
  expect(out.removed).toBe(4);
  expect(calls[0]).toEqual({ tool: "forget_mailbox", args: { address: "anna@gmail.com" } });
  expect(db.query(`SELECT count(*) AS n FROM mail_accounts WHERE member_id = ?`).get(ANNA)).toEqual({ n: 0 });
  expect(fs.existsSync(path.join(people, "jean-fiche.md"))).toBe(false);
});
