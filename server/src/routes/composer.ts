import { Hono } from "hono";
import db from "../db";
import { scanNotes, resolveSubtree } from "../services/composer/notes";
import { searchBooks, bookCoverage, libraryRootFor, listChapters } from "../services/composer/calibre";
import { weighItems, validateItems } from "../services/composer/weights";
import { getSpec, saveSpec, refreshSpec, resolveToText, canCompose } from "../services/composer/specs";
import { searchFiles, resolveFolderItem } from "../services/composer/files";

// Context composer API (account-scoped via the /api/v1/* userId gate).
// B1: unified omnibox search across notes, books, and conversations.

const composer = new Hono();

function matchScore(ql: string, ...fields: (string | null | undefined)[]): number {
  if (!ql) return 50; // empty query → everything, recency/title order
  let best = 0;
  for (const f of fields) {
    const s = (f ?? "").toLowerCase();
    if (!s) continue;
    if (s === ql) best = Math.max(best, 100);
    else if (s.startsWith(ql)) best = Math.max(best, 80);
    else if (s.includes(ql)) best = Math.max(best, 60);
  }
  return best;
}

interface SearchResult {
  type: "note" | "book" | "conversation" | "file" | "folder";
  id: string | number;
  title: string;
  sub: string;
  badges: Record<string, unknown>;
  score: number;
}

// GET /api/v1/composer/search?q=…  → ranked results across the three types.
composer.get("/search", (c) => {
  const memberId = c.get("userId") as string;
  if (!memberId) return c.json({ error: "Authentication required" }, 401);
  const q = (c.req.query("q") || "").trim();
  const ql = q.toLowerCase();
  const limit = Math.min(Number(c.req.query("limit")) || 40, 100);
  const out: SearchResult[] = [];

  // ── Notes (orphans/unparented are first-class — every note is searchable) ──
  for (const n of scanNotes(memberId).values()) {
    const score = matchScore(ql, n.title, n.slug);
    if (!score) continue;
    out.push({
      type: "note",
      id: n.slug,
      title: n.title,
      sub: n.isMoc ? "MOC · fans out" : "note · leaf",
      badges: { moc: n.isMoc, archived: n.isArchived, encrypted: n.isEncrypted },
      score,
    });
  }

  // ── Books (the account's Calibre library) ──
  const root = libraryRootFor(memberId);
  for (const b of searchBooks(memberId, q, 30)) {
    const score = matchScore(ql, b.title, b.authors[0]);
    if (!score) continue;
    const cov = root ? bookCoverage(root, b.path) : { chaptersExtracted: 0, chaptersWithSummary: 0 };
    out.push({
      type: "book",
      id: b.id,
      title: b.title,
      sub: b.authors.join(", "),
      badges: {
        author: b.authors[0] ?? null,
        coverage: cov.chaptersExtracted
          ? `${cov.chaptersWithSummary}/${cov.chaptersExtracted}`
          : null,
      },
      score,
    });
  }

  // ── Conversations (rooms the member participates in) ──
  const convRows = db
    .query(
      `SELECT c.id, c.title, c.updated_at
       FROM conversations c
       JOIN conversation_participants p
         ON p.conversation_id = c.id AND p.member_id = ?
       GROUP BY c.id
       ORDER BY c.updated_at DESC
       LIMIT 300`,
    )
    .all(memberId) as Array<{ id: string; title: string | null; updated_at: string }>;
  for (const r of convRows) {
    const title = r.title || "Untitled conversation";
    const score = matchScore(ql, title);
    if (!score) continue;
    const date = (r.updated_at || "").slice(0, 10);
    out.push({
      type: "conversation",
      id: r.id,
      title,
      sub: `conversation · ${date}`,
      badges: { date },
      score,
    });
  }

  // ── Library files + folders (the member's per-user file library) ──
  for (const h of searchFiles(memberId, ql)) {
    const score = matchScore(ql, h.title);
    if (!score) continue;
    out.push({
      type: h.type,
      id: h.id,
      title: h.title,
      sub: h.sub,
      badges: { kind: h.kind ?? null },
      score,
    });
  }

  out.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  return c.json({ q, results: out.slice(0, limit) });
});

// GET /api/v1/composer/folders/:id/resolve?recurse=&exclude=
// Descendant tree (subfolders + files) with per-file include/exclude, text token
// weight, and binary attachments flagged n/a. Mirrors notes/:id/resolve; drives
// the folder tray card's "include contents" preview.
composer.get("/folders/:id/resolve", (c) => {
  const memberId = c.get("userId") as string;
  if (!memberId) return c.json({ error: "Authentication required" }, 401);
  const recurseParam = c.req.query("recurse");
  const res = resolveFolderItem(memberId, {
    id: c.req.param("id"),
    recurse: recurseParam == null ? undefined : recurseParam === "true",
    exclude: (c.req.query("exclude") || "").split(",").map((s) => s.trim()).filter(Boolean),
  });
  if (!res) return c.json({ error: "Folder not found" }, 404);
  return c.json(res);
});

