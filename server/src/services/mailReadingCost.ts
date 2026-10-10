import { getModel, householdDefaultModel } from "./models";
import { newUsage, priceFor, priceUsage } from "./pricing";

// What reading a member's mailbox would cost — for the operator: the log
// and the console, never the member (Candide's direction, 26 September 2026:
// spending is abstract to a member and every app spares them the subject;
// the only ceiling is the household's). The member's "yes" is a consent to
// read, given on the card under Settings → Mail, which shows the volume and
// the time. Until 10 October 2026 this file also rendered the message of a
// conversation Maurice opened with the mailbox's numbers; he no longer
// opens one.

/** What `email__estimate_reading` answers, the part the price needs. */
export interface ReadingEstimate {
  years: number;
  messages: number;
  window: { messages: number; bulk: number; correspondence: number; other: number };
  to_read: number;
  tokens: { light: number; full: number } | null;
  nights: { low: number; high: number };
  /** All-time counts by kind (the triage's), when the caller has them. */
  all?: { bulk: number; correspondence: number; other: number };
}

export interface CostRange {
  low: number;
  high: number;
  /** The models the two bounds were priced on. */
  light_model: string;
  full_model: string;
}

// ── The price ────────────────────────────────────────────────────────────

/** The light pass reads the first characters of each message and answers
 *  in a few words, on the small Qwen (30 September 2026; the spec said
 *  mistral-small). It thinks before it answers, and its reasoning is billed as
 *  output: 100 tokens a message is a guess until a real reading measures it. */
export const LIGHT_MODEL = "qwen3.6-35b-a3b";
const LIGHT_OUTPUT_TOKENS_PER_MESSAGE = 100;
/** A full reading writes: a share of what it read, as output. */
const FULL_OUTPUT_SHARE = 0.1;

/** Euros for `tokens` in and `out` out on a model, from the price sheet.
 *  Null when the sheet does not know the model — never zero, which would
 *  read as free. An Ollama model is free by construction. */
export function eurosFor(model: string, tokensIn: number, tokensOut: number): number | null {
  const provider = getModel(model)?.provider ?? "";
  if (provider !== "ollama" && !priceFor(model)) return null;
  // priceUsage holds the sheet, the EUR rate and Ollama's zero: one place.
  const u = newUsage(provider, model);
  u.input = tokensIn;
  u.output = tokensOut;
  return priceUsage(u).cost;
}

/** Low: the light pass alone. High: the light pass, then every body read
 *  whole by the member's everyday model. Both from the calibration's tokens.
 *  For the operator — the log, the console — never for the member. */
export function readingCost(est: ReadingEstimate, fullModel: string = householdDefaultModel()): CostRange | null {
  if (!est.tokens) return null;
  const light = eurosFor(LIGHT_MODEL, est.tokens.light, est.to_read * LIGHT_OUTPUT_TOKENS_PER_MESSAGE);
  const full = eurosFor(fullModel, est.tokens.full, Math.round(est.tokens.full * FULL_OUTPUT_SHARE));
  if (light === null || full === null) return null;
  return { low: light, high: light + full, light_model: LIGHT_MODEL, full_model: fullModel };
}

/** One line for the log and the console: the operator's view of what a
 *  reading would cost. Never shown to the member. */
export function describeCost(cost: CostRange | null): string {
  if (!cost) return "cost: unpriced model";
  return `cost: ${cost.low.toFixed(3)}–${cost.high.toFixed(3)} € (${cost.light_model} → ${cost.full_model})`;
}
