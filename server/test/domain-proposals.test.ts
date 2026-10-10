/**
 * What the app's list shows of a proposal, the part that needs neither a
 * database row nor a model (services/domainProposals.ts): its weight on five
 * dots, its share of the member's conversations, one line of its summary.
 * They lived in services/domainOpener.ts until 10 October 2026, beside the
 * message Maurice no longer writes.
 */
import { expect, test } from "bun:test";

const proposals = await import("../src/services/domainProposals");

test("weight: five dots for the biggest, at least one for anything, a square root between", () => {
  expect(proposals.WEIGHT_DOTS).toBe(5);
  expect(proposals.weightOf(723, 723)).toBe(5);
  expect(proposals.weightOf(149, 723)).toBe(2);
  expect(proposals.weightOf(95, 723)).toBe(2);
  expect(proposals.weightOf(41, 723)).toBe(1);
  expect(proposals.weightOf(1, 723)).toBe(1);
  expect(proposals.weightOf(0, 723)).toBe(1);
  // Never more than five, whatever the list's biggest was thought to be.
  expect(proposals.weightOf(900, 723)).toBe(5);
  expect(proposals.weightOf(3, 0)).toBe(1);
});

test("share: a whole percentage, never zero for something", () => {
  expect(proposals.shareOf(723, 5046)).toBe(14);
  expect(proposals.shareOf(3, 5046)).toBe(1);
  expect(proposals.shareOf(0, 5046)).toBe(0);
  expect(proposals.shareOf(3, 0)).toBe(0);
});

test("one line: the first sentence, cut cleanly when long", () => {
  expect(proposals.oneLine("You practise and ask about technique. Lately the bow arm.")).toBe("You practise and ask about technique.");
  expect(proposals.oneLine("  Several   spaces\nand a line break, no period")).toBe("Several spaces and a line break, no period");
  const long = "A ".repeat(40) + "word ".repeat(40) + ". Next.";
  const cut = proposals.oneLine(long, 60);
  expect(cut.length).toBeLessThanOrEqual(60);
  expect(cut.endsWith("…")).toBe(true);
  expect(proposals.oneLine("")).toBe("");
});

test("a proposal weighs its conversations and its mail threads", () => {
  expect(proposals.sizeOf({ conversation_ids: ["a", "b"], mail: ["mail/x.md"] })).toBe(3);
  expect(proposals.sizeOf({ conversation_ids: [], mail: [] })).toBe(0);
});
