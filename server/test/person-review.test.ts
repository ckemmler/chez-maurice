// The member's word on a person fiche and the "À vérifier" footer (lot 4 of
// specs/contacts.md; services/personReview.ts, services/reviewFooter.ts,
// routes/people.ts). What is held down: the fiche seen element by element,
// with what is pending; a fragment the member edits is confirmed, one they
// reject goes; a corrected relation is confirmed and sends the pending
// fragments back to the writer; a rejected address stays; "confirm all";
// a fiche the member wrote cannot be rejected, one Maurice made goes; the
// routes act on the caller's own garden only; and the footer lists what
// entered a turn unconfirmed — through a tool, the corpus or the composer —
// with links to the elements, grouped past three, and nothing once
// confirmed.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";

const GARDENS = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "maurice-review-"));
process.env.MAURICE_GARDENS_DIR = GARDENS;

const db = (await import("../src/db")).default;
const review = await import("../src/services/personReview");
const footer = await import("../src/services/reviewFooter");
const { fragmentHash } = await import("../src/services/mailPeople");
const routes = (await import("../src/routes/people")).default;
const { createSession } = await import("../src/services/auth");

const ANNA = "pr-anna";
const BEN = "pr-ben";
const peopleDir = path.join(GARDENS, ANNA, "people", "fr");
let annaAuth = "";
let benAuth = "";

const REL = "Le prof de solfège d'Adriano. — [1 sept. 2026, Jean, « Solfège » · Gmail](maurice-mail:m1)";
const FRAG1 = "## Ce qui est en cours\n\n- Le cours reprend jeudi — [1 sept. 2026, Jean, « Solfège » · Gmail](maurice-mail:m1)\n";
const FRAG2 = "## Resté ouvert\n\n- Le paiement du trimestre — [3 sept. 2026, Jean, « Facture » · Proton](maurice-mail:m2)\n";

function writeJean() {
  fs.rmSync(path.join(GARDENS, ANNA), { recursive: true, force: true });
  fs.mkdirSync(path.join(peopleDir, "jean-derely-fiche", "_fragments"), { recursive: true });
  fs.writeFileSync(path.join(peopleDir, "jean-derely-fiche.md"), `---
title: Jean Derély
resource_collection: people
resource_id: jean-derely
locale: fr
status: pending
identities:
  - address: jean@x.org
    mailboxes:
      - anna@gmail.com
    status: pending
    source: mail
  - address: jd@y.org
    mailboxes:
      - anna@proton.me
    status: pending
    source: vcard
    conflict: writes as « JD Music »
relation:
  status: pending
  since: "2026-09"
  until: null
  written_hash: ${fragmentHash(REL)}
meta:
  opened: false
  author: maurice
  origin: mail
  person_key: jean@x.org
---

## La relation

${REL}

## D'où ça vient

Une partie de cette note a été écrite par une machine lisant ton courrier.
`);
  const frag = (n: string, mailbox: string, body: string) =>
    fs.writeFileSync(path.join(peopleDir, "jean-derely-fiche", "_fragments", `${n}.frag`),
      `---\nsummary: Courrier · jean@x.org · ${mailbox === "anna@gmail.com" ? "Gmail" : "Proton"}\norigin: mail\nstatus: pending\naddress: jean@x.org\nmailbox: ${mailbox}\nsources:\n  - m1\nwritten_hash: ${fragmentHash(body)}\n---\n${body}`);
  frag("001", "anna@gmail.com", FRAG1);
  frag("002", "anna@proton.me", FRAG2);
}

beforeAll(() => {
  db.run(`INSERT OR IGNORE INTO households (id, name) VALUES ('default', 'Home')`);
  for (const [id, name] of [[ANNA, "Anna"], [BEN, "Ben"]] as const) {
    db.run(`INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES (?, ?, ?, 'standard')`, [id, id, name]);
  }
  annaAuth = `Bearer ${createSession(ANNA).token}`;
  benAuth = `Bearer ${createSession(BEN).token}`;
  fs.mkdirSync(path.join(GARDENS, BEN), { recursive: true });
});

beforeEach(writeJean);

const garden = () => ({ root: path.join(GARDENS, ANNA), username: ANNA });

