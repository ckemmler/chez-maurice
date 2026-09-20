// The domain briefs (services/domainBriefs.ts). What is nailed down here is the
// shape of the night rather than the model's prose: a first brief reads the
// domain's conversations and only the member's; a night with nothing new
// makes no call; the next rewrite reads only what came after the last one,
// with the previous brief in hand; the output is capped whatever the model
// returns; the night's own allowance stops the call before it is made and is
// charged to the ledger's "system" spender; and the night skips guests.

import { beforeAll, beforeEach, expect, test } from "bun:test";

const { default: db } = await import("../src/db");
const budget = await import("../src/services/budget");
const { addModel } = await import("../src/services/models");
const { setPinnedModel, ancillaryModel } = await import("../src/services/ancillary");
const briefs = await import("../src/services/domainBriefs");
const { getMaurice } = await import("../src/services/maurices");

const ANNA = "briefs-anna";
const GUEST = "briefs-guest";
const BEN = "briefs-ben";
const NIGHT = "deepseek-v4-flash-0731"; // priced in pricing.ts, so the fuse can count it

type Req = { system?: string; prompt: string; maxTokens: number };
let requests: Req[] = [];
let reply: { text: string; stop: "end" | "max_tokens" | "refusal" | "other"; cost: number } = { text: "", stop: "end", cost: 0.002 };
let semantic: Array<{ conversation_id: string; score: number }> = [];

function usage(cost: number) {
  return { provider: "scaleway", model: NIGHT, rounds: 1, input: 1000, output: 100, cache_read: 0, cache_write: 0, cost, cost_uncached: cost };
}

/** Insert a conversation the member sits in, with dated turns. */
function convo(id: string, member: string, title: string, mauriceId: string | null, turns: Array<[string, string, string]>) {
  db.run(`INSERT INTO conversations (id, user_id, title, maurice_id) VALUES (?, ?, ?, ?)`, [id, member, title, mauriceId]);
  db.run(`INSERT INTO conversation_participants (conversation_id, member_id, role) VALUES (?, ?, 'owner')`, [id, member]);
  for (const [role, content, at] of turns) say(id, role, content, at);
}

function say(id: string, role: string, content: string, at: string) {
  db.run(`INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)`, [
    crypto.randomUUID(), id, role, content, at,
  ]);
}

beforeAll(() => {
  db.run(`INSERT OR IGNORE INTO households (id, name) VALUES ('default', 'Home')`);
  db.run(`UPDATE households SET scaleway_api_key = 'test-key' WHERE id = 'default'`);
  for (const [id, name, role] of [[ANNA, "Anna", "standard"], [GUEST, "Gus", "guest"], [BEN, "Ben", "standard"]] as const) {
    db.run(`INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES (?, ?, ?, ?)`, [id, id, name, role]);
  }
  if (!db.query(`SELECT 1 FROM models WHERE id = ?`).get(NIGHT)) {
    addModel({ id: NIGHT, name: "DeepSeek V4 Flash", tier: "cloud", vendor: "deepseek", provider: "scaleway" });
  }
  setPinnedModel("domain_brief", NIGHT);

  db.run(`INSERT INTO maurices (id, name, tagline, created_by) VALUES ('dom-health', 'Health', 'Blood tests and cholesterol', ?)`, [ANNA]);
  db.run(`INSERT INTO maurices (id, name, tagline, created_by) VALUES ('dom-house', 'House', 'The flat and its works', ?)`, [ANNA]);
  db.run(`INSERT INTO maurices (id, name, tagline, created_by) VALUES ('dom-guest', 'Visit', '', ?)`, [GUEST]);

  convo("c-bound", ANNA, "My cholesterol results", "dom-health", [
    ["user", "My LDL came back at 160, is that a worry?", "2026-09-10 10:00:00"],
    ["assistant", "It is above the usual target; here is what the figure means.", "2026-09-10 10:01:00"],
  ]);
  convo("c-free", ANNA, "Iron and ferritin", null, [
    ["user", "Ferritin at 12, the doctor mentioned supplements.", "2026-09-12 09:00:00"],
    ["assistant", "Low ferritin is common; a few points on supplements.", "2026-09-12 09:02:00"],
  ]);
  convo("c-house", ANNA, "Floor insulation", "dom-house", [
    ["user", "How do I insulate the floor against the neighbour's noise?", "2026-09-11 18:00:00"],
    ["assistant", "Acoustic underlay under a floating floor is the usual route.", "2026-09-11 18:03:00"],
  ]);
  convo("c-ben", BEN, "Ben's blood tests", null, [
    ["user", "My own test results, nothing to do with Anna.", "2026-09-13 08:00:00"],
  ]);
  convo("c-reply-only", ANNA, "A thread Maurice closed", null, [
    ["assistant", "A reply with no question from you since.", "2026-09-14 08:00:00"],
  ]);

  briefs.setBriefDeps({
    write: async (req) => {
      requests.push({ system: req.system, prompt: req.prompt, maxTokens: req.maxTokens });
      return { text: reply.text, model: NIGHT, provider: "scaleway", stop: reply.stop, usage: usage(reply.cost) };
    },
    search: async () => semantic,
    members: () => [{ id: ANNA, role: "standard" }, { id: GUEST, role: "guest" }],
  });
});

