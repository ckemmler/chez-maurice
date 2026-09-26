// The header walk, driven from the server (services/mailScan.ts). What is
// held down: adding a mail account starts the walk as that member, without
// waiting for it; the nightly walks every member and polls the tool until
// the job is no longer running, skips a member with no mail, records a
// failure by name; "due" is the corpus's rule at 03:00; the view the app
// reads flattens the tool's answer, with `none` for a member without mail;
// and once a walk is done the night reconciles weekly, triages, calibrates,
// estimates, and opens the conversation with the numbers — once, and only
// when the walk is done.

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";

const db = (await import("../src/db")).default;
const accountsSvc = await import("../src/services/mailAccounts");
const routes = (await import("../src/routes/mailAccounts")).default;
const scan = await import("../src/services/mailScan");
const { createSession } = await import("../src/services/auth");

const ANNA = "ms-anna";
let annaAuth = "";

interface Call { member: string; tool: string; args: any }
let calls: Call[] = [];

const NO_ACCOUNT = { error: "AccessDenied: you have no mail account set up — add one in the app, Settings → Mail" };

const TRIAGE = { messages: 100, counts: { bulk: 60, correspondence: 30, other: 10 } };
const ESTIMATE = {
  years: 3, messages: 100, window: { messages: 40, bulk: 20, correspondence: 15, other: 5 }, to_read: 20,
  tokens: { light: 4000, full: 30000 }, nights: { low: 1, high: 2, per_night: 1500 },
};

/** A gateway whose tool answers are scripted per member; the free work of
 *  lot 2 answers by default. */
function gateway(answers: (member: string, tool: string) => any) {
  return async (member: string, tool: string, args: any) => {
    calls.push({ member, tool, args });
    const r = answers(member, tool);
    if (r !== undefined) return r;
    if (tool === "triage_mailbox") return TRIAGE;
    if (tool === "calibrate_reading") return { sampled: 100 };
    if (tool === "estimate_reading") return ESTIMATE;
    if (tool === "reconcile_mailbox") return { status: "started", job: { id: "rec_1", kind: "reconcile", state: "running" } };
    throw new Error(`unexpected tool ${tool}`);
  };
}

let opened: any[] = [];
const night = (d: Partial<Parameters<typeof scan.runMailNightly>[0]>) => ({
  open: async (req: any) => {
    opened.push(req);
    return { ok: true as const, conversation: { id: `conv_${opened.length}` } as any, message: {} as any };
  },
  locale: () => "fr",
  pollMs: 5,
  ...d,
} as Parameters<typeof scan.runMailNightly>[0]);

const running = (n: number) => ({ running: true, job: { id: "job_1", state: "running", counts: { seen: n, written: n } }, totals: { messages: n, locations: n } });
const done = (n: number) => ({ running: false, job: { id: "job_1", state: "done", counts: { seen: n, written: n }, last_error: null }, totals: { messages: n, locations: n } });

beforeAll(() => {
  db.run(`INSERT OR IGNORE INTO households (id, name) VALUES ('default', 'Home')`);
  db.run(`INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES (?, ?, ?, 'standard')`, [ANNA, ANNA, "Anna"]);
  annaAuth = `Bearer ${createSession(ANNA).token}`;
  accountsSvc.setChecker(async () => ({ state: "ok", error: null }));
});

afterAll(() => {
  accountsSvc.setChecker(null);
  scan.setMailScanDeps(null);
});

beforeEach(() => {
  calls = [];
  opened = [];
  scan._resetMailNightlyState();
  db.run(`DELETE FROM mail_accounts WHERE member_id = ?`, [ANNA]);
});

function req(path: string, init: RequestInit = {}) {
  return routes.request(path, { ...init, headers: { Authorization: annaAuth, "Content-Type": "application/json", ...(init.headers ?? {}) } });
}

test("adding a mailbox starts the walk as that member, without waiting for it", async () => {
  scan.setMailScanDeps({ call: gateway((_m, tool) => (tool === "scan_mailbox" ? { status: "started", job: { id: "job_1", state: "running" } } : running(12))) });
  const res = await req("/", { method: "POST", body: JSON.stringify({ address: "anna@gmail.com", password: "good" }) });
  expect(res.status).toBe(201);
  await new Promise((r) => setTimeout(r, 20));
  expect(calls[0]).toMatchObject({ member: ANNA, tool: "scan_mailbox", args: {} });
});

test("a mailbox that refuses the login starts nothing", async () => {
  accountsSvc.setChecker(async () => ({ state: "error", error: "LoginError: Authentication Failed" }));
  try {
    scan.setMailScanDeps({ call: gateway(() => running(0)) });
    const res = await req("/", { method: "POST", body: JSON.stringify({ address: "anna@gmail.com", password: "bad" }) });
    expect(res.status).toBe(422);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toHaveLength(0);
  } finally {
    accountsSvc.setChecker(async () => ({ state: "ok", error: null }));
  }
});

