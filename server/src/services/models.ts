import db from "../db";

// The household's model roster — cloud (Anthropic, metered) + local (Ollama,
// on-device, private). The table is the source of truth; the iOS app and the
// generation path both read from here. Per-member access lives in
// services/modelAccess.ts (kept separate to avoid an import cycle).

export interface Model {
  id: string;
  name: string;
  tier: "cloud" | "local";
  vendor: string;
  /** which API the model speaks: anthropic | openai | mistral | ollama */
  provider: string;
  ctx: number;
  ram: number | null;
  discovered: boolean;
  descr: string;
}

/** The shape the apps consume (matches the iOS ModelInfo decoder). */
export interface ModelInfo {
  id: string;
  name: string;
  tier: "cloud" | "local";
  provider: string; // anthropic | openai | mistral | ollama — for grouping/logos
  sub: string;      // vendor (+ size for local)
  desc: string;
  note: string;     // "metered" | "private"
  available: boolean;
  is_default?: boolean; // the household default — used by everyday conversations
}

function rowToModel(r: any): Model {
  return {
    id: r.id,
    name: r.name,
    tier: r.tier,
    vendor: r.vendor,
    provider: r.provider || (r.tier === "local" ? "ollama" : "anthropic"),
    ctx: r.ctx,
    ram: r.ram ?? null,
    discovered: !!r.discovered,
    descr: r.descr,
  };
}

export function listModels(): Model[] {
  // Cloud first (by seed order), then local (largest first).
  const rows = db
    .query(
      `SELECT * FROM models
       ORDER BY (tier = 'local'), sort, ram DESC, name`,
    )
    .all() as any[];
  return rows.map(rowToModel);
}

export function getModel(id: string): Model | null {
  const r = db.query(`SELECT * FROM models WHERE id = ?`).get(id) as any;
  return r ? rowToModel(r) : null;
}

export function toModelInfo(m: Model): ModelInfo {
  return {
    id: m.id,
    name: m.name,
    tier: m.tier,
    provider: m.provider,
    sub: m.tier === "local" && m.ram ? `${m.vendor} · ${m.ram} GB` : m.vendor,
    desc: m.descr,
    note: m.tier === "local" ? "private" : "metered",
    available: true,
  };
}

/** Which providers are usable: local Ollama always, cloud ones only if a key is
 *  set. Keeps keyless providers out of the apps' model lists. */
export function configuredProviders(): Set<string> {
  const row = db
    .query(`SELECT api_key, openai_api_key, mistral_api_key FROM households WHERE id = 'default'`)
    .get() as any;
  const s = new Set<string>(["ollama"]);
  if (row?.api_key) s.add("anthropic");
  if (row?.openai_api_key) s.add("openai");
  if (row?.mistral_api_key) s.add("mistral");
  return s;
}

/** The roster as ModelInfo, limited to providers that are actually configured. */
export function availableModels(): ModelInfo[] {
  const ok = configuredProviders();
  return listModels().filter((m) => ok.has(m.provider)).map(toModelInfo);
}

export interface ModelInput {
  id: string;
  name: string;
  tier: "cloud" | "local";
  vendor?: string;
  provider?: string;
  ctx?: number;
  ram?: number | null;
  discovered?: boolean;
  descr?: string;
}

export function addModel(input: ModelInput): Model {
  const provider = input.provider ?? (input.tier === "local" ? "ollama" : "anthropic");
  db.run(
    `INSERT INTO models (id, name, tier, vendor, provider, ctx, ram, discovered, descr, sort)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 100)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, tier = excluded.tier, vendor = excluded.vendor,
       provider = excluded.provider, ctx = excluded.ctx, ram = excluded.ram, descr = excluded.descr`,
    [
      input.id,
      input.name,
      input.tier,
      input.vendor ?? "",
      provider,
      input.ctx ?? 0,
      input.ram ?? null,
      input.discovered ? 1 : 0,
      input.descr ?? "",
    ],
  );
  return getModel(input.id)!;
}

export function removeModel(id: string): boolean {
  const res = db.run(`DELETE FROM models WHERE id = ?`, [id]);
  return res.changes > 0;
}

export function householdDefaultModel(): string {
  const row = db
    .query(`SELECT default_model FROM households WHERE id = 'default'`)
    .get() as { default_model: string } | null;
  return row?.default_model ?? "claude-sonnet-4-6";
}

/** Resolve a preferred model id to one that actually exists in the roster,
 *  else fall back. */
export function resolveModelId(preferred: string | null | undefined, fallback: string): string {
  if (preferred && getModel(preferred)) return preferred;
  return fallback;
}