test("the fiche element by element, with what is pending", () => {
  const v = review.personView(garden(), "fr", "jean-derely-fiche");
  expect(v.status).toBe("pending");
  expect(v.relation).toMatchObject({ status: "pending", since: "2026-09", edited: false });
  expect(v.relation.text).toBe(REL);
  expect(v.identities.map((i) => [i.address, i.status, i.conflict])).toEqual([["jean@x.org", "pending", null], ["jd@y.org", "pending", "writes as « JD Music »"]]);
  expect(v.fragments.map((f) => [f.id, f.status, f.mailbox])).toEqual([["001", "pending", "anna@gmail.com"], ["002", "pending", "anna@proton.me"]]);
  expect(v.pending).toBe(6);
});

test("an edited fragment is confirmed and stays the member's; a rejected one goes; a relation corrected is confirmed and marked for rewrite", () => {
  let v = review.review(ANNA, garden(), "fr", "jean-derely-fiche", { target: "fragment", action: "edit", id: "001", text: "- Le cours reprend jeudi, à 17 h." })!;
  expect(v.fragments[0]).toMatchObject({ id: "001", status: "confirmed", edited: true });
  const raw = fs.readFileSync(path.join(peopleDir, "jean-derely-fiche", "_fragments", "001.frag"), "utf8");
  expect(raw).toContain("edited_by: member");
  expect(raw).toContain(`written_hash: ${fragmentHash(FRAG1)}`); // the hash of what was written: the text no longer matches it
  v = review.review(ANNA, garden(), "fr", "jean-derely-fiche", { target: "fragment", action: "reject", id: "002" })!;
  expect(v.fragments.map((f) => f.id)).toEqual(["001"]);
  v = review.review(ANNA, garden(), "fr", "jean-derely-fiche", { target: "relation", action: "edit", text: "Le prof de solfège d'Adriano, depuis 2025." })!;
  expect(v.relation).toMatchObject({ status: "confirmed", text: "Le prof de solfège d'Adriano, depuis 2025." });
  const fiche = fs.readFileSync(path.join(peopleDir, "jean-derely-fiche.md"), "utf8");
  expect(fiche).toMatch(/relation:\n\s+status: confirmed[\s\S]*rewrite: true/);
  expect(fiche).toContain("## D'où ça vient"); // the rest of the body kept
  v = review.review(ANNA, garden(), "fr", "jean-derely-fiche", { target: "identity", action: "reject", id: "JD@y.org" })!;
  expect(v.identities[1]!.status).toBe("rejected");
  expect(v.pending).toBe(2); // the person, and jean@x.org
  v = review.review(ANNA, garden(), "fr", "jean-derely-fiche", { target: "all", action: "confirm" })!;
  expect(v.pending).toBe(0);
  expect(v.identities[1]!.status).toBe("rejected"); // "all" confirms what was pending, not what was rejected
});

test("a fiche Maurice made can be rejected and goes; a fiche the member wrote cannot", () => {
  expect(review.review(ANNA, garden(), "fr", "jean-derely-fiche", { target: "fiche", action: "reject" })).toBeNull();
  expect(fs.existsSync(path.join(peopleDir, "jean-derely-fiche.md"))).toBe(false);
  expect(fs.existsSync(path.join(peopleDir, "jean-derely-fiche"))).toBe(false);
  fs.writeFileSync(path.join(peopleDir, "paola-fiche.md"), "---\ntitle: Paola\nresource_collection: people\nlocale: fr\n---\n\n## Journal\n");
  expect(review.personView(garden(), "fr", "paola-fiche")).toMatchObject({ status: "confirmed", pending: 0 });
  expect(() => review.review(ANNA, garden(), "fr", "paola-fiche", { target: "fiche", action: "reject" })).toThrow("yours to delete");
});

test("the routes act on the caller's own garden, and refuse what makes no sense", async () => {
  const req = (auth: string, p: string, init: RequestInit = {}) => routes.request(p, { ...init, headers: { Authorization: auth, "Content-Type": "application/json" } });
  expect((await (await req(annaAuth, "/fr/jean-derely-fiche")).json()).pending).toBe(6);
  expect((await req(benAuth, "/fr/jean-derely-fiche")).status).toBe(404);
  expect((await req(annaAuth, "/fr/..%2Fsecret-fiche")).status).toBe(400);
  const ok = await req(annaAuth, "/fr/jean-derely-fiche/review", { method: "POST", body: JSON.stringify({ target: "fragment", action: "confirm", id: "001" }) });
  expect(ok.status).toBe(200);
  expect((await ok.json()).view.fragments[0].status).toBe("confirmed");
  expect((await req(annaAuth, "/fr/jean-derely-fiche/review", { method: "POST", body: JSON.stringify({ target: "fragment", action: "confirm", id: "../x" }) })).status).toBe(400);
  expect((await req(annaAuth, "/fr/jean-derely-fiche/review", { method: "POST", body: JSON.stringify({ target: "relation", action: "edit" }) })).status).toBe(400);
  expect((await req(benAuth, "/fr/jean-derely-fiche/review", { method: "POST", body: JSON.stringify({ target: "all", action: "confirm" }) })).status).toBe(404);
});

