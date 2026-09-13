import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// A conversation loaded as context: short ones ride whole; long ones are
// summarised by the composer, the summary keyed on a hash of the transcript.
// Continue the thread and the hash moves: the summary reads as stale, the new
// messages ride along verbatim, and a fresh summary is generated.

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "maurice-summary-"));
// Files in one `bun test` run share the module cache — and so the database
// the first of them pointed db.ts at. Claim the data dir only if nobody has,
// and leave it to the OS: a later file may still be using it.
process.env.MAURICE_DATA_DIR ??= TMP;

let db: any;
let cs: typeof import("../src/services/composer/conversationSummary");
let specs: typeof import("../src/services/composer/specs");
let weights: typeof import("../src/services/composer/weights");
let addMessage: typeof import("../src/services/conversations").addMessage;

let generated = 0;
const LONG = "lorem ipsum dolor sit amet ".repeat(300); // ~8k chars → ~2k tokens per message

beforeAll(async () => {
  db = (await import("../src/db")).default;
  cs = await import("../src/services/composer/conversationSummary");
  specs = await import("../src/services/composer/specs");
  weights = await import("../src/services/composer/weights");
  ({ addMessage } = await import("../src/services/conversations"));
  cs.setSummaryGenerator(async ({ title, transcript }) => {
    generated += 1;
    return `SUMMARY#${generated} of "${title}" (${transcript.length} chars)`;
  });
  db.run(`INSERT INTO users (id, username, display_name) VALUES ('alice', 'alice', 'Alice')`);
  db.run(`INSERT INTO users (id, username, display_name) VALUES ('bob', 'bob', 'Bob')`);
  for (const [id, title] of [["short", "A short one"], ["long", "A long one"]]) {
    db.run(`INSERT INTO conversations (id, user_id, title) VALUES (?, 'alice', ?)`, [id, title]);
    db.run(`INSERT INTO conversation_participants (conversation_id, member_id, role) VALUES (?, 'alice', 'owner')`, [id]);
  }
  addMessage("short", "user", "Bonjour", { authorId: "alice" });
  addMessage("short", "assistant", "Bonjour Alice.");
  for (let i = 0; i < 6; i++) {
    addMessage("long", "user", `Q${i} ${LONG}`, { authorId: "alice" });
    addMessage("long", "assistant", `A${i} ${LONG}`);
  }
});

afterAll(() => cs.setSummaryGenerator(null));

describe("conversationContext", () => {
  it("loads a short conversation whole, without scheduling anything", async () => {
    const ctx = cs.conversationContext("short");
    expect(ctx.representation).toBe("full");
    expect(ctx.summarisable).toBe(false);
    expect(ctx.summary).toBe("none");
    expect(ctx.text).toBe("Alice: Bonjour\n\nMaurice: Bonjour Alice.");
    await cs.whenSummariesSettled();
    expect(generated).toBe(0);
  });

  it("falls back to the transcript while the first summary is pending, then loads the summary", async () => {
    const pending = cs.conversationContext("long");
    expect(pending.summarisable).toBe(true);
    expect(pending.fullWeight).toBeGreaterThan(cs.SUMMARY_THRESHOLD);
    expect(pending.representation).toBe("full");
    expect(pending.summary).toBe("pending");
    expect(pending.count).toBe(12);

    await cs.whenSummariesSettled();
    expect(generated).toBe(1);
    const ready = cs.conversationContext("long");
    expect(ready.representation).toBe("summary");
    expect(ready.summary).toBe("ready");
    expect(ready.text).toStartWith('SUMMARY#1 of "A long one"');
    expect(ready.weight).toBeLessThan(ready.fullWeight);
    expect(ready.hash).toBe(pending.hash);
  });

  it("does not regenerate while the transcript is unchanged", async () => {
    cs.conversationContext("long");
    await cs.ensureSummary("long");
    await cs.whenSummariesSettled();
    expect(generated).toBe(1);
  });

  it("a continued conversation changes the hash: stale summary + tail, then a fresh one", async () => {
    const before = cs.conversationContext("long").hash;
    addMessage("long", "user", "Et une dernière question ?", { authorId: "alice" });
    addMessage("long", "assistant", "Voici la dernière réponse.");
    const stale = cs.conversationContext("long");
    expect(stale.hash).not.toBe(before);
    expect(stale.summary).toBe("stale");
    expect(stale.representation).toBe("summary");
    expect(stale.uncovered).toBe(2);
    expect(stale.text).toStartWith("SUMMARY#1");
    expect(stale.text).toContain("Alice: Et une dernière question ?");
    expect(stale.text).toContain("Maurice: Voici la dernière réponse.");
    expect(stale.text).not.toContain("Q0 lorem");

    await cs.whenSummariesSettled();
    expect(generated).toBe(2);
    const fresh = cs.conversationContext("long");
    expect(fresh.summary).toBe("ready");
    expect(fresh.text).toStartWith("SUMMARY#2");
    expect(fresh.text).not.toContain("dernière question");
  });

  it("representation: full pins the transcript even when long", () => {
    const ctx = cs.conversationContext("long", true);
    expect(ctx.representation).toBe("full");
    expect(ctx.summary).toBe("none");
    expect(ctx.weight).toBe(ctx.fullWeight);
    expect(ctx.text).toContain("Q0 lorem");
  });

  it("coalesces concurrent generations for the same conversation", async () => {
    db.run(`DELETE FROM conversation_summaries WHERE conversation_id = 'long'`);
    const n = generated;
    const [a, b] = await Promise.all([cs.ensureSummary("long"), cs.ensureSummary("long")]);
    expect(generated).toBe(n + 1);
    expect(a?.summary).toBe(b?.summary);
  });
});

