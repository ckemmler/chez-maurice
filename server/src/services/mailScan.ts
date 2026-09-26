import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAppDir } from "../../lib/appDir";
import { isDue } from "./corpusNightly";
import { memberLocale } from "./domainBriefs";
import { describeCost, mailOpeningTitle, readingCost, renderMailOpening, type ReadingEstimate } from "./mailOpener";
import { corpusCall } from "./mcpClient";
import { openConversation, type OpenRequest, type OpenResult } from "./openedConversations";
import { listUsers } from "./users";
import { backfillMailConversations, linkMailConversation } from "./mailApproval";
import { readingWanted, runMailReading } from "./mailReading";
import { writeMailDocuments } from "./mailDocuments";

// The header walk, driven from the server (specs/mail-import.md, the wiring
// of lot 1, settled 26 September 2026).
//
// The `email` tool walks a member's mailboxes into their header store —
// free, no body read, one SQLite file per member that nothing else writes.
// Three moments start it, all through the tool, as the member:
//
// 1. As soon as a mail account is created: after the login check succeeded
//    in POST /api/mail-accounts, without a prior "yes" — it costs nothing,
//    reads no body and writes only the member's own file. Fire-and-forget:
//    a first pass over years of mail outlives any request.
// 2. Every night at 03:00 local, at the same rendezvous as the corpus
//    (services/corpusNightly.ts, same shape: start, then poll `scan_status`
//    until `running` goes false), to finish an interrupted pass and pick up
//    the new mail from the cursor.
// 3. On demand, by `scan_mailbox` in a conversation or by the button in
//    Settings → Mail, which reads GET /api/mail-accounts/scan.
//
// Once a member's walk is done, the night goes on with the free work of
// lot 2, through the same tool: a reconciliation once a week (the store
// trimmed to what the mailbox still holds, by relisting UIDs), the triage
// (bulk or correspondence, from the headers), the calibration (a hundred
// bodies sampled and counted, nothing kept) and the estimate. And then,
// once per member, Maurice opens a conversation with the numbers and the
// question — settled 26 September 2026: opened late, only when the walk
// is done; numbers and nothing else; past the opening guard, this once.
// The "yes" is lot 3 (services/mailApproval.ts): the conversation opened
// here is linked to its member in `mail_conversations`, which is what
// grants the tool that takes the yes.
//
// The nightly keeps its last run, and per member the last reconciliation
// and the conversation opened, in a small file on the app dir, like the
// corpus's, so a restart at 03:30 does not redo a run from 03:05.

const HOUR = 3;
const TICK_MS = 10 * 60 * 1000;
const FIRST_TICK_MS = 45_000;
const POLL_MS = 20_000;
const MAX_WAIT_MS = 4 * 60 * 60 * 1000;

/** What the app and the nightly read of a member's walk: the tool's answer,
 *  flattened. `state` is the job's (`running`, `paused`, `done`, `failed`),
 *  `idle` when the store has no job yet, `none` when the member has no mail
 *  account at all. */
export interface ScanView {
  state: "running" | "paused" | "done" | "failed" | "idle" | "none";
  running: boolean;
  /** Rows in the member's header store, and where they were seen. */
  messages: number;
  locations: number;
  /** The current or last job's counts. */
  seen: number;
  written: number;
  job_id: string | null;
  started_at: string | null;
  updated_at: string | null;
  last_error: string | null;
  /** The tool's own words when it refused or failed to answer. */
  error: string | null;
  /** The member's word on the reading (lot 3): `pending` until asked and
   *  answered, then `approved` or `declined` — and, once lot 4 runs it,
   *  the job's own states. `decided_at` is when the word was given. */
  reading: { state: string; decided_at: string | null; years: number | null; job_id: string } | null;
}

/** What the run needs from the world, replaceable by a test. */
export interface MailScanDeps {
  /** Call an `email` tool as the member; the tool's JSON, parsed. */
  call: (memberId: string, tool: string, args: any) => Promise<any>;
  members: () => { id: string }[];
  open: (req: OpenRequest) => Promise<OpenResult>;
  locale: (memberId: string) => string;
  now?: () => Date;
  pollMs?: number;
  maxWaitMs?: number;
  /** The reading passes (services/mailReading.ts); a test stubs them. */
  read?: (memberId: string) => Promise<{ outcome: string; judged: number; read: number; cost: number; error: string | null }>;
  wantsReading?: (memberId: string) => boolean;
  /** The documents (services/mailDocuments.ts), after a reading that read. */
  document?: (memberId: string) => Promise<{ outcome: string; written: unknown[]; cost: number; error: string | null }>;
}

