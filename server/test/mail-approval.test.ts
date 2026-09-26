/**
 * The member's yes to Maurice reading their mail (services/mailApproval.ts,
 * lot 3 of specs/mail-import.md). Nailed down: the tool exists in the one
 * conversation the night opened for the mail, for its member, and nowhere
 * else; an explicit yes calls the tool as the member, which leaves an
 * approved job in their store and spends nothing; a no is kept, the prompt
 * says never to ask again, and a later yes still turns it around; the card's
 * route does the same and Maurice says so in the conversation; the link is
 * rebuilt from the nightly record at boot; the two tool-side words are never
 * in a model's roster; and nothing the member could read — tool, prompt,
 * replies, the app's strings — speaks of money.
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";

const db = (await import("../src/db")).default;
const approval = await import("../src/services/mailApproval");
const scan = await import("../src/services/mailScan");
const opener = await import("../src/services/mailOpener");
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
function gateway(member: string, tool: string, args: any) {
  calls.push({ member, tool, args });
  if (tool === "approve_reading" || tool === "decline_reading") {
    const want = tool === "approve_reading" ? "approved" : "declined";
    const cur = jobs[member];
    if (cur && cur.state === want) return { status: want, job: cur, already: true };
    if (cur && (cur.state === "running" || cur.state === "paused")) return { status: cur.state, job: cur, already: true, note: "a reading is already under way; it goes on" };
    const job = { id: cur?.id ?? `job_${member}`, state: want, cursor: { years: args?.years ?? 3 }, updated_at: "2026-09-26T21:00:00+00:00" };
    jobs[member] = job;
    return { status: want, job, already: false };
  }
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
});

beforeEach(() => {
  calls = [];
  published = [];
  for (const k of Object.keys(jobs)) delete jobs[k];
  db.run(`DELETE FROM mail_conversations WHERE member_id IN (?, ?)`, [ANNA, BEN]);
  db.run(`DELETE FROM spend_ledger WHERE user_id IN (?, ?)`, [ANNA, BEN]);
});

/** A conversation as the night opens it: Maurice's, for the member. */
function mailConversation(memberId: string): string {
  const c = createConversation(memberId, null, { openedBy: "maurice" });
  approval.linkMailConversation(memberId, c.id);
  return c.id;
}

const req = (p: string, init: RequestInit = {}) =>
  routes.request(p, { ...init, headers: { Authorization: annaAuth, "Content-Type": "application/json", ...(init.headers ?? {}) } });

test("the tool exists in the mail conversation, for its member, and nowhere else", () => {
  const mail = mailConversation(ANNA);
  const other = createConversation(ANNA, null, { openedBy: "maurice" }).id; // his, but not the mail one
  const own = createConversation(ANNA, null).id;
  expect(approval.mailToolsFor(mail, ANNA).map((t) => t.name)).toEqual(["mail__approve_reading"]);
  expect(approval.mailToolsFor(mail, BEN)).toEqual([]);
  expect(approval.mailToolsFor(other, ANNA)).toEqual([]);
  expect(approval.mailToolsFor(own, ANNA)).toEqual([]);
  expect(approval.mailToolsFor(mail, undefined)).toEqual([]);
  expect(approval.mailPromptSection(mail, ANNA, "Anna")).toContain("## Reading Anna's mail");
  expect(approval.mailPromptSection(own, ANNA, "Anna")).toBe("");
  expect(approval.mailPromptSection(mail, BEN, "Ben")).toBe("");
  // A conversation the member opened themselves, even linked by mistake, grants nothing.
  approval.linkMailConversation(BEN, own);
  expect(approval.mailToolsFor(own, BEN)).toEqual([]);
});