/** The brief's own call, not the one-liner's: every rewrite now makes two, the
 *  second asking for the index entry that stands for the brief in the everyday
 *  prompt (services/domainBriefs.ts, writeSummary). */
const briefCalls = () => requests.filter((r) => !r.system.includes("one-line index entry"));
const summaryCalls = () => requests.filter((r) => r.system.includes("one-line index entry"));

beforeEach(() => {
  requests = [];
  reply = { text: "You had your LDL measured on 10 September: 160.\n\nYour ferritin is low; supplements were discussed.", stop: "end", cost: 0.002 };
  semantic = [
    { conversation_id: "c-free", score: 0.8 },
    { conversation_id: "c-house", score: 0.7 }, // another domain's: never read here
    { conversation_id: "c-ben", score: 0.9 }, // another member's: the database decides
    { conversation_id: "c-reply-only", score: 0.9 }, // nothing the member said
  ];
  db.run(`DELETE FROM spend_ledger WHERE user_id = ?`, [budget.SYSTEM_SPENDER]);
  budget.setSystemDailyCap(null);
});

const health = () => getMaurice("dom-health")!;

test("the night model is the pin, and the fuse can price it", () => {
  expect(ancillaryModel("domain_brief")).toBe(NIGHT);
  expect(budget.verdict("scaleway", NIGHT, 0, budget.SYSTEM_SPENDER).ok).toBe(true);
});

test("a first brief reads the domain's conversations — bound and found — and only the member's", async () => {
  db.run(`DELETE FROM domain_briefs`);
  const r = await briefs.refreshBrief(health(), ANNA);
  expect(r.outcome).toBe("written");
  expect(briefCalls().length).toBe(1);
  const { system, prompt } = briefCalls()[0]!;
  expect(system).toContain("Anna");
  expect(system).toContain(`${briefs.FIRST_WORDS} words at most`);
  expect(system).toContain("ask no question");
  expect(prompt).toContain("Write the brief");
  expect(prompt).toContain("Blood tests and cholesterol");
  expect(prompt).toContain("My LDL came back at 160");
  expect(prompt).toContain("Ferritin at 12");
  expect(prompt).not.toContain("insulate the floor"); // dom-house's conversation
  expect(prompt).not.toContain("Ben's blood tests"); // Ben's
  expect(prompt).not.toContain("A thread Maurice closed"); // no user turn
  // Oldest first in the prompt.
  expect(prompt.indexOf("My cholesterol results")).toBeLessThan(prompt.indexOf("Iron and ferritin"));

  const b = briefs.getBrief("dom-health", ANNA)!;
  expect(b.text).toBe(reply.text);
  expect(b.sources).toEqual(["c-bound", "c-free"]);
  expect(b.read_until).toBe("2026-09-12 09:02:00");
  expect(b.model).toBe(NIGHT);

  // Charged to the night, not to Anna — the brief and its one-liner both.
  expect(budget.usageFor(budget.SYSTEM_SPENDER).today_usd).toBeCloseTo(0.004, 6);
  expect(budget.spentTodayUsd(ANNA)).toBe(0);
  const row = db.query(`SELECT user_id, model FROM spend_ledger ORDER BY id DESC LIMIT 1`).get() as any;
  expect(row).toEqual({ user_id: "system", model: NIGHT });
});

