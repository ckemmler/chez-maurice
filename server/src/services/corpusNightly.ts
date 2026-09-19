import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAppDir } from "../../lib/appDir";
import { corpusCall } from "./mcpClient";
import { listUsers } from "./users";

// The corpus reconciles itself every night.
//
// After every reply the server asks the corpus to index that one conversation
// (mcpClient.indexConversationInBackground). That push was the only path into
// the index, and when it broke — a tool called by the wrong name, answered
// "Unknown tool" as ordinary text — nothing noticed for three months: a comment
// in mcpClient.ts called "the periodic backfill" the safety net, and there was
// none. This is the net. Once a night it asks the corpus to reconcile every
// conversation (`index_conversation` with no id: a hash diff per message, so a
// night with nothing new writes nothing) and to prune the file-backed entries
// whose file is gone, one member at a time since a gateway session is scoped
// to one member's store.
//
// It lives in the server rather than in a launchd timer or a cron line because
// the gateway already holds every store open: a second process reconciling
// the same sqlite files would be a second writer, and the container has no
// cron anyway. The same code runs at home and on a hosted household.
//
// The last run is written to a small file on the app dir, so a restart at
// 03:30 after a run at 03:05 does not start over.

const HOUR = 3; // local time — MAURICE_TIMEZONE / TZ in the container
const TICK_MS = 10 * 60 * 1000;
const FIRST_TICK_MS = 30_000;

export type NightlyOutcome = "off" | "reconciled" | "failed" | "no_members";

export interface NightlyStats {
  conversations: number;
  chunks_written: number;
  pruned: number;
  members: number;
}

export interface NightlyState {
  last_run_at: string | null;
  last_outcome: NightlyOutcome | null;
  last_error: string | null;
  last_stats: NightlyStats | null;
  duration_ms: number | null;
}

/** What the run needs from the world, replaceable by a test. */
export interface NightlyDeps {
  call: (memberId: string, tool: string, args: any) => Promise<any>;
  members: () => { id: string }[];
  now?: () => Date;
  /** How often to ask the corpus whether the full pass is done. */
  pollMs?: number;
  /** Give up waiting after this long; the corpus keeps working regardless. */
  maxWaitMs?: number;
}

const defaultDeps: NightlyDeps = { call: corpusCall, members: () => listUsers() };
const POLL_MS = 15_000;
const MAX_WAIT_MS = 3 * 60 * 60 * 1000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Ask the corpus to reconcile every conversation and wait for it to finish.
 *  The tool starts the pass in the background and returns at once — a first
 *  pass on years of conversations outlives any request timeout, which is how
 *  the first run by hand on 19 September 2026 ended — so the outcome is read
 *  from `reconcile_status` until `running` goes false. A corpus older than
 *  that answers the counts directly, and those are taken as they come. */
async function reconcileAll(deps: NightlyDeps, memberId: string): Promise<{ conversations: number; chunks_written: number }> {
  const r = await deps.call(memberId, "index_conversation", {});
  if (r?.error || r?.raw) throw new Error(String(r.error ?? r.raw));
  if (r?.status !== "started" && r?.status !== "running") {
    return { conversations: Number(r?.conversations ?? 0), chunks_written: Number(r?.chunks_written ?? 0) };
  }
  const pollMs = deps.pollMs ?? POLL_MS;
  const deadline = Date.now() + (deps.maxWaitMs ?? MAX_WAIT_MS);
  for (;;) {
    await sleep(pollMs);
    const s = await deps.call(memberId, "reconcile_status", {});
    if (s?.error || s?.raw) throw new Error(String(s.error ?? s.raw));
    if (!s?.running) {
      if (s?.error) throw new Error(String(s.error));
      return { conversations: Number(s?.conversations ?? 0), chunks_written: Number(s?.chunks_written ?? 0) };
    }
    if (Date.now() > deadline) throw new Error("the corpus is still reconciling after the wait limit; it carries on without us");
  }
}

let inflight: Promise<NightlyOutcome> | null = null;
let state: NightlyState | null = null;

export function nightlyOn(): boolean {
  if (process.env.MAURICE_CORPUS_NIGHTLY?.trim() === "off") return false;
  if (process.env.NODE_ENV === "test") return false;
  return true;
}

function stateFile(): string {
  return join(getAppDir(), "corpus-nightly.json");
}

function loadState(): NightlyState {
  if (state) return state;
  try {
    if (existsSync(stateFile())) {
      state = JSON.parse(readFileSync(stateFile(), "utf8"));
      return state!;
    }
  } catch {
    // A corrupt state file costs one extra run, nothing more.
  }
  state = { last_run_at: null, last_outcome: null, last_error: null, last_stats: null, duration_ms: null };
  return state;
}

