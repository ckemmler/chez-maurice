/**
 * The context-window planner: pure arithmetic over message shapes, no DB.
 * Run with `bun test`.
 */

import { describe, expect, test } from "bun:test";
import { estimateMessage, historyBudget, planDrop, replyReserve } from "../src/services/contextWindow";

const text = (role: string, chars: number) => ({
  role,
  content: [{ type: "text", text: "x".repeat(chars) }],
});

// 100 turns of 3,000 chars ≈ 1,000 tokens each, then the live user turn and
// the time reminder that always ride at the tail.
function conversation(turns: number, chars = 3000) {
  const out: { role: string; content: unknown }[] = [];
  for (let i = 0; i < turns; i++) out.push(text(i % 2 === 0 ? "user" : "assistant", chars));
  out.push(text("user", 60));
  out.push(text("user", 200)); // the clock
  return out;
}

describe("estimateMessage", () => {
  test("text scales with length; an image is a flat charge; a PDF with its size", () => {
    expect(estimateMessage(text("user", 3000))).toBe(1004);
    expect(estimateMessage({ content: "abc" })).toBe(5);
    expect(
      estimateMessage({ content: [{ type: "image", source: { type: "base64", data: "…" } }] }),
    ).toBe(1604);
    const pdf = estimateMessage({
      content: [{ type: "document", source: { type: "base64", data: "p".repeat(160_000) } }],
    });
    expect(pdf).toBeGreaterThan(4000);
    expect(pdf).toBeLessThan(6000);
  });
});

describe("replyReserve", () => {
  test("a household max_tokens sized for the cloud does not swallow a 32k local window", () => {
    // The household's 32k max_tokens against Ollama's 32,768-token request.
    expect(replyReserve(32_768, 32_000)).toBe(8_192);
    const budget = { contextTokens: 32_768, headTokens: 5_000, replyTokens: replyReserve(32_768, 32_000) };
    expect(historyBudget(budget)).toBeGreaterThan(12_000);
    // On a big window the household figure stands.
    expect(replyReserve(200 * 1024, 32_000)).toBe(32_000);
  });
});

describe("planDrop", () => {
  const budget = { contextTokens: 32_000, headTokens: 5_000, replyTokens: 4_000 };

  test("nothing to drop while the conversation fits", () => {
    expect(planDrop(conversation(10), budget)).toBe(0);
  });

  test("over the line it cuts back well below the budget, not just under it", () => {
    const msgs = conversation(40); // ~40k tokens against ~19.8k allowed
    const drop = planDrop(msgs, budget);
    expect(drop).toBeGreaterThan(0);
    const kept = msgs.slice(drop);
    const keptTokens = kept.reduce((a, m) => a + estimateMessage(m), 0);
    const allowed = historyBudget(budget);
    expect(keptTokens).toBeLessThanOrEqual(allowed * 0.7);
    // …and not gratuitously: at most one extra message goes to land the window
    // on a user turn, so the exchange before the cut would have crossed the target.
    const twoMore = keptTokens + estimateMessage(msgs[drop - 1]!) + estimateMessage(msgs[drop - 2]!);
    expect(twoMore).toBeGreaterThan(allowed * 0.7);
  });

  test("the window opens on a user turn", () => {
    const msgs = conversation(40);
    const drop = planDrop(msgs, budget);
    expect(msgs[drop]!.role).toBe("user");
    // Force a cut that would otherwise land on an assistant turn: an
    // assistant message tiny enough that the loop stops right after it.
    const skewed = [text("user", 6000), text("assistant", 30), ...conversation(30).slice(0)];
    const d = planDrop(skewed, budget);
    expect(skewed[d]!.role).toBe("user");
  });

  test("the live turn and the clock are never dropped, even when alone they overflow", () => {
    const tiny = { contextTokens: 8_000, headTokens: 7_000, replyTokens: 2_000 };
    const msgs = conversation(6);
    expect(historyBudget(tiny)).toBeLessThan(0);
    expect(planDrop(msgs, tiny)).toBe(msgs.length - 2);
  });

  test("a subsequent turn inside the window drops nothing more (hysteresis)", () => {
    const msgs = conversation(40);
    const drop = planDrop(msgs, budget);
    const next = [...msgs.slice(drop, -2), text("assistant", 3000), text("user", 60), text("user", 200)];
    expect(planDrop(next, budget)).toBe(0);
  });
});