describe("the composer", () => {
  it("accepts representation on a conversation item, and only summary|full", () => {
    expect(weights.validateItems([{ type: "conversation", id: "long", representation: "full" }])).toEqual([]);
    expect(weights.validateItems([{ type: "conversation", id: "long" }])).toEqual([]);
    expect(weights.validateItems([{ type: "conversation", id: "long", representation: "brief" }]).length).toBe(1);
    expect(weights.validateItems([{ type: "conversation", id: "long", recurse: true }]).length).toBe(1);
  });

  it("weighs the summary, and reports the transcript's own weight beside it", async () => {
    await cs.whenSummariesSettled();
    const w = weights.weighItems("alice", [
      { type: "conversation", id: "long" },
      { type: "conversation", id: "long", representation: "full" },
      { type: "conversation", id: "short" },
    ]);
    const [sum, full, short] = w.items;
    expect(sum.representation).toBe("summary");
    expect(sum.summary).toBe("ready");
    expect(sum.summarisable).toBe(true);
    expect(sum.weight).toBeLessThan(sum.fullWeight!);
    expect(full.representation).toBe("full");
    expect(full.weight).toBe(full.fullWeight);
    expect(short.summarisable).toBe(false);
    expect(short.summary).toBe("none");
  });

  it("refuses a conversation the member is not in", () => {
    const w = weights.weighItems("bob", [{ type: "conversation", id: "long" }]);
    expect(w.items[0].missing).toBe(true);
    expect(w.items[0].weight).toBe(0);
  });

  it("freezes the representation and the hash into the spec, and resolves the summary text", async () => {
    db.run(`INSERT INTO conversations (id, user_id, title) VALUES ('host', 'alice', 'Host')`);
    db.run(`INSERT INTO conversation_participants (conversation_id, member_id, role) VALUES ('host', 'alice', 'owner')`);
    const saved = specs.saveSpec("alice", "host", [{ type: "conversation", id: "long" }]);
    expect("errors" in saved).toBe(false);
    const item = (saved as any).spec.items[0];
    expect(item.snapshot.representation).toBe("summary");
    expect(item.snapshot.summary).toBe("ready");
    expect(item.snapshot.fullWeight).toBeGreaterThan(item.snapshot.weight);

    const resolved = specs.resolveToText("alice", "host");
    expect(resolved.items[0].text).toStartWith("SUMMARY#");
    expect(resolved.items[0].weight).toBe(item.snapshot.weight);

    const pinned = specs.saveSpec("alice", "host", [{ type: "conversation", id: "long", representation: "full" }]);
    expect((pinned as any).spec.items[0].snapshot.representation).toBe("full");
    expect(specs.resolveToText("alice", "host").items[0].text).toContain("Q0 lorem");
  });
});
