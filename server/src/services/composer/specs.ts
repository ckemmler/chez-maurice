import db from "../../db";
import { isParticipant } from "../conversations";
import { resolveSubtree, readNoteBody, estimateTokens } from "./notes";
import { readChapters } from "./calibre";
import { resolveFileItem, resolveFolderItem, fileText, fileBinary, type FileAttachment } from "./files";
import {
  resolveBookItem,
  conversationWeight,
  validateItems,
  CTX_BUDGET,
  type ItemValidationError,
} from "./weights";

// B5: persist the composed context per (conversation, account) with SNAPSHOT
// semantics — each item freezes the set it resolved to (note slugs / chapter
// refs) at save/refresh time. Adding a child note later can't silently grow an
// existing context until an explicit refresh. The resolve endpoint reads the
// actual text for the frozen set (content stays live; scope is frozen).

export interface SpecItemSnapshot {
  weight: number;
  count: number;
  slugs?: string[]; // note: the frozen descendant set
  refs?: string[]; // book: the frozen included chapters
  representation?: "summary" | "full";
  encrypted?: boolean;
  archivedWithheld?: number;
  // file/folder
  kind?: string; // file: its kind (text/img/pdf/file)
  na?: boolean; // file: binary (rides along as an attachment, weight 0)
  textIds?: string[]; // folder: frozen included text files
  binaryIds?: string[]; // file (self) or folder: frozen binary attachments
  resolved_at: string;
}
export interface SpecItem {
  type: "note" | "book" | "conversation" | "file" | "folder";
  id: string | number;
  [k: string]: any;
  snapshot: SpecItemSnapshot;
}
export interface ContextSpec {
  items: SpecItem[];
  resolved_at: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function budgetOf(items: SpecItem[]) {
  const total = items.reduce((s, i) => s + (i.snapshot?.weight ?? 0), 0);
  const f = total / CTX_BUDGET;
  const tier = f >= 1 ? "warn" : f >= 0.55 ? "caution" : f >= 0.18 ? "inkSoft" : "light";
  return { total, budget: CTX_BUDGET, over: total > CTX_BUDGET, tier };
}

// Resolve one item's set + weight and freeze it into a snapshot.
function freeze(memberId: string, it: any): SpecItem {
  const at = nowIso();
  if (it.type === "note") {
    const r = resolveSubtree(memberId, it.id, {
      recurse: it.recurse,
      includeArchived: it.include_archived,
      excluded: it.exclude,
    });
    const s = r?.resolved;
    return {
      ...it,
      snapshot: {
        weight: s?.weight ?? 0,
        count: s?.count ?? 0,
        slugs: s?.slugs ?? [],
        encrypted: s?.encrypted ?? false,
        archivedWithheld: s?.archivedWithheld ?? 0,
        resolved_at: at,
      },
    };
  }
  if (it.type === "book") {
    const r = resolveBookItem(memberId, it);
    return {
      ...it,
      snapshot: {
        weight: r.weight,
        count: r.count,
        refs: r.includedRefs,
        representation: r.representation,
        resolved_at: at,
      },
    };
  }
  if (it.type === "file") {
    const r = resolveFileItem(memberId, String(it.id));
    return {
      ...it,
      snapshot: {
        weight: r.weight, count: 1, kind: r.kind, na: r.na,
        binaryIds: r.na ? [String(it.id)] : [],
        resolved_at: at,
      },
    };
  }
  if (it.type === "folder") {
    const r = resolveFolderItem(memberId, it);
    return {
      ...it,
      snapshot: {
        weight: r?.weight ?? 0, count: r?.count ?? 0,
        textIds: r?.includedTextIds ?? [], binaryIds: r?.includedBinaryIds ?? [],
        resolved_at: at,
      },
    };
  }
  // conversation
  const r = conversationWeight(memberId, it.id);
  return { ...it, snapshot: { weight: r.weight, count: r.count, resolved_at: at } };
}

export function getSpec(memberId: string, conversationId: string): ContextSpec {
  const row = db
    .query(`SELECT spec_json FROM composer_specs WHERE conversation_id = ? AND account_id = ?`)
    .get(conversationId, memberId) as { spec_json: string } | null;
  if (!row) return { items: [], resolved_at: nowIso() };
  try {
    return JSON.parse(row.spec_json) as ContextSpec;
  } catch {
    return { items: [], resolved_at: nowIso() };
  }
}

export interface SaveResult {
  spec: ContextSpec;
  total: number;
  budget: number;
  over: boolean;
  tier: string;
}

export { budgetOf };

/** Validate and freeze a set of items into a snapshot spec, WITHOUT persisting.
 *  Shared by conversation specs and by a Maurice's baked-in context bundle. */
export function freezeItems(
  memberId: string,
  items: any[],
): { spec: ContextSpec } | { errors: ItemValidationError[] } {
  const errors = validateItems(items);
  if (errors.length) return { errors };
  const frozen = items.map((it) => freeze(memberId, it));
  return { spec: { items: frozen, resolved_at: nowIso() } };
}

/** Validate, freeze each item's resolved set, and persist. Returns budget. */
export function saveSpec(
  memberId: string,
  conversationId: string,
  items: any[],
): SaveResult | { errors: ItemValidationError[] } {
  const frozenRes = freezeItems(memberId, items);
  if ("errors" in frozenRes) return frozenRes;
  const spec = frozenRes.spec;
  const frozen = spec.items;
  db.run(
    `INSERT INTO composer_specs (conversation_id, account_id, spec_json, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(conversation_id, account_id)
     DO UPDATE SET spec_json = excluded.spec_json, updated_at = datetime('now')`,
    [conversationId, memberId, JSON.stringify(spec)],
  );
  return { spec, ...budgetOf(frozen) };
}

/** Re-resolve every item against the current garden/library (explicit refresh). */
export function refreshSpec(memberId: string, conversationId: string): SaveResult {
  const current = getSpec(memberId, conversationId);
  // strip stale snapshots before re-freezing
  const items = current.items.map(({ snapshot, ...rest }) => rest);
  return saveSpec(memberId, conversationId, items) as SaveResult;
}

export function canCompose(memberId: string, conversationId: string): boolean {
  return isParticipant(conversationId, memberId);
}

// ── Resolution to the actual text payload Maurice loads ──

export interface ResolvedItemText {
  type: string;
  id: string | number;
  text: string;
  weight: number;
  encrypted?: boolean;
}
export interface ResolvedPayload {
  items: ResolvedItemText[];
  total: number;
  budget: number;
  over: boolean;
  tier: string;
}

function transcriptText(conversationId: string): string {
  const rows = db
    .query(
      `SELECT m.role, m.content, u.display_name
       FROM messages m LEFT JOIN users u ON u.id = m.author_id
       WHERE m.conversation_id = ? ORDER BY m.created_at`,
    )
    .all(conversationId) as Array<{ role: string; content: string; display_name: string | null }>;
  return rows
    .filter((r) => r.role !== "system")
    .map((r) => `${r.role === "assistant" ? "Maurice" : r.display_name || "User"}: ${r.content}`)
    .join("\n\n");
}

/** Produce the assembled context text from the FROZEN snapshots. Never truncates
 *  — reports per-item weight + total against the budget so the UI can trim. */
export function resolveToText(memberId: string, conversationId: string): ResolvedPayload {
  return resolveSpecToText(memberId, getSpec(memberId, conversationId));
}

/** Resolve an arbitrary frozen spec (a conversation's, or a Maurice's baked-in
 *  bundle) to its text payload. */
export function resolveSpecToText(memberId: string, spec: ContextSpec): ResolvedPayload {
  const items: ResolvedItemText[] = spec.items.map((it) => {
    if (it.type === "note") {
      const slugs = it.snapshot?.slugs ?? [];
      const parts = slugs
        .map((s) => readNoteBody(memberId, s))
        .filter((n): n is { title: string; body: string } => !!n)
        .map((n) => `# ${n.title}\n\n${n.body}`);
      const text = parts.join("\n\n---\n\n");
      return { type: "note", id: it.id, text, weight: estimateTokens(text), encrypted: it.snapshot?.encrypted };
    }
    if (it.type === "book") {
      const refs = it.snapshot?.refs ?? [];
      const rep = (it.snapshot?.representation ?? "summary") as "summary" | "full";
      const chs = readChapters(memberId, Number(it.id), refs, rep);
      const text = chs.map((c) => c.text).filter(Boolean).join("\n\n---\n\n");
      return { type: "book", id: it.id, text, weight: estimateTokens(text) };
    }
    if (it.type === "file") {
      // binaries carry no text (they ride along via resolveSpecAttachments)
      const text = it.snapshot?.na ? "" : fileText(memberId, String(it.id));
      return { type: "file", id: it.id, text, weight: estimateTokens(text) };
    }
    if (it.type === "folder") {
      const ids = it.snapshot?.textIds ?? [];
      const text = ids.map((fid) => fileText(memberId, fid)).filter(Boolean).join("\n\n---\n\n");
      return { type: "folder", id: it.id, text, weight: estimateTokens(text) };
    }
    // conversation
    const text = transcriptText(String(it.id));
    return { type: "conversation", id: it.id, text, weight: estimateTokens(text) };
  });
  const total = items.reduce((s, i) => s + i.weight, 0);
  const f = total / CTX_BUDGET;
  const tier = f >= 1 ? "warn" : f >= 0.55 ? "caution" : f >= 0.18 ? "inkSoft" : "light";
  return { items, total, budget: CTX_BUDGET, over: total > CTX_BUDGET, tier };
}

// ── Binary attachments (img/pdf) from the FROZEN snapshots ───────────────────
// Files are the only context type that can carry binaries. Text rides in the
// system prompt (resolveSpecToText); images/PDFs become real content blocks on
// the user turn (claude.ts). Deduped by file id across the whole spec.
export function resolveSpecAttachments(memberId: string, spec: ContextSpec): FileAttachment[] {
  const seen = new Set<string>();
  const out: FileAttachment[] = [];
  for (const it of spec.items) {
    if (it.type !== "file" && it.type !== "folder") continue;
    for (const fid of it.snapshot?.binaryIds ?? []) {
      if (seen.has(fid)) continue;
      seen.add(fid);
      const att = fileBinary(memberId, fid);
      if (att) out.push(att);
    }
  }
  return out;
}

/** Binary attachments for a conversation's stored spec. */
export function resolveAttachments(memberId: string, conversationId: string): FileAttachment[] {
  return resolveSpecAttachments(memberId, getSpec(memberId, conversationId));
}
