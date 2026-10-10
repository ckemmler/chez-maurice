/**
 * A yes per mailbox (28 September 2026): the yes to reading covers the
 * mailboxes there are; one added after it is not read without its own —
 * the reading asks the tool for the approved mailboxes only, and a yes to
 * one mailbox (the app's "Read this mailbox") marks that one alone. Since
 * 10 October 2026 nothing is said about it in a conversation: the mailbox's
 * card asks.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";

const { default: db } = await import("../src/db");
const accounts = await import("../src/services/mailAccounts");
const approval = await import("../src/services/mailApproval");
const reading = await import("../src/services/mailReading");
const scan = await import("../src/services/mailScan");
const est = await import("../src/services/mailboxEstimate");
const routes = (await import("../src/routes/mailAccounts")).default;
const { createSession } = await import("../src/services/auth");

const M = "perbox-m";
const SOLO = "perbox-solo";
const calls: Array<{ tool: string; args: any }> = [];

/** What Maurice has opened for the member, and said to them anywhere. */
const spoken = (memberId: string) => ({
  opened: (db.query(`SELECT COUNT(*) AS n FROM conversations WHERE user_id = ? AND opened_by = 'maurice'`).get(memberId) as { n: number }).n,
  said: (db.query(`SELECT COUNT(*) AS n FROM messages WHERE role = 'assistant' AND conversation_id IN (SELECT id FROM conversations WHERE user_id = ?)`).get(memberId) as { n: number }).n,
});

/** The `email` tool's store, as a stub: one reading job per member. */
const jobs: Record<string, { id: string; state: string; cursor: any; updated_at: string }> = {};
async function gateway(member: string, tool: string, args: any) {
  calls.push({ tool, args });
  if (tool === "approve_reading") {
    const already = jobs[member]?.state === "approved";
    jobs[member] = { id: `job_${member}`, state: "approved", cursor: { years: 3 }, updated_at: "2026-10-10T08:00:00+00:00" };
    return { status: "approved", job: jobs[member], already };
  }
  if (tool === "reading_progress") return { job: jobs[member] ?? null, progress: { to_light: 0, to_read: 0 } };
  if (tool === "scan_status") return { running: false, job: { id: "walk", state: "done", counts: { seen: 5, written: 5 } }, reading: jobs[member] ?? null, totals: { messages: 5, locations: 5 } };
  return {};
}

beforeAll(() => {
  db.run(`INSERT OR IGNORE INTO households (id, name) VALUES ('default', 'Home')`);
  for (const id of [M, SOLO]) {
    db.run(`INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES (?, ?, 'M', 'standard')`, [id, id]);
    db.run(`DELETE FROM mail_reading_consent WHERE member_id = ?`, [id]);
    db.run(`DELETE FROM mail_accounts WHERE member_id = ?`, [id]);
  }
  db.run(`INSERT INTO mail_accounts (id, member_id, address, secret, state) VALUES ('pb-1', ?, 'first@example.org', 'v1:x', 'ok')`, [M]);
  reading.setMailReadingDeps({ call: gateway });
  scan.setMailScanDeps({ call: gateway });
});

afterAll(() => {
  reading.setMailReadingDeps(null);
  scan.setMailScanDeps(null);
});

const as = (memberId: string) => {
  const auth = `Bearer ${createSession(memberId).token}`;
  return (p: string, init: RequestInit = {}) => routes.request(p, { ...init, headers: { Authorization: auth, "Content-Type": "application/json" } });
};

test("the yes covers the mailboxes there are; one added later is not read, and the reading asks for the approved ones only", async () => {
  expect(accounts.approvedMailboxAddresses(M)).toEqual([]);
  expect(reading.readingWanted(M)).toBe(false);
  await approval.decideReading(M, "approve");
  expect(approval.readingState(M)).toBe("approved");
  db.run(`INSERT INTO mail_accounts (id, member_id, address, secret, state) VALUES ('pb-2', ?, 'Later@Example.org', 'v1:x', 'ok')`, [M]);
  expect(accounts.approvedMailboxAddresses(M)).toEqual(["first@example.org"]);
  calls.length = 0;
  await reading.runMailReading(M);
  expect(calls.find((c) => c.tool === "reading_progress")!.args.addresses).toEqual(["first@example.org"]);
});

test("a yes to one mailbox, from its card, marks that one alone and says nothing anywhere", async () => {
  db.run(`INSERT INTO mail_accounts (id, member_id, address, secret, state) VALUES ('pb-3', ?, 'third@example.org', 'v1:x', 'ok')`, [M]);
  const before = spoken(M);
  calls.length = 0;
  const res = await as(M)("/pb-2/reading", { method: "POST" });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ started: true, running: true });
  expect(accounts.approvedMailboxAddresses(M).sort()).toEqual(["first@example.org", "later@example.org"]);
  // The member's word was already yes: the tool is not asked for it again.
  expect(calls.some((c) => c.tool === "approve_reading")).toBe(false);
  expect((await as(M)("/pb-nobody/reading", { method: "POST" })).status).toBe(404);
  await new Promise((r) => setTimeout(r, 30));
  expect(spoken(M)).toEqual(before);
  expect(spoken(M).opened).toBe(0);
});

test("a member's first yes, given to one mailbox, covers that mailbox only and is their word", async () => {
  db.run(`INSERT INTO mail_accounts (id, member_id, address, secret, state) VALUES ('ps-1', ?, 'one@example.org', 'v1:x', 'ok')`, [SOLO]);
  db.run(`INSERT INTO mail_accounts (id, member_id, address, secret, state) VALUES ('ps-2', ?, 'two@example.org', 'v1:x', 'ok')`, [SOLO]);
  expect(approval.readingState(SOLO)).toBe("pending");
  calls.length = 0;
  expect((await as(SOLO)("/ps-2/reading", { method: "POST" })).status).toBe(200);
  expect(calls.filter((c) => c.tool === "approve_reading")).toHaveLength(1);
  expect(approval.readingState(SOLO)).toBe("approved");
  expect(accounts.approvedMailboxAddresses(SOLO)).toEqual(["two@example.org"]);
  await new Promise((r) => setTimeout(r, 30));
  expect(spoken(SOLO)).toEqual({ opened: 0, said: 0 });
});

test("the member is never shown what a mailbox would cost: the view goes out without the euros", () => {
  const box: est.MailboxView = {
    address: "later@example.org", messages: 12345, untriaged: 0,
    reading: { window: 900, to_light: 600, kept: 100, skipped: 200, to_read: 100, read: 0 },
    top_senders: [],
    estimate: { to_sort: 600, to_read: 300, hours: 0.4, euros: 4.2, basis: "formula", pending: false },
  };
  const [shown] = est.withoutMoney([box]);
  expect(shown!.estimate).toMatchObject({ to_read: 300, hours: 0.4, euros: null });
  // And the sentence Maurice had for a mailbox added after the yes is gone.
  expect((est as any).newMailboxNotice).toBeUndefined();
});