test("a night with nothing new makes no call and changes nothing", async () => {
  const before = briefs.getBrief("dom-health", ANNA)!;
  const r = await briefs.refreshBrief(health(), ANNA);
  expect(r.outcome).toBe("unchanged");
  expect(requests.length).toBe(0);
  expect(briefs.getBrief("dom-health", ANNA)).toEqual(before);
  expect(budget.usageFor(budget.SYSTEM_SPENDER).today_usd).toBe(0);
});

test("the incremental path reads only what came after, with the previous brief in hand", async () => {
  const previous = briefs.getBrief("dom-health", ANNA)!.text;
  say("c-bound", "user", "Follow-up: the statin is prescribed, 10 mg.", "2026-09-15 11:00:00");
  say("c-bound", "assistant", "Noted; the usual check is at three months.", "2026-09-15 11:01:00");
  reply.text = "On 15 September you were prescribed a statin at 10 mg; the check is in three months.\n\nFerritin: supplements discussed on 12 September.";
  const r = await briefs.refreshBrief(health(), ANNA);
  expect(r.outcome).toBe("written");
  expect(briefCalls().length).toBe(1);
  const { system, prompt } = briefCalls()[0]!;
  expect(system).toContain(`${briefs.INCREMENTAL_WORDS} words at most`);
  expect(prompt).toContain("Rewrite the brief");
  expect(prompt).toContain(previous);
  expect(prompt).toContain("the statin is prescribed");
  expect(prompt).not.toContain("My LDL came back at 160"); // read last time
  expect(prompt).not.toContain("Ferritin at 12"); // nothing new there
  const b = briefs.getBrief("dom-health", ANNA)!;
  expect(b.text).toBe(reply.text);
  expect(b.sources).toEqual(["c-bound"]);
  expect(b.read_until).toBe("2026-09-15 11:01:00");
});

