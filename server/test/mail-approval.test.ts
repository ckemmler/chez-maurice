/**
 * The member's yes to Maurice reading their mail (services/mailApproval.ts,
 * lot 3 of specs/mail-import.md). Since 10 October 2026 the word is given on
 * the card under Settings → Mail and nowhere else: Maurice opens no
 * conversation for the mail, and the tool that took the answer in one is
 * gone. Nailed down: the word is a row of `mail_reading_consent`, with no
 * conversation anywhere near it — pending until given, the approved
 * mailboxes speaking for it meanwhile; the yes calls the `email` tool as the
 * member, which leaves an approved job in their store and spends nothing; a
 * no is kept, and a later yes still turns it around; a tool that refuses
 * leaves the word as it was; the card's route does the same and says
 * nothing in any conversation; the two tool-side words are never in a
 * model's roster; and nothing the member could read speaks of money.
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";

const db = (await import("../src/db")).default;
const approval = await import("../src/services/mailApproval");
const accounts = await import("../src/services/mailAccounts");
const scan = await import("../src/services/mailScan");
const budget = await import("../src/services/budget");
const routes = (await import("../src/routes/mailAccounts")).default;
const { createConversation, getMessages } = await import("../src/services/conversations");
const { isServerOnlyTool } = await import("../src/services/toolFamilies");
const { setRoomPublisher } = await import("../src/services/roomBus");
const { createSession } = await import("../src/services/auth");

const ANNA = "ma-anna";
const BEN = "ma-ben";
let annaAuth = "";
let published: Array<{ topic: string; event: any }> = [];

interface Call { member: string; tool: string; args: any }
let calls: Call[] = [];

/** The `email` tool's store, as a stub: one reading job per member, the
 *  states the real one answers. */
const jobs: Record<string, { id: string; state: string; cursor: any; updated_at: string }> = {};
let refusal: any = null;
function gateway(member: string, tool: string, args: any) {
  calls.push({ member, tool, args });
  if (tool === "approve_reading" || tool === "decline_reading") {
    if (refusal) return refusal;
    const want = tool === "approve_reading" ? "approved" : "declined";
    const cur = jobs[member];
    if (cur && cur.state === want) return { status: want, job: cur, already: true };
    if (cur && (cur.state === "running" || cur.state === "paused")) return { status: cur.state, job: cur, already: true, note: "a reading is already under way; it goes on" };
    const job = { id: cur?.id ?? `job_${member}`, state: want, cursor: { years: args?.years ?? 3 }, updated_at: "2026-09-26T21:00:00+00:00" };
    jobs[member] = job;
    return { status: want, job, already: false };
  }
  if (tool === "reading_window") {
    const cur = jobs[member];
    if (!cur || cur.state === "declined") return { error: "AccessDenied: the member has not approved the reading of their mail" };
    const previous = cur.cursor.years;
    const years = Math.max(previous, args.years);
    cur.cursor = { years };
    return { job: cur, years, previous, changed: years > previous };
  }
  if (tool === "reading_progress") return { job: null, progress: null };
  if (tool === "scan_status") return { running: false, job: { id: "walk", state: "done", counts: { seen: 5, written: 5 } }, reading: jobs[member] ?? null, totals: { messages: 5, locations: 5 } };
  throw new Error(`unexpected tool ${tool}`);
}

beforeAll(() => {
  db.run(`INSERT OR IGNORE INTO households (id, name) VALUES ('default', 'Home')`);
  for (const [id, name] of [[ANNA, "Anna"], [BEN, "Ben"]] as const) {
    db.run(`INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES (?, ?, ?, 'standard')`, [id, id, name]);
  }
  annaAuth = `Bearer ${createSession(ANNA).token}`;
  setRoomPublisher((topic, data) => published.push({ topic, event: JSON.parse(data) }));
  scan.setMailScanDeps({ call: async (m, t, a) => gateway(m, t, a) });
});

afterAll(() => {
  scan.setMailScanDeps(null);
  setRoomPublisher(null);
  db.run(`DELETE FROM mail_accounts WHERE member_id IN (?, ?)`, [ANNA, BEN]);
});

