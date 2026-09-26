/**
 * The two reading passes (services/mailReading.ts, lot 4 of
 * specs/mail-import.md). Nailed down, against a stubbed tool and a stubbed
 * model: the light pass asks in batches of twenty with previews only and
 * records keep or skip for every id (a missing verdict is kept); the full
 * pass reads each kept message whole and records one structured reading in
 * the member's language; every call lands on the ledger as the member under
 * the job's id; the household's cap pauses the run before the call, a limit
 * or the clock pauses it with work left, the end of the window is `done`,
 * and a tool that fails leaves the job `failed` with the reason; the night
 * reads only for a member whose word is yes; the admin route starts a run
 * by hand; and the four tool words are never a model's.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";

const db = (await import("../src/db")).default;
const reading = await import("../src/services/mailReading");
const approval = await import("../src/services/mailApproval");
const scan = await import("../src/services/mailScan");
const budget = await import("../src/services/budget");
const { addModel } = await import("../src/services/models");
const { pinNewInvocations } = await import("../src/services/ancillary");
const { isServerOnlyTool } = await import("../src/services/toolFamilies");
const { createSession } = await import("../src/services/auth");
const { createConversation } = await import("../src/services/conversations");
const admin = (await import("../src/routes/admin")).default;

const ANNA = "mr-anna";
const BOSS = "mr-admin";
const LIGHT = "mistral-small-3.2-24b-instruct-2506";
const FULL = "mistral-medium-3.5-128b";

/** The member's store, as a stub: the window's messages and what the passes leave. */
interface Row { id: string; light: "keep" | "skip" | null; reading: any | null; preview: string; body: string }
let rows: Row[] = [];
let job: { id: string; state: string; counts: any; last_error: string | null } | null = null;
let capacity: any[] = [];
let calls: Array<{ tool: string; args: any }> = [];
let writes: Array<{ invocation: string; prompt: string; system: string }> = [];
let refuseNext = 0;

function progress() {
  return {
    messages: rows.length,
    to_light: rows.filter((r) => !r.light).length,
    kept: rows.filter((r) => r.light === "keep").length,
    skipped: rows.filter((r) => r.light === "skip").length,
    to_read: rows.filter((r) => r.light === "keep" && !r.reading).length,
    read: rows.filter((r) => !!r.reading).length,
  };
}

async function tool(_member: string, name: string, args: any) {
  calls.push({ tool: name, args });
  if (name === "reading_progress") return { job, progress: progress(), capacity: capacity.at(-1) ?? null };
  if (!job || job.state === "declined") return { error: "AccessDenied: the member has not approved the reading of their mail" };
  if (name === "reading_next") {
    if (refuseNext > 0) { refuseNext--; return { stage: args.stage, messages: [], missing: ["x"], errors: ["INBOX: boom"], progress: progress() }; }
    const pick = (args.stage === "light" ? rows.filter((r) => !r.light) : rows.filter((r) => r.light === "keep" && !r.reading)).slice(0, args.limit);
    return {
      stage: args.stage,
      messages: pick.map((r) => ({ id: r.id, from: `Ami <${r.id}@example.org>`, to: ["anna@x"], cc: [], date: "2026-09-01", subject: `Sujet ${r.id}`, ...(args.stage === "light" ? { preview: r.preview } : { body: r.body, truncated: false }) })),
      missing: [],
      progress: progress(),
    };
  }
  if (name === "reading_record") {
    for (const v of args.verdicts ?? []) { const r = rows.find((x) => x.id === v.id); if (r) r.light = v.keep ? "keep" : "skip"; }
    for (const v of args.readings ?? []) { const r = rows.find((x) => x.id === v.id); if (r) r.reading = v.reading; }
    job.counts.judged = (job.counts.judged ?? 0) + (args.verdicts?.length ?? 0);
    job.counts.read = (job.counts.read ?? 0) + (args.readings?.length ?? 0);
    return { recorded: { verdicts: args.verdicts?.length ?? 0, readings: args.readings?.length ?? 0 }, job, progress: progress() };
  }
  if (name === "reading_control") {
    job.state = args.state;
    job.last_error = args.error ?? null;
    if (args.measured?.messages) capacity.push(args.measured);
    return { job, capacity: capacity.at(-1) ?? null };
  }
  throw new Error(`unexpected tool ${name}`);
}

