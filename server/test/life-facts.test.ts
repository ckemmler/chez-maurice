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

/** What the second opinion answers. Tests set it; nothing here calls a model. */
let judgeSays = "KEEP";
let judgeCalls = 0;

beforeAll(() => {
  facts.setFactJudge(async (req) => {
    judgeCalls++;
    const text = judgeSays === "KEEP" ? `KEEP ${req.prompt}` : judgeSays;
    return { text, model: "test-judge", provider: "test", stop: "end", usage: null };
  });
});

beforeEach(() => {
  db.run(`DELETE FROM life_facts WHERE member_id IN (?, ?)`, [ANNA, BEN]);
  judgeSays = "KEEP";
  judgeCalls = 0;
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
  test("it proposes, and says plainly that nothing is known yet", async () => {
    const r = await facts.runRememberFactTool({ fact: "Emilio a onze ans." }, ANNA, "c1", 0);
    expect(r.isError).toBe(false);
    expect(r.text).toContain("Proposed");
    expect(r.text).toContain("not treat it as known");
    // The card is what tells the member.
    expect((r.data as any).card).toBe("fact");
    expect((r.data as any).text).toBe("Emilio a onze ans.");
  });

  test("a refusal is an ordinary answer, not an error to retry", async () => {
    await facts.runRememberFactTool({ fact: "Emilio a onze ans." }, ANNA, "c1", 0);
    const again = await facts.runRememberFactTool({ fact: "Emilio a onze ans." }, ANNA, "c1", 1);
    expect(again.isError).toBe(false);
    expect(again.data).toBeUndefined(); // nothing to show her
    expect(again.text).toContain("already proposed");
  });

  test("no member, no writing", async () => {
    expect((await facts.runRememberFactTool({ fact: "x" }, undefined, "c1", 0)).isError).toBe(true);
  });
});

describe("the second opinion", () => {
  test("a project is refused, and nothing is written", async () => {
    judgeSays = "DROP a plan, not a fact";
    const r = await facts.runRememberFactTool({ fact: "Il envisage un voyage aux Galápagos." }, ANNA, "c1", 0);
    expect(r.isError).toBe(false);
    expect(r.data).toBeUndefined();
    expect(r.text).toContain("a plan, not a fact");
    expect(facts.allFacts(ANNA)).toHaveLength(0);
  });

  test("it may reword a clumsy fact, and that wording is what is proposed", async () => {
    judgeSays = "KEEP Emilio a onze ans.";
    const r = await facts.runRememberFactTool({ fact: "emilio, il a 11 ans je crois" }, ANNA, "c1", 0);
    expect((r.data as any).text).toBe("Emilio a onze ans.");
  });

  test("it is not paid to read what would be refused anyway", async () => {
    // Empty, too long, already known: turned away before the judge is called.
    await facts.runRememberFactTool({ fact: "   " }, ANNA, "c1", 0);
    await facts.runRememberFactTool({ fact: "x".repeat(300) }, ANNA, "c1", 0);
    await facts.runRememberFactTool({ fact: "Un." }, ANNA, "c1", 2); // over the per-turn cap
    expect(judgeCalls).toBe(0);
  });

  test("a refused fact still spends its share of the turn's quota", async () => {
    // Otherwise a model on a roll could be turned down ten times in one turn
    // and still have bought ten judgements.
    judgeSays = "DROP a plan, not a fact";
    const a = await facts.runRememberFactTool({ fact: "Il envisage un voyage." }, ANNA, "c1", 0);
    expect(a.counted).toBe(true);
    const b = await facts.runRememberFactTool({ fact: "Il envisage autre chose." }, ANNA, "c1", 1);
    expect(b.counted).toBe(true);
    // Third one in the same turn: turned away before the judge is paid again.
    const before = judgeCalls;
    const c = await facts.runRememberFactTool({ fact: "Et encore une idée." }, ANNA, "c1", 2);
    expect(c.text).toContain("Two facts in one turn");
    expect(judgeCalls).toBe(before);
    expect(c.counted).toBeUndefined();
  });

  test("a judge that breaks lets the fact through — the member is the real gate", async () => {
    facts.setFactJudge(async () => {
      throw new Error("provider down");
    });
    const r = await facts.runRememberFactTool({ fact: "Elle vit à Bruxelles." }, ANNA, "c1", 0);
    expect((r.data as any).text).toBe("Elle vit à Bruxelles.");
    facts.setFactJudge(async (req) => ({ text: `KEEP ${req.prompt}`, model: "t", provider: "t", stop: "end", usage: null }));
  });

  test("an answer that is neither KEEP nor DROP does not get to decide", async () => {
    judgeSays = "I think that is probably fine?";
    const r = await facts.runRememberFactTool({ fact: "Elle joue du violon." }, ANNA, "c1", 0);
    expect((r.data as any).text).toBe("Elle joue du violon.");
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