beforeEach(() => {
  calls = [];
  published = [];
  refusal = null;
  for (const k of Object.keys(jobs)) delete jobs[k];
  db.run(`DELETE FROM mail_reading_consent WHERE member_id IN (?, ?)`, [ANNA, BEN]);
  db.run(`DELETE FROM mail_accounts WHERE member_id IN (?, ?)`, [ANNA, BEN]);
  db.run(`DELETE FROM spend_ledger WHERE user_id IN (?, ?)`, [ANNA, BEN]);
});

/** What Maurice has opened for the member, and said to them anywhere. */
const spoken = (memberId: string) => ({
  opened: (db.query(`SELECT COUNT(*) AS n FROM conversations WHERE user_id = ? AND opened_by = 'maurice'`).get(memberId) as { n: number }).n,
  said: (db.query(`SELECT COUNT(*) AS n FROM messages WHERE role = 'assistant' AND conversation_id IN (SELECT id FROM conversations WHERE user_id = ?)`).get(memberId) as { n: number }).n,
});

const consent = (memberId: string) =>
  db.query(`SELECT member_id, reading, decided_at FROM mail_reading_consent WHERE member_id = ?`).get(memberId) as { member_id: string; reading: string; decided_at: string } | null;

const mailbox = (id: string, memberId: string, address: string) =>
  db.run(`INSERT INTO mail_accounts (id, member_id, address, secret, state) VALUES (?, ?, ?, 'v1:x', 'ok')`, [id, memberId, address]);

const req = (p: string, init: RequestInit = {}) =>
  routes.request(p, { ...init, headers: { Authorization: annaAuth, "Content-Type": "application/json", ...(init.headers ?? {}) } });

test("the word is the member's own row, with no conversation at all: pending, then approved or declined", async () => {
  const before = spoken(ANNA);
  expect(approval.readingState(ANNA)).toBe("pending");
  expect(consent(ANNA)).toBeNull();
  expect(approval.readingApproved(ANNA)).toBe(false);

  await approval.decideReading(ANNA, "approve");
  expect(approval.readingState(ANNA)).toBe("approved");
  expect(approval.readingApproved(ANNA)).toBe(true);
  expect(consent(ANNA)).toMatchObject({ member_id: ANNA, reading: "approved" });
  expect(consent(ANNA)!.decided_at).toBeTruthy();

  // One member's word is nobody else's.
  expect(approval.readingState(BEN)).toBe("pending");
  await approval.decideReading(BEN, "decline");
  expect(approval.readingState(BEN)).toBe("declined");
  expect(approval.readingApproved(BEN)).toBe(false);
  expect(approval.readingState(ANNA)).toBe("approved");

  // Nothing was opened, nothing was said, to either.
  expect(spoken(ANNA)).toEqual(before);
  expect(spoken(BEN).opened).toBe(0);
  expect(published).toHaveLength(0);
});

test("while the word is pending, the mailboxes a yes approved speak for it; a word given overrides them", async () => {
  mailbox("ma-box-1", ANNA, "anna@gmail.com");
  expect(approval.readingApproved(ANNA)).toBe(false);
  // A yes as it stood on the mailbox alone, with no row to mirror it.
  expect(accounts.approveMailboxes(ANNA)).toBe(1);
  expect(approval.readingState(ANNA)).toBe("pending");
  expect(approval.readingApproved(ANNA)).toBe(true);
  // The member says no: the row decides, whatever the mailbox still carries.
  await approval.decideReading(ANNA, "decline");
  expect(accounts.approvedMailboxAddresses(ANNA)).toEqual(["anna@gmail.com"]);
  expect(approval.readingApproved(ANNA)).toBe(false);
});

