// The spending fuse. What matters here is not arithmetic — it is that each way
// the fuse could silently fail to blow is nailed down by a test.

import { test, expect, beforeEach, afterEach } from "bun:test";

const ENV = ["MAURICE_SPEND_CAP_USD", "MAURICE_SPEND_CAP_DAILY_USD"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  // Importing budget is what creates the ledger table, so it has to come first.
  await import("../src/services/budget");
  const db = (await import("../src/db")).default;
  db.run("DELETE FROM spend_ledger");
});

afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
});

async function budget() {
  return await import("../src/services/budget");
}

function turn(cost: number | null, model = "claude-sonnet-5", provider = "anthropic") {
  return {
    provider,
    model,
    rounds: 1,
    input: 1000,
    output: 100,
    cache_read: 0,
    cache_write: 0,
    cost,
    cost_uncached: cost,
  };
}

test("uncapped by default: no env, no opinion", async () => {
  const b = await budget();
  expect(b.capped()).toBe(false);
  expect(b.verdict("anthropic", "claude-sonnet-5").ok).toBe(true);
  // An unpriced model is fine when nobody is capping anything.
  expect(b.verdict("scaleway", "some-unknown-model").ok).toBe(true);
});

test("a total cap blows once the ledger passes it", async () => {
  const b = await budget();
  process.env.MAURICE_SPEND_CAP_USD = "1.00";

  b.recordSpend(turn(0.6));
  expect(b.verdict("anthropic", "claude-sonnet-5").ok).toBe(true);

  b.recordSpend(turn(0.5));
  const v = b.verdict("anthropic", "claude-sonnet-5");
  expect(v.ok).toBe(false);
  expect(v.reason).toContain("allowance");
});

test("the turn in progress counts before it is persisted", async () => {
  const b = await budget();
  process.env.MAURICE_SPEND_CAP_USD = "1.00";
  b.recordSpend(turn(0.9));

  // Ledger says 0.90, under the cap — but this turn has already run up 0.20
  // across its earlier agentic rounds. Without pendingUsd the fuse never blows
  // until the turn ends, which is exactly the runaway we are guarding against.
  expect(b.verdict("anthropic", "claude-sonnet-5", 0).ok).toBe(true);
  expect(b.verdict("anthropic", "claude-sonnet-5", 0.2).ok).toBe(false);
});

test("an unpriced model is refused under a cap, never waved through", async () => {
  const b = await budget();
  process.env.MAURICE_SPEND_CAP_USD = "10.00";
  const v = b.verdict("scaleway", "some-unknown-model");
  expect(v.ok).toBe(false);
  expect(v.reason).toContain("no price on file");
});

test("an unpriced turn cannot quietly cost zero", async () => {
  const b = await budget();
  process.env.MAURICE_SPEND_CAP_USD = "1.00";
  // pricing.ts returns cost: null for a model it cannot price. If that landed
  // in the ledger as a 0 the fuse would never blow for that model.
  b.recordSpend(turn(null, "some-unknown-model", "scaleway"));
  expect(b.spentTotalUsd()).toBe(0);
  // ...which is why the verdict refuses it outright instead.
  expect(b.verdict("scaleway", "some-unknown-model").ok).toBe(false);
});

test("a local model is free, and stays usable at the cap", async () => {
  const b = await budget();
  process.env.MAURICE_SPEND_CAP_USD = "1.00";
  b.recordSpend(turn(5.0));
  expect(b.verdict("anthropic", "claude-sonnet-5").ok).toBe(false);
  // Ollama is billed to nobody, so no cap applies — decided by provider, the
  // same way priceUsage decides it.
  expect(b.verdict("ollama", "llama3.2").ok).toBe(true);
});

test("the daily cap is independent of the total", async () => {
  const b = await budget();
  process.env.MAURICE_SPEND_CAP_DAILY_USD = "0.50";
  b.recordSpend(turn(0.6));
  const v = b.verdict("anthropic", "claude-sonnet-5");
  expect(v.ok).toBe(false);
  expect(v.reason).toContain("daily");
});

test("remaining headroom is the tightest of the caps", async () => {
  const b = await budget();
  process.env.MAURICE_SPEND_CAP_USD = "10.00";
  process.env.MAURICE_SPEND_CAP_DAILY_USD = "1.00";
  b.recordSpend(turn(0.25));
  expect(b.verdict("anthropic", "claude-sonnet-5").remainingUsd).toBeCloseTo(0.75, 5);
});

test("a nonsense cap is ignored rather than obeyed", async () => {
  const b = await budget();
  process.env.MAURICE_SPEND_CAP_USD = "not-a-number";
  expect(b.caps().totalUsd).toBe(null);
  expect(b.verdict("anthropic", "claude-sonnet-5").ok).toBe(true);
});
