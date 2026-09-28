/**
 * A confirmed relation, revisited (services/mailPeople.ts, personReview.ts):
 * the member's word is never rewritten, but when the person has grown past
 * what the relation rested on — more messages, or a mailbox it had not seen
 * — Maurice writes a revision beside it, once, for the member to accept or
 * refuse. Salman's case on 28 September 2026: "sends New Year wishes",
 * confirmed on Proton, then a colleague in contactoffice.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, expect, test } from "bun:test";

const GARDENS = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "maurice-revisit-"));
process.env.MAURICE_GARDENS_DIR = GARDENS;

const db = (await import("../src/db")).default;
const people = await import("../src/services/mailPeople");
const review = await import("../src/services/personReview");
const { wordsFor } = await import("../src/services/mailDocuments");

const M = "rv-member";
const dir = path.join(GARDENS, M, "people", "fr");
const garden = () => ({ root: path.join(GARDENS, M), username: M });
const REL = "Salman t'envoie des vœux chaque 1er janvier depuis 2024. — [1 janv. 2024, Salman, « Happy new year! » · Proton](maurice-mail:p1)";

const msg = (id: string, date: string, mailbox: string, subject: string) => ({
  id, message_id: `<${id}@x>`, from: "Salman <salman@x.org>", to: ["me@x.org"], cc: [], date, subject, thread: `<${id}@x>`,
  reading: { summary: subject, kind: "work" }, mailboxes: [mailbox],
});
const OLD = [msg("p1", "2024-01-01T10:00:00+00:00", "me@proton.me", "Happy new year!"), msg("p2", "2025-01-01T10:00:00+00:00", "me@proton.me", "Happy new year!")];
const NEW = Array.from({ length: 6 }, (_, i) => msg(`c${i}`, `2026-0${i + 1}-10T10:00:00+00:00`, "me@contactoffice.com", `Re: backlog CO ${i}`));

function writeSalman() {
  fs.rmSync(path.join(GARDENS, M), { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, "salman-fiche", "_fragments"), { recursive: true });
  fs.writeFileSync(path.join(dir, "salman-fiche.md"), `---
title: Salman
resource_collection: people
resource_id: salman
locale: fr
status: confirmed
identities:
  - address: salman@x.org
    mailboxes:
      - me@proton.me
    status: confirmed
    source: mail
relation:
  status: confirmed
  since: "2024-01"
  until: null
  sources:
    - p1
  written_hash: ${people.fragmentHash(REL)}
meta:
  author: maurice
  origin: mail
  person_key: salman@x.org
---

## La relation

${REL}

## D'où ça vient

Une partie de cette note a été écrite par une machine lisant ton courrier.
`);
}

let asks: string[] = [];
let answer = '{"relation": {"text": "Un collègue de ContactOffice avec qui tu travailles sur le backlog [3][4], qui t\'envoie aussi ses vœux chaque année [1].", "since": "2024-01", "until": null}}';

function ctx(all: any[]) {
  return {
    garden: garden(), locale: "fr", language: "French", member: "Candide", w: wordsFor("fr"), labels: new Map<string, string>(),
    now: new Date("2026-09-28T12:00:00Z"), index: people.indexPeopleFiches(garden()),
    artefact: { kind: "person", key: "salman@x.org", slug: "salman-fiche", locale: "fr", title: "Salman", sources: all.map((m) => m.id), written_at: "x", deleted_at: null } as any,
    exchanges: null,
    ask: async (system: string, _prompt: string) => {
      asks.push(system);
      return { text: answer, model: "test-model", provider: "x", stop: "end" as const, usage: null as any };
    },
  };
}

const person = (messages: any[]) => ({
  key: "salman@x.org", card: null, name: "Salman", identities: [{ address: "salman@x.org", mailboxes: ["me@proton.me"], status: "confirmed", source: "mail" }] as any,
  messages, addressOf: new Map(messages.map((m) => [m.id, "salman@x.org"])),
});

beforeAll(() => {
  db.run(`INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES (?, ?, 'Candide', 'standard')`, [M, M]);
});

beforeEach(() => {
  writeSalman();
  asks = [];
});

test("what a relation rests on: recorded, or, for an older one, what there was up to what it cites", () => {
  expect(people.relationBasis({ sources: ["p1"] }, [...OLD, ...NEW])).toEqual({ messages: 1, mailboxes: ["me@proton.me"] });
  expect(people.relationBasis({ basis: { messages: 7, mailboxes: ["a"] } }, OLD)).toEqual({ messages: 7, mailboxes: ["a"] });
  expect(people.relationGrown({ sources: ["p1"] }, OLD)).toBe(false); // one more, same mailbox
  expect(people.relationGrown({ sources: ["p1"] }, [...OLD, NEW[0]!])).toBe(true); // a mailbox it had not seen
  expect(people.relationGrown({ basis: { messages: 2, mailboxes: ["me@proton.me"] } }, [...OLD, ...NEW.slice(0, 4)].map((m) => ({ ...m, mailboxes: ["me@proton.me"] })))).toBe(false);
  expect(people.relationGrown({ basis: { messages: 2, mailboxes: ["me@proton.me"] } }, [...OLD, ...NEW.slice(0, 5)].map((m) => ({ ...m, mailboxes: ["me@proton.me"] })))).toBe(true);
});

test("a confirmed relation the person outgrew: a revision beside it, never in its place, and asked once", async () => {
  const all = [...OLD, ...NEW];
  // Everything already covered: without the revisit, nothing would be asked.
  const out = await people.writePerson(ctx(all), person(all));
  expect(asks).toHaveLength(1);
  expect(asks[0]).toContain("confirmed this relation");
  const text = fs.readFileSync(path.join(dir, "salman-fiche.md"), "utf8");
  expect(text).toContain(REL); // the member's word, untouched
  expect(text).toContain("## Maurice propose");
  expect(text).toContain("Un collègue de ContactOffice");
  expect(text.indexOf("## Maurice propose")).toBeGreaterThan(text.indexOf("## La relation"));
  expect(text).toMatch(/proposed:\n\s+sources:/);
  expect(out.kind).toBe("unchanged");
  // Again: the proposal is there, nothing is asked.
  await people.writePerson(ctx(all), person(all));
  expect(asks).toHaveLength(1);
  // The page shows it, pending.
  const v = review.personView(garden(), "fr", "salman-fiche");
  expect(v.relation.proposed!.text).toContain("Un collègue de ContactOffice");
  expect(v.pending).toBeGreaterThanOrEqual(1);
});

test("the model sees nothing new to say: no proposal, and the basis moves so it is not asked every night", async () => {
  answer = '{"relation": null}';
  const all = [...OLD, ...NEW];
  await people.writePerson(ctx(all), person(all));
  await people.writePerson(ctx(all), person(all));
  expect(asks).toHaveLength(1);
  expect(fs.readFileSync(path.join(dir, "salman-fiche.md"), "utf8")).not.toContain("## Maurice propose");
  answer = '{"relation": {"text": "Un collègue de ContactOffice avec qui tu travailles sur le backlog [3][4], qui t\'envoie aussi ses vœux chaque année [1].", "since": "2024-01", "until": null}}';
});

test("accepted, the proposal becomes the relation; refused, it goes and the relation stays", async () => {
  const all = [...OLD, ...NEW];
  await people.writePerson(ctx(all), person(all));
  const v = review.review(M, garden(), "fr", "salman-fiche", { target: "proposal", action: "confirm" })!;
  expect(v.relation.text).toContain("Un collègue de ContactOffice");
  expect(v.relation.status).toBe("confirmed");
  expect(v.relation.proposed).toBeNull();
  expect(fs.readFileSync(path.join(dir, "salman-fiche.md"), "utf8")).not.toContain("## Maurice propose");

  writeSalman();
  await people.writePerson(ctx(all), person(all));
  const r = review.review(M, garden(), "fr", "salman-fiche", { target: "proposal", action: "reject" })!;
  expect(r.relation.text).toBe(REL);
  expect(r.relation.proposed).toBeNull();
  expect(() => review.review(M, garden(), "fr", "salman-fiche", { target: "proposal", action: "confirm" })).toThrow("no relation proposed");
});