test("the yes calls the tool as the member, leaves an approved job, spends nothing; a second yes is a no-op", async () => {
  const mail = mailConversation(ANNA);
  const r = await approval.runMailTool({ action: "approve" }, mail);
  expect(r.isError).toBe(false);
  expect(r.data).toMatchObject({ reading: "approved", already: false });
  expect((r.data as any).say).toContain("next night");
  expect(calls).toEqual([{ member: ANNA, tool: "approve_reading", args: {} }]);
  expect(jobs[ANNA]).toMatchObject({ state: "approved", cursor: { years: 3 } });
  expect(approval.mailConversationOf(ANNA)).toMatchObject({ reading: "approved", conversation_id: mail });
  expect(approval.mailConversationOf(ANNA)!.decided_at).not.toBeNull();
  expect(budget.spentTodayUsd(ANNA)).toBe(0);
  expect(budget.spentOnJob(jobs[ANNA]!.id)).toBe(0);
  // The prompt now says so, and says not to ask again.
  expect(approval.mailPromptSection(mail, ANNA, "Anna")).toContain("already said yes");
  const again = await approval.runMailTool({ action: "approve" }, mail);
  expect(again.data).toMatchObject({ reading: "approved", already: true });
  expect(calls).toHaveLength(2);
});

test("a no is kept and never asked again; a later, explicit yes still turns it around", async () => {
  const mail = mailConversation(ANNA);
  const no = await approval.runMailTool({ action: "decline" }, mail);
  expect(no.data).toMatchObject({ reading: "declined", already: false });
  expect(jobs[ANNA]!.state).toBe("declined");
  const prompt = approval.mailPromptSection(mail, ANNA, "Anna");
  expect(prompt).toContain("has said no");
  expect(prompt).toContain("Never ask again");
  const yes = await approval.runMailTool({ action: "approve" }, mail);
  expect(yes.data).toMatchObject({ reading: "approved", already: false });
  expect(jobs[ANNA]!.id).toBe(`job_${ANNA}`); // the same row, turned around
});

test("the tool refuses outside the mail conversation, a bad action, and a reading under way", async () => {
  const own = createConversation(ANNA, null).id;
  expect((await approval.runMailTool({ action: "approve" }, own)).isError).toBe(true);
  const mail = mailConversation(ANNA);
  expect((await approval.runMailTool({ action: "maybe" }, mail)).isError).toBe(true);
  expect((await approval.runMailTool({}, mail)).isError).toBe(true);
  jobs[ANNA] = { id: "job_run", state: "running", cursor: { years: 3 }, updated_at: "x" };
  const r = await approval.runMailTool({ action: "decline" }, mail);
  expect(r.isError).toBe(true);
  expect(r.text).toContain("under way");
  expect(approval.mailConversationOf(ANNA)!.reading).toBe("pending");
});

test("the card's route does the same, and Maurice says so in the conversation, once", async () => {
  const mail = mailConversation(ANNA);
  const res = await req("/reading", { method: "POST", body: JSON.stringify({ action: "approve" }) });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.reading).toMatchObject({ state: "approved", years: 3, job_id: `job_${ANNA}` });
  expect(body.decision).toMatchObject({ reading: "approved", already: false, conversation_id: mail });
  expect(body.decision.said).toBeTruthy();
  const msgs = getMessages(mail);
  expect(msgs.at(-1)).toMatchObject({ role: "assistant", content: opener.MAIL_OPENER_STRINGS.en!.approved });
  expect(published.some((p) => p.topic === `room:${mail}` && p.event.type === "message")).toBe(true);
  // Said once: the same word again leaves the conversation alone.
  const again = await (await req("/reading", { method: "POST", body: JSON.stringify({ action: "approve" }) })).json();
  expect(again.decision).toMatchObject({ already: true, said: null });
  expect(getMessages(mail)).toHaveLength(msgs.length);
  // Withdrawn from the card: the no, and its line.
  const no = await (await req("/reading", { method: "POST", body: JSON.stringify({ action: "decline" }) })).json();
  expect(no.reading.state).toBe("declined");
  expect(getMessages(mail).at(-1)!.content).toBe(opener.MAIL_OPENER_STRINGS.en!.declined);
  expect((await req("/reading", { method: "POST", body: JSON.stringify({ action: "burn" }) })).status).toBe(400);
});

