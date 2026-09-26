// The spending fuse. What matters here is not arithmetic — it is that each way
// the fuse could silently fail to blow is nailed down by a test.

import { test, expect, beforeEach, afterEach } from "bun:test";

const ENV = ["MAURICE_SPEND_CAP_USD", "MAURICE_SPEND_CAP_DAILY_USD"] as const;
const saved: Record<string, string | undefined> = {};

// Two members, so a cap on one can be shown not to touch the other.
const ANNA = "budget-anna";
const BEN = "budget-ben";

beforeEach(async () => {
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  // Importing budget is what creates the ledger table, so it has to come first.
  await import("../src/services/budget");
  const db = (await import("../src/db")).default;
  db.run("DELETE FROM spend_ledger");
  // The stored caps outlive a test as surely as the ledger does.
  db.run("UPDATE households SET spend_cap_daily_usd = NULL WHERE id = 'default'");
  for (const [id, name] of [[ANNA, "Anna"], [BEN, "Ben"]] as const) {
    db.run(
      `INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES (?, ?, ?, 'standard')`,
      [id, id, name],
    );
  }
  db.run("UPDATE users SET spend_cap_daily_usd = NULL WHERE id IN (?, ?)", [ANNA, BEN]);
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

// ── Per-member and per-household layers ─────────────────────────────────────

test("a member's cap trips for that member and nobody else", async () => {
  const b = await budget();
  b.setMemberDailyCap(ANNA, 1.0);
  b.recordSpend(turn(0.7), ANNA);
  b.recordSpend(turn(0.7), ANNA);
  const anna = b.verdict("anthropic", "claude-sonnet-5", 0, ANNA);
  expect(anna.ok).toBe(false);
  expect(anna.reason).toContain("your daily limit");
  // Ben has no cap of his own and no household cap stands over him.
  expect(b.verdict("anthropic", "claude-sonnet-5", 0, BEN).ok).toBe(true);
  // A turn with nobody named cannot be checked against a member's cap.
  expect(b.verdict("anthropic", "claude-sonnet-5").ok).toBe(true);
});

test("a member's cap counts only that member's turns", async () => {
  const b = await budget();
  b.setMemberDailyCap(ANNA, 1.0);
  b.recordSpend(turn(5.0), BEN);
  b.recordSpend(turn(0.25), ANNA);
  const v = b.verdict("anthropic", "claude-sonnet-5", 0, ANNA);
  expect(v.ok).toBe(true);
  expect(v.remainingUsd).toBeCloseTo(0.75, 5);
  expect(b.spentTodayUsd(ANNA)).toBeCloseTo(0.25, 5);
  expect(b.spentTodayUsd()).toBeCloseTo(5.25, 5);
});

test("the household's cap trips for everyone, on the household's sum", async () => {
  const b = await budget();
  b.setHouseholdDailyCap(1.0);
  b.recordSpend(turn(0.6), ANNA);
  b.recordSpend(turn(0.6), BEN);
  for (const who of [ANNA, BEN, null]) {
    const v = b.verdict("anthropic", "claude-sonnet-5", 0, who);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("This household has reached its daily limit");
  }
});

test("the tightest of the three layers is what is left", async () => {
  const b = await budget();
  process.env.MAURICE_SPEND_CAP_DAILY_USD = "10.00";
  b.setHouseholdDailyCap(5.0);
  b.setMemberDailyCap(ANNA, 1.0);
  b.recordSpend(turn(0.4), ANNA);
  b.recordSpend(turn(2.0), BEN);
  // Anna: her own 1.00 - 0.40 = 0.60 is tighter than the household's 5 - 2.4.
  expect(b.verdict("anthropic", "claude-sonnet-5", 0, ANNA).remainingUsd).toBeCloseTo(0.6, 5);
  // Ben: no cap of his own; the household's 5.00 - 2.40 beats the instance's.
  expect(b.verdict("anthropic", "claude-sonnet-5", 0, BEN).remainingUsd).toBeCloseTo(2.6, 5);
});

test("the refusal names the cap that was reached", async () => {
  const b = await budget();
  process.env.MAURICE_SPEND_CAP_DAILY_USD = "0.50";
  b.setHouseholdDailyCap(5.0);
  b.setMemberDailyCap(ANNA, 5.0);
  b.recordSpend(turn(0.6), BEN);
  const v = b.verdict("anthropic", "claude-sonnet-5", 0, ANNA);
  expect(v.ok).toBe(false);
  expect(v.reason).toContain("This instance has reached its daily limit of $0.50");
  expect(v.reason).not.toContain("household");
  expect(v.reason).not.toContain("your daily limit");
});

test("a stored cap of nonsense is ignored, like an env one", async () => {
  const b = await budget();
  const db = (await import("../src/db")).default;
  db.run("UPDATE users SET spend_cap_daily_usd = -3 WHERE id = ?", [ANNA]);
  expect(b.memberDailyCap(ANNA)).toBe(null);
  expect(b.capped(ANNA)).toBe(false);
});

test("a member's own view: spent, tightest daily cap, headroom", async () => {
  const b = await budget();
  expect(b.usageFor(ANNA)).toEqual({ today_usd: 0, month_usd: 0, cap_daily_usd: null, remaining_usd: null });

  process.env.MAURICE_SPEND_CAP_USD = "100.00";
  b.setHouseholdDailyCap(3.0);
  b.setMemberDailyCap(ANNA, 2.0);
  b.recordSpend(turn(0.5), ANNA);
  b.recordSpend(turn(2.0), BEN);
  const u = b.usageFor(ANNA);
  expect(u.today_usd).toBeCloseTo(0.5, 5);
  expect(u.month_usd).toBeCloseTo(0.5, 5);
  // The tightest *daily* cap is her own 2.00 ...
  expect(u.cap_daily_usd).toBe(2.0);
  // ... but the household's 3.00 - 2.50 is the tighter headroom.
  expect(u.remaining_usd).toBeCloseTo(0.5, 5);
});

test("a job's spend is kept apart from chat: job_id on the row, summed by spentOnJob, still counted in the member's day", async () => {
  const b = await budget();
  const db = (await import("../src/db")).default;
  // A chat turn: no job. A night's reading: the job's id, as the member.
  b.recordSpend(turn(0.2), ANNA);
  b.recordSpend(turn(0.3), ANNA, "job_reading_1");
  b.recordSpend(turn(0.1), ANNA, "job_reading_1");
  b.recordSpend(turn(0.4), BEN, "job_reading_2");
  const rows = db.query(`SELECT user_id, job_id, cost_usd FROM spend_ledger ORDER BY id`).all() as any[];
  expect(rows.map((r) => r.job_id)).toEqual([null, "job_reading_1", "job_reading_1", "job_reading_2"]);
  expect(b.spentOnJob("job_reading_1")).toBeCloseTo(0.4, 5);
  expect(b.spentOnJob("job_reading_2")).toBeCloseTo(0.4, 5);
  expect(b.spentOnJob("job_nobody")).toBe(0);
  // The member's day and the household's still see every row: the job is a
  // dimension, not an exemption from the caps.
  expect(b.spentTodayUsd(ANNA)).toBeCloseTo(0.6, 5);
  expect(b.spentTodayUsd()).toBeCloseTo(1.0, 5);
});
