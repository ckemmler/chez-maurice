/**
 * The console's budget section: the household's monthly budget, one amount
 * for the whole household, posted from the main screen.
 */

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";

const db = (await import("../src/db")).default;
const web = (await import("../src/routes/web-admin")).default;
const { createSession } = await import("../src/services/auth");
const { householdMonthlyBudget } = await import("../src/services/budget");

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

test("the main screen carries the budget form: one amount for the household", async () => {
  const res = await web.request("/dashboard", { headers: { Host: "localhost", Cookie: adminCookie } });
  const html = await res.text();
  expect(html).toContain(`action="/admin/budget"`);
  expect(html).toContain(`name="budget_monthly_eur"`);
  expect(html).not.toContain(`name="share:`);
});

test("a budget is saved; a nonsense one saves nothing; an empty one clears it", async () => {
  expect(await post({ budget_monthly_eur: "40" })).toContain("msg=budget_saved");
  expect(householdMonthlyBudget()).toBe(40);
  expect(await post({ budget_monthly_eur: "-3" })).toContain("msg=budget_invalid");
  expect(householdMonthlyBudget()).toBe(40);
  await post({ budget_monthly_eur: "" });
  expect(householdMonthlyBudget()).toBe(null);
});
