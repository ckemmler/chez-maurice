import db from "../db";
import {
  freezeItems,
  budgetOf,
  resolveSpecToText,
  resolveSpecAttachments,
  type ContextSpec,
  type SpecItem,
  type ResolvedItemText,
  type ResolvedPayload,
} from "./composer/specs";
import type { ItemValidationError } from "./composer/weights";
import { configuredProviders, getModel, householdDefaultModel } from "./models";
import { docContextText, docsForContext, docsWeight, isDelta } from "./mauriceDocs";

// Specialized Maurices (personas). Private to their creator: only the member
// who made one may list, edit, delete, or use it (the routes enforce ownership;
// the `users` access list exists only so an admin can share a persona with a
// guest). A persona owns a frozen context bundle (same snapshot shape as
// composer_specs) — its locked knowledge. A conversation bound to a persona can
// ADD context but never remove the persona's items.

interface MauriceRow {
  id: string;
  household_id: string;
  name: string;
  hat: string;
  palette: string;
  model: string | null;
  temp: number;
  thinking: number | null;
  tagline: string;
  prompt: string;
  context_json: string;
  tool_families: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface Maurice {
  id: string;
  name: string;
  hat: string;
  palette: string;
  model: string | null;
  temp: number;
  /** For a model that reasons optionally: null = the provider's own default,
   *  true = reason before answering, false = answer directly. Ignored on any
   *  other model — the roster (`models.thinking`) says which is which. */
  thinking: boolean | null;
  tagline: string;
  prompt: string;
  /** member ids allowed to use this Maurice */
  users: string[];
  /** the frozen context bundle, as spec items (client renders these as chips) */
  context: SpecItem[];
  /** total token weight of the context bundle */
  weight: number;
  count: number;
  /** allowed tool family ids; null = inherit (household default / all) */
  tool_families: string[] | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  /** true for Maurice Maurice, the built-in persona: present for every member,
   *  not editable, its model chosen by the server (see builtinMaurice). */
  builtin?: boolean;
}

export interface MauriceInput {
  name: string;
  hat?: string;
  palette?: string;
  model?: string | null;
  temp?: number;
  /** see Maurice.thinking; undefined leaves the stored value alone */
  thinking?: boolean | null;
  tagline?: string;
  prompt?: string;
  users?: string[];
  /** raw composer items (will be validated + frozen server-side) */
  context?: any[];
  /** allowed tool family ids; null = inherit, [] = no tools */
  tool_families?: string[] | null;
}

function parseFamiliesJson(json: string | null): string[] | null {
  if (json == null) return null;
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.map(String) : null;
  } catch {
    return null;
  }
}

function parseSpec(json: string): ContextSpec {
  try {
    const s = JSON.parse(json) as ContextSpec;
    return Array.isArray(s.items) ? s : { items: [], resolved_at: "" };
  } catch {
    return { items: [], resolved_at: "" };
  }
}

function accessFor(mauriceId: string): string[] {
  return (
    db
      .query(`SELECT member_id FROM maurice_access WHERE maurice_id = ?`)
      .all(mauriceId) as Array<{ member_id: string }>
  ).map((r) => r.member_id);
}