test("the app reads a flat view of the walk, and `none` for a member without mail", async () => {
  scan.setMailScanDeps({ call: gateway(() => done(164194)) });
  const view = await (await req("/scan")).json();
  expect(view).toMatchObject({ state: "done", running: false, messages: 164194, seen: 164194, job_id: "job_1", error: null });

  scan.setMailScanDeps({ call: gateway(() => NO_ACCOUNT) });
  expect((await (await req("/scan")).json()).state).toBe("none");

  scan.setMailScanDeps({ call: gateway(() => ({ running: false, job: null, totals: { messages: 0, locations: 0 } })) });
  expect((await (await req("/scan")).json()).state).toBe("idle");

  scan.setMailScanDeps({ call: async () => { throw new Error("ECONNREFUSED"); } });
  const down = await (await req("/scan")).json();
  expect(down.state).toBe("failed");
  expect(down.error).toContain("ECONNREFUSED");
});

test("the button starts the walk again and answers with the status", async () => {
  scan.setMailScanDeps({ call: gateway((_m, tool) => (tool === "scan_mailbox" ? { status: "started", job: { id: "job_2", state: "running" } } : running(3))) });
  const view = await (await req("/scan", { method: "POST" })).json();
  expect(calls.map((c) => c.tool)).toEqual(["scan_mailbox", "scan_status"]);
  expect(view).toMatchObject({ state: "running", running: true, messages: 3 });
});

test("due once per local day, from three o'clock on", () => {
  const at = (h: number, day = 26) => new Date(2026, 8, day, h, 5);
  expect(scan.isMailNightlyDue(at(2), null)).toBe(false);
  expect(scan.isMailNightlyDue(at(3), null)).toBe(true);
  expect(scan.isMailNightlyDue(at(3), at(3, 25).toISOString())).toBe(true);
  expect(scan.isMailNightlyDue(at(9), at(3).toISOString())).toBe(false);
  expect(scan.mailNightlyOn()).toBe(false); // off under test
});

test("the night walks every member with mail, polls to the end, skips the others", async () => {
  const polls: Record<string, number> = {};
  const deps = night({
    members: () => [{ id: "m-anna" }, { id: "m-nomail" }, { id: "m-ben" }],
    call: gateway((m, tool) => {
      if (m === "m-nomail") return NO_ACCOUNT;
      if (tool === "scan_mailbox") return { status: "started", job: { id: `job_${m}`, state: "running" } };
      if (tool !== "scan_status") return undefined;
      polls[m] = (polls[m] ?? 0) + 1;
      // The walk's three polls; a reconciliation's status is idle at once.
      return polls[m]! < 3 ? running(100) : done(m === "m-anna" ? 1000 : 20);
    }),
  });
  expect(await scan.runMailNightly(deps)).toBe("walked");
  expect(calls.filter((c) => c.tool === "scan_mailbox").map((c) => c.member)).toEqual(["m-anna", "m-nomail", "m-ben"]);
  expect(calls.filter((c) => c.member === "m-nomail")).toHaveLength(1); // no status asked of a member without mail
  expect(polls).toEqual({ "m-anna": 4, "m-ben": 4 }); // three for the walk, one for the reconciliation
  // After each walk: reconcile (first night), triage, calibrate, estimate.
  expect(calls.filter((c) => c.member === "m-ben").map((c) => c.tool)).toEqual([
    "scan_mailbox", "scan_status", "scan_status", "scan_status",
    "reconcile_mailbox", "scan_status", "triage_mailbox", "calibrate_reading", "estimate_reading",
  ]);
  const s = scan.mailNightlyStatus();
  expect(s.last_outcome).toBe("walked");
  expect(s.last_stats).toEqual({ members: 3, walked: 2, skipped: 1, failed: 0, messages: 1020, reconciled: 2, opened: 2 });
  expect(opened.map((o) => o.memberId)).toEqual(["m-anna", "m-ben"]);
  expect(s.members["m-anna"]).toMatchObject({ conversation_id: "conv_1" });
  expect(s.members["m-anna"]!.reconciled_at && s.members["m-anna"]!.announced_at).toBeTruthy();
  expect(s.last_error).toBeNull();
  expect(s.running).toBe(false);
});