test("the output is capped, and a brief cut by the token ceiling is not kept", async () => {
  // capWords: past twice the asked length, cut at a paragraph, else a sentence.
  const para = Array.from({ length: 50 }, (_, i) => `Paragraph ${i} has exactly six words here.`).join("\n\n");
  const capped = briefs.capWords(para, 100);
  expect(capped.split(/\s+/).length).toBeLessThanOrEqual(200);
  expect(capped.endsWith("here.")).toBe(true);
  expect(briefs.capWords("short enough", 100)).toBe("short enough");
  const oneLine = Array.from({ length: 300 }, (_, i) => `w${i}`).join(" ") + ". Then more words.";
  expect(briefs.capWords(oneLine, 100).split(/\s+/).length).toBeLessThanOrEqual(200);

  // Through the service: a runaway reply is stored cut.
  say("c-free", "user", "Ferritin re-tested: 30 now.", "2026-09-16 09:00:00");
  reply.text = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} says something about ferritin and iron.`).join(" ");
  expect((await briefs.refreshBrief(health(), ANNA)).outcome).toBe("written");
  expect(briefs.getBrief("dom-health", ANNA)!.text.split(/\s+/).length).toBeLessThanOrEqual(briefs.INCREMENTAL_WORDS * 2);

  // A reply that hit max_tokens is a failure, and the previous brief stays.
  const kept = briefs.getBrief("dom-health", ANNA)!;
  say("c-free", "user", "And B12 is fine.", "2026-09-17 09:00:00");
  reply = { text: "half a brief", stop: "max_tokens", cost: 0.003 };
  const r = await briefs.refreshBrief(health(), ANNA);
  expect(r.outcome).toBe("failed");
  expect(r.error).toContain("token ceiling");
  expect(briefs.getBrief("dom-health", ANNA)).toEqual(kept);
  // The failed call still cost money, and the ledger says so. Three calls in
  // all: the brief that was written and its one-liner, then the brief that hit
  // the ceiling — which fails before any summary is asked for.
  expect(budget.usageFor(budget.SYSTEM_SPENDER).today_usd).toBeCloseTo(0.007, 6);
});

test("a written brief gets its one-liner, and a member's correction drops it", async () => {
  db.run(`DELETE FROM domain_briefs`);
  reply.text = "You had your LDL measured on 10 September: 160.\n\nFerritin is low.";
  await briefs.refreshBrief(health(), ANNA);
  expect(summaryCalls().length).toBe(1);
  // It is asked for the brief that was just written, and in the member's language.
  expect(summaryCalls()[0]!.prompt).toContain("Domain: Health");
  expect(summaryCalls()[0]!.prompt).toContain("LDL measured on 10 September");
  const stored = briefs.getBrief("dom-health", ANNA)!;
  expect(stored.summary).toBeTruthy();
  // The index shows the summary rather than the brief's opening.
  const line = briefs.indexLine({ name: "Health", text: stored.text, updated_at: stored.updated_at, model: stored.model, summary: stored.summary });
  expect(line).toBe(stored.summary);

  // The member rewrites the brief by hand: the old one-liner described the old
  // text, so it goes, and the index falls back to their own opening words.
  briefs.setBriefText("dom-health", ANNA, "Actually the only thing that matters is the statin. Nothing else is live.");
  const mine = briefs.getBrief("dom-health", ANNA)!;
  expect(mine.summary).toBeNull();
  expect(briefs.indexLine({ name: "Health", text: mine.text, updated_at: mine.updated_at, model: mine.model, summary: null }))
    .toContain("Actually the only thing that matters is the statin.");
});

test("the night's allowance stops the call before it is made, and is nobody's cap", async () => {
  say("c-free", "user", "Vitamin D too.", "2026-09-18 09:00:00");
  budget.recordSpend(usage(0.05), budget.SYSTEM_SPENDER);
  budget.setSystemDailyCap(0.04);
  const r = await briefs.refreshBrief(health(), ANNA);
  expect(r.outcome).toBe("capped");
  expect(r.error).toContain("night's work");
  expect(requests.length).toBe(0);
  // Anna's own turns are not under the night's cap, and the night is not under hers.
  expect(budget.verdict("scaleway", NIGHT, 0, ANNA).ok).toBe(true);
  budget.setSystemDailyCap(null);
  budget.setMemberDailyCap(ANNA, 0);
  expect(budget.verdict("scaleway", NIGHT, 0, budget.SYSTEM_SPENDER).ok).toBe(true);
  budget.setMemberDailyCap(ANNA, null);
  // Lifted, the same material is written.
  expect((await briefs.refreshBrief(health(), ANNA)).outcome).toBe("written");
});

test("the night iterates every member's domains, skips guests, and records what it did", async () => {
  db.run(`DELETE FROM domain_briefs`);
  const outcome = await briefs.runDomainBriefs();
  expect(outcome).toBe("done");
  const s = briefs.briefsNightlyStatus();
  expect(s.last_outcome).toBe("done");
  expect(s.last_stats).toEqual({ members: 1, domains: 2, written: 2, unchanged: 0, failed: 0, cost_usd: 0.004 });
  expect(briefs.getBrief("dom-health", ANNA)).not.toBeNull();
  expect(briefs.getBrief("dom-house", ANNA)).not.toBeNull();
  expect(briefs.getBrief("dom-guest", GUEST)).toBeNull();
  expect(s.running).toBe(false);
  expect(s.last_error).toBeNull();

  // The next night: nothing new, no call.
  requests = [];
  expect(await briefs.runDomainBriefs()).toBe("done");
  expect(requests.length).toBe(0);
  expect(briefs.briefsNightlyStatus().last_stats?.unchanged).toBe(2);
});

test("a night that hits the allowance stops there and says so", async () => {
  db.run(`DELETE FROM domain_briefs`);
  budget.recordSpend(usage(0.05), budget.SYSTEM_SPENDER);
  budget.setSystemDailyCap(0.04);
  expect(await briefs.runDomainBriefs()).toBe("capped");
  const s = briefs.briefsNightlyStatus();
  expect(s.last_outcome).toBe("capped");
  expect(s.last_stats?.written).toBe(0);
  expect(s.last_error).toContain("allowance");
  expect(requests.length).toBe(0);
});

test("off under test, and due an hour after the corpus", async () => {
  const { isDue } = await import("../src/services/corpusNightly");
  expect(briefs.briefsNightlyOn()).toBe(false);
  const at = (h: number) => new Date(2026, 8, 19, h, 5);
  expect(isDue(at(3), null, 4)).toBe(false);
  expect(isDue(at(4), null, 4)).toBe(true);
});
