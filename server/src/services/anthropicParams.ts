/**
 * The request fields Anthropic's model generations disagree on.
 *
 * Tried against the API on 16 October 2026 (Opus 5, Opus 5.5, Sonnet 5.5):
 *
 * - **Temperature** is refused outright from Opus 4.7 on — Opus 5, Opus 5.5
 *   and Sonnet 5.5 all answer a 400 "`temperature` is deprecated for this
 *   model", whatever the thinking mode. A persona's creativity is therefore
 *   not sent to them; the older models still take it.
 * - **Turning reasoning off** takes three forms. Opus 5 and the 4.6+ family
 *   accept `thinking: {type: "disabled"}`. Sonnet 5.5 refuses it and wants
 *   `thinking: {type: "between_tools"}` instead. Opus 5.5 (and Fable) cannot
 *   turn it off at all — `disabled` and `between_tools` are both a 400 — so
 *   "answer directly" becomes the lowest effort, which is as close to off as
 *   the model goes.
 * - **Saying nothing** is not neutral on every model. Up to Opus 4.8 a request
 *   with no `thinking` field does not reason; from Opus 5 and Sonnet 5 on it
 *   reasons adaptively. So no choice, on those, is sent as "answer directly" —
 *   the same rule as Z.ai's GLM (see `thinkingBody` in claude.ts): reasoning
 *   is something a persona asks for, not something a model upgrade turns on.
 *
 * Unknown future ids fall through to the 4.6+ behaviour; the first 400 will
 * say which row they belong in.
 */

/** Models that refuse any `temperature`. */
const NO_TEMPERATURE = /^claude-(opus-4-[78]|opus-5|sonnet-5|haiku-5|fable|mythos)/;

/** Models that reason when the request says nothing about it. */
const THINKS_BY_DEFAULT = /^claude-(opus-5|sonnet-5|haiku-5|fable|mythos)/;

/** Models whose reasoning cannot be turned off: "off" is `effort: low`. */
const ALWAYS_THINKS = /^claude-(opus-5-5|fable|mythos)/;

/** Models that turn reasoning off with `between_tools`, not `disabled`. */
const BETWEEN_TOOLS = /^claude-sonnet-5-5/;

export function anthropicTakesTemperature(model: string): boolean {
  return !NO_TEMPERATURE.test(model);
}

/** The fields that carry a reasoning choice to this model, merged into the
 *  request body as-is: adaptive when asked for, the model's own form of "off"
 *  when declined — or when no choice was made and the model would otherwise
 *  reason (see above). Nothing on the older models when no choice was made. */
export function anthropicThinking(model: string, thinking: boolean | undefined): Record<string, unknown> | undefined {
  if (thinking === true) return { thinking: { type: "adaptive" } };
  if (thinking === undefined && !THINKS_BY_DEFAULT.test(model)) return undefined;
  if (ALWAYS_THINKS.test(model)) return { output_config: { effort: "low" } };
  if (BETWEEN_TOOLS.test(model)) return { thinking: { type: "between_tools" } };
  return { thinking: { type: "disabled" } };
}
