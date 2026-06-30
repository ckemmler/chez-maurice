import db from "../../db";
import { estimateTokens, resolveSubtree } from "./notes";
import { listChapters, type ChapterInfo } from "./calibre";
import { resolveFileItem, resolveFolderItem } from "./files";

// B4: weight estimation across the three artifact types. Drives the per-chip
// count/weight and the running context total. Estimates are char/4 token counts —
// consistent and fast (file stats only for books; no content reads here). The
// book scope→included resolution is shared with the B5 text resolver.

export const CTX_BUDGET = 200_000;

// ── Item shapes (the persisted spec contract, B5) ──
export type BookScope =
  | { mode: "all" }
  | { mode: "up_to"; chapter: number } // chapter = index into the VISIBLE list, inclusive
  | { mode: "chapters"; refs: string[] };

export type ComposerItem =
  | { type: "note"; id: string; recurse?: boolean; include_archived?: boolean; exclude?: string[] }
  | { type: "book"; id: number; representation?: "summary" | "full"; scope?: BookScope }
  | { type: "conversation"; id: string }
  | { type: "file"; id: string }
  | { type: "folder"; id: string; recurse?: boolean; exclude?: string[] };

export interface ItemValidationError {
  index: number;
  message: string;
}

// Conversations never fan out; notes don't carry a representation/scope; books
// don't recurse. Reject mismatches rather than silently ignoring them.
export function validateItems(items: any[]): ItemValidationError[] {
  const errs: ItemValidationError[] = [];
  items.forEach((it, index) => {
    if (!it || typeof it !== "object") return errs.push({ index, message: "not an object" });
    if (it.type === "conversation") {
      if ("recurse" in it || "representation" in it || "scope" in it || "exclude" in it)
        errs.push({ index, message: "conversation items take no recurse/representation/scope" });
    } else if (it.type === "note") {
      if ("representation" in it || "scope" in it)
        errs.push({ index, message: "note items take no representation/scope" });
    } else if (it.type === "book") {
      if ("recurse" in it || "exclude" in it)
        errs.push({ index, message: "book items take no recurse/exclude" });
    } else if (it.type === "file") {
      if ("recurse" in it || "representation" in it || "scope" in it || "exclude" in it)
        errs.push({ index, message: "file items take no recurse/representation/scope/exclude" });
    } else if (it.type === "folder") {
      if ("representation" in it || "scope" in it)
        errs.push({ index, message: "folder items take no representation/scope" });
    } else {
      errs.push({ index, message: `unknown item type: ${it.type}` });
    }
  });
  return errs;
}

// ── Per-type resolvers (return weight + the detail the chip needs) ──

export interface ResolvedNote {
  weight: number;
  count: number;
  encrypted: boolean;
  archivedWithheld: number;
  title: string;
  moc: boolean;
  missing?: boolean;
}
export function resolveNoteItem(memberId: string, it: any): ResolvedNote {
  const r = resolveSubtree(memberId, it.id, {
    recurse: it.recurse,
    includeArchived: it.include_archived,
    excluded: it.exclude,
  });
  if (!r) return { weight: 0, count: 0, encrypted: false, archivedWithheld: 0, title: String(it.id), moc: false, missing: true };
  return {
    weight: r.resolved.weight,
    count: r.resolved.count,
    encrypted: r.resolved.encrypted,
    archivedWithheld: r.resolved.archivedWithheld,
    title: r.tree.title,
    moc: r.tree.moc,
  };
}

export interface ResolvedBook {
  weight: number;
  count: number;
  visibleCount: number;
  representation: "summary" | "full";
  includedRefs: string[];
  title: string;
  missing?: boolean;
}
export function resolveBookItem(memberId: string, it: any): ResolvedBook {
  const bc = listChapters(memberId, Number(it.id));
  const rep: "summary" | "full" = it.representation === "full" ? "full" : "summary";
  if (!bc) return { weight: 0, count: 0, visibleCount: 0, representation: rep, includedRefs: [], title: String(it.id), missing: true };

  const visible = bc.chapters.filter((c) => !c.hidden);
  const scope: BookScope = it.scope ?? { mode: "all" };
  let included: ChapterInfo[];
  if (scope.mode === "up_to") {
    const n = Math.max(0, Math.min(visible.length - 1, Number((scope as any).chapter)));
    included = visible.slice(0, n + 1); // spoiler-safe, over visible only
  } else if (scope.mode === "chapters") {
    const refs = new Set((scope as any).refs ?? []);
    included = bc.chapters.filter((c) => refs.has(c.ref)); // Select may include hidden
  } else {
    included = visible; // "all" never sweeps in back-matter
  }
  const key = rep === "full" ? "full_tok" : "summary_tok";
  const weight = included.reduce((s, c) => s + (c[key] || 0), 0);
  return {
    weight,
    count: included.length,
    visibleCount: visible.length,
    representation: rep,
    includedRefs: included.map((c) => c.ref),
    title: bc.title,
  };
}

