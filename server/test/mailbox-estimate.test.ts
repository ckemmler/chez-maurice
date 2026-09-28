/**
 * Each mailbox's status and estimate (services/mailboxEstimate.ts): the
 * numbers per mailbox as the email tool counts them, what is left to sort
 * and to read, the hours, and the euros — from the member's own reading
 * when they have one, from the price sheet otherwise — which a member never
 * sees.
 */
import { beforeAll, expect, test } from "bun:test";

const { default: db } = await import("../src/db");
const est = await import("../src/services/mailboxEstimate");
const { setPinnedModel } = await import("../src/services/ancillary");
const { addModel } = await import("../src/services/models");

const LIGHT = "mistral-small-3.2-24b-instruct-2506";
const FULL = "mistral-medium-latest";
const WRITE = "deepseek-v4-flash-0731";

beforeAll(() => {
  for (const [id, provider] of [[LIGHT, "scaleway"], [FULL, "mistral"], [WRITE, "scaleway"]] as const) {
    if (!db.query(`SELECT 1 FROM models WHERE id = ?`).get(id)) addModel({ id, name: id, tier: "cloud", vendor: "x", provider });
  }
  setPinnedModel("mail_read_light", LIGHT);
  setPinnedModel("mail_read_full", FULL);
  setPinnedModel("mail_write", WRITE);
  db.run(`INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES ('est-m', 'est-m', 'M', 'standard')`);
});

const box = (address: string, messages: number, untriaged: number, r: Partial<est.BoxReading>) => ({
  address, messages, untriaged, reading: { window: 0, to_light: 0, kept: 0, skipped: 0, to_read: 0, read: 0, ...r },
});

test("each mailbox says its own numbers; a finished one has no estimate", async () => {
  const views = est.mailboxViews({
    mailboxes: [
      box("done@x", 1000, 0, { window: 400, kept: 100, skipped: 300, read: 98, to_read: 2 }),
      box("new@x", 37000, 0, { window: 36000, to_light: 12000, kept: 1000, skipped: 3000, to_read: 1000 }),
    ],
    calibration: { sampled: 100, tokens: 22000, preview_tokens: 140 },
  });
  expect(views[0]!.estimate).toBeNull();
  const e = views[1]!.estimate!;
  // Kept a quarter so far (1 100 of 4 400 judged): 12 000 to sort → 3 000 more to read.
  expect(e.to_sort).toBe(12000);
  expect(e.to_read).toBe(1000 + 3000);
  expect(e.hours).toBe(Math.round((12000 / est.LIGHT_PER_HOUR + 4000 / est.FULL_PER_HOUR) * 10) / 10);
  expect(e.basis).toBe("formula");
  // Priced when every model of the passes is on the price sheet; unknown
  // (null), never zero, when one is not — other suites move the pins.
  expect(e.euros === null || e.euros > 0).toBe(true);
  expect(est.unitCostsFromFormula(null)).toBeNull();
  // A member never sees the money.
  expect(est.withoutMoney(views)[1]!.estimate!.euros).toBeNull();
});

test("the member's own reading prices it when there is enough of it", () => {
  const job = "job_est_1";
  db.run(`DELETE FROM spend_ledger WHERE job_id = ?`, [job]);
  const spend = (model: string, cost: number) =>
    db.run(`INSERT INTO spend_ledger (provider, model, cost_usd, user_id, job_id) VALUES ('x', ?, ?, 'est-m', ?)`, [model, cost, job]);
  spend(LIGHT, 2); // 2 € for 20 000 sorted
  spend(FULL, 1.5); spend(WRITE, 2.5); // 4 € for 2 000 read
  const u = est.unitCostsFromHistory(job, { judged: 20000, read: 2000 })!;
  expect(u.light).toBeCloseTo(0.0001, 6);
  expect(u.read).toBeCloseTo(0.002, 6);
  const [v] = est.mailboxViews({
    reading: { id: job, counts: { judged: 20000, read: 2000 } },
    mailboxes: [box("new@x", 5000, 0, { window: 5000, to_light: 1000, kept: 250, skipped: 750, to_read: 0 })],
  });
  expect(v!.estimate!.basis).toBe("history");
  // 1 000 to sort at 0.0001, 250 to read at 0.002.
  expect(v!.estimate!.euros).toBe(0.6);
  // Too little history: not used.
  expect(est.unitCostsFromHistory(job, { judged: 100, read: 10 })).toBeNull();
});

test("a mailbox not sorted yet is estimated, and says the numbers will move", () => {
  const [v] = est.mailboxViews({ mailboxes: [box("fresh@x", 10000, 10000, {})], calibration: { sampled: 100, tokens: 20000, preview_tokens: 140 } });
  expect(v!.estimate!.pending).toBe(true);
  expect(v!.estimate!.to_sort).toBe(5000);
});