test("a member's walk that fails, or outlasts the wait, is named and does not stop the others", async () => {
  const deps = night({
    members: () => [{ id: "m-anna" }, { id: "m-ben" }],
    maxWaitMs: 20,
    call: gateway((m, tool) => {
      if (tool === "scan_mailbox") return { status: "started", job: { id: "j", state: "running" } };
      if (m === "m-anna") return { running: false, job: { id: "j", state: "failed", counts: {}, last_error: "anna@icloud.com: refused" }, totals: { messages: 5, locations: 5 } };
      return running(1);
    }),
  });
  expect(await scan.runMailNightly(deps)).toBe("failed");
  const s = scan.mailNightlyStatus();
  expect(s.last_stats).toMatchObject({ walked: 0, failed: 2, messages: 5, opened: 0 });
  expect(s.last_error).toContain("m-ben");
  expect(s.last_error).toContain("still going");
  // Anna's failure was logged by name before Ben's; both were tried — and
  // nothing was opened: the conversation waits for a walk that is done.
  expect(calls.filter((c) => c.tool === "scan_mailbox").map((c) => c.member)).toEqual(["m-anna", "m-ben"]);
  expect(opened).toHaveLength(0);
  expect(calls.some((c) => c.tool === "triage_mailbox")).toBe(false);
});

test("a run already going is shared, not doubled", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const deps = night({
    members: () => [{ id: "m-anna" }],
    pollMs: 1,
    call: gateway((_m, tool) => (tool === "scan_mailbox" ? gate.then(() => ({ status: "started", job: { state: "running" } })) : tool === "scan_status" ? done(1) : undefined)),
  });
  const first = scan.runMailNightly(deps);
  const second = scan.runMailNightly(deps);
  expect(scan.mailNightlyStatus().running).toBe(true);
  release();
  expect(await first).toBe("walked");
  expect(await second).toBe("walked");
  expect(calls.filter((c) => c.tool === "scan_mailbox")).toHaveLength(1);
});

test("a household with no members does nothing and says so", async () => {
  expect(await scan.runMailNightly(night({ members: () => [], call: gateway(() => done(0)) }))).toBe("no_members");
  expect(calls).toHaveLength(0);
});

test("the conversation opens once, when the walk is done, past the guard, with numbers only", async () => {
  const deps = night({
    members: () => [{ id: "m-anna" }],
    call: gateway((_m, tool) => (tool === "scan_mailbox" ? { status: "started", job: { id: "j", state: "running" } } : tool === "scan_status" ? done(100) : undefined)),
  });
  expect(await scan.runMailNightly(deps)).toBe("walked");
  expect(opened).toHaveLength(1);
  const req = opened[0];
  expect(req).toMatchObject({ memberId: "m-anna", force: true, title: "Ta boîte mail, en chiffres" });
  expect(req.text).toContain("100 messages, dont 30 de correspondance");
  expect(req.text).toContain("Sur les 3 dernières années : 40 messages, dont 15 de correspondance");
  expect(req.text).toContain("une ou deux nuits");
  expect(req.text).toContain("Je lis ? Oui ou non.");
  expect(req.text).not.toMatch(/@/); // nobody is named
  // The second night: the walk is done again, nothing is opened again, and
  // the reconciliation waits for its week.
  calls = [];
  expect(await scan.runMailNightly(deps)).toBe("walked");
  expect(opened).toHaveLength(1);
  expect(calls.map((c) => c.tool)).toEqual(["scan_mailbox", "scan_status", "triage_mailbox", "calibrate_reading", "estimate_reading"]);
  expect(scan.mailNightlyStatus().last_stats).toMatchObject({ reconciled: 0, opened: 0 });
});

test("a walk still running at the end of the wait opens nothing; a paused one neither", async () => {
  const paused = night({
    members: () => [{ id: "m-anna" }],
    call: gateway((_m, tool) => (tool === "scan_mailbox" ? { status: "started", job: { id: "j", state: "running" } }
      : tool === "scan_status" ? { running: false, job: { id: "j", state: "paused", counts: {} }, totals: { messages: 50, locations: 50 } } : undefined)),
  });
  expect(await scan.runMailNightly(paused)).toBe("failed");
  expect(opened).toHaveLength(0);
  expect(scan.mailNightlyStatus().last_error).toContain("paused");
});

test("a calibration with nothing to read does not stop the numbers", async () => {
  const deps = night({
    members: () => [{ id: "m-anna" }],
    call: gateway((_m, tool) => {
      if (tool === "scan_mailbox") return { status: "started", job: { id: "j", state: "running" } };
      if (tool === "scan_status") return done(3);
      if (tool === "calibrate_reading") return { error: "MailboxError: no body could be sampled: nothing to read in the window" };
      if (tool === "estimate_reading") return { ...ESTIMATE, to_read: 0, tokens: null, nights: { low: 0, high: 0 } };
      return undefined;
    }),
  });
  expect(await scan.runMailNightly(deps)).toBe("walked");
  expect(opened[0].text).toContain("Il n'y a rien à lire");
});
