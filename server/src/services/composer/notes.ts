import fs from "node:fs";
import path from "node:path";
import { getUser } from "../users";
import { gardensRoot } from "../gardensRoot";

// Reader for a member's garden notes — the composer's view of the notes graph.
//
// Notes live at web/gardens/<username>/notes/<locale>/<slug>.md. moc/archived/
// encrypted are entries in the `flags` array. The tree the garden renders is
// built from wiki-links ([[slug]]) in MOC bodies (see web/src/lib/subtree-scan),
// so we capture both the `parent` frontmatter (15 notes use it) and the body's
// wiki-links; the B2 descendant resolver picks the model. Weight is a fast,
// consistent char/4 token estimate of the body.

export interface NoteMeta {
  slug: string;
  locale: string;
  title: string;
  description?: string;
  flags: string[];
  isMoc: boolean;
  isArchived: boolean;
  isEncrypted: boolean;
  parent?: string;
  /** wiki-linked slugs found in the body (a MOC's children) */
  links: string[];
  /** estimated token weight of the body */
  weight: number;
}

const WIKI_RE = /\[\[([a-z0-9-]+)(?:\|[^\]]+)?\]\]/g;
const GARDENS = gardensRoot();

export function estimateTokens(text: string): number {
  // ~4 chars/token — fast and consistent; exactness isn't the point.
  return Math.ceil((text?.length ?? 0) / 4);
}

function notesRootFor(memberId: string): string | null {
  const user = getUser(memberId);
  if (!user) return null;
  return path.join(GARDENS, user.username, "notes");
}

const unquote = (s: string) => s.trim().replace(/^["']|["']$/g, "").trim();

// Parse just the fields the composer needs, without a YAML dependency — the
// same approach web/src/lib/subtree-scan.ts uses for these notes. `flags` is
// either flow (`[public, moc]`) or block (`- public\n- moc`).
function parseFlags(fmText: string): string[] {
  const flow = fmText.match(/^flags:\s*\[([^\]]*)\]/m);
  if (flow) return flow[1].split(",").map((s) => s.trim()).filter(Boolean);
  const block = fmText.match(/^flags:\s*\n((?:[ \t]*-[ \t]*.+\n?)*)/m);
  if (block) {
    return (block[1].match(/^[ \t]*-[ \t]*(.+)$/gm) ?? []).map((l) =>
      l.replace(/^[ \t]*-[ \t]*/, "").trim(),
    );
  }
  return [];
}

function field(fmText: string, key: string): string | undefined {
  const m = fmText.match(new RegExp(`^${key}:[ \\t]*(.+)$`, "m"));
  return m ? unquote(m[1]) : undefined;
}

function parseNote(raw: string, slug: string, locale: string): NoteMeta | null {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return null;
  const fmText = m[1];
  const body = m[2] ?? "";
  const flags = parseFlags(fmText);
  const links = [...new Set([...body.matchAll(WIKI_RE)].map((x) => x[1]))];
  return {
    slug,
    locale,
    title: field(fmText, "title") || slug,
    description: field(fmText, "description"),
    flags,
    isMoc: flags.includes("moc"),
    isArchived: flags.includes("archived"),
    isEncrypted: flags.includes("encrypted"),
    parent: field(fmText, "parent"),
    links,
    weight: estimateTokens(body),
  };
}

// ── Per-member scan cache (short TTL — fresh enough for autocomplete) ──
interface CacheEntry {
  at: number;
  bySlug: Map<string, NoteMeta>;
}
const _cache = new Map<string, CacheEntry>();
const TTL_MS = 15_000;

/** All of a member's notes, keyed by slug. Cached briefly. */
export function scanNotes(memberId: string): Map<string, NoteMeta> {
  const hit = _cache.get(memberId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.bySlug;

  const bySlug = new Map<string, NoteMeta>();
  const root = notesRootFor(memberId);
  if (root && fs.existsSync(root)) {
    for (const locale of fs.readdirSync(root)) {
      const dir = path.join(root, locale);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(dir);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;
      for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith(".md") && !file.endsWith(".mdx")) continue;
        const slug = file.replace(/\.mdx?$/, "");
        // en/fr translations carry different slugs; if a slug somehow repeats,
        // first locale wins (deterministic).
        if (bySlug.has(slug)) continue;
        let raw: string;
        try {
          raw = fs.readFileSync(path.join(dir, file), "utf8");
        } catch {
          continue;
        }
        const note = parseNote(raw, slug, locale);
        if (note) bySlug.set(slug, note);
      }
    }
  }
  _cache.set(memberId, { at: Date.now(), bySlug });
  return bySlug;
}