test("a member never asked can still approve from the card; nothing is said anywhere", async () => {
  const res = await req("/reading", { method: "POST", body: JSON.stringify({ action: "approve" }) });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.decision).toMatchObject({ reading: "approved", said: null, conversation_id: null });
  expect(jobs[ANNA]!.state).toBe("approved");
});

test("the walk's view carries the word", async () => {
  jobs[ANNA] = { id: "job_x", state: "declined", cursor: { years: 2 }, updated_at: "2026-09-26T21:00:00+00:00" };
  const view = await (await req("/scan")).json();
  expect(view.reading).toEqual({ state: "declined", decided_at: "2026-09-26T21:00:00+00:00", years: 2, job_id: "job_x" });
  expect(scan.scanView({ running: false, job: null, totals: {} }).reading).toBeNull();
});

test("the link is rebuilt from the nightly record at boot, once, and the night writes it", async () => {
  const c = createConversation(ANNA, null, { openedBy: "maurice" }).id;
  const members = { [ANNA]: { reconciled_at: null, announced_at: "2026-09-26T13:52:00.000Z", conversation_id: c }, [BEN]: { reconciled_at: null, announced_at: null, conversation_id: null } };
  expect(approval.backfillMailConversations(members)).toBe(1);
  expect(approval.backfillMailConversations(members)).toBe(0);
  expect(approval.mailConversationOf(ANNA)).toMatchObject({ conversation_id: c, opened_at: "2026-09-26 13:52:00", reading: "pending" });
  expect(approval.mailConversationMemberOf(c)).toBe(ANNA);
  expect(approval.mailConversationOf(BEN)).toBeNull();
});

test("the two tool-side words are the server's, never a model's", () => {
  expect(isServerOnlyTool("email__approve_reading")).toBe(true);
  expect(isServerOnlyTool("email__decline_reading")).toBe(true);
  expect(isServerOnlyTool("email__scan_status")).toBe(false);
  expect(isServerOnlyTool("corpus__reindex")).toBe(true);
});

test("nothing the member could read speaks of money", () => {
  const mail = mailConversation(ANNA);
  const money = /€|euro|\bcost|price|token|budget|\bcap\b|limit/i;
  const tool = approval.mailToolsFor(mail, ANNA)[0]!;
  expect(tool.description + JSON.stringify(tool.inputSchema)).not.toMatch(/€|euro|\bcost|price|token|budget|\bcap\b/i);
  for (const state of ["pending", "approved", "declined"]) {
    db.run(`UPDATE mail_conversations SET reading = ? WHERE member_id = ?`, [state, ANNA]);
    // The prompt names the subject once, to forbid it; every other word is about reading.
    const section = approval.mailPromptSection(mail, ANNA, "Anna").replace("never speak of what it costs, of a budget, or of limits", "");
    expect(section).not.toMatch(money);
  }
  for (const [locale, t] of Object.entries(opener.MAIL_OPENER_STRINGS)) {
    expect(t.approved, locale).not.toMatch(money);
    expect(t.declined, locale).not.toMatch(money);
  }
  const res = path.join(import.meta.dir, "..", "..", "app", "Maurice", "Resources");
  for (const l of ["en", "fr", "it", "de", "es", "pt", "nl"]) {
    const lines = fs.readFileSync(path.join(res, `${l}.lproj`, "Localizable.strings"), "utf8").split("\n").filter((s) => s.startsWith('"mail.reading.'));
    expect(lines.length, l).toBeGreaterThanOrEqual(8);
    for (const s of lines) expect(s, `${l}: ${s}`).not.toMatch(/€|euro|\bcost|coût|costo|Kosten|preis|prix|token|budget/i);
  }
});