const usage = (model: string, input: number, output: number) => ({ provider: "scaleway", model, rounds: 1, input, output, cache_read: 0, cache_write: 0, cost: model === LIGHT ? 0.001 : 0.01, cost_uncached: null });

let lightAnswer: (ids: string[]) => string = (ids) => JSON.stringify({ verdicts: ids.map((id, i) => ({ id, keep: i % 2 === 0, reason: i % 2 === 0 ? "a real exchange" : "a receipt" })) });
let fullAnswer: (prompt: string) => string = (prompt) => JSON.stringify({ summary: `Lu : ${prompt.match(/Subject: (.*)/)?.[1]}`, kind: "personal", people: [{ name: "Ami", address: null, role: "un ami" }], said: ["bonjour"], promised: [], decided: [], asked: [], dates: [], open: [], thread: "le dîner" });

async function write(req: any) {
  writes.push({ invocation: req.invocation, prompt: req.prompt, system: req.system ?? "" });
  if (req.invocation === "mail_read_light") {
    const ids = [...req.prompt.matchAll(/id: (\S+)/g)].map((m) => m[1]);
    return { text: lightAnswer(ids), model: LIGHT, provider: "scaleway", stop: "end" as const, usage: usage(LIGHT, 100 * ids.length, 20 * ids.length) };
  }
  return { text: fullAnswer(req.prompt), model: FULL, provider: "scaleway", stop: "end" as const, usage: usage(FULL, 800, 200) };
}

function seed(n: number) {
  rows = Array.from({ length: n }, (_, i) => ({ id: `m${i + 1}`, light: null, reading: null, preview: `aperçu ${i + 1}`, body: `corps ${i + 1} `.repeat(20) }));
  job = { id: "job_r1", state: "approved", counts: {}, last_error: null };
}

let bossAuth = "";

beforeAll(() => {
  db.run(`INSERT OR IGNORE INTO households (id, name) VALUES ('default', 'Home')`);
  db.run(`INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES (?, ?, ?, 'standard')`, [ANNA, ANNA, "Anna"]);
  db.run(`INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES (?, ?, ?, 'admin')`, [BOSS, BOSS, "Boss"]);
  db.run(`UPDATE households SET default_model = ?, scaleway_api_key = 'k' WHERE id = 'default'`, [FULL]);
  for (const id of [LIGHT, FULL]) addModel({ id, name: id, tier: "cloud", vendor: "mistral", provider: "scaleway" });
  // What the boot does for a new invocation with a preference: the light pass lands on mistral-small.
  pinNewInvocations();
  bossAuth = `Bearer ${createSession(BOSS).token}`;
  reading.setMailReadingDeps({ call: tool, write, language: () => "French" });
  scan.setMailScanDeps({ call: tool as any });
});

afterAll(() => {
  reading.setMailReadingDeps(null);
  scan.setMailScanDeps(null);
  budget.setHouseholdDailyCap(null);
  budget.setMemberDailyCap(ANNA, null);
});

beforeEach(() => {
  calls = [];
  writes = [];
  capacity = [];
  refuseNext = 0;
  db.run(`DELETE FROM spend_ledger WHERE user_id = ?`, [ANNA]);
  db.run(`DELETE FROM mail_conversations WHERE member_id = ?`, [ANNA]);
  budget.setHouseholdDailyCap(null);
  budget.setMemberDailyCap(ANNA, null);
  delete process.env.MAURICE_SPEND_CAP_USD;
  delete process.env.MAURICE_SPEND_CAP_DAILY_USD;
});

