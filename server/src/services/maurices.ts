import db from "../db";
import {
  freezeItems,
  budgetOf,
  resolveSpecToText,
  resolveSpecAttachments,
  type ContextSpec,
  type SpecItem,
} from "./composer/specs";
import type { ItemValidationError } from "./composer/weights";

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
}

export interface MauriceInput {
  name: string;
  hat?: string;
  palette?: string;
  model?: string | null;
  temp?: number;
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

export function getMaurice(id: string): Maurice | null {
  const row = getRow(id);
  return row ? toMaurice(row) : null;
}

/** Whether a member may use a Maurice — its creator, or a guest it's shared
 *  with. A null id is the everyday Maurice, always usable. Unknown ids are not. */
export function canUseMaurice(mauriceId: string | null, userId: string): boolean {
  if (!mauriceId) return true;
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

export function createMaurice(
  memberId: string,
  input: MauriceInput,
): Maurice | { errors: ItemValidationError[] } {
  const frozen = freezeItems(memberId, input.context ?? []);
  if ("errors" in frozen) return frozen;

  const id = crypto.randomUUID();
  db.run(
    `INSERT INTO maurices
       (id, name, hat, palette, model, temp, tagline, prompt, context_json, tool_families, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.name.trim(),
      input.hat ?? "boater",
      input.palette ?? "ink",
      input.model ?? null,
      input.temp ?? 0.5,
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
       name = ?, hat = ?, palette = ?, model = ?, temp = ?, tagline = ?,
       prompt = ?, context_json = ?, tool_families = ?, updated_at = datetime('now')
     WHERE id = ?`,
    [
      (input.name ?? row.name).trim(),
      input.hat ?? row.hat,
      input.palette ?? row.palette,
      input.model !== undefined ? input.model : row.model,
      input.temp ?? row.temp,
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
export function resolveMauriceContext(memberId: string, m: Maurice) {
  return resolveSpecToText(memberId, { items: m.context, resolved_at: "" });
}

/** Binary (img/pdf) attachments baked into a Maurice's context bundle. */
export function resolveMauriceAttachments(memberId: string, m: Maurice) {
  return resolveSpecAttachments(memberId, { items: m.context, resolved_at: "" });
}
