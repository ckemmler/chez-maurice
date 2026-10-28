/**
 * The console's budget section: the household's monthly budget and each
 * member's share, posted as one form from the main screen. Nothing is written
 * unless the whole form holds.
 */

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";

const db = (await import("../src/db")).default;
const web = (await import("../src/routes/web-admin")).default;
const { createSession } = await import("../src/services/auth");
const { householdMonthlyBudget, budgetShares } = await import("../src/services/budget");

let adminCookie = "";
const ADMIN = "budget-admin";
const MEMBER = "budget-member";

beforeAll(() => {
  db.run(`INSERT OR IGNORE INTO households (id, name) VALUES ('default', 'Home')`);
  db.run(`INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES (?, ?, ?, 'admin')`, [ADMIN, "budgetadmin", "Budget admin"]);
  db.run(`INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES (?, ?, ?, 'standard')`, [MEMBER, "budgetmember", "Budget member"]);
  adminCookie = `maurice_admin=${createSession(ADMIN).token}`;
});

// The test database is shared across files: leave no members behind (the
// dictation vocabulary, for one, is capped and counts every display name).
afterAll(() => {
  db.run(`DELETE FROM sessions WHERE user_id IN (?, ?)`, [ADMIN, MEMBER]);
  db.run(`DELETE FROM users WHERE id IN (?, ?)`, [ADMIN, MEMBER]);
});

beforeEach(() => {
  db.run(`UPDATE households SET budget_monthly_eur = NULL WHERE id = 'default'`);
  db.run(`UPDATE users SET budget_share_pct = NULL`);
});

async function post(fields: Record<string, string>): Promise<string> {
  const body = new URLSearchParams(fields);
  const res = await web.request("/budget", {
    method: "POST",
    body,
    headers: { Host: "localhost", Cookie: adminCookie, "Content-Type": "application/x-www-form-urlencoded" },
  });
  expect(res.status).toBe(302);
  return res.headers.get("location") ?? "";
}

const share = (id: string) => budgetShares().find((s) => s.userId === id)?.setPct;

test("the main screen carries the budget form, a share field per member", async () => {
  const res = await web.request("/dashboard", { headers: { Host: "localhost", Cookie: adminCookie } });
  const html = await res.text();
  expect(html).toContain(`action="/admin/budget"`);
  expect(html).toContain(`name="budget_monthly_eur"`);
  expect(html).toContain(`name="share:${MEMBER}"`);
});

test("a budget and a share are saved together", async () => {
  const to = await post({ budget_monthly_eur: "40", [`share:${MEMBER}`]: "25" });
  expect(to).toContain("msg=budget_saved");
  expect(householdMonthlyBudget()).toBe(40);
  expect(share(MEMBER)).toBe(25);
  expect(share(ADMIN)).toBe(null);
});

test("shares over 100 save nothing", async () => {
  const others = Object.fromEntries(budgetShares().map((s) => [`share:${s.userId}`, "0"]));
  const to = await post({ ...others, budget_monthly_eur: "40", [`share:${MEMBER}`]: "60", [`share:${ADMIN}`]: "50" });
  expect(to).toContain("msg=budget_over");
  expect(householdMonthlyBudget()).toBe(null);
  expect(share(MEMBER)).toBe(null);
});

test("a share out of range saves nothing; an empty budget clears it", async () => {
  expect(await post({ budget_monthly_eur: "40", [`share:${MEMBER}`]: "120" })).toContain("msg=budget_invalid");
  expect(householdMonthlyBudget()).toBe(null);
  await post({ budget_monthly_eur: "40" });
  expect(householdMonthlyBudget()).toBe(40);
  await post({ budget_monthly_eur: "" });
  expect(householdMonthlyBudget()).toBe(null);
});
