// Facts of a life (20 September 2026): the small lasting things Maurice learns
// in conversation, proposed rather than asserted.
//
// The rule the whole design turns on: a proposed fact is not known. It reaches
// no prompt until the member has kept it. A model that writes into someone's
// memory unsupervised eventually writes something false into it, and the
// member is the one who has to live with that.

import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

const { default: db } = await import("../src/db");
const facts = await import("../src/services/lifeFacts");
const routes = (await import("../src/routes/lifeFacts")).default;
const { createSession } = await import("../src/services/auth");

const ANNA = "lf-anna";
const BEN = "lf-ben";
let annaAuth = "";
let benAuth = "";

function req(auth: string, path: string, init: RequestInit = {}) {
  return routes.request(path, { ...init, headers: { Authorization: auth, "Content-Type": "application/json", ...(init.headers ?? {}) } });
}

beforeAll(() => {
  db.run(`INSERT OR IGNORE INTO households (id, name) VALUES ('default', 'Home')`);
  for (const [id, name] of [[ANNA, "Anna"], [BEN, "Ben"]] as const) {
    db.run(`INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES (?, ?, ?, 'standard')`, [id, id, name]);
  }
  annaAuth = `Bearer ${createSession(ANNA).token}`;
  benAuth = `Bearer ${createSession(BEN).token}`;
});

beforeEach(() => {
  db.run(`DELETE FROM life_facts WHERE member_id IN (?, ?)`, [ANNA, BEN]);
});

describe("proposing", () => {
  test("a proposed fact is not yet known", () => {
    const { fact } = facts.proposeFact(ANNA, "Emilio a onze ans.", "c1");
    expect(fact!.state).toBe("proposed");
    // The prompt carries nothing until she has decided.
    expect(facts.factsForPrompt(ANNA)).toBe("");
    facts.decideFact(ANNA, fact!.id, true);
    expect(facts.factsForPrompt(ANNA)).toContain("Emilio a onze ans.");
  });

  test("whitespace is squeezed, emptiness and essays refused", () => {
    expect(facts.proposeFact(ANNA, "  Elle joue   du violon.  ", null).fact!.text).toBe("Elle joue du violon.");
    expect(facts.proposeFact(ANNA, "   ", null).refused).toBe("empty");
    expect(facts.proposeFact(ANNA, "x".repeat(facts.FACT_MAX_CHARS + 1), null).refused).toBe("too long");
  });

  test("the same fact is not proposed twice, in either state", () => {
    const { fact } = facts.proposeFact(ANNA, "Emilio a onze ans.", null);
    // Same sentence, different punctuation and case: still the same fact.
    expect(facts.proposeFact(ANNA, "emilio a onze ans", null).refused).toBe("already proposed");
    facts.decideFact(ANNA, fact!.id, true);
    expect(facts.proposeFact(ANNA, "Emilio a onze ans.", null).refused).toBe("already known");
  });

  test("a dismissed fact may be proposed again — she may have changed her mind", () => {
    const { fact } = facts.proposeFact(ANNA, "Elle déteste le café.", null);
    facts.decideFact(ANNA, fact!.id, false);
    expect(facts.proposeFact(ANNA, "Elle déteste le café.", null).fact).toBeTruthy();
  });

  test("two a turn, and the third is told why", () => {
    expect(facts.proposeFact(ANNA, "Un.", null, 0).fact).toBeTruthy();
    expect(facts.proposeFact(ANNA, "Deux.", null, 1).fact).toBeTruthy();
    expect(facts.proposeFact(ANNA, "Trois.", null, 2).refused).toBe("too many this turn");
  });
});

describe("the tool", () => {
  test("it proposes, and says plainly that nothing is known yet", () => {
    const r = facts.runRememberFactTool({ fact: "Emilio a onze ans." }, ANNA, "c1", 0);
    expect(r.isError).toBe(false);
    expect(r.text).toContain("Proposed");
    expect(r.text).toContain("not treat it as known");
    // The card is what tells the member.
    expect((r.data as any).card).toBe("fact");
    expect((r.data as any).text).toBe("Emilio a onze ans.");
  });

  test("a refusal is an ordinary answer, not an error to retry", () => {
    facts.runRememberFactTool({ fact: "Emilio a onze ans." }, ANNA, "c1", 0);
    const again = facts.runRememberFactTool({ fact: "Emilio a onze ans." }, ANNA, "c1", 1);
    expect(again.isError).toBe(false);
    expect(again.data).toBeUndefined(); // nothing to show her
    expect(again.text).toContain("already proposed");
  });

  test("no member, no writing", () => {
    expect(facts.runRememberFactTool({ fact: "x" }, undefined, "c1", 0).isError).toBe(true);
  });
});

describe("the member decides", () => {
  test("keep, dismiss, correct, forget — and each is theirs alone", async () => {
    const { fact } = facts.proposeFact(ANNA, "Emilio a dix ans.", "c1");
    const id = fact!.id;

    // Ben cannot touch it.
    expect((await req(benAuth, `/${id}/keep`, { method: "POST" })).status).toBe(404);
    expect((await req(benAuth, `/${id}`, { method: "DELETE" })).status).toBe(404);

    // She corrects Maurice, then keeps it.
    const patched = await (await req(annaAuth, `/${id}`, { method: "PATCH", body: JSON.stringify({ text: "Emilio a onze ans." }) })).json();
    expect(patched.text).toBe("Emilio a onze ans.");
    const kept = await (await req(annaAuth, `/${id}/keep`, { method: "POST" })).json();
    expect(kept.state).toBe("kept");
    expect(facts.factsForPrompt(ANNA)).toContain("Emilio a onze ans.");

    // And months later, she takes it back.
    expect((await req(annaAuth, `/${id}`, { method: "DELETE" })).status).toBe(200);
    expect(facts.factsForPrompt(ANNA)).toBe("");
  });

  test("a dismissed fact leaves the prompt alone but stays on file", async () => {
    const { fact } = facts.proposeFact(ANNA, "Elle est née en 1980.", null);
    await req(annaAuth, `/${fact!.id}/dismiss`, { method: "POST" });
    expect(facts.factsForPrompt(ANNA)).toBe("");
    expect(facts.proposedFacts(ANNA)).toHaveLength(0);
    // Still there, so the same sentence is not proposed again next week.
    expect(facts.getFact(fact!.id)!.state).toBe("dismissed");
  });

  test("the list answers what is waiting, what is known, and nobody else's", async () => {
    const waiting = facts.proposeFact(ANNA, "Elle joue du violon.", null).fact!;
    const known = facts.proposeFact(ANNA, "Elle vit à Bruxelles.", null).fact!;
    facts.decideFact(ANNA, known.id, true);
    facts.proposeFact(BEN, "Il a un potager.", null);

    const pending = await (await req(annaAuth, "/?state=proposed")).json();
    expect(pending.facts.map((f: any) => f.text)).toEqual(["Elle joue du violon."]);
    const kept = await (await req(annaAuth, "/?state=kept")).json();
    expect(kept.facts.map((f: any) => f.text)).toEqual(["Elle vit à Bruxelles."]);
    const all = await (await req(annaAuth, "/")).json();
    expect(all.facts).toHaveLength(2);
    expect(JSON.stringify(all)).not.toContain("potager");
    expect(waiting.state).toBe("proposed");
  });
});