// GET /api/v1/composer/notes/:id/resolve
//   ?recurse=true|false        (default: the note's own moc flag)
//   &include_archived=true     (default false — archived withheld + counted)
//   &exclude=slugA,slugB       (drop these nodes and their subtrees)
// Returns the flat resolved set + counts AND the nested tree preview (same data,
// two zoom levels) so the UI can show "+9 notes" collapsed or the outline open.
composer.get("/notes/:id/resolve", (c) => {
  const memberId = c.get("userId") as string;
  if (!memberId) return c.json({ error: "Authentication required" }, 401);
  const recurseParam = c.req.query("recurse");
  const res = resolveSubtree(memberId, c.req.param("id"), {
    recurse: recurseParam == null ? undefined : recurseParam === "true",
    includeArchived: c.req.query("include_archived") === "true",
    excluded: (c.req.query("exclude") || "").split(",").map((s) => s.trim()).filter(Boolean),
  });
  if (!res) return c.json({ error: "Note not found" }, 404);
  return c.json(res);
});

// GET /api/v1/composer/books/:id/chapters
// Classified chapter list (front_matter | body | back_matter; front/back hidden),
// per-chapter summary availability + summary/full token weights, and book-level
// coverage over the visible (body) chapters. Drives the section list, the Up-to
// slider (over visible), and Select mode.
composer.get("/books/:id/chapters", (c) => {
  const memberId = c.get("userId") as string;
  if (!memberId) return c.json({ error: "Authentication required" }, 401);
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "Invalid book id" }, 400);
  const res = listChapters(memberId, id);
  if (!res) return c.json({ error: "No library connected, or book not found" }, 404);
  return c.json(res);
});

// POST /api/v1/composer/weigh  { items: [...] }
// Per-item weight + count and the running context total against the 200k window
// (with tier + over-budget flag). Powers the chip readouts and the total — the
// "two numbers always agree" guarantee. Rejects mismatched options (e.g. a
// conversation that carries recurse/representation).
composer.post("/weigh", async (c) => {
  const memberId = c.get("userId") as string;
  if (!memberId) return c.json({ error: "Authentication required" }, 401);
  const body = await c.req.json().catch(() => ({}));
  const items = Array.isArray(body.items) ? body.items : [];
  const errs = validateItems(items);
  if (errs.length) return c.json({ error: "invalid items", details: errs }, 400);
  return c.json(weighItems(memberId, items));
});

// ── Context spec: persistence (snapshot) + resolution (text payload) ──

// GET the stored spec (frozen snapshots) for a conversation.
composer.get("/context/:cid", (c) => {
  const memberId = c.get("userId") as string;
  const cid = c.req.param("cid");
  if (!canCompose(memberId, cid)) return c.json({ error: "Forbidden" }, 403);
  return c.json(getSpec(memberId, cid));
});

// PUT the spec — validates, freezes each item's resolved set at save time,
// persists, returns the budget. Snapshot semantics: this is when scope is fixed.
composer.put("/context/:cid", async (c) => {
  const memberId = c.get("userId") as string;
  const cid = c.req.param("cid");
  if (!canCompose(memberId, cid)) return c.json({ error: "Forbidden" }, 403);
  const body = await c.req.json().catch(() => ({}));
  const items = Array.isArray(body.items) ? body.items : [];
  const res = saveSpec(memberId, cid, items);
  if ("errors" in res) return c.json({ error: "invalid items", details: res.errors }, 400);
  return c.json(res);
});

// Explicit refresh — re-resolve every item against the current garden/library.
composer.post("/context/:cid/refresh", (c) => {
  const memberId = c.get("userId") as string;
  const cid = c.req.param("cid");
  if (!canCompose(memberId, cid)) return c.json({ error: "Forbidden" }, 403);
  return c.json(refreshSpec(memberId, cid));
});

// Resolve the spec to the actual text payload Maurice loads (from the frozen
// snapshots). Reports per-item weight + total against the budget; never truncates.
composer.get("/context/:cid/resolve", (c) => {
  const memberId = c.get("userId") as string;
  const cid = c.req.param("cid");
  if (!canCompose(memberId, cid)) return c.json({ error: "Forbidden" }, 403);
  return c.json(resolveToText(memberId, cid));
});

export default composer;
