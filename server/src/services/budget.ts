// ============================================================================
// budget.ts — a spending fuse for an instance whose inference is paid by
// somebody other than its users.
//
// This is NOT the meter. pricing.ts prices a turn and the chat UI shows the
// figure; that is information, and it is for the person spending their own
// money. This is the thing that says *no* — for the demo fleet, where every
// household runs on our key, and for any hosted instance sold with a bundle.
//
// Two caps, either or both, both off by default:
//
//   MAURICE_SPEND_CAP_USD        total, over the life of the instance
//   MAURICE_SPEND_CAP_DAILY_USD  rolling 24 hours
//
// With neither set the instance is uncapped and every function here is a
// no-op, which is what a household paying its own provider wants.
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

export function caps(): BudgetCaps {
  return {
    totalUsd: num("MAURICE_SPEND_CAP_USD"),
    dailyUsd: num("MAURICE_SPEND_CAP_DAILY_USD"),
  };
}

export function capped(): boolean {
  const c = caps();
  return c.totalUsd != null || c.dailyUsd != null;
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

/** Record what a completed turn cost. Called wherever usage is persisted, so
 *  every turn is counted once regardless of which route produced it. */
export function recordSpend(u: TurnUsage | null | undefined): void {
  if (!u || u.cost == null || u.cost <= 0) return;
  db.run(`INSERT INTO spend_ledger (provider, model, cost_usd) VALUES (?, ?, ?)`, [
    u.provider,
    u.model,
    u.cost,
  ]);
}

export function spentTotalUsd(): number {
  const row = db
    .query<{ total: number | null }, []>(`SELECT sum(cost_usd) AS total FROM spend_ledger`)
    .get();
  return row?.total ?? 0;
}

export function spentTodayUsd(): number {
  const row = db
    .query<{ total: number | null }, []>(
      `SELECT sum(cost_usd) AS total FROM spend_ledger WHERE at >= datetime('now', '-1 day')`,
    )
    .get();
  return row?.total ?? 0;
}

// ── The verdict ─────────────────────────────────────────────────────────────

export interface Verdict {
  ok: boolean;
  /** Prose meant to be read by the person who is about to be refused. */
  reason?: string;
  /** What is left under the tightest cap, or null when uncapped. */
  remainingUsd: number | null;
}

/**
 * May a turn proceed?
 *
 * `pendingUsd` is what the turn in progress has already run up but not yet
 * written to the ledger — pass it when checking between agentic rounds, or a
 * single turn with six tool rounds can walk straight through a cap that was
 * only ever consulted before the first one.
 */
export function verdict(provider: string | null, model: string | null, pendingUsd = 0): Verdict {
  const c = caps();
  if (c.totalUsd == null && c.dailyUsd == null) return { ok: true, remainingUsd: null };

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

  const headroom: number[] = [];
  if (c.totalUsd != null) {
    const left = c.totalUsd - (spentTotalUsd() + pendingUsd);
    if (left <= 0) {
      return {
        ok: false,
        remainingUsd: 0,
        reason:
          `This instance has spent its allowance of $${c.totalUsd.toFixed(2)}. ` +
          `Nothing is lost — the conversation and everything in the garden are still here.`,
      };
    }
    headroom.push(left);
  }
  if (c.dailyUsd != null) {
    const left = c.dailyUsd - (spentTodayUsd() + pendingUsd);
    if (left <= 0) {
      return {
        ok: false,
        remainingUsd: 0,
        reason:
          `This instance has reached its daily limit of $${c.dailyUsd.toFixed(2)}. ` +
          `It resets as the day rolls forward; nothing here is lost in the meantime.`,
      };
    }
    headroom.push(left);
  }
  return { ok: true, remainingUsd: Math.min(...headroom) };
}
