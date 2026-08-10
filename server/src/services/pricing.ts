// What a turn cost, and what it would have cost without the cache.
//
// The numbers here are list prices in USD per million tokens. They are a local
// copy of a published price sheet, so they drift: treat a missing entry as
// "unpriced" (cost comes back null and the apps show tokens only) rather than
// guessing. Never let an unknown model silently price at zero — a zero reads as
// "this was free", which is the one wrong answer.

export interface ModelPrice {
  /** USD per million uncached input tokens. */
  input: number;
  /** USD per million output tokens. */
  output: number;
  /** Multiplier on `input` for tokens written to the cache. */
  cacheWrite: number;
  /** Multiplier on `input` for tokens served from the cache. */
  cacheRead: number;
}

// Anthropic's cache pricing is uniform across the family: a write costs 1.25x a
// normal input token (5-minute TTL; the 1-hour TTL is 2x, which we don't use),
// and a read costs 0.1x. Both are expressed as multipliers so a price change
// only has to be made in one place.
const ANTHROPIC_CACHE = { cacheWrite: 1.25, cacheRead: 0.1 };

/** List prices per million tokens. Keys are bare model ids — a dated snapshot
 *  id (`...-20251001`) resolves to its base entry, see `priceFor`. */
const PRICES: Record<string, ModelPrice> = {
  // Anthropic — https://platform.claude.com/docs/en/pricing
  "claude-opus-5": { input: 5, output: 25, ...ANTHROPIC_CACHE },
  "claude-opus-4-8": { input: 5, output: 25, ...ANTHROPIC_CACHE },
  "claude-opus-4-7": { input: 5, output: 25, ...ANTHROPIC_CACHE },
  "claude-opus-4-6": { input: 5, output: 25, ...ANTHROPIC_CACHE },
  // Sonnet 5 carries an introductory rate of $2/$10 through 2026-08-31, after
  // which it is the $3/$15 below. Deliberately priced at the standard rate: a
  // cost meter that reads high is an annoyance, one that reads low is a false
  // reassurance, and the intro rate would silently become the wrong number the
  // moment it lapsed. Over the intro period this overstates by half.
  "claude-sonnet-5": { input: 3, output: 15, ...ANTHROPIC_CACHE },
  "claude-sonnet-4-6": { input: 3, output: 15, ...ANTHROPIC_CACHE },
  "claude-sonnet-4-5": { input: 3, output: 15, ...ANTHROPIC_CACHE },
  "claude-haiku-4-5": { input: 1, output: 5, ...ANTHROPIC_CACHE },

  // Mistral — https://mistral.ai/news/mistral-medium-3 (medium tier: $0.40/$2.00).
  // Cached input bills at 0.1x like Anthropic's; unlike Anthropic there is no
  // documented write premium, so a write is priced as ordinary input. Verify
  // both against https://mistral.ai/pricing before trusting the figure.
  "mistral-medium-latest": { input: 0.4, output: 2, cacheWrite: 1, cacheRead: 0.1 },

  // OpenAI is deliberately absent until someone checks its current sheet — an
  // unpriced model shows token counts with no dollar figure, which is honest; a
  // wrong figure is worse than none. Local (Ollama) models are never priced:
  // they cost nothing per token.
};

/** Look up a model's prices, tolerating dated snapshot ids. Null = unpriced. */
export function priceFor(modelId: string): ModelPrice | null {
  if (PRICES[modelId]) return PRICES[modelId]!;
  // `claude-haiku-4-5-20251001` → `claude-haiku-4-5`
  const base = modelId.replace(/-\d{8}$/, "");
  return PRICES[base] ?? null;
}

/** Token counts for one assistant turn, summed across its agentic rounds. */
export interface TurnUsage {
  provider: string;
  model: string;
  /** Rounds of the agentic loop this turn took (1 = answered without tools). */
  rounds: number;
  /** Input tokens billed at full price (neither read from nor written to cache). */
  input: number;
  output: number;
  /** Tokens served from the cache — the signal that caching is biting. */
  cache_read: number;
  /** Tokens written to the cache this turn (billed at a premium). */
  cache_write: number;
  /** USD actually spent, or null when the model has no price entry. */
  cost: number | null;
  /** USD the same turn would have cost with no cache at all, or null when
   *  unpriced. Compare against `cost` to see what caching saved. */
  cost_uncached: number | null;
}

/** Empty accumulator for a turn on the given model. */
export function newUsage(provider: string, model: string): TurnUsage {
  return {
    provider,
    model,
    rounds: 0,
    input: 0,
    output: 0,
    cache_read: 0,
    cache_write: 0,
    cost: null,
    cost_uncached: null,
  };
}

/** Fill in `cost` / `cost_uncached` from the accumulated token counts. Local
 *  models are free rather than unpriced — the distinction matters to the UI. */
export function priceUsage(u: TurnUsage): TurnUsage {
  if (u.provider === "ollama") {
    u.cost = 0;
    u.cost_uncached = 0;
    return u;
  }
  const p = priceFor(u.model);
  if (!p) {
    u.cost = null;
    u.cost_uncached = null;
    return u;
  }
  const per = (tokens: number, rate: number) => (tokens / 1_000_000) * rate;
  u.cost =
    per(u.input, p.input) +
    per(u.output, p.output) +
    per(u.cache_write, p.input * p.cacheWrite) +
    per(u.cache_read, p.input * p.cacheRead);
  // The counterfactual: every cached token re-read at full input price, and no
  // write premium paid. This is what the turn cost before caching existed.
  u.cost_uncached =
    per(u.input + u.cache_read + u.cache_write, p.input) + per(u.output, p.output);
  return u;
}

/** True when the turn recorded anything worth showing. */
export function hasUsage(u: TurnUsage): boolean {
  return u.input > 0 || u.output > 0 || u.cache_read > 0 || u.cache_write > 0;
}
