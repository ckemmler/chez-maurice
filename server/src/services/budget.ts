// ============================================================================
// budget.ts — a spending fuse for an instance whose inference is paid by
// somebody other than its users.
//
// This is NOT the meter. pricing.ts prices a turn and the chat UI shows the
// figure; that is information, and it is for the person spending their own
// money. This is the thing that says *no* — for the demo fleet, where every
// household runs on our key, and for any hosted instance sold with a bundle.
//
// Every figure here is in euros — what the household pays in — since
// 24 September 2026 (`pricing.ts` converts at its fixed rate). The `_usd`
// in column, env and field names is older than that and left alone: a rename
// would touch every deployed plist, fleet env and client for a label.
//
// Three layers of cap, the tightest one wins, all off by default:
//
//   the instance's — env, the operator's fuse, counted over the whole household
//     MAURICE_SPEND_CAP_USD        total, over the life of the instance
//     MAURICE_SPEND_CAP_DAILY_USD  rolling 24 hours
//   the household's — households.spend_cap_daily_usd, its own choice, counted
//     over the whole household
//   the member's — users.spend_cap_daily_usd, counted over that member alone
//   the night's — households.spend_cap_system_daily_usd, counted over what
//     Maurice spends on nobody's turn (the domain briefs, later the mapping),
//     recorded under the "system" spender below
//
// With none set the instance is uncapped and every function here is a no-op,
// which is what a household paying its own provider wants. The ledger names
// who spent each turn either way, so a member can always see their own figure.
//
// ── The trap this file exists to avoid ──────────────────────────────────────
//
// pricing.ts is deliberate that an unknown model prices at `null`, never zero:
// "a zero reads as 'this was free', which is the one wrong answer." For a
// meter, null is honest. For a *cap*, null is a hole: an unpriced model spends
// real money while the ledger stays at zero, so the fuse never blows. So when
// a cap is set and a model cannot be priced, the turn is refused rather than
// waved through. An instance that cannot count what it spends has no business
// spending it on someone else's key. Add the model to PRICES — the refusal
// says so.
//
// (Ollama is exempt for the right reason rather than by accident: priceUsage
// gives it a true zero because nobody is billed for it.)
// ============================================================================

import db from "../db";
import { priceFor, type TurnUsage } from "./pricing";

// ── Caps ────────────────────────────────────────────────────────────────────

export interface BudgetCaps {
  totalUsd: number | null;
  dailyUsd: number | null;
}

function num(name: string): number | null {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    console.warn(`[budget] ignoring ${name}=${JSON.stringify(raw)}: not a non-negative number`);
    return null;
  }
  return n;
}

/** The instance's caps — the operator's, from the environment. */
export function caps(): BudgetCaps {
  return {
    totalUsd: num("MAURICE_SPEND_CAP_USD"),
    dailyUsd: num("MAURICE_SPEND_CAP_DAILY_USD"),
  };
}

/** A stored cap column: null, or a non-negative number. The setters never let
 *  anything else in, but a hand-edited database is no reason to obey nonsense. */
