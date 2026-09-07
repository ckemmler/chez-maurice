/**
 * The composer's view of the garden's fiches — the working face of an entry,
 * where reading accumulates.
 *
 *   <collection>/<locale>/<slug>-fiche.md      the fiche itself
 *   <collection>/<locale>/<slug>-fiche/_fragments/NNN.frag   what was written on it
 *
 * A fiche is a 5th context type alongside notes/books/conversations/files.
 * It differs from a note in one way that matters here: its body is only half
 * the material. The fragments beside it are the record of the conversations
 * that produced it, and for a Maurice bound to one book they are the point —
 * so an item carries its fragments by default, and can drop them.
 *
 * Fiches live outside `notes/`, which is all `scanNotes` walks, so none of the
 * note machinery reaches them; this module is deliberately small and separate.
 */

import fs from "node:fs";
import path from "node:path";
import { getUser } from "../users";
import { gardensRoot } from "../gardensRoot";
import { estimateTokens } from "./notes";

const GARDENS = gardensRoot();

/** Mirrors data-api's RESOURCE_COLLECTIONS: every collection that has fiches. */
const COLLECTIONS = [
  "books", "articles", "movies", "games", "series", "podcasts", "people",
] as const;

export interface FicheMeta {
  /** `<collection>/<locale>/<slug>` — stable across renames of the title. */
  id: string;
  collection: string;
  locale: string;
  /** The `-fiche` stem, as on disk. */
  slug: string;
  title: string;
  /** Absolute path to the fiche file. */
  file: string;
  /** Fragment count, for the tray's subtitle. */
  fragments: number;
  /** mtime of the newest of the fiche and its fragments, ISO-8601. */
  updatedAt: string;
}

function ficheId(collection: string, locale: string, slug: string): string {
  return `${collection}/${locale}/${slug}`;
}

/** Split an id back into its parts. Returns null for anything malformed — the
 *  id reaches here from a client, and it becomes a filesystem path. */
export function parseFicheId(id: string): { collection: string; locale: string; slug: string } | null {
  const parts = String(id).split("/");
  if (parts.length !== 3) return null;
  const [collection, locale, slug] = parts as [string, string, string];
  if (!(COLLECTIONS as readonly string[]).includes(collection)) return null;
  if (!/^[a-z]{2}$/.test(locale)) return null;
  // No traversal, no separators: the slug is one filename stem.
  if (!/^[A-Za-z0-9._-]+$/.test(slug) || slug.includes("..")) return null;
  return { collection, locale, slug };
}

function fragmentsDirOf(file: string): string {
  return path.join(path.dirname(file), path.basename(file, ".md"), "_fragments");
}

/** The fragment files of a fiche, oldest first — they are numbered in the
 *  order they were written, which is the order they should be read in. */
function fragmentFiles(file: string): string[] {
  const dir = fragmentsDirOf(file);
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".frag"))
      .sort()
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

function titleOf(raw: string, fallback: string): string {
  const fm = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return fallback;
  const m = fm[1]!.match(/^\s*title:\s*(.+?)\s*$/m) ?? fm[1]!.match(/^\s*name:\s*(.+?)\s*$/m);
  if (!m) return fallback;
  return m[1]!.replace(/^['"]|['"]$/g, "") || fallback;
}

function newest(files: string[]): string {
  let best = "";
  for (const f of files) {
    try {
      const t = fs.statSync(f).mtime.toISOString();
      if (t > best) best = t;
    } catch {}
  }
  return best;
}

/** Every fiche of a member's garden. Cached briefly, like scanNotes. */
export function scanFiches(memberId: string): Map<string, FicheMeta> {
  const hit = _cache.get(memberId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.byId;

  const byId = new Map<string, FicheMeta>();
  const user = getUser(memberId);
  if (user) {
    for (const collection of COLLECTIONS) {
      const collDir = path.join(GARDENS, user.username, collection);
      if (!fs.existsSync(collDir)) continue;
      for (const locale of fs.readdirSync(collDir)) {
        const dir = path.join(collDir, locale);
        try {
          if (!fs.statSync(dir).isDirectory()) continue;
        } catch {
          continue;
        }
        for (const file of fs.readdirSync(dir)) {
          // Only the fiche face: a card is the published position, and it is
          // already on the web — the fiche is where the working notes are.
          if (!file.endsWith("-fiche.md")) continue;
          const full = path.join(dir, file);
          let raw: string;
          try {
            raw = fs.readFileSync(full, "utf8");
          } catch {
            continue;
          }
          const slug = file.slice(0, -".md".length);
          const frags = fragmentFiles(full);
          byId.set(ficheId(collection, locale, slug), {
            id: ficheId(collection, locale, slug),
            collection,
            locale,
            slug,
            title: titleOf(raw, slug),
            file: full,
            fragments: frags.length,
            updatedAt: newest([full, ...frags]),
          });
        }
      }
    }
  }
  _cache.set(memberId, { at: Date.now(), byId });
  return byId;
}

interface CacheEntry {
  at: number;
  byId: Map<string, FicheMeta>;
}
const _cache = new Map<string, CacheEntry>();
const TTL_MS = 15_000;

export function getFiche(memberId: string, id: string): FicheMeta | null {
  return scanFiches(memberId).get(id) ?? null;
}

export interface ResolvedFiche {
  weight: number;
  /** 1 for the fiche, plus one per included fragment. */
  count: number;
  fragments: number;
  title: string;
  missing?: boolean;
}

/** Weigh a fiche item. `include_fragments` defaults to true: for a Maurice
 *  bound to a book, the fragments ARE the accumulated reading. */
export function resolveFicheItem(memberId: string, it: any): ResolvedFiche {
  const meta = getFiche(memberId, String(it.id));
  if (!meta) return { weight: 0, count: 0, fragments: 0, title: String(it.id), missing: true };
  const withFragments = it.include_fragments !== false;
  const text = ficheText(memberId, String(it.id), withFragments);
  return {
    weight: estimateTokens(text),
    count: 1 + (withFragments ? meta.fragments : 0),
    fragments: withFragments ? meta.fragments : 0,
    title: meta.title,
  };
}

/** Strip the frontmatter block; the body is what the model should read. */
function bodyOf(raw: string): string {
  const m = raw.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/);
  return (m ? m[1]! : raw).trim();
}

/** A fragment's one-line summary, from its frontmatter — it labels the
 *  fragment in the assembled text so the model can cite which session said
 *  what. */
function fragmentSummary(raw: string): string {
  const m = raw.match(/^---\n([\s\S]*?)\n---/);
  const s = m?.[1]?.match(/^\s*summary:\s*(.+?)\s*$/m)?.[1] ?? "";
  return s.replace(/^["']|["']$/g, "");
}

/** The fiche's text: its body, then each fragment under its own summary. */
export function ficheText(memberId: string, id: string, withFragments = true): string {
  const meta = getFiche(memberId, id);
  if (!meta) return "";
  let raw: string;
  try {
    raw = fs.readFileSync(meta.file, "utf8");
  } catch {
    return "";
  }
  const parts = [`# ${meta.title}\n\n${bodyOf(raw)}`];
  if (withFragments) {
    for (const f of fragmentFiles(meta.file)) {
      let fr: string;
      try {
        fr = fs.readFileSync(f, "utf8");
      } catch {
        continue;
      }
      const summary = fragmentSummary(fr);
      parts.push(`## ${summary || path.basename(f, ".frag")}\n\n${bodyOf(fr)}`);
    }
  }
  return parts.join("\n\n---\n\n");
}