function toMaurice(row: MauriceRow): Maurice {
  const spec = parseSpec(row.context_json);
  const { total, count } = (() => {
    const b = budgetOf(spec.items);
    const c = spec.items.reduce((s, i) => s + (i.snapshot?.count ?? 0), 0);
    return { total: b.total, count: c };
  })();
  return {
    id: row.id,
    name: row.name,
    hat: row.hat,
    palette: row.palette,
    model: row.model,
    temp: row.temp,
    thinking: row.thinking == null ? null : row.thinking === 1,
    tagline: row.tagline,
    prompt: row.prompt,
    users: accessFor(row.id),
    context: spec.items,
    weight: total,
    count,
    tool_families: parseFamiliesJson(row.tool_families),
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ── Maurice Maurice, the built-in persona ───────────────────────
// The specialist of Maurice itself: present in every member's list (guests
// included), never stored, never editable, and always carrying the whole
// system documentation (services/mauriceDocs.ts) as its baked-in context. Its
// model is picked here, not by the member, and cannot be switched: a strong
// cloud model from a provider the household has a key for, the household's
// own provider first.

export const BUILTIN_MAURICE_ID = "maurice-maurice";

/** Candidate models per provider, strongest-but-reasonable first. Only ids
 *  that exist in the roster count, so an older household's Anthropic seed
 *  (Sonnet 4.5) is found by the later entries. No local model: the docs alone
 *  outgrow the 32k we ask of Ollama. */
const BUILTIN_MODEL_CANDIDATES: Record<string, string[]> = {
  anthropic: ["claude-sonnet-4-6", "claude-sonnet-4-5-20250929", "claude-opus-4-8", "claude-opus-4-6"],
  scaleway: ["mistral-medium-3.5-128b", "qwen3.5-397b-a17b", "glm-5.2", "gpt-oss-120b"],
  mistral: ["mistral-large-latest"],
  openai: ["gpt-4o"],
  zai: ["glm-5.3"],
};

/** The model Maurice Maurice runs on for this household: the first candidate
 *  whose provider has a key, trying the household default's provider first.
 *  Falls back to the household default when no cloud provider is configured
 *  (the persona then answers as best it can, or echoes). */
export function builtinMauriceModel(): string {
  const ok = configuredProviders();
  const def = householdDefaultModel();
  const defProvider = getModel(def)?.provider;
  const order = [
    ...(defProvider ? [defProvider] : []),
    ...Object.keys(BUILTIN_MODEL_CANDIDATES),
  ];
  for (const provider of order) {
    if (!ok.has(provider)) continue;
    for (const id of BUILTIN_MODEL_CANDIDATES[provider] ?? []) {
      if (getModel(id)) return id;
    }
  }
  return def;
}

const BUILTIN_PROMPT = `You are Maurice Maurice, the Maurice specialist: the member of the household who knows everything about Maurice itself — the household AI system you are part of — and answers questions about it.

Your knowledge is the system documentation loaded below, written by Maurice's maker and dated: usually a digest that condenses the whole set to its facts, plus any note loaded in full because it was updated after the digest — where the two differ, the full note is right. Ground every answer in it. Quote or paraphrase what the notes say, name the note you are drawing on when it helps, and follow the [[wiki-links]] between notes to connect the pieces. Read the "ships vs. exists" distinctions and the "gaps" sections carefully: say plainly when something is experimental, private, or not built yet, and never present a planned feature as a working one.

When the documentation does not answer a question, say so rather than guessing; suggest where the answer would live (which surface, which note) and offer what you do know that is adjacent. If a detail in the docs looks out of date compared to what the person describes, say which is more likely and why.

Be practical: someone asking "how do I…" wants the actual steps on the actual surface (the app, Carnet, the web admin, a script), in order. Someone asking "why…" wants the reasoning the notes give — the vision, the trade-offs, the constraints. Keep answers proportionate; a short question deserves a short answer.

Answer in the language the person writes in. The documentation is in English; translate its terms naturally rather than quoting English where a plain word exists, but keep code identifiers, paths, commands and route names exactly as written.`;

function builtinTagline(lang: string): string {
  switch (lang) {
    case "fr": return "Le spécialiste de Maurice : posez-lui toutes vos questions sur Maurice.";
    case "it": return "Lo specialista di Maurice: fagli qualsiasi domanda su Maurice.";
    case "de": return "Der Maurice-Spezialist: stell ihm jede Frage über Maurice.";
    case "es": return "El especialista en Maurice: hazle cualquier pregunta sobre Maurice.";
    case "pt": return "O especialista em Maurice: faz-lhe qualquer pergunta sobre o Maurice.";
    case "nl": return "De Maurice-specialist: stel hem elke vraag over Maurice.";
    default: return "The Maurice specialist: ask him anything about Maurice.";
  }
}

/** Maurice Maurice as the apps see him. `lang` picks the tagline's language;
 *  the prompt and the docs are the same for everyone. */
export function builtinMaurice(lang = "en"): Maurice {
  const docs = docsForContext();
  return {
    id: BUILTIN_MAURICE_ID,
    name: "Maurice Maurice",
    hat: "boater",
    palette: "ink",
    model: builtinMauriceModel(),
    temp: 0.3,
    // Answers about the docs are lookups, not puzzles: no reasoning phase.
    thinking: false,
    tagline: builtinTagline(lang),
    prompt: BUILTIN_PROMPT,
    users: [],
    context: [],
    weight: docsWeight(docs),
    count: docs.length,
    tool_families: null,
    created_by: null,
    created_at: "2026-09-18T00:00:00.000Z",
    updated_at: docs.reduce((m, d) => (d.date && d.date > m ? d.date : m), "2026-09-18"),
    builtin: true,
  };
}

export function isBuiltinMaurice(id: string | null | undefined): boolean {
  return id === BUILTIN_MAURICE_ID;
}

function getRow(id: string): MauriceRow | null {
  return (db
    .query(`SELECT * FROM maurices WHERE id = ?`)
    .get(id) as MauriceRow | null);
}

// ── Reads ───────────────────────────────────────────────────────

/** Every household Maurice. The caller decides who may use which via `users`. */
export function listMaurices(): Maurice[] {
  const rows = db
    .query(`SELECT * FROM maurices ORDER BY name COLLATE NOCASE`)
    .all() as MauriceRow[];
  return rows.map(toMaurice);
}

export function getMaurice(id: string, lang = "en"): Maurice | null {
  if (isBuiltinMaurice(id)) return builtinMaurice(lang);
  const row = getRow(id);
  return row ? toMaurice(row) : null;
}

/** Whether a member may use a Maurice — its creator, or a guest it's shared
 *  with. A null id is the everyday Maurice, always usable. Unknown ids are not. */
export function canUseMaurice(mauriceId: string | null, userId: string): boolean {
  if (!mauriceId || isBuiltinMaurice(mauriceId)) return true;
  const m = getMaurice(mauriceId);
  if (!m) return false;
  return m.created_by === userId || m.users.includes(userId);
}

// ── Writes ──────────────────────────────────────────────────────

export function setAccess(mauriceId: string, memberIds: string[]): void {
  db.run(`DELETE FROM maurice_access WHERE maurice_id = ?`, [mauriceId]);
  for (const m of [...new Set(memberIds)]) {
    db.run(
      `INSERT OR IGNORE INTO maurice_access (maurice_id, member_id) VALUES (?, ?)`,
      [mauriceId, m],
    );
  }
}

/** The stored form of a persona's reasoning choice: NULL for "the provider's
 *  default", else 0/1. Anything that is not a boolean (a client sending a
 *  string, say) is read as "no choice" rather than as a request. */
function thinkingColumn(v: unknown): number | null {
  return v === true ? 1 : v === false ? 0 : null;
}

export function createMaurice(
  memberId: string,
  input: MauriceInput,
): Maurice | { errors: ItemValidationError[] } {
  const frozen = freezeItems(memberId, input.context ?? []);
  if ("errors" in frozen) return frozen;

  const id = crypto.randomUUID();
  db.run(
    `INSERT INTO maurices
       (id, name, hat, palette, model, temp, thinking, tagline, prompt, context_json, tool_families, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.name.trim(),
      input.hat ?? "boater",
      input.palette ?? "ink",
      input.model ?? null,
      input.temp ?? 0.5,
      thinkingColumn(input.thinking ?? null),
      input.tagline ?? "",
      input.prompt ?? "",
      JSON.stringify(frozen.spec),
      input.tool_families != null ? JSON.stringify(input.tool_families) : null,
      memberId,
    ],
  );
  setAccess(id, input.users ?? [memberId]);
  return getMaurice(id)!;
}

export function updateMaurice(
  id: string,
  memberId: string,
  input: MauriceInput,
): Maurice | { errors: ItemValidationError[] } | null {
  if (isBuiltinMaurice(id)) return null;
  const row = getRow(id);
  if (!row) return null;

  // Re-freeze context only when the caller actually sends a context array.
  let contextJson = row.context_json;
  if (input.context !== undefined) {
    const frozen = freezeItems(memberId, input.context);
    if ("errors" in frozen) return frozen;
    contextJson = JSON.stringify(frozen.spec);
  }

  const toolFamilies =
    input.tool_families !== undefined
      ? input.tool_families === null ? null : JSON.stringify(input.tool_families)
      : row.tool_families;

  db.run(
    `UPDATE maurices SET
       name = ?, hat = ?, palette = ?, model = ?, temp = ?, thinking = ?, tagline = ?,
       prompt = ?, context_json = ?, tool_families = ?, updated_at = datetime('now')
     WHERE id = ?`,
    [
      (input.name ?? row.name).trim(),
      input.hat ?? row.hat,
      input.palette ?? row.palette,
      input.model !== undefined ? input.model : row.model,
      input.temp ?? row.temp,
      input.thinking !== undefined ? thinkingColumn(input.thinking) : row.thinking,
      input.tagline ?? row.tagline,
      input.prompt ?? row.prompt,
      contextJson,
      toolFamilies,
      id,
    ],
  );
  if (input.users !== undefined) setAccess(id, input.users);
  return getMaurice(id);
}

export function deleteMaurice(id: string): boolean {
  if (isBuiltinMaurice(id)) return false;
  // Conversations that used this Maurice fall back to the everyday one.
  db.run(`UPDATE conversations SET maurice_id = NULL WHERE maurice_id = ?`, [id]);
  const res = db.run(`DELETE FROM maurices WHERE id = ?`, [id]);
  return res.changes > 0;
}

// ── For generation ──────────────────────────────────────────────

/** The Maurice a conversation is bound to (null = everyday Maurice). */
export function getConversationMaurice(conversationId: string): Maurice | null {
  const row = db
    .query(`SELECT maurice_id FROM conversations WHERE id = ?`)
    .get(conversationId) as { maurice_id: string | null } | null;
  if (!row?.maurice_id) return null;
  return getMaurice(row.maurice_id);
}

/** Resolve a Maurice's baked-in context bundle to its text payload. */
export function resolveMauriceContext(memberId: string, m: Maurice): ResolvedPayload {
  // Maurice Maurice's bundle is the documentation — the digest plus the notes
  // updated since it — read fresh each turn (the reader caches on mtimes);
  // nothing per member in it.
  if (m.builtin) {
    const docs = docsForContext();
    const items: ResolvedItemText[] = docs.map((d) => {
      const text = docContextText(d, isDelta(d, docs));
      return { type: "note", id: `docs:${d.slug}`, text, weight: Math.ceil(text.length / 3) };
    });
    const total = items.reduce((s, i) => s + i.weight, 0);
    return { items, total, budget: total, over: false, tier: "light" };
  }
  return resolveSpecToText(memberId, { items: m.context, resolved_at: "" });
}

/** Binary (img/pdf) attachments baked into a Maurice's context bundle. */
export function resolveMauriceAttachments(memberId: string, m: Maurice) {
  if (m.builtin) return [];
  return resolveSpecAttachments(memberId, { items: m.context, resolved_at: "" });
}