test("the light pass sorts in batches of twenty on previews, the full pass reads what was kept, both on the ledger under the job", async () => {
  seed(45);
  const r = await reading.runMailReading(ANNA);
  expect(r).toMatchObject({ outcome: "done", job_id: "job_r1", judged: 45, kept: 23, skipped: 22, read: 23, error: null });
  expect(r.models).toEqual({ light: LIGHT, full: FULL });
  // Three light calls (20, 20, 5), each with previews and no body; then one call per kept message.
  const light = writes.filter((w) => w.invocation === "mail_read_light");
  expect(light).toHaveLength(3);
  expect(light[0]!.prompt).toContain("id: m1");
  expect(light[0]!.prompt).toContain("aperçu 1");
  expect(light[0]!.prompt).not.toContain("corps");
  expect(light[0]!.system).toContain("Anna");
  const full = writes.filter((w) => w.invocation === "mail_read_full");
  expect(full).toHaveLength(23);
  expect(full[0]!.prompt).toContain("corps 1");
  expect(full[0]!.system).toContain("Write in French");
  // What the tool kept: the verdicts for every id, the readings shaped and stamped.
  expect(rows.filter((x) => x.light === "keep").map((x) => x.id)).toContain("m1");
  const read = rows.find((x) => x.id === "m1")!.reading;
  expect(read).toMatchObject({ summary: "Lu : Sujet m1", kind: "personal", thread: "le dîner", model: FULL, truncated: false });
  // The ledger: 26 rows, as Anna, all under the job; the caps still see them.
  const ledger = db.query(`SELECT job_id, user_id, model FROM spend_ledger WHERE user_id = ?`).all(ANNA) as any[];
  expect(ledger).toHaveLength(26);
  expect(new Set(ledger.map((l) => l.job_id))).toEqual(new Set(["job_r1"]));
  expect(budget.spentOnJob("job_r1")).toBeCloseTo(3 * 0.001 + 23 * 0.01, 6);
  expect(budget.spentTodayUsd(ANNA)).toBeCloseTo(r.cost, 6);
  // The job: running while it went, done at the end, the run measured.
  expect(calls.filter((c) => c.tool === "reading_control").map((c) => c.args.state)).toEqual(["running", "done"]);
  expect(job!.state).toBe("done");
  expect(capacity).toEqual([{ messages: 68, seconds: expect.any(Number) }]);
});

test("a limit pauses with work left, and the next run carries on from the store", async () => {
  seed(30);
  const first = await reading.runMailReading(ANNA, { limit: 10 });
  expect(first).toMatchObject({ outcome: "paused", judged: 10, read: 5 });
  expect(job!.state).toBe("paused");
  expect(first.progress).toMatchObject({ to_light: 20, to_read: 0, read: 5 });
  const second = await reading.runMailReading(ANNA);
  expect(second).toMatchObject({ outcome: "done", judged: 20, read: 10 });
  expect(progress()).toMatchObject({ to_light: 0, to_read: 0, read: 15 });
  // Nothing left: a third run touches no model and says done.
  writes = [];
  expect((await reading.runMailReading(ANNA)).outcome).toBe("done");
  expect(writes).toHaveLength(0);
});

test("the household's cap stops the run before the call, and the job is paused, not failed", async () => {
  seed(40);
  // Her own cap (the household's sum would carry other suites' rows): the
  // first light call goes, nothing spent yet; the second is refused.
  budget.setMemberDailyCap(ANNA, 0.0005);
  const r = await reading.runMailReading(ANNA);
  expect(r.outcome).toBe("capped");
  expect(r.error).toContain("limit");
  expect(r.judged).toBe(20);
  expect(job!.state).toBe("paused");
  expect(job!.last_error).toContain("limit");
  expect(writes).toHaveLength(1);
});