test("the footer lists what entered the turn unconfirmed, with links to the elements; grouped past three; nothing once confirmed", () => {
  const CONVO = "pr-convo";
  // Nothing seen, nothing said.
  footer.startReview(CONVO);
  expect(footer.takeFooter(CONVO, ANNA, "https://home.example", "fr")).toBeNull();
  // Through the garden tool: the model is told, and the footer groups the six.
  footer.startReview(CONVO);
  const mark = footer.noteTool(CONVO, ANNA, "garden__get_fiche", { resource_collection: "people", resource_id: "jean-derely", locale: "fr" }, null);
  expect(mark).toContain("Not confirmed by the member yet");
  expect(mark).toContain("the address jd@y.org (writes as « JD Music »)");
  expect(mark).toContain("fragment 001");
  let f = footer.takeFooter(CONVO, ANNA, "https://home.example", "fr")!;
  expect(f).toContain("**À vérifier — pas encore confirmé par toi**");
  expect(f).toContain(`- [Jean Derély](https://home.example/g/${ANNA}/fr/fiches/people/jean-derely-fiche#review) — 6 éléments à vérifier`);
  // Taken once: a second take says nothing.
  expect(footer.takeFooter(CONVO, ANNA, "https://home.example", "fr")).toBeNull();
  // Three left: one line each, anchored.
  review.review(ANNA, garden(), "fr", "jean-derely-fiche", { target: "fiche", action: "confirm" });
  review.review(ANNA, garden(), "fr", "jean-derely-fiche", { target: "identity", action: "confirm", id: "jean@x.org" });
  review.review(ANNA, garden(), "fr", "jean-derely-fiche", { target: "identity", action: "reject", id: "jd@y.org" });
  // Through the corpus: a hit in a fragment.
  footer.startReview(CONVO);
  const cm = footer.noteTool(CONVO, ANNA, "corpus__search", { query: "solfège" }, [{ file_path: `${peopleDir}/jean-derely-fiche/_fragments/002.frag` }, { file_path: `${GARDENS}/${ANNA}/notes/fr/violon.md` }]);
  expect(cm).toContain("Jean Derély: the relation, fragment 001, fragment 002");
  f = footer.takeFooter(CONVO, ANNA, "https://home.example", "fr")!;
  expect(f.split("\n").filter((l) => l.startsWith("- "))).toEqual([
    `- [Jean Derély](https://home.example/g/${ANNA}/fr/fiches/people/jean-derely-fiche#relation) · la relation : « Le prof de solfège d'Adriano. »`,
    `- [Jean Derély](https://home.example/g/${ANNA}/fr/fiches/people/jean-derely-fiche#fragment-001) · fragment Courrier · jean@x.org · Gmail`,
    `- [Jean Derély](https://home.example/g/${ANNA}/fr/fiches/people/jean-derely-fiche#fragment-002) · fragment Courrier · jean@x.org · Proton`,
  ]);
  // Through the composer; then everything confirmed: no footer.
  review.review(ANNA, garden(), "fr", "jean-derely-fiche", { target: "all", action: "confirm" });
  footer.startReview(CONVO);
  expect(footer.noteComposer(CONVO, ANNA, [{ type: "fiche", id: "people/fr/jean-derely-fiche" }, { type: "note", id: "x" }])).toBe("");
  expect(footer.takeFooter(CONVO, ANNA, "https://home.example", "fr")).toBeNull();
  // Not started (a room): nothing noted.
  expect(footer.noteTool("pr-room", ANNA, "garden__get_fiche", { resource_collection: "people", resource_id: "jean-derely", locale: "fr" }, null)).toBe("");
  expect(footer.takeFooter("pr-room", ANNA, "https://home.example", "fr")).toBeNull();
});

afterAll(() => fs.rmSync(GARDENS, { recursive: true, force: true }));