test("the yes calls the tool as the member, leaves an approved job, covers the mailboxes there are, spends nothing; a second yes is a no-op", async () => {
  mailbox("ma-box-1", ANNA, "anna@gmail.com");
  mailbox("ma-box-2", ANNA, "anna@proton.me");
  const d = await approval.decideReading(ANNA, "approve");
  expect(d).toEqual({ reading: "approved", already: false, job_id: `job_${ANNA}`, decided_at: "2026-09-26T21:00:00+00:00" });
  expect(calls).toEqual([{ member: ANNA, tool: "approve_reading", args: {} }]);
  expect(jobs[ANNA]).toMatchObject({ state: "approved", cursor: { years: 3 } });
  expect(accounts.approvedMailboxAddresses(ANNA).sort()).toEqual(["anna@gmail.com", "anna@proton.me"]);
  expect(budget.spentTodayUsd(ANNA)).toBe(0);
  expect(budget.spentOnJob(jobs[ANNA]!.id)).toBe(0);
  const again = await approval.decideReading(ANNA, "approve");
  expect(again).toMatchObject({ reading: "approved", already: true });
  expect(calls).toHaveLength(2);
  expect(db.query(`SELECT COUNT(*) AS n FROM mail_reading_consent WHERE member_id = ?`).get(ANNA)).toEqual({ n: 1 });
});

test("the years asked for go to the tool with the yes, never with the no; a yes to one mailbox marks that one alone", async () => {
  mailbox("ma-box-1", ANNA, "anna@gmail.com");
  mailbox("ma-box-2", ANNA, "anna@proton.me");
  await approval.decideReading(ANNA, "decline", { years: 7 });
  expect(calls.at(-1)).toEqual({ member: ANNA, tool: "decline_reading", args: {} });
  expect(accounts.approvedMailboxAddresses(ANNA)).toEqual([]);
  await approval.decideReading(ANNA, "approve", { years: 7, mailbox: "ma-box-2" });
  expect(calls.at(-1)).toEqual({ member: ANNA, tool: "approve_reading", args: { years: 7 } });
  expect(jobs[ANNA]!.cursor).toEqual({ years: 7 });
  expect(accounts.approvedMailboxAddresses(ANNA)).toEqual(["anna@proton.me"]);
});

test("a no is kept; a later, explicit yes turns it around, and a no after a yes is a no", async () => {
  const no = await approval.decideReading(ANNA, "decline");
  expect(no).toMatchObject({ reading: "declined", already: false });
  expect(jobs[ANNA]!.state).toBe("declined");
  expect(approval.readingState(ANNA)).toBe("declined");
  const yes = await approval.decideReading(ANNA, "approve");
  expect(yes).toMatchObject({ reading: "approved", already: false });
  expect(jobs[ANNA]!.id).toBe(`job_${ANNA}`); // the same row, turned around
  expect(approval.readingApproved(ANNA)).toBe(true);
  const back = await approval.decideReading(ANNA, "decline");
  expect(back).toMatchObject({ reading: "declined", already: false });
  expect(approval.readingState(ANNA)).toBe("declined");
  expect(approval.readingApproved(ANNA)).toBe(false);
  // One row all along: the last word replaces the one before.
  expect(db.query(`SELECT COUNT(*) AS n FROM mail_reading_consent WHERE member_id = ?`).get(ANNA)).toEqual({ n: 1 });
});

test("a tool that refuses, cannot be read, or has a reading under way throws, and the word stays as it was", async () => {
  // Never asked: the table stays empty.
  refusal = { error: "AccessDenied: you have no mail account set up" };
  await expect(approval.decideReading(ANNA, "approve")).rejects.toThrow("no mail account");
  expect(consent(ANNA)).toBeNull();
  refusal = { raw: "<html>502 Bad Gateway</html>" };
  await expect(approval.decideReading(ANNA, "approve")).rejects.toThrow("502");
  expect(consent(ANNA)).toBeNull();
  refusal = { status: "weird", job: { id: "j", state: "weird" } };
  await expect(approval.decideReading(ANNA, "approve")).rejects.toThrow("the reading job is weird");
  expect(consent(ANNA)).toBeNull();
  expect(approval.readingState(ANNA)).toBe("pending");

  // A yes on record, and a reading under way: the no is not taken over the run.
  refusal = null;
  mailbox("ma-box-1", ANNA, "anna@gmail.com");
  await approval.decideReading(ANNA, "approve");
  const row = consent(ANNA);
  jobs[ANNA] = { id: "job_run", state: "running", cursor: { years: 3 }, updated_at: "x" };
  await expect(approval.decideReading(ANNA, "decline")).rejects.toThrow("under way");
  expect(consent(ANNA)).toEqual(row);
  expect(approval.readingApproved(ANNA)).toBe(true);

  // And a gateway that cannot be reached at all.
  scan.setMailScanDeps({ call: async () => { throw new Error("ECONNREFUSED"); } });
  try {
    await expect(approval.decideReading(ANNA, "decline")).rejects.toThrow("ECONNREFUSED");
    expect(consent(ANNA)).toEqual(row);
  } finally {
    scan.setMailScanDeps({ call: async (m, t, a) => gateway(m, t, a) });
  }
});

