/**
 * What reading a mailbox would cost (services/mailReadingCost.ts), for the
 * operator alone: the range priced from the calibration's tokens on the
 * price sheet — the light pass alone at the low end, the light pass and a
 * full reading at the high end, zero on Ollama, null when the sheet does not
 * know the model — and the one line the log carries. Nothing here renders a
 * message to the member any more. No model, no gateway.
 */
import { expect, test } from "bun:test";

const cost = await import("../src/services/mailReadingCost");
const { priceFor } = await import("../src/services/pricing");
const { addModel } = await import("../src/services/models");

const est: cost.ReadingEstimate = {
  years: 3,
  messages: 164194,
  window: { messages: 2131, bulk: 1665, correspondence: 36, other: 430 },
  to_read: 466,
  tokens: { light: 60000, full: 900000 },
  nights: { low: 3, high: 4 },
  all: { bulk: 134488, correspondence: 19825, other: 9881 },
};

test("the range: the light pass at the low end, a full reading on top at the high end", () => {
  const range = cost.readingCost(est, "mistral-medium-latest")!;
  expect(range.low).toBeGreaterThan(0);
  expect(range.high).toBeGreaterThan(range.low);
  expect(range.light_model).toBe(cost.LIGHT_MODEL);
  expect(range.full_model).toBe("mistral-medium-latest");
  // The light pass: 60 000 tokens in on the small Qwen plus 100 out per message.
  const small = priceFor(cost.LIGHT_MODEL)!;
  const expectedLow = ((60000 / 1e6) * small.input + ((466 * 100) / 1e6) * small.output) / 1.1537;
  expect(range.low).toBeCloseTo(expectedLow, 6);
  // A model the sheet does not know is not priced at zero.
  expect(cost.readingCost(est, "some-unknown-model")).toBeNull();
  // Not calibrated: no range at all.
  expect(cost.readingCost({ ...est, tokens: null }, "mistral-medium-latest")).toBeNull();
});

test("euros for a model: from the sheet, null when it is not on it, zero on Ollama", () => {
  expect(cost.eurosFor(cost.LIGHT_MODEL, 60000, 46600)).toBeCloseTo(cost.readingCost(est, "mistral-medium-latest")!.low, 9);
  expect(cost.eurosFor("some-unknown-model", 1000, 1000)).toBeNull();
  addModel({ id: "mrc-local:latest", name: "Local", tier: "local", vendor: "qwen", provider: "ollama" });
  expect(cost.eurosFor("mrc-local:latest", 1_000_000, 1_000_000)).toBe(0);
});

test("the cost line is for the log alone, and says when a model is not priced", () => {
  expect(cost.describeCost(null)).toBe("cost: unpriced model");
  expect(cost.describeCost({ low: 0.0123, high: 0.87, light_model: "x", full_model: "y" })).toBe("cost: 0.012–0.870 € (x → y)");
});

test("the member's message went with the conversation: nothing here renders one", () => {
  for (const gone of ["renderMailOpening", "mailOpenerStrings", "MAIL_OPENER_STRINGS", "mailOpeningTitle", "nightsPhrase", "formatCount", "formatEuros"]) {
    expect((cost as any)[gone], gone).toBeUndefined();
  }
});
