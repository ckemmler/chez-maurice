/**
 * The conversation with the mailbox numbers (services/mailOpener.ts): the
 * range priced from the calibration's tokens on the price sheet — the light
 * pass alone at the low end, the light pass and a full reading at the high
 * end, zero on Ollama, null when the sheet does not know the model — and the
 * message: four paragraphs in the member's language, every one a number or
 * the question, never a name. No model, no gateway.
 */
import { expect, test } from "bun:test";

const opener = await import("../src/services/mailOpener");
const { priceFor } = await import("../src/services/pricing");

/** Intl's narrow and regular no-break spaces, as plain ones, to compare. */
const plain = (s: string) => s.replace(/[\u202f\u00a0]/g, " ");

const est: opener.ReadingEstimate = {
  years: 3,
  messages: 164194,
  window: { messages: 2131, bulk: 1665, correspondence: 36, other: 430 },
  to_read: 466,
  tokens: { light: 60000, full: 900000 },
  nights: { low: 3, high: 4 },
  all: { bulk: 134488, correspondence: 19825, other: 9881 },
};

test("the range: the light pass at the low end, a full reading on top at the high end", () => {
  const cost = opener.readingCost(est, "mistral-medium-latest")!;
  expect(cost.low).toBeGreaterThan(0);
  expect(cost.high).toBeGreaterThan(cost.low);
  expect(cost.light_model).toBe(opener.LIGHT_MODEL);
  // The light pass: 60 000 tokens in on mistral-small plus 40 out per message.
  const small = priceFor(opener.LIGHT_MODEL)!;
  const expectedLow = ((60000 / 1e6) * small.input + ((466 * 40) / 1e6) * small.output) / 1.1537;
  expect(cost.low).toBeCloseTo(expectedLow, 6);
  // A model the sheet does not know is not priced at zero.
  expect(opener.readingCost(est, "some-unknown-model")).toBeNull();
  // Not calibrated: no range at all.
  expect(opener.readingCost({ ...est, tokens: null }, "mistral-medium-latest")).toBeNull();
});

test("the message: numbers, the range, the nights in words, the question — and nobody", () => {
  const cost = { low: 0.0123, high: 0.87, light_model: "x", full_model: "y" };
  const fr = plain(opener.renderMailOpening({ locale: "fr", estimate: est, cost }));
  expect(fr).toBe(
    "J'ai relevé les en-têtes de ta boîte : 164 194 messages, dont 19 825 de correspondance.\n\n" +
      "Sur les 3 dernières années : 2 131 messages, dont 36 de correspondance.\n\n" +
      "Les lire coûterait entre 0,02 € et 0,87 €, sur trois ou quatre nuits.\n\n" +
      "Je lis ? Oui ou non.",
  );
  const en = plain(opener.renderMailOpening({ locale: "en", estimate: est, cost }));
  expect(en).toContain("164,194 messages, 19,825 of them correspondence");
  expect(en).toContain("between €0.02 and €0.87, over three or four nights");
  expect(en).toContain("Shall I read them? Yes or no.");
  expect(opener.mailOpeningTitle("fr")).toBe("Ta boîte mail, en chiffres");
  // Never "tomorrow morning": more than ten nights are digits, still a range.
  expect(plain(opener.renderMailOpening({ locale: "fr", estimate: { ...est, nights: { low: 12, high: 13 } }, cost }))).toContain("sur 12 ou 13 nuits");
  // No name, no address, no subject.
  for (const text of [fr, en]) expect(text).not.toMatch(/@|facebook|uber/i);
});

test("free on Ollama, said so; unpriced, said so; nothing to read, said so", () => {
  const free = opener.renderMailOpening({ locale: "fr", estimate: est, cost: { low: 0, high: 0, light_model: "x", full_model: "y" } });
  expect(free).toContain("ne coûte rien sur ce foyer ; il faudrait trois ou quatre nuits");
  const unpriced = opener.renderMailOpening({ locale: "fr", estimate: est, cost: null });
  expect(unpriced).toContain("Je n'ai pas le prix du modèle");
  expect(unpriced).toContain("Je lis ? Oui ou non.");
  const nothing = opener.renderMailOpening({ locale: "de", estimate: { ...est, to_read: 0, tokens: null, nights: { low: 0, high: 0 } }, cost: null });
  expect(nothing).toContain("In diesem Zeitraum gibt es nichts zu lesen.");
  expect(nothing).not.toContain("Ja oder nein");
});

test("every language renders, with its own number format", () => {
  for (const locale of Object.keys(opener.MAIL_OPENER_STRINGS)) {
    const text = opener.renderMailOpening({ locale, estimate: est, cost: { low: 0.5, high: 1.5, light_model: "x", full_model: "y" } });
    expect(text.split("\n\n")).toHaveLength(4);
    expect(text).toContain(opener.formatCount(164194, locale));
    expect(text).toContain(opener.mailOpenerStrings(locale).question);
  }
  expect(plain(opener.formatEuros(0.001, "fr"))).toBe("0,01 €"); // never "0 €"
});