test("the card's route takes the word and answers with the walk's view; nothing is opened, nothing is said, in any conversation", async () => {
  // A conversation Maurice once opened about the mail, kept as an ordinary
  // one, and one of the member's own: neither hears of it.
  const old = createConversation(ANNA, null, { openedBy: "maurice" }).id;
  const own = createConversation(ANNA, null).id;
  const before = spoken(ANNA);

  const res = await req("/reading", { method: "POST", body: JSON.stringify({ action: "approve" }) });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.reading).toMatchObject({ state: "approved", years: 3, job_id: `job_${ANNA}` });
  expect(body.decision).toEqual({ reading: "approved", already: false, job_id: `job_${ANNA}`, decided_at: "2026-09-26T21:00:00+00:00" });
  expect(body.decision).not.toHaveProperty("said");
  expect(body.decision).not.toHaveProperty("conversation_id");
  expect(approval.readingState(ANNA)).toBe("approved");

  // The same word again changes nothing.
  const again = await (await req("/reading", { method: "POST", body: JSON.stringify({ action: "approve" }) })).json();
  expect(again.decision).toMatchObject({ reading: "approved", already: true });

  // Withdrawn from the card: the no.
  const no = await (await req("/reading", { method: "POST", body: JSON.stringify({ action: "decline" }) })).json();
  expect(no.reading.state).toBe("declined");
  expect(no.decision).toMatchObject({ reading: "declined", already: false });
  expect(approval.readingState(ANNA)).toBe("declined");
  expect((await req("/reading", { method: "POST", body: JSON.stringify({ action: "burn" }) })).status).toBe(400);
  expect((await req("/reading", { method: "POST", body: "{" })).status).toBe(400);

  // Three words and two refusals later: not a conversation more, not a message.
  expect(spoken(ANNA)).toEqual(before);
  expect(getMessages(old)).toHaveLength(0);
  expect(getMessages(own)).toHaveLength(0);
  expect(published).toHaveLength(0);
});

test("a member Maurice never spoke to about their mail approves from the card", async () => {
  expect(spoken(BEN)).toEqual({ opened: 0, said: 0 });
  const benAuth = `Bearer ${createSession(BEN).token}`;
  const res = await routes.request("/reading", { method: "POST", body: JSON.stringify({ action: "approve" }), headers: { Authorization: benAuth, "Content-Type": "application/json" } });
  expect(res.status).toBe(200);
  expect((await res.json()).decision).toEqual({ reading: "approved", already: false, job_id: `job_${BEN}`, decided_at: "2026-09-26T21:00:00+00:00" });
  expect(jobs[BEN]!.state).toBe("approved");
  expect(approval.readingState(BEN)).toBe("approved");
  expect(spoken(BEN)).toEqual({ opened: 0, said: 0 });
});

test("the route answers 422 when the tool refuses, and the word stays as it was", async () => {
  refusal = { error: "AccessDenied: you have no mail account set up" };
  const res = await req("/reading", { method: "POST", body: JSON.stringify({ action: "approve" }) });
  expect(res.status).toBe(422);
  expect((await res.json()).error).toContain("no mail account");
  expect(consent(ANNA)).toBeNull();
});

test("the walk's view carries the word", async () => {
  jobs[ANNA] = { id: "job_x", state: "declined", cursor: { years: 2 }, updated_at: "2026-09-26T21:00:00+00:00" };
  const view = await (await req("/scan")).json();
  expect(view.reading).toEqual({ state: "declined", decided_at: "2026-09-26T21:00:00+00:00", years: 2, job_id: "job_x" });
  expect(scan.scanView({ running: false, job: null, totals: {} }).reading).toBeNull();
});