test("a missing verdict keeps the message; an unusable reading leaves it to read; a tool that fails leaves the job failed", async () => {
  seed(4);
  lightAnswer = (ids) => JSON.stringify({ verdicts: [{ id: ids[0], keep: false, reason: "noise" }] });
  fullAnswer = () => "not json at all";
  const r = await reading.runMailReading(ANNA);
  expect(r).toMatchObject({ outcome: "paused", judged: 4, kept: 3, skipped: 1, read: 0 });
  expect(rows.filter((x) => x.light === "keep")).toHaveLength(3);
  expect(rows.every((x) => !x.reading)).toBe(true);
  lightAnswer = (ids) => JSON.stringify({ verdicts: ids.map((id) => ({ id, keep: true, reason: "" })) });
  fullAnswer = (p) => JSON.stringify({ summary: `ok ${p.match(/Subject: (.*)/)?.[1]}` });
  seed(3);
  const failing = async (m: string, name: string, args: any) => (name === "reading_record" ? { error: "MailboxError: disk full" } : tool(m, name, args));
  const f = await reading.runMailReading(ANNA, {}, { call: failing, write, language: () => "French" });
  expect(f.outcome).toBe("failed");
  expect(f.error).toContain("disk full");
  expect(job!.state).toBe("failed");
  // A failure is tried again: the next run takes the job back to running.
  const again = await reading.runMailReading(ANNA);
  expect(again.outcome).toBe("done");
  expect(job!.state).toBe("done");
});

test("a folder that refuses is retried once, then the pass moves on", async () => {
  seed(5);
  refuseNext = 1;
  const r = await reading.runMailReading(ANNA);
  expect(r.outcome).toBe("done");
  expect(r.judged).toBe(5);
});

test("nothing to do without a yes, or with a declined job", async () => {
  rows = [];
  job = null;
  expect((await reading.runMailReading(ANNA)).outcome).toBe("nothing");
  job = { id: "j", state: "declined", counts: {}, last_error: null };
  expect((await reading.runMailReading(ANNA)).outcome).toBe("nothing");
  expect(writes).toHaveLength(0);
});

test("the night reads for a member whose word is yes, and for nobody else", async () => {
  const c = createConversation(ANNA, null, { openedBy: "maurice" }).id;
  approval.linkMailConversation(ANNA, c);
  expect(reading.readingWanted(ANNA)).toBe(false);
  db.run(`UPDATE mail_conversations SET reading = 'approved' WHERE member_id = ?`, [ANNA]);
  expect(reading.readingWanted(ANNA)).toBe(true);
  db.run(`UPDATE mail_conversations SET reading = 'declined' WHERE member_id = ?`, [ANNA]);
  expect(reading.readingWanted(ANNA)).toBe(false);
});

test("the admin route starts a run by hand and reports it", async () => {
  seed(6);
  const req = (path: string, init: RequestInit = {}) => admin.request(path, { ...init, headers: { Authorization: bossAuth, "Content-Type": "application/json" } });
  const res = await req("/mail/reading/run", { method: "POST", body: JSON.stringify({ username: ANNA, limit: 3, wait: true }) });
  expect(res.status).toBe(200);
  const r = await res.json();
  expect(r).toMatchObject({ outcome: "paused", member_id: ANNA, judged: 3, read: 3 });
  const status = await (await req(`/mail/reading/${ANNA}`)).json();
  expect(status).toMatchObject({ running: false, last: { outcome: "paused", judged: 3 } });
  expect((await req("/mail/reading/run", { method: "POST", body: JSON.stringify({ username: "nobody" }) })).status).toBe(404);
  const bg = await req("/mail/reading/run", { method: "POST", body: JSON.stringify({ member_id: ANNA }) });
  expect(bg.status).toBe(202);
  await new Promise((r) => setTimeout(r, 30));
  expect(job!.state).toBe("done");
});

test("the passes' four tool words are the server's, never a model's", () => {
  for (const t of ["reading_next", "reading_record", "reading_control", "reading_progress"]) expect(isServerOnlyTool(`email__${t}`)).toBe(true);
  expect(isServerOnlyTool("email__search")).toBe(false);
});