export interface ResolvedConv {
  weight: number;
  count: number; // message count
  title: string;
  missing?: boolean;
}
export function conversationWeight(memberId: string, convId: string): ResolvedConv {
  const isP = db
    .query(`SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND member_id = ?`)
    .get(convId, memberId);
  if (!isP) return { weight: 0, count: 0, title: "conversation", missing: true };
  const convo = db.query(`SELECT title FROM conversations WHERE id = ?`).get(convId) as { title: string | null } | null;
  const rows = db
    .query(`SELECT content FROM messages WHERE conversation_id = ? ORDER BY created_at`)
    .all(convId) as Array<{ content: string }>;
  const text = rows.map((r) => r.content).join("\n");
  return { weight: estimateTokens(text), count: rows.length, title: convo?.title || "Untitled conversation" };
}

// ── The running total ──

function tierFor(total: number): "warn" | "caution" | "inkSoft" | "light" {
  const f = total / CTX_BUDGET;
  if (f >= 1) return "warn";
  if (f >= 0.55) return "caution";
  if (f >= 0.18) return "inkSoft";
  return "light";
}

export interface WeighedItem {
  type: string;
  id: string | number;
  title: string;
  weight: number;
  count?: number;
  encrypted?: boolean;
  archivedWithheld?: number;
  visibleCount?: number;
  representation?: string;
  moc?: boolean;
  heavy?: boolean; // ≥40 resolved notes, or a book ≥80k tokens
  missing?: boolean;
  // file/folder
  kind?: string; // file kind (text/img/pdf/file)
  na?: boolean; // binary file — no token estimate (rides along as attachment)
  binaryCount?: number; // attachments swept in by a folder (uncounted)
  path?: string; // file's folder breadcrumb
}

export function weighItems(memberId: string, items: any[]): {
  items: WeighedItem[];
  total: number;
  budget: number;
  over: boolean;
  tier: string;
} {
  const out: WeighedItem[] = items.map((it) => {
    if (it.type === "note") {
      const r = resolveNoteItem(memberId, it);
      return { type: "note", id: it.id, title: r.title, moc: r.moc, weight: r.weight, count: r.count, encrypted: r.encrypted, archivedWithheld: r.archivedWithheld, heavy: r.count >= 40, missing: r.missing };
    }
    if (it.type === "book") {
      const r = resolveBookItem(memberId, it);
      return { type: "book", id: it.id, title: r.title, weight: r.weight, count: r.count, visibleCount: r.visibleCount, representation: r.representation, heavy: r.weight >= 80_000, missing: r.missing };
    }
    if (it.type === "conversation") {
      const r = conversationWeight(memberId, it.id);
      return { type: "conversation", id: it.id, title: r.title, weight: r.weight, count: r.count, missing: r.missing };
    }
    if (it.type === "file") {
      const r = resolveFileItem(memberId, it.id);
      return { type: "file", id: it.id, title: r.name, weight: r.weight, kind: r.kind, na: r.na, path: r.path, missing: r.missing };
    }
    if (it.type === "folder") {
      const r = resolveFolderItem(memberId, it);
      if (!r) return { type: "folder", id: it.id, title: String(it.id), weight: 0, missing: true };
      return { type: "folder", id: it.id, title: r.title, weight: r.weight, count: r.count, binaryCount: r.binaryCount, heavy: r.weight >= 80_000, missing: false };
    }
    return { type: it.type, id: it.id, title: String(it.id), weight: 0, missing: true };
  });
  const total = out.reduce((s, i) => s + (i.weight || 0), 0);
  return { items: out, total, budget: CTX_BUDGET, over: total > CTX_BUDGET, tier: tierFor(total) };
}
