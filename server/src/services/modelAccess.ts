import db from "../db";
import { getUser } from "./users";
import { listModels, availableModels, toModelInfo, getModel, householdDefaultModel, type ModelInfo } from "./models";

// Per-member model access. Admins are computed-all (no rows persisted); standard
// members have an explicit allow-list. The household default must be in a
// member's set, else they fall back to their best available model.

function isAdmin(userId: string): boolean {
  return getUser(userId)?.role === "admin";
}

/** Model ids a member may use (admins: every model). */
export function allowedModelIds(userId: string): string[] {
  if (isAdmin(userId)) return listModels().map((m) => m.id);
  return (
    db
      .query(`SELECT model_id FROM user_model_access WHERE user_id = ?`)
      .all(userId) as Array<{ model_id: string }>
  ).map((r) => r.model_id);
}

export function canUse(userId: string, modelId: string): boolean {
  if (isAdmin(userId)) return !!getModel(modelId);
  return !!db
    .query(`SELECT 1 FROM user_model_access WHERE user_id = ? AND model_id = ?`)
    .get(userId, modelId);
}

/** Replace a standard member's whole allow-list (admins are ignored). */
export function replaceAccess(userId: string, modelIds: string[]): void {
  if (isAdmin(userId)) return;
  db.run(`DELETE FROM user_model_access WHERE user_id = ?`, [userId]);
  const valid = new Set(listModels().map((m) => m.id));
  for (const id of [...new Set(modelIds)]) {
    if (valid.has(id)) {
      db.run(`INSERT OR IGNORE INTO user_model_access (user_id, model_id) VALUES (?, ?)`, [userId, id]);
    }
  }
}

export function setAccess(userId: string, modelId: string, on: boolean): void {
  if (isAdmin(userId)) return;
  if (on) {
    db.run(`INSERT OR IGNORE INTO user_model_access (user_id, model_id) VALUES (?, ?)`, [userId, modelId]);
  } else {
    db.run(`DELETE FROM user_model_access WHERE user_id = ? AND model_id = ?`, [userId, modelId]);
  }
}

// ── Everyday Maurice: the per-member preferred model ────────────────────────
// The everyday (unspecialized) Maurice has no DB row, so its "model" lives on the
// member. Each member may run a different LLM for it; null = household default.

/** A member's stored everyday-model preference (null if unset or now-unknown). */
export function getEverydayModel(userId: string): string | null {
  const row = db
    .query(`SELECT everyday_model FROM users WHERE id = ?`)
    .get(userId) as { everyday_model: string | null } | undefined;
  const m = row?.everyday_model;
  return m && getModel(m) ? m : null;
}

/** The model the everyday Maurice actually uses for this member (preference, else
 *  household default). */
export function everydayModelFor(userId: string): string {
  return getEverydayModel(userId) ?? householdDefaultModel();
}

/** Set (or clear with null) a member's everyday model. Must be usable by them. */
export function setEverydayModel(userId: string, modelId: string | null): boolean {
  if (modelId !== null && !canUse(userId, modelId)) return false;
  db.run(`UPDATE users SET everyday_model = ? WHERE id = ?`, [modelId, userId]);
  return true;
}

/** Seed a brand-new standard member with the household default model. */
export function seedDefaultAccess(userId: string): void {
  if (isAdmin(userId)) return;
  const def = (db.query(`SELECT default_model FROM households WHERE id = 'default'`).get() as any)?.default_model;
  if (def && getModel(def)) {
    db.run(`INSERT OR IGNORE INTO user_model_access (user_id, model_id) VALUES (?, ?)`, [userId, def]);
  }
}

/** member id → allowed model ids (admins resolved to all). */
export function accessMatrix(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const users = db.query(`SELECT id FROM users`).all() as Array<{ id: string }>;
  for (const u of users) out[u.id] = allowedModelIds(u.id);
  return out;
}

/** model id → number of members who may use it (admins always count). */
export function accessCounts(): Record<string, number> {
  const matrix = accessMatrix();
  const counts: Record<string, number> = {};
  for (const m of listModels()) counts[m.id] = 0;
  for (const ids of Object.values(matrix)) {
    for (const id of ids) if (id in counts) counts[id] = (counts[id] ?? 0) + 1;
  }
  return counts;
}

/** The roster a member may use, as ModelInfo (for /api/models). */
export function availableModelsForUser(userId: string): ModelInfo[] {
  const allowed = new Set(allowedModelIds(userId));
  const def = householdDefaultModel();
  return availableModels()
    .filter((m) => allowed.has(m.id))
    .map((m) => ({ ...m, is_default: m.id === def }));
}

/** Pick a usable model for a turn: the preferred one if allowed, else the
 *  household default if allowed, else the member's best available (prefer the
 *  default's tier, then any). Returns null if the member has no models. */
export function resolveUsableModel(userId: string, preferred: string | null | undefined, fallback: string): string | null {
  if (preferred && getModel(preferred) && canUse(userId, preferred)) return preferred;
  if (getModel(fallback) && canUse(userId, fallback)) return fallback;
  const allowed = allowedModelIds(userId).filter((id) => getModel(id));
  if (allowed.length === 0) return null;
  // Prefer a cloud model if any (closest to the usual default), else first.
  const cloud = allowed.find((id) => getModel(id)?.tier === "cloud");
  return cloud ?? allowed[0] ?? null;
}