const RECONCILE_EVERY_MS = 7 * 24 * 60 * 60 * 1000;

/** The gateway namespaces the tool's calls `email__<tool>`; corpusCall
 *  passes a name that already carries its family through unchanged. */
const emailCall = (memberId: string, tool: string, args: any) => corpusCall(memberId, `email__${tool}`, args ?? {});

/** Call an `email` tool as the member through whatever the deps say — the
 *  gateway, or a test's stub. What the approval (services/mailApproval.ts)
 *  uses, so a test of the yes swaps the same thing as a test of the night. */
export function mailToolCall(memberId: string, tool: string, args: any): Promise<any> {
  return deps.call(memberId, tool, args ?? {});
}

const defaultDeps: MailScanDeps = {
  call: emailCall, members: () => listUsers(), open: openConversation, locale: memberLocale,
  read: (memberId) => runMailReading(memberId), wantsReading: readingWanted,
  document: (memberId) => writeMailDocuments(memberId),
};
let deps: MailScanDeps = defaultDeps;

/** Tests swap the gateway and the member list for stubs. */
export function setMailScanDeps(d: Partial<MailScanDeps> | null): void {
  deps = d ? { ...defaultDeps, ...d } : defaultDeps;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── Reading the tool ─────────────────────────────────────────────────────

/** "AccessDenied: you have no mail account set up — …": the tool's answer
 *  to a member with nothing to walk. Not a failure, nothing to do. */
export function isNoAccount(error: unknown): boolean {
  return typeof error === "string" && /^AccessDenied\b/.test(error) && /no mail account/.test(error);
}

/** Flatten what `scan_status` (or `scan_mailbox`) answered. */
export function scanView(payload: any): ScanView {
  const error = payload?.error ?? payload?.raw ?? null;
  const job = payload?.job ?? null;
  const counts = job?.counts ?? {};
  const totals = payload?.totals ?? {};
  const state: ScanView["state"] = error
    ? isNoAccount(error) ? "none" : "failed"
    : job?.state === "running" || job?.state === "paused" || job?.state === "done" || job?.state === "failed"
      ? job.state
      : "idle";
  return {
    state,
    running: state === "running",
    messages: Number(totals.messages ?? 0),
    locations: Number(totals.locations ?? 0),
    seen: Number(counts.seen ?? 0),
    written: Number(counts.written ?? 0),
    job_id: job?.id ?? null,
    started_at: job?.created_at ?? null,
    updated_at: job?.updated_at ?? null,
    last_error: job?.last_error ?? null,
    error: error ? String(error) : null,
    reading: readingView(payload?.reading),
  };
}

function readingView(job: any): ScanView["reading"] {
  if (!job || typeof job !== "object" || !job.id) return null;
  const years = job.cursor && typeof job.cursor === "object" ? Number(job.cursor.years) : NaN;
  return { state: String(job.state), decided_at: job.updated_at ?? null, years: Number.isFinite(years) ? years : null, job_id: String(job.id) };
}

/** The member's walk as it stands. Never throws: a gateway that cannot be
 *  reached is a `failed` view with the reason. */
export async function mailScanStatus(memberId: string): Promise<ScanView> {
  try {
    return scanView(await deps.call(memberId, "scan_status", {}));
  } catch (err) {
    return scanView({ error: `the mail tool could not be reached: ${(err as Error).message}` });
  }
}

/** Start (or join) the member's walk; the view right after. */
export async function startMailScan(memberId: string): Promise<ScanView> {
  try {
    const started = await deps.call(memberId, "scan_mailbox", {});
    if (started?.error || started?.raw) return scanView(started);
    // The start answers with the job alone; the totals come from the status.
    return scanView(await deps.call(memberId, "scan_status", {}));
  } catch (err) {
    return scanView({ error: `the mail tool could not be reached: ${(err as Error).message}` });
  }
}

/** After an account is added: start the walk and do not wait for it. */
export function startMailScanInBackground(memberId: string): void {
  startMailScan(memberId)
    .then((v) => {
      if (v.error) console.warn(`[mail] scan for ${memberId} not started: ${v.error}`);
      else console.log(`[mail] scan for ${memberId}: ${v.state} (${v.messages} message(s) in the store)`);
    })
    .catch((err) => console.warn(`[mail] scan for ${memberId}: ${(err as Error).message}`));
}

// ── The night ────────────────────────────────────────────────────────────

export type MailNightlyOutcome = "off" | "walked" | "failed" | "no_members";

export interface MailNightlyStats {
  members: number;
  /** Members whose walk ran to its end tonight. */
  walked: number;
  /** Members with no mail account. */
  skipped: number;
  /** Members whose walk failed, or outlasted the wait. */
  failed: number;
  /** Rows in every store, added up. */
  messages: number;
  /** Stores reconciled tonight (weekly). */
  reconciled: number;
  /** Conversations opened tonight with the numbers. */
  opened: number;
  /** Members whose reading ran tonight (lot 4), and what it got through. */
  reading?: { members: number; judged: number; read: number; cost: number };
  /** Notes written tonight from the readings (lot 5). */
  documents?: { members: number; notes: number; cost: number };
}

/** What the night remembers of one member. */
export interface MemberMailState {
  reconciled_at: string | null;
  /** The conversation with the numbers, opened once; null until then. */
  announced_at: string | null;
  conversation_id: string | null;
}

export interface MailNightlyState {
  last_run_at: string | null;
  last_outcome: MailNightlyOutcome | null;
  last_error: string | null;
  last_stats: MailNightlyStats | null;
  duration_ms: number | null;
  members: Record<string, MemberMailState>;
}

let inflight: Promise<MailNightlyOutcome> | null = null;
let state: MailNightlyState | null = null;

export function mailNightlyOn(): boolean {
  if (process.env.MAURICE_MAIL_NIGHTLY?.trim() === "off") return false;
  if (process.env.NODE_ENV === "test") return false;
  return true;
}

function stateFile(): string {
  return join(getAppDir(), "mail-nightly.json");
}

function loadState(): MailNightlyState {
  if (state) return state;
  try {
    if (existsSync(stateFile())) {
      state = JSON.parse(readFileSync(stateFile(), "utf8"));
      return state!;
    }
  } catch {
    // A corrupt state file costs one extra run, nothing more.
  }
  state = { last_run_at: null, last_outcome: null, last_error: null, last_stats: null, duration_ms: null, members: {} };
  return state;
}

function memberState(memberId: string): MemberMailState {
  const st = loadState();
  st.members ??= {};
  return (st.members[memberId] ??= { reconciled_at: null, announced_at: null, conversation_id: null });
}

function saveState(next: MailNightlyState): void {
  state = next;
  try {
    mkdirSync(dirname(stateFile()), { recursive: true });
    writeFileSync(stateFile(), JSON.stringify(next, null, 2) + "\n");
  } catch (err) {
    console.warn(`[mail] nightly: could not save state: ${(err as Error).message}`);
  }
}

/** Tests only: forget the state so a night starts from nothing. */
export function _resetMailNightlyState(): void {
  state = { last_run_at: null, last_outcome: null, last_error: null, last_stats: null, duration_ms: null, members: {} };
}

export function mailNightlyStatus(): MailNightlyState & { on: boolean; running: boolean } {
  return { ...loadState(), on: mailNightlyOn(), running: inflight !== null };
}

/** Due once per local day from 03:00 on — the corpus's rule, at its hour. */
export function isMailNightlyDue(now: Date, lastRunAt: string | null): boolean {
  return isDue(now, lastRunAt, HOUR);
}

/** Walk one member's mailboxes to the end: start (or join), then read the
 *  status until the job is no longer running. `skipped` is a member with no
 *  account; a walk that outlasts the wait carries on without us and is
 *  reported as failed tonight. */
export async function walkMailbox(memberId: string, d: MailScanDeps = deps): Promise<{ view: ScanView; skipped: boolean }> {
  const started = await d.call(memberId, "scan_mailbox", {});
  if (started?.error || started?.raw) {
    const view = scanView(started);
    if (view.state === "none") return { view, skipped: true };
    throw new Error(view.error ?? "scan_mailbox failed");
  }
  const pollMs = d.pollMs ?? POLL_MS;
  const deadline = Date.now() + (d.maxWaitMs ?? MAX_WAIT_MS);
  for (;;) {
    await sleep(pollMs);
    const view = scanView(await d.call(memberId, "scan_status", {}));
    if (view.error) throw new Error(view.error);
    if (!view.running) return { view, skipped: false };
    if (Date.now() > deadline) throw new Error("the header walk is still going after the wait limit; it carries on without us");
  }
}

/** Poll `scan_status` until nothing runs on the store any more. */
async function waitIdle(memberId: string, d: MailScanDeps): Promise<ScanView> {
  const pollMs = d.pollMs ?? POLL_MS;
  const deadline = Date.now() + (d.maxWaitMs ?? MAX_WAIT_MS);
  for (;;) {
    await sleep(pollMs);
    const view = scanView(await d.call(memberId, "scan_status", {}));
    if (view.error) throw new Error(view.error);
    if (!view.running) return view;
    if (Date.now() > deadline) throw new Error("the store is still busy after the wait limit; it carries on without us");
  }
}

function failed(r: any, what: string): never {
  throw new Error(`${what}: ${String(r?.error ?? r?.raw ?? "no answer")}`);
}

/** Once a week: trim the store to what the mailbox still holds. */
async function reconcileIfDue(memberId: string, d: MailScanDeps, now: Date): Promise<boolean> {
  const ms = memberState(memberId);
  const last = ms.reconciled_at ? Date.parse(ms.reconciled_at) : NaN;
  if (Number.isFinite(last) && now.getTime() - last < RECONCILE_EVERY_MS) return false;
  const r = await d.call(memberId, "reconcile_mailbox", {});
  if (r?.error || r?.raw) failed(r, "reconcile_mailbox");
  await waitIdle(memberId, d);
  ms.reconciled_at = now.toISOString();
  return true;
}

/** The free work of lot 2, in order; the estimate at the end. */
async function measure(memberId: string, d: MailScanDeps): Promise<ReadingEstimate> {
  const t = await d.call(memberId, "triage_mailbox", {});
  if (t?.error || t?.raw) failed(t, "triage_mailbox");
  const c = await d.call(memberId, "calibrate_reading", {});
  // A window with nothing to read cannot be calibrated, and need not be:
  // the estimate says zero on its own.
  if ((c?.error || c?.raw) && !/nothing to read/.test(String(c.error ?? c.raw))) failed(c, "calibrate_reading");
  const e = await d.call(memberId, "estimate_reading", {});
  if (e?.error || e?.raw) failed(e, "estimate_reading");
  return { ...e, all: t.counts } as ReadingEstimate;
}

/** Open the conversation with the numbers — once per member, and only
 *  when the walk is done. Returns whether one was opened tonight. */
async function announce(memberId: string, est: ReadingEstimate, d: MailScanDeps, now: Date): Promise<boolean> {
  const ms = memberState(memberId);
  if (ms.announced_at) return false;
  const locale = d.locale(memberId);
  const text = renderMailOpening({ locale, estimate: est });
  const opened = await d.open({ memberId, text, title: mailOpeningTitle(locale), force: true });
  if (!opened.ok) throw new Error(`the conversation could not be opened: ${opened.reason}`);
  ms.announced_at = now.toISOString();
  ms.conversation_id = opened.conversation.id;
  // The link that grants the tool taking the yes (services/mailApproval.ts).
  linkMailConversation(memberId, opened.conversation.id);
  // What it would cost is the operator's to know, not the member's.
  console.log(`[mail] nightly: conversation ${opened.conversation.id} opened for ${memberId} with the numbers; ${est.to_read} to read, ${describeCost(readingCost(est))}`);
  return true;
}

async function doRun(d: MailScanDeps): Promise<MailNightlyOutcome> {
  const now = d.now ?? (() => new Date());
  const started = now();
  const finish = (outcome: MailNightlyOutcome, error: string | null, stats: MailNightlyStats | null): MailNightlyOutcome => {
    saveState({
      last_run_at: started.toISOString(),
      last_outcome: outcome,
      last_error: error,
      last_stats: stats,
      duration_ms: now().getTime() - started.getTime(),
      members: loadState().members ?? {},
    });
    return outcome;
  };
  const members = d.members();
  if (!members.length) {
    console.log("[mail] nightly: no members, nothing to walk");
    return finish("no_members", null, null);
  }
  const stats: MailNightlyStats = { members: members.length, walked: 0, skipped: 0, failed: 0, messages: 0, reconciled: 0, opened: 0 };
  let lastError: string | null = null;
  for (const m of members) {
    try {
      const { view, skipped } = await walkMailbox(m.id, d);
      if (skipped) {
        stats.skipped++;
        continue;
      }
      stats.messages += view.messages;
      if (view.state === "done") {
        stats.walked++;
        // The walk is done: the free work, then the numbers, once.
        if (await reconcileIfDue(m.id, d, now())) stats.reconciled++;
        const est = await measure(m.id, d);
        if (await announce(m.id, est, d, now())) stats.opened++;
        // The member said yes (lot 3): the reading passes, as far as the
        // night allows (lot 4). Its own failures are its own; the job says.
        if (d.wantsReading?.(m.id) && d.read) {
          const r = await d.read(m.id);
          stats.reading ??= { members: 0, judged: 0, read: 0, cost: 0 };
          stats.reading.members++;
          stats.reading.judged += r.judged;
          stats.reading.read += r.read;
          stats.reading.cost += r.cost;
          if (r.outcome === "failed" && r.error) {
            lastError = `${m.id}: reading — ${r.error}`;
            console.warn(`[mail] nightly: ${lastError}`);
          }
          // Something was read tonight: the documents (lot 5) — the fiches
          // and digests the new readings allow, in the member's garden.
          if (r.read > 0 && d.document) {
            const w = await d.document(m.id);
            stats.documents ??= { members: 0, notes: 0, cost: 0 };
            stats.documents.members++;
            stats.documents.notes += w.written.length;
            stats.documents.cost += w.cost;
            if (w.outcome === "failed" && w.error) {
              lastError = `${m.id}: documents — ${w.error}`;
              console.warn(`[mail] nightly: ${lastError}`);
            }
          }
        }
      } else {
        // Paused (the member said stop) or failed: named, and tried again
        // tomorrow from the cursor.
        stats.failed++;
        lastError = `${m.id}: ${view.state}${view.last_error ? ` — ${view.last_error}` : ""}`;
        console.warn(`[mail] nightly: ${lastError}`);
      }
    } catch (err) {
      stats.failed++;
      lastError = `${m.id}: ${(err as Error).message}`;
      console.warn(`[mail] nightly: ${lastError}`);
    }
  }
  const ms = now().getTime() - started.getTime();
  console.log(
    `[mail] nightly: ${stats.walked} mailbox(es) walked, ${stats.skipped} member(s) without mail, ${stats.failed} failed, ` +
      `${stats.messages} message(s) in the stores, ${stats.reconciled} reconciled, ${stats.opened} conversation(s) opened` +
      (stats.reading ? `, ${stats.reading.members} reading(s): ${stats.reading.judged} judged, ${stats.reading.read} read, ${stats.reading.cost.toFixed(3)} €` : "") +
      (stats.documents ? `, ${stats.documents.notes} note(s) written for ${stats.documents.members} member(s), ${stats.documents.cost.toFixed(3)} €` : "") +
      `, in ${Math.round(ms / 1000)}s`,
  );
  return finish(stats.failed ? "failed" : "walked", lastError, stats);
}

/** Walk every member's mailboxes now. Never throws; a run already going is
 *  shared rather than doubled. */
export function runMailNightly(d: MailScanDeps = deps): Promise<MailNightlyOutcome> {
  if (!inflight) {
    inflight = doRun(d).finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

/** Tick every ten minutes; run once per local day from HOUR on. */
export function scheduleMailNightly(): void {
  // The conversations opened before `mail_conversations` existed are linked
  // from the night's own record, once; nothing to do afterwards.
  try {
    const added = backfillMailConversations(loadState().members);
    if (added) console.log(`[mail] ${added} mail conversation(s) linked from the nightly record`);
  } catch (err) {
    console.warn(`[mail] could not link the mail conversations: ${(err as Error).message}`);
  }
  if (!mailNightlyOn()) {
    console.log("[mail] nightly header walk off");
    return;
  }
  const tick = () => {
    if (inflight) return;
    if (!isMailNightlyDue(new Date(), loadState().last_run_at)) return;
    runMailNightly().catch((err) => console.error(`[mail] nightly: ${(err as Error).message}`));
  };
  setTimeout(() => {
    tick();
    setInterval(tick, TICK_MS).unref();
  }, FIRST_TICK_MS).unref();
}
