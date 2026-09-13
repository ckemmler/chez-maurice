/**
 * What fleet-status.ts and tower.ts share: the inventory, the tokens, and one
 * probe of an instance's /healthz. No UI in here.
 *
 * Tokens come from ~/.maurice/ops/fleet-tokens (name=maur_…), never from the
 * inventory; MAURICE_FLEET and MAURICE_FLEET_TOKENS override both paths.
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";

export const OPS_DIR = import.meta.dir;
export const REPO_DIR = join(OPS_DIR, "..");
const TIMEOUT_MS = 5000;

export type Instance = {
  name: string; url: string; owner?: string; since?: string; insecure?: boolean;
  /** Shell command, run from the repo root, that puts the current checkout live there. */
  deploy?: string;
};

/** The inventory is a flat list of mappings; that is all this reads. */
export function readFleet(): Instance[] {
  const text = readFileSync(process.env.MAURICE_FLEET || join(OPS_DIR, "fleet.yaml"), "utf8");
  const out: Record<string, string>[] = [];
  let cur: Record<string, string> | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+#.*$/, "").trimEnd();
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const item = line.match(/^\s*-\s+(\w+):\s*(.*)$/);
    const kv = line.match(/^\s+(\w+):\s*(.*)$/);
    if (item) {
      cur = { [item[1]!]: unquote(item[2]!) };
      out.push(cur);
    } else if (kv && cur) {
      cur[kv[1]!] = unquote(kv[2]!);
    }
  }
  return out.map((i) => ({ ...(i as unknown as Instance), insecure: i.insecure === "true" }));
}

function unquote(v: string): string {
  const t = v.trim();
  return /^(".*"|'.*')$/.test(t) ? t.slice(1, -1) : t;
}

export function readTokens(): Record<string, string> {
  const file = process.env.MAURICE_FLEET_TOKENS || join(process.env.HOME || "", ".maurice", "ops", "fleet-tokens");
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([\w-]+)\s*=\s*(\S+)/);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

export type Row = {
  name: string; owner?: string; reach: "up" | "down"; status?: string; version?: string;
  git_sha?: string | null; schema_version?: number; uptime_s?: number; db?: string;
  disk_free_mb?: number | null; errors_1h?: number; errors_24h?: number; last_error_at?: string | null;
  last_error_kind?: string | null; probe: "full" | "public" | "none"; note?: string; at: number;
};

export async function probe(i: Instance, token?: string): Promise<Row> {
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  const opts: RequestInit & { tls?: { rejectUnauthorized: boolean } } = {
    headers, signal: AbortSignal.timeout(TIMEOUT_MS),
  };
  if (i.insecure) opts.tls = { rejectUnauthorized: false };
  const at = Date.now();
  try {
    const res = await fetch(`${i.url}/healthz`, opts);
    const body = (await res.json()) as Partial<Row>;
    const full = "uptime_s" in body;
    return {
      name: i.name, owner: i.owner, reach: "up", ...body, at,
      probe: full ? "full" : "public",
      note: token && !full ? "token refused" : undefined,
    };
  } catch (err) {
    return {
      name: i.name, owner: i.owner, reach: "down", probe: "none", at,
      note: (err as { code?: string }).code ?? (err as Error).name,
    };
  }
}

export function probeAll(fleet: Instance[], tokens = readTokens()): Promise<Row[]> {
  return Promise.all(fleet.map((i) => probe(i, tokens[i.name])));
}

export function isBad(r: Row): boolean {
  return r.reach === "down" || (r.status != null && r.status !== "ok");
}

// ── Formatting shared by both faces ─────────────────────────────

export function age(s?: number): string {
  if (s == null) return "";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function since(iso?: string | null): string {
  if (!iso) return "—";
  return `${age(Math.floor((Date.now() - Date.parse(iso)) / 1000))} ago`;
}

export function stateOf(r: Row): string {
  return r.reach === "down" ? `DOWN (${r.note})` : r.status === "ok" ? "ok" : "DEGRADED";
}

export function lastErrorOf(r: Row): string {
  if (r.probe === "public") return r.note ?? "no token";
  if (r.last_error_at) return `${since(r.last_error_at)} ${r.last_error_kind ?? ""}`;
  return r.probe === "full" ? "none" : "";
}

export const HEAD = ["instance", "state", "version", "sha", "schema", "up", "db", "disk", "err/1h", "err/24h", "last error"];

export function cells(r: Row): string[] {
  return [
    r.name,
    stateOf(r),
    r.version ?? "",
    r.git_sha ?? "",
    r.schema_version != null ? String(r.schema_version) : "",
    age(r.uptime_s),
    r.db ?? "",
    r.disk_free_mb != null ? `${Math.floor(r.disk_free_mb / 1024)}G` : "",
    r.errors_1h != null ? String(r.errors_1h) : "",
    r.errors_24h != null ? String(r.errors_24h) : "",
    lastErrorOf(r),
  ];
}

export function table(rows: Row[], head = HEAD, lines = rows.map(cells)): string[] {
  const widths = head.map((h, c) => Math.max(h.length, ...lines.map((l) => l[c]!.length)));
  const fmt = (l: string[]) => l.map((v, c) => v.padEnd(widths[c]!)).join("  ");
  return [fmt(head), fmt(widths.map((w) => "─".repeat(w))), ...lines.map(fmt)];
}