function stored(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

export function householdDailyCap(): number | null {
  const row = db
    .query<{ cap: number | null }, []>(`SELECT spend_cap_daily_usd AS cap FROM households WHERE id = 'default'`)
    .get();
  return stored(row?.cap);
}

export function memberDailyCap(userId: string): number | null {
  const row = db
    .query<{ cap: number | null }, [string]>(`SELECT spend_cap_daily_usd AS cap FROM users WHERE id = ?`)
    .get(userId);
  return stored(row?.cap);
}

// ── The "system" spender ────────────────────────────────────────────────────
//
// Since 19 September 2026 Maurice spends money on nobody's turn: the domain
// briefs are rewritten at night, and the mapping will follow. Those rows carry
// this id in `spend_ledger.user_id` instead of a member's — they are the
// household's cost, not anyone's — and are capped by the night's own daily
// allowance, so a runaway night cannot eat the household's day. Not a row in
// `users`: the ledger's user_id has no foreign key, on purpose.

export const SYSTEM_SPENDER = "system";

export function isSystemSpender(id: string | null | undefined): boolean {
  return id === SYSTEM_SPENDER;
}

export function systemDailyCap(): number | null {
  const row = db
    .query<{ cap: number | null }, []>(`SELECT spend_cap_system_daily_usd AS cap FROM households WHERE id = 'default'`)
    .get();
  return stored(row?.cap);
}

/** Set (or clear with null) the night's own daily cap. */
export function setSystemDailyCap(usd: number | null): void {
  db.run(`UPDATE households SET spend_cap_system_daily_usd = ? WHERE id = 'default'`, [stored(usd)]);
}

/** Set (or clear with null) the household's own daily cap. */
export function setHouseholdDailyCap(usd: number | null): void {
  db.run(`UPDATE households SET spend_cap_daily_usd = ? WHERE id = 'default'`, [stored(usd)]);
}

/** Set (or clear with null) a member's daily cap. */
export function setMemberDailyCap(userId: string, usd: number | null): void {
  db.run(`UPDATE users SET spend_cap_daily_usd = ? WHERE id = ?`, [stored(usd), userId]);
}

/** Every cap that applies to a member, layer by layer. */
export interface AppliedCaps extends BudgetCaps {
  householdDailyUsd: number | null;
  memberDailyUsd: number | null;
}

export function capsFor(userId?: string | null): AppliedCaps {
  return {
    ...caps(),
    householdDailyUsd: householdDailyCap(),
    memberDailyUsd: isSystemSpender(userId) ? systemDailyCap() : userId ? memberDailyCap(userId) : null,
  };
}

/** Is anything capped at all — for this member, or household-wide with none named? */
export function capped(userId?: string | null): boolean {
  const c = capsFor(userId);
  return c.totalUsd != null || c.dailyUsd != null || c.householdDailyUsd != null || c.memberDailyUsd != null;
}

// ── The ledger ──────────────────────────────────────────────────────────────
//
// A row per billed turn. The same numbers live in messages.usage, but summing
// a JSON column across every message an instance has ever held is the wrong
// shape for something consulted before each agentic round — and a message can
// be deleted, while what it cost was still spent.

db.run(`
  CREATE TABLE IF NOT EXISTS spend_ledger (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    at         TEXT NOT NULL DEFAULT (datetime('now')),
    provider   TEXT NOT NULL,
    model      TEXT NOT NULL,
    cost_usd   REAL NOT NULL
  )
`);
db.run(`CREATE INDEX IF NOT EXISTS idx_spend_ledger_at ON spend_ledger(at)`);
// Who spent it: the member whose turn it was (in a room, whoever sent the
// message Maurice answered). Null on rows from before this column existed.
try { db.run(`ALTER TABLE spend_ledger ADD COLUMN user_id TEXT`); } catch {}
db.run(`CREATE INDEX IF NOT EXISTS idx_spend_ledger_user_at ON spend_ledger(user_id, at)`);

/** Record what a completed turn cost, and whose turn it was. Called wherever
 *  usage is persisted, so every turn is counted once regardless of which
 *  route produced it. */
export function recordSpend(u: TurnUsage | null | undefined, spenderId?: string | null): void {
  if (!u || u.cost == null || u.cost <= 0) return;
  db.run(`INSERT INTO spend_ledger (provider, model, cost_usd, user_id) VALUES (?, ?, ?, ?)`, [
    u.provider,
    u.model,
    u.cost,
    spenderId ?? null,
  ]);
}

/** Sum of the ledger since `since` (an SQLite datetime expression), for one
 *  member or, with no member named, the whole household. */
function spentSince(since: string, userId?: string | null): number {
  const row = userId
    ? db
        .query<{ total: number | null }, [string]>(
          `SELECT sum(cost_usd) AS total FROM spend_ledger WHERE at >= ${since} AND user_id = ?`,
        )
        .get(userId)
    : db
        .query<{ total: number | null }, []>(`SELECT sum(cost_usd) AS total FROM spend_ledger WHERE at >= ${since}`)
        .get();
  return row?.total ?? 0;
}

export function spentTotalUsd(): number {
  const row = db
    .query<{ total: number | null }, []>(`SELECT sum(cost_usd) AS total FROM spend_ledger`)
    .get();
  return row?.total ?? 0;
}

/** Rolling 24 hours — the window every daily cap is counted over. */
export function spentTodayUsd(userId?: string | null): number {
  return spentSince(`datetime('now', '-1 day')`, userId);
}

/** The calendar month so far, on the server's clock. Information for the
 *  member, never a cap. */
export function spentMonthUsd(userId?: string | null): number {
  return spentSince(`datetime('now', 'start of month')`, userId);
}

// ── The verdict ─────────────────────────────────────────────────────────────

export interface Verdict {
  ok: boolean;
  /** Prose meant to be read by the person who is about to be refused. */
  reason?: string;
  /** What is left under the tightest cap, or null when uncapped. */
  remainingUsd: number | null;
}

/** One cap, what has been spent under it, and what to say when it is reached. */
interface Layer {
  capUsd: number;
  spentUsd: number;
  reason: string;
}

/** The caps that apply to a member, most specific first, so that when more
 *  than one is reached the refusal names the one closest to the person reading
 *  it. Each layer is counted over what its cap covers: the member's own turns
 *  for their cap, the whole household's for the other three. */
function layers(userId?: string | null): Layer[] {
  const c = capsFor(userId);
  const usd = (n: number) => `$${n.toFixed(2)}`;
  const out: Layer[] = [];
  if (c.memberDailyUsd != null && userId) {
    out.push({
      capUsd: c.memberDailyUsd,
      spentUsd: spentTodayUsd(userId),
      reason: isSystemSpender(userId)
        ? `The night's work has reached its daily allowance of ${usd(c.memberDailyUsd)}; ` +
          `what is left waits for the next night.`
        : `You have reached your daily limit of ${usd(c.memberDailyUsd)}. ` +
          `It resets as the day rolls forward; nothing here is lost in the meantime.`,
    });
  }
  if (c.householdDailyUsd != null) {
    out.push({
      capUsd: c.householdDailyUsd,
      spentUsd: spentTodayUsd(),
      reason:
        `This household has reached its daily limit of ${usd(c.householdDailyUsd)}. ` +
        `It resets as the day rolls forward; nothing here is lost in the meantime.`,
    });
  }
  if (c.dailyUsd != null) {
    out.push({
      capUsd: c.dailyUsd,
      spentUsd: spentTodayUsd(),
      reason:
        `This instance has reached its daily limit of ${usd(c.dailyUsd)}. ` +
        `It resets as the day rolls forward; nothing here is lost in the meantime.`,
    });
  }
  if (c.totalUsd != null) {
    out.push({
      capUsd: c.totalUsd,
      spentUsd: spentTotalUsd(),
      reason:
        `This instance has spent its allowance of ${usd(c.totalUsd)}. ` +
        `Nothing is lost — the conversation and everything in the garden are still here.`,
    });
  }
  return out;
}

/**
 * May a turn proceed?
 *
 * `pendingUsd` is what the turn in progress has already run up but not yet
 * written to the ledger — pass it when checking between agentic rounds, or a
 * single turn with six tool rounds can walk straight through a cap that was
 * only ever consulted before the first one.
 *
 * `userId` is whose turn it is. Without it only the household-wide layers
 * apply: a member's own cap cannot be checked against nobody.
 */
export function verdict(
  provider: string | null,
  model: string | null,
  pendingUsd = 0,
  userId?: string | null,
): Verdict {
  const applied = layers(userId);
  if (applied.length === 0) return { ok: true, remainingUsd: null };

  // Nobody is billed for a local model, so no cap can apply to it. Decided by
  // provider rather than by model name, because that is how priceUsage decides
  // it — two places disagreeing about what is free is how a fuse stops working.
  if (provider === "ollama") return { ok: true, remainingUsd: null };

  // Priced in? See the header: under a cap, unpriceable means refused.
  if (model && !priceFor(model)) {
    return {
      ok: false,
      remainingUsd: null,
      reason:
        `This instance has a spending limit, and ${model} has no price on file, ` +
        `so what it costs cannot be counted. Add it to the price list, or use a model that is on it.`,
    };
  }

  let remaining = Infinity;
  for (const l of applied) {
    const left = l.capUsd - (l.spentUsd + pendingUsd);
    if (left <= 0) return { ok: false, remainingUsd: 0, reason: l.reason };
    remaining = Math.min(remaining, left);
  }
  return { ok: true, remainingUsd: remaining };
}

// ── A member's own view ─────────────────────────────────────────────────────

export interface MemberUsage {
  today_usd: number;
  month_usd: number;
  /** The tightest daily cap that applies to this member, or null. */
  cap_daily_usd: number | null;
  /** Headroom under the tightest cap of any kind, or null when uncapped. */
  remaining_usd: number | null;
}

/** What a member has spent and how much room they have left, for them to
 *  read — the same layers the verdict weighs, minus the model question. */
export function usageFor(userId: string): MemberUsage {
  const c = capsFor(userId);
  const daily = [c.memberDailyUsd, c.householdDailyUsd, c.dailyUsd].filter((n): n is number => n != null);
  const applied = layers(userId);
  return {
    today_usd: spentTodayUsd(userId),
    month_usd: spentMonthUsd(userId),
    cap_daily_usd: daily.length ? Math.min(...daily) : null,
    remaining_usd: applied.length ? Math.max(0, Math.min(...applied.map((l) => l.capUsd - l.spentUsd))) : null,
  };
}