export function getNote(memberId: string, slug: string): NoteMeta | null {
  return scanNotes(memberId).get(slug) ?? null;
}

// ── B2: descendant resolution + tree preview ──────────────────────────────
//
// The garden's tree is wiki-link based (a MOC's body links its children); we
// walk those links from the selected note with a visited-set so a node reachable
// by several paths appears once (and cycles terminate). Two product rules:
//   • `archived` is a PER-NODE exclusion (the node drops; its non-archived
//     children still resolve) — toggleable via includeArchived.
//   • a manually `excluded` node drops itself AND its whole subtree (cascades).
// The root is the anchor — always included. `encrypted` is carried per node and
// never collapsed to a per-subtree flag.

export interface TreeNode {
  id: string;
  title: string;
  moc: boolean;
  archived: boolean;
  encrypted: boolean;
  missing?: boolean;
  weight: number;
  childCount: number;
  /** in the resolved context set given recurse/include_archived/excluded */
  included: boolean;
  /** dropped by a manual exclusion (self or ancestor) */
  excluded: boolean;
  children: TreeNode[];
}

export interface ResolveResult {
  id: string;
  recurse: boolean;
  resolved: {
    count: number;
    weight: number;
    encrypted: boolean; // any included node is encrypted
    archivedWithheld: number; // archived nodes kept out (the "include N archived" affordance)
    manualExcluded: number;
    hasChildren: boolean;
    slugs: string[];
  };
  tree: TreeNode;
}

export function resolveSubtree(
  memberId: string,
  slug: string,
  opts: { recurse?: boolean; includeArchived?: boolean; excluded?: string[] } = {},
): ResolveResult | null {
  const bySlug = scanNotes(memberId);
  const rootNote = bySlug.get(slug);
  if (!rootNote) return null;

  const includeArchived = !!opts.includeArchived;
  const excludedSet = new Set(opts.excluded ?? []);
  // Default recurse follows the node's nature (ON for a MOC, OFF for a leaf),
  // but an explicit flag wins.
  const recurse = opts.recurse ?? rootNote.isMoc;

  const visited = new Set<string>();
  let archivedWithheld = 0;

  const walk = (s: string, manualExcludedAncestor: boolean, isRoot: boolean): TreeNode | null => {
    if (visited.has(s)) return null; // dedup multi-path / break cycles
    visited.add(s);
    const note = bySlug.get(s);
    if (!note) {
      return {
        id: s, title: s, moc: false, archived: false, encrypted: false, missing: true,
        weight: 0, childCount: 0, included: false, excluded: true, children: [],
      };
    }
    const manualExcluded = manualExcludedAncestor || excludedSet.has(s);
    const children =
      recurse && (isRoot || !manualExcluded)
        ? note.links.map((l) => walk(l, manualExcluded, false)).filter((n): n is TreeNode => !!n)
        : [];
    const includedByArchive = isRoot || !note.isArchived || includeArchived;
    const included = isRoot || (recurse && !manualExcluded && includedByArchive);
    if (!included && note.isArchived && !manualExcluded) archivedWithheld++;
    return {
      id: s, title: note.title, moc: note.isMoc, archived: note.isArchived,
      encrypted: note.isEncrypted, weight: note.weight,
      childCount: children.length, included, excluded: manualExcluded && !isRoot, children,
    };
  };

  const tree = walk(slug, false, true)!;

  // Aggregate over the included nodes.
  let count = 0, weight = 0, encrypted = false;
  const slugs: string[] = [];
  const collect = (n: TreeNode) => {
    if (n.included) {
      count++; weight += n.weight; encrypted ||= n.encrypted; slugs.push(n.id);
    }
    n.children.forEach(collect);
  };
  collect(tree);

  return {
    id: slug,
    recurse,
    resolved: {
      count, weight, encrypted, archivedWithheld,
      manualExcluded: excludedSet.size,
      hasChildren: (rootNote.links.length > 0),
      slugs,
    },
    tree,
  };
}

/** Invalidate the scan cache (used after writes / on explicit refresh). */
export function invalidateNotes(memberId?: string): void {
  if (memberId) _cache.delete(memberId);
  else _cache.clear();
}

/** Read a note's title + body (frontmatter stripped) for context resolution. */
export function readNoteBody(memberId: string, slug: string): { title: string; body: string } | null {
  const note = scanNotes(memberId).get(slug);
  const root = notesRootFor(memberId);
  if (!note || !root) return null;
  for (const ext of [".md", ".mdx"]) {
    const p = path.join(root, note.locale, slug + ext);
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, "utf8");
      const m = raw.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/);
      return { title: note.title, body: (m ? m[1] : raw).trim() };
    }
  }
  return null;
}