function saveState(next: NightlyState): void {
  state = next;
  try {
    mkdirSync(dirname(stateFile()), { recursive: true });
    writeFileSync(stateFile(), JSON.stringify(next, null, 2) + "\n");
  } catch (err) {
    console.warn(`[corpus] nightly: could not save state: ${(err as Error).message}`);
  }
}

export function corpusNightlyStatus(): NightlyState & { on: boolean; running: boolean } {
  return { ...loadState(), on: nightlyOn(), running: inflight !== null };
}

/** The local calendar day, the unit a nightly run is counted in. */
function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Due once per local day, from HOUR onwards. A server that was down at HOUR
 *  runs it when it comes back rather than skipping the day. */
export function isDue(now: Date, lastRunAt: string | null, hour = HOUR): boolean {
  if (now.getHours() < hour) return false;
  if (!lastRunAt) return true;
  const last = new Date(lastRunAt);
  return Number.isNaN(last.getTime()) || localDay(last) !== localDay(now);
}

async function doRun(deps: NightlyDeps): Promise<NightlyOutcome> {
  const now = deps.now ?? (() => new Date());
  const started = now();
  const members = deps.members();
  const finish = (outcome: NightlyOutcome, error: string | null, stats: NightlyStats | null): NightlyOutcome => {
    saveState({
      last_run_at: started.toISOString(),
      last_outcome: outcome,
      last_error: error,
      last_stats: stats,
      duration_ms: now().getTime() - started.getTime(),
    });
    return outcome;
  };
  if (!members.length) {
    console.log("[corpus] nightly: no members, nothing to reconcile");
    return finish("no_members", null, null);
  }
  const stats: NightlyStats = { conversations: 0, chunks_written: 0, pruned: 0, members: members.length };
  try {
    // One pass reconciles every conversation for every participant; the member
    // it is scoped to only satisfies the gateway's auth.
    const r = await reconcileAll(deps, members[0]!.id);
    stats.conversations = r.conversations;
    stats.chunks_written = r.chunks_written;
    // Prune is scoped to the caller's store, so once per member. The first
    // member's call also sweeps the shared pool (`_default.db`, the books),
    // which no member-scoped session reaches otherwise: a book removed from
    // Calibre kept its chunks until someone ran prune from the corpus's CLI.
    // A member whose prune fails does not take the others down; the error
    // is kept.
    let pruneError: string | null = null;
    for (const [i, m] of members.entries()) {
      try {
        const p = await deps.call(m.id, "prune", i === 0 ? { shared: true } : {});
        if (p?.error || p?.raw) throw new Error(String(p.error ?? p.raw));
        stats.pruned += Number(p?.removed ?? 0);
      } catch (err) {
        pruneError = `prune(${m.id}): ${(err as Error).message}`;
        console.warn(`[corpus] nightly: ${pruneError}`);
      }
    }
    const ms = now().getTime() - started.getTime();
    console.log(
      `[corpus] nightly: ${stats.conversations} conversation(s) reconciled, ${stats.chunks_written} chunk(s) written, ` +
        `${stats.pruned} stale file entr${stats.pruned === 1 ? "y" : "ies"} pruned across ${stats.members} member(s) in ${Math.round(ms / 1000)}s`
    );
    return finish(pruneError ? "failed" : "reconciled", pruneError, stats);
  } catch (err) {
    const message = (err as Error).message;
    console.error(`[corpus] nightly: failed: ${message}`);
    return finish("failed", message, stats);
  }
}

/** Reconcile the corpus now. Never throws; a run already going is shared
 *  rather than doubled — the admin's button during the night's run joins it. */
export function reconcileCorpus(deps: NightlyDeps = defaultDeps): Promise<NightlyOutcome> {
  if (!inflight) {
    inflight = doRun(deps).finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

/** Tick every ten minutes; run once per local day from HOUR on. */
export function scheduleCorpusNightly(deps: NightlyDeps = defaultDeps): void {
  if (!nightlyOn()) {
    console.log("[corpus] nightly reconciliation off");
    return;
  }
  const tick = () => {
    if (inflight) return;
    if (!isDue(new Date(), loadState().last_run_at)) return;
    reconcileCorpus(deps).catch((err) => console.error(`[corpus] nightly: ${(err as Error).message}`));
  };
  setTimeout(() => {
    tick();
    setInterval(tick, TICK_MS).unref();
  }, FIRST_TICK_MS).unref();
}
