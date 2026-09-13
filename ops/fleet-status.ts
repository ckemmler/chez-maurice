#!/usr/bin/env bun
/**
 * One command, one table: which version runs where, and what is down.
 *
 *   ops/fleet-status.ts            every instance in ops/fleet.yaml
 *   ops/fleet-status.ts aline      just that one
 *   ops/fleet-status.ts --json     machine-readable, for a cron or a notifier
 *
 * Exit code 1 when any instance is unreachable or degraded, so a cron line
 * can page. Tokens come from ~/.maurice/ops/fleet-tokens (name=maur_…), never
 * from the inventory; without one an instance shows its public face only.
 * MAURICE_FLEET and MAURICE_FLEET_TOKENS override both paths.
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";

const ROOT = import.meta.dir;
const TIMEOUT_MS = 5000;

type Instance = { name: string; url: string; owner?: string; since?: string; insecure?: boolean };

/** The inventory is a flat list of mappings; that is all this reads. */
function readFleet(): Instance[] {
  const text = readFileSync(process.env.MAURICE_FLEET || join(ROOT, "fleet.yaml"), "utf8");
  const out: Instance[] = [];
  let cur: Record<string, string> | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+#.*$/, "").trimEnd();
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const item = line.match(/^\s*-\s+(\w+):\s*(.*)$/);
    const kv = line.match(/^\s+(\w+):\s*(.*)$/);
    if (item) {
      cur = { [item[1]!]: item[2]!.trim() };
      out.push(cur as unknown as Instance);
    } else if (kv && cur) {
      cur[kv[1]!] = kv[2]!.trim();
    }
  }
  return out.map((i) => ({ ...i, insecure: String(i.insecure) === "true" }));
}

function readTokens(): Record<string, string> {
  const file = process.env.MAURICE_FLEET_TOKENS || join(process.env.HOME || "", ".maurice", "ops", "fleet-tokens");
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([\w-]+)\s*=\s*(\S+)/);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

type Row = {
  name: string; owner?: string; reach: "up" | "down"; status?: string; version?: string;
  git_sha?: string | null; schema_version?: number; uptime_s?: number; db?: string;
  disk_free_mb?: number | null; errors_1h?: number; errors_24h?: number; last_error_at?: string | null;
  last_error_kind?: string | null; probe: "full" | "public" | "none"; note?: string;
};

async function probe(i: Instance, token?: string): Promise<Row> {
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  const opts: RequestInit & { tls?: { rejectUnauthorized: boolean } } = {
    headers, signal: AbortSignal.timeout(TIMEOUT_MS),
  };
  if (i.insecure) opts.tls = { rejectUnauthorized: false };
  try {
    const res = await fetch(`${i.url}/healthz`, opts);
    const body = (await res.json()) as Partial<Row>;
    const full = "uptime_s" in body;
    return {
      name: i.name, owner: i.owner, reach: "up", ...body,
      probe: full ? "full" : "public",
      note: token && !full ? "token refused" : undefined,
    };
  } catch (err) {
    return { name: i.name, owner: i.owner, reach: "down", probe: "none", note: (err as { code?: string }).code ?? (err as Error).name };
  }
}

function age(s?: number): string {
  if (s == null) return "";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function since(iso?: string | null): string {
  if (!iso) return "—";
  const s = Math.floor((Date.now() - Date.parse(iso)) / 1000);
  return `${age(s)} ago`;
}

function table(rows: Row[]): string {
  const head = ["instance", "state", "version", "sha", "schema", "up", "db", "disk", "err/1h", "err/24h", "last error"];
  const lines = rows.map((r) => [
    r.name,
    r.reach === "down" ? `DOWN (${r.note})` : r.status === "ok" ? "ok" : `DEGRADED`,
    r.version ?? "",
    r.git_sha ?? "",
    r.schema_version != null ? String(r.schema_version) : "",
    age(r.uptime_s),
    r.db ?? "",
    r.disk_free_mb != null ? `${Math.floor(r.disk_free_mb / 1024)}G` : "",
    r.errors_1h != null ? String(r.errors_1h) : "",
    r.errors_24h != null ? String(r.errors_24h) : "",
    r.probe === "public" ? (r.note ?? "no token") : r.last_error_at ? `${since(r.last_error_at)} ${r.last_error_kind ?? ""}` : r.probe === "full" ? "none" : "",
  ]);
  const widths = head.map((h, c) => Math.max(h.length, ...lines.map((l) => l[c]!.length)));
  const fmt = (l: string[]) => l.map((v, c) => v.padEnd(widths[c]!)).join("  ");
  return [fmt(head), fmt(widths.map((w) => "─".repeat(w))), ...lines.map(fmt)].join("\n");
}

const args = process.argv.slice(2);
const json = args.includes("--json");
const only = args.filter((a) => !a.startsWith("--"));
const tokens = readTokens();
const fleet = readFleet().filter((i) => !only.length || only.includes(i.name));
if (!fleet.length) {
  console.error("no instance matches; see ops/fleet.yaml");
  process.exit(2);
}
const rows = await Promise.all(fleet.map((i) => probe(i, tokens[i.name])));
if (json) console.log(JSON.stringify(rows, null, 2));
else console.log(table(rows));
const bad = rows.some((r) => r.reach === "down" || (r.status && r.status !== "ok"));
process.exit(bad ? 1 : 0);
