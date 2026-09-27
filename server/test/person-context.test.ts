// The person beside a corpus hit (lot 5 of specs/contacts.md;
// services/personContext.ts). What is held down: a hit that mentions someone
// with a relation — by a link to their fiche, or by a full name in either
// order, accents and case aside — carries one line saying who they are to
// the member now, dated and marked confirmed or not; a first name alone
// matches nothing; the person's own fiche or fragment gets nothing; a fiche
// without a relation, or with a rejected one, says nothing; a pending
// relation attached this way enters the "À vérifier" footer.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";

const GARDENS = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "maurice-person-ctx-"));
process.env.MAURICE_GARDENS_DIR = GARDENS;

const db = (await import("../src/db")).default;
const ctx = await import("../src/services/personContext");
const footer = await import("../src/services/reviewFooter");
const { fragmentHash } = await import("../src/services/mailPeople");

const ANNA = "pc-anna";
const dir = path.join(GARDENS, ANNA, "people", "fr");

function fiche(basename: string, fm: string, body: string) {
  fs.writeFileSync(path.join(dir, `${basename}.md`), `---\n${fm}\n---\n\n${body}`);
}

beforeAll(() => {
  db.run(`INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES (?, ?, ?, 'standard')`, [ANNA, ANNA, "Anna"]);
});

beforeEach(() => {
  fs.rmSync(path.join(GARDENS, ANNA), { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  ctx._clearPeopleIndex();
  ctx._clearFichesByAddress();
  const jean = "Ton collègue chez Acme, parti en mars 2026. — [3 mars 2026, Jean, « Dernier jour » · Gmail](maurice-mail:m1)";
  fiche("jean-dupont-fiche", `title: Jean Dupont\nresource_collection: people\nstatus: confirmed\nrelation:\n  status: confirmed\n  since: "2021"\n  until: "2026-03"\n  written_hash: ${fragmentHash(jean)}`, `## La relation\n\n${jean}\n`);
  const paola = "La mère de tes enfants.";
  fiche("magi-paola-fiche", `title: Magi Paola\nresource_collection: people\nrelation:\n  status: pending\n  written_hash: ${fragmentHash(paola)}\nmeta:\n  author: maurice`, `## La relation\n\n${paola}\n`);
  fiche("marc-fiche", `title: Marc\nrelation:\n  status: pending\n  written_hash: x`, `## La relation\n\nUn voisin.\n`);
  fiche("francisco-varela-fiche", `title: Francisco Varela\nresource_collection: people`, `## Journal\n\n- Lu en 2024.\n`);
  const eve = "Une ancienne cliente.";
  fiche("eve-martin-fiche", `title: Eve Martin\nrelation:\n  status: rejected\n  written_hash: ${fragmentHash(eve)}`, `## La relation\n\n${eve}\n`);
});

afterAll(() => fs.rmSync(GARDENS, { recursive: true, force: true }));

test("who has a relation to say, and by which names", () => {
  const idx = ctx.peopleIndex(ANNA);
  expect(idx.map((e) => e.basename).sort()).toEqual(["jean-dupont-fiche", "magi-paola-fiche", "marc-fiche"]);
  const jean = idx.find((e) => e.basename === "jean-dupont-fiche")!;
  expect(jean).toMatchObject({ relation: "Ton collègue chez Acme, parti en mars 2026.", status: "confirmed", since: "2021", until: "2026-03" });
  expect(idx.find((e) => e.basename === "marc-fiche")!.names).toEqual([]); // a first name alone is no name to match
  expect(ctx.personLine(jean)).toBe("Jean Dupont — Ton collègue chez Acme, parti en mars 2026. (2021 → 2026-03) [confirmed by the member]");
});

test("a full name in either order, accents and case aside, or a link; never a first name alone", () => {
  const idx = ctx.peopleIndex(ANNA);
  const who = (t: string) => ctx.mentionsIn(t, idx).map((e) => e.basename);
  expect(who("Réunion avec JEAN DUPONT sur la feature du client.")).toEqual(["jean-dupont-fiche"]);
  expect(who("Paola Magi a appelé l'école.")).toEqual(["magi-paola-fiche"]);
  expect(who("Voir [[jean-dupont-fiche|Jean]] pour le contexte.")).toEqual(["jean-dupont-fiche"]);
  expect(who("Marc est passé, Jean aussi, et Paola.")).toEqual([]);
  expect(who("Jean-Dupontesque n'est pas un nom.")).toEqual([]);
});

test("each hit carries the people it mentions; the person's own fiche does not; a pending relation enters the footer", () => {
  const CONVO = "pc-convo";
  footer.startReview(CONVO);
  const rows = [
    { file_path: `${GARDENS}/${ANNA}/notes/fr/feature-x.md`, title: "Feature X", text: "Jean Dupont nous a expliqué la feature pour le client. Paola Magi était là." },
    { file_path: `${dir}/magi-paola-fiche/_fragments/001.frag`, title: "Courrier", text: "Magi Paola t'envoie les bordereaux." },
    { file_path: `${GARDENS}/${ANNA}/notes/fr/rien.md`, title: "Rien", text: "Personne ici." },
  ];
  const narrowed = JSON.stringify({ results: rows.map((r) => ({ source: r.title, kind: "note", passage: r.text })) });
  const out = JSON.parse(ctx.attachPeople(CONVO, ANNA, narrowed, rows));
  expect(out.results[0].people).toEqual([
    "Jean Dupont — Ton collègue chez Acme, parti en mars 2026. (2021 → 2026-03) [confirmed by the member]",
    "Magi Paola — La mère de tes enfants. [not confirmed yet]",
  ]);
  expect(out.results[1].people).toBeUndefined();
  expect(out.results[2].people).toBeUndefined();
  const f = footer.takeFooter(CONVO, ANNA, "https://home.example", "fr")!;
  expect(f).toContain("[Magi Paola](https://home.example/g/pc-anna/fr/fiches/people/magi-paola-fiche#relation) · la relation : « La mère de tes enfants. »");
  expect(f).not.toContain("Jean Dupont"); // confirmed: nothing to check
  // Nothing to attach, or a shape it does not know: the text as it was.
  expect(ctx.attachPeople(CONVO, ANNA, narrowed.replace("Jean Dupont", "Jean").replace("Paola Magi", "Paola"), rows.map((r) => ({ ...r, text: "" })))).toBe(narrowed.replace("Jean Dupont", "Jean").replace("Paola Magi", "Paola"));
  expect(ctx.attachPeople(CONVO, ANNA, "not json", rows)).toBe("not json");
});

test("an exchanges result names the fiche its addresses belong to, and how to open it; a rejected address, or none, says nothing", () => {
  fiche("melanie-fiche", `title: Mélanie\nresource_collection: people\nidentities:\n  - address: mela@partfin.be\n    status: pending\n  - address: old@partfin.be\n    status: rejected`, `## Les échanges\n\n3 message(s).\n`);
  const hint = ctx.fichesForExchanges(ANNA, { addresses: ["MELA@partfin.be"], total: 3, messages: [] });
  expect(hint).toContain(`Mélanie (garden__get_fiche: resource_collection "people", resource_id "melanie", locale "fr")`);
  expect(hint).toContain("going on");
  expect(ctx.fichesForExchanges(ANNA, { addresses: ["old@partfin.be"] })).toBe("");
  expect(ctx.fichesForExchanges(ANNA, { addresses: ["nobody@x.org"] })).toBe("");
  expect(ctx.fichesForExchanges(null, { addresses: ["mela@partfin.be"] })).toBe("");
  expect(ctx.fichesForExchanges(ANNA, null)).toBe("");
});