test("read further back: the window widens, never narrows, and only after a yes", async () => {
  const window = (years: unknown) => req("/reading/window", { method: "POST", body: JSON.stringify({ years }) });
  // Not without the member's yes, and not with years that are not years.
  expect((await window(10)).status).toBe(409);
  await req("/reading", { method: "POST", body: JSON.stringify({ action: "approve" }) });
  for (const bad of [0, -2, 2.5, "ten", null]) expect((await window(bad)).status).toBe(400);

  const wider = await (await window(10)).json();
  expect(wider.window).toEqual({ years: 10, previous: 3, changed: true, job_id: `job_${ANNA}` });
  expect(wider.started).toBe(true);
  expect(wider.reading).toMatchObject({ state: "approved", years: 10 });
  expect(calls.find((c) => c.tool === "reading_window")).toEqual({ member: ANNA, tool: "reading_window", args: { years: 10 } });

  // Narrower changes nothing and starts nothing; everything is fifty years.
  const narrower = await (await window(5)).json();
  expect(narrower.window).toMatchObject({ years: 10, changed: false });
  expect(narrower.started).toBe(false);
  await new Promise((r) => setTimeout(r, 20));
  const all = await (await window(4000)).json();
  expect(all.window).toMatchObject({ years: approval.READING_ALL_YEARS, previous: 10, changed: true });
  expect(isServerOnlyTool("email__reading_window")).toBe(true);
  await new Promise((r) => setTimeout(r, 20));

  // After a no, the door is closed again.
  jobs[ANNA]!.state = "approved";
  await req("/reading", { method: "POST", body: JSON.stringify({ action: "decline" }) });
  expect((await window(20)).status).toBe(409);
});

test("the two tool-side words are the server's, never a model's; the tool that took the yes in a conversation is gone", () => {
  expect(isServerOnlyTool("email__approve_reading")).toBe(true);
  expect(isServerOnlyTool("email__decline_reading")).toBe(true);
  expect(isServerOnlyTool("email__scan_status")).toBe(false);
  expect(isServerOnlyTool("corpus__reindex")).toBe(true);
  for (const gone of ["MAIL_TOOL_NAME", "isMailTool", "mailToolsFor", "runMailTool", "mailPromptSection", "linkMailConversation", "mailConversationOf", "sayReadingDecided", "carryReadingApproval"]) {
    expect((approval as any)[gone], gone).toBeUndefined();
  }
  // No source file still names it for a model to find.
  const src = path.join(import.meta.dir, "..", "src");
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith(".ts") ? [path.join(dir, e.name)] : []));
  const naming = walk(src).filter((f) => !f.endsWith("mailApproval.ts") && /\bmail__approve_reading/.test(fs.readFileSync(f, "utf8")));
  expect(naming.map((f) => path.relative(src, f))).toEqual([]);
});

test("nothing the member could read speaks of money", async () => {
  const money = /€|euro|\bcost|price|token|budget|\bcap\b|limit/i;
  // What the card's route answers: the decision, and the mailboxes without their euros.
  mailbox("ma-box-1", ANNA, "anna@gmail.com");
  const body = await (await req("/reading", { method: "POST", body: JSON.stringify({ action: "approve" }) })).json();
  expect(JSON.stringify(body.decision)).not.toMatch(money);
  for (const b of body.mailboxes ?? []) expect(b.estimate?.euros ?? null, b.address).toBeNull();
  const res = path.join(import.meta.dir, "..", "..", "app", "Maurice", "Resources");
  for (const l of ["en", "fr", "it", "de", "es", "pt", "nl"]) {
    const lines = fs.readFileSync(path.join(res, `${l}.lproj`, "Localizable.strings"), "utf8").split("\n").filter((s) => s.startsWith('"mail.reading.'));
    expect(lines.length, l).toBeGreaterThanOrEqual(8);
    for (const s of lines) expect(s, `${l}: ${s}`).not.toMatch(/€|euro|\bcost|coût|costo|Kosten|preis|prix|token|budget/i);
  }
});
