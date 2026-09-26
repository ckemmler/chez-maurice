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

test("the message: what the box holds, the real exchanges, what reading gives, the nights in words, the question — no money, nobody", () => {
  const fr = plain(opener.renderMailOpening({ locale: "fr", estimate: est }));
  expect(fr).toBe(
    "J'ai relevé les en-têtes de ta boîte : 164 194 messages en tout, dont 134 488 lettres d'information et notifications.\n\n" +
      "Sur les 3 dernières années, j'y compte 466 vrais échanges.\n\n" +
      "Je peux les lire, sur trois ou quatre nuits, et te dire qui compte pour toi et ce qui est en cours.\n\n" +
      "Je lis ? Oui ou non.",
  );
  const en = plain(opener.renderMailOpening({ locale: "en", estimate: est }));
  expect(en).toContain("164,194 messages in all, 134,488 of them newsletters and notifications");
  expect(en).toContain("I count 466 real exchanges");
  expect(en).toContain("over three or four nights");
  expect(en).toContain("Shall I read them? Yes or no.");
  expect(opener.mailOpeningTitle("fr")).toBe("Ta boîte mail, en chiffres");
  // Never "tomorrow morning": more than ten nights are digits, still a range.
  expect(plain(opener.renderMailOpening({ locale: "fr", estimate: { ...est, nights: { low: 12, high: 13 } } }))).toContain("sur 12 ou 13 nuits");
  // No name, no address, no subject — and no euro, no token.
  for (const text of [fr, en]) expect(text).not.toMatch(/@|facebook|uber|€|token/i);
});

test("nothing to read, said so; the cost line is for the log alone", () => {
  const nothing = opener.renderMailOpening({ locale: "de", estimate: { ...est, to_read: 0, tokens: null, nights: { low: 0, high: 0 } } });
  expect(nothing).toContain("In den letzten 3 Jahren finde ich keinen echten Wechsel zum Lesen.");
  expect(nothing).not.toContain("Ja oder nein");
  expect(opener.describeCost(null)).toBe("cost: unpriced model");
  expect(opener.describeCost({ low: 0.0123, high: 0.87, light_model: "x", full_model: "y" })).toBe("cost: 0.012–0.870 € (x → y)");
});

test("every language renders, with its own number format", () => {
  for (const locale of Object.keys(opener.MAIL_OPENER_STRINGS)) {
    const text = opener.renderMailOpening({ locale, estimate: est });
    expect(text.split("\n\n")).toHaveLength(4);
    expect(text).toContain(opener.formatCount(164194, locale));
    expect(text).toContain(opener.mailOpenerStrings(locale).question);
  }
  expect(plain(opener.formatEuros(0.001, "fr"))).toBe("0,01 €"); // never "0 €"
});
