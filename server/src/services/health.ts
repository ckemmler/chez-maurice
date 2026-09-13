/**
 * Technical health of this instance — what an operator running several
 * households needs to see at a glance, and nothing about the people in them.
 *
 * Two faces of one endpoint (GET /healthz):
 *   - public: `status` + `version`, enough for an uptime probe and for the
 *     apps to check compatibility;
 *   - full, behind a `health`-scoped API token: build, schema, uptime, disk,
 *     database, and an error rate.
 *
 * The error rate is deliberately crude: every `console.error` and every 5xx
 * response is one tick in a ring of timestamps. It says "something is going
 * wrong, and how often", which is the question an operator asks first; the
 * logs say what. No message text is kept — only the `[tag]` a log line opens
 * with, so a stack trace or a member's words never reach the fleet tooling.
 */

import { existsSync, readFileSync, statfsSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";
import db, { dataDir, SCHEMA_VERSION } from "../db";

// ── Build identity ──────────────────────────────────────────────

export type BuildInfo = { version: string; git_sha: string | null; built_at: string | null };

const SERVER_ROOT = join(import.meta.dir, "..", "..");

function git(...args: string[]): string | null {
  try {
    const r = spawnSync("git", ["-C", SERVER_ROOT, ...args], { encoding: "utf8", timeout: 2000 });
    if (r.status !== 0) return null;
    const out = r.stdout.trim();
    return out || null;
  } catch {
    return null;
  }
}

/** Resolved once at startup. Precedence: env → build-info.json (written by
 *  scripts/build-info.sh at deploy or image build) → the git checkout the
 *  server runs from (the Mac install) → "dev". */
function resolveBuildInfo(): BuildInfo {
  let fromFile: Partial<BuildInfo> = {};
  const file = join(SERVER_ROOT, "build-info.json");
  if (existsSync(file)) {
    try { fromFile = JSON.parse(readFileSync(file, "utf8")); } catch {}
  }
  const sha = process.env.MAURICE_GIT_SHA || fromFile.git_sha || git("rev-parse", "--short=12", "HEAD");
  const version =
    process.env.MAURICE_VERSION || fromFile.version || git("describe", "--tags", "--match", "*v[0-9]*", "--always", "--dirty") || "dev";
  const builtAt =
    process.env.MAURICE_BUILT_AT || fromFile.built_at ||
    (sha ? git("show", "-s", "--format=%cI", "HEAD") : null);
  return { version, git_sha: sha ?? null, built_at: builtAt ?? null };
}

export const BUILD: BuildInfo = resolveBuildInfo();

// ── Error ring ──────────────────────────────────────────────────

const RING = 2048;
const errorsAt: number[] = [];
const kinds = new Map<string, number>();
let lastKind: string | null = null;
let startedAt = Date.now();

/** Record one error. `kind` is a short opaque label ("[claude]", "http-500"),
 *  never a message. */
export function recordError(kind: string): void {
  const now = Date.now();
  errorsAt.push(now);
  if (errorsAt.length > RING) errorsAt.splice(0, errorsAt.length - RING);
  lastKind = kind;
  kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
}

/** Wraps console.error so every existing `[tag] failed:` log line counts. The
 *  tag is the only thing kept. Call once at startup. */
export function hookConsoleErrors(): void {
  const original = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    const head = typeof args[0] === "string" ? args[0] : "";
    const tag = head.match(/^\[[\w:-]+\]/)?.[0] ?? "log";
    recordError(tag);
    original(...args);
  };
}

function countSince(ms: number): number {
  const cutoff = Date.now() - ms;
  let i = errorsAt.length;
  while (i > 0 && (errorsAt[i - 1] ?? 0) >= cutoff) i--;
  return errorsAt.length - i;
}

/** Test seam: forget every recorded error. */
export function _resetErrors(): void {
  errorsAt.length = 0;
  kinds.clear();
  lastKind = null;
  startedAt = Date.now();
}

// ── Checks ──────────────────────────────────────────────────────

function checkDb(): "ok" | "degraded" {
  try {
    db.query("SELECT 1").get();
    const r = db.query("PRAGMA quick_check(1)").get() as { quick_check?: string } | undefined;
    return r?.quick_check === "ok" ? "ok" : "degraded";
  } catch {
    return "degraded";
  }
}

function diskFreeMb(): number | null {
  try {
    const s = statfsSync(dataDir);
    return Math.floor((s.bavail * s.bsize) / 1048576);
  } catch {
    return null;
  }
}

// ── Snapshots ───────────────────────────────────────────────────

export function publicHealth() {
  return { status: "ok", service: "maurice", version: BUILD.version };
}

export function fullHealth() {
  const errors_1h = countSince(3600_000);
  const errors_24h = countSince(86_400_000);
  const dbState = checkDb();
  const disk = diskFreeMb();
  const status: "ok" | "degraded" = dbState !== "ok" || (disk !== null && disk < 512) ? "degraded" : "ok";
  const lastAt = errorsAt[errorsAt.length - 1];
  const last = lastAt ? new Date(lastAt).toISOString() : null;
  return {
    ...publicHealth(),
    status,
    git_sha: BUILD.git_sha,
    built_at: BUILD.built_at,
    schema_version: SCHEMA_VERSION,
    uptime_s: Math.floor(process.uptime()),
    started_at: new Date(startedAt).toISOString(),
    db: dbState,
    disk_free_mb: disk,
    errors_1h,
    errors_24h,
    last_error_at: last,
    last_error_kind: lastKind,
    error_kinds: Object.fromEntries(kinds),
    bun: Bun.version,
  };
}
