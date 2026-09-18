import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

// The Maurice system documentation, as read by Maurice Maurice — the built-in
// persona that answers questions about Maurice (services/maurices.ts). The
// notes are written in the owner's garden (maurice-docs.md and the maurice-*.md
// notes beside it) and copied into the repo by scripts/sync-docs.sh, so the
// container image ships a snapshot of them.
//
// Where they are read from:
//   1. MAURICE_DOCS_DIR env — a garden notes dir, to read the live notes
//   2. <repo>/docs/maurice — the committed snapshot (what the image carries)
//
// What goes into the persona's context: the DIGEST plus the DELTA. The digest
// (a note with `digest: true`, maurice-digest.md) condenses the whole set to
// its facts and names, in its `covers` frontmatter map, the date of each note
// it reflects. A note updated since — or one the digest never saw — is loaded
// in full beside it, so the docs stay current between two condensations
// without every turn paying for the full ~60k tokens. With no digest present
// the full set is loaded. Reads are cached on the files' mtimes, so an edited
// note is picked up without a restart.

export interface MauriceDoc {
  /** the note's slug — its filename without .md */
  slug: string;
  title: string;
  /** frontmatter `date`, when present */
  date: string | null;
  /** the note body, frontmatter stripped */
  body: string;
  /** true for the digest note */
  digest: boolean;
  /** digest only: slug → the note date it condenses */
  covers: Record<string, string>;
}

export const DOCS_INDEX_SLUG = "maurice-docs";

export function docsDir(): string {
  const env = process.env.MAURICE_DOCS_DIR;
  if (env) return env;
  // server/src/services -> <repo>/docs/maurice
  return resolve(import.meta.dir, "../../../docs/maurice");
}

interface Frontmatter {
  meta: Record<string, string>;
  /** one level of nesting: `covers:` followed by indented `slug: date` lines */
  maps: Record<string, Record<string, string>>;
  body: string;
}

const unquote = (s: string) => s.trim().replace(/^['"]|['"]$/g, "");

function parseFrontmatter(raw: string): Frontmatter {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: {}, maps: {}, body: raw };
  const meta: Record<string, string> = {};
  const maps: Record<string, Record<string, string>> = {};
  let open: string | null = null;
  for (const line of m[1]!.split(/\r?\n/)) {
    const nested = open && line.match(/^\s+([\w-]+):\s*(.*)$/);
    if (nested) {
      maps[open!]![nested[1]!] = unquote(nested[2]!);
      continue;
    }
    open = null;
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    if (kv[2]!.trim() === "") {
      open = kv[1]!;
      maps[open] = {};
    } else {
      meta[kv[1]!] = unquote(kv[2]!);
    }
  }
  return { meta, maps, body: raw.slice(m[0].length) };
}

let cache: { key: string; docs: MauriceDoc[] } | null = null;

/** Every documentation note — the index first, then the others by slug. Empty
 *  when the directory is missing — the persona then says so rather than
 *  inventing a system. */
export function loadMauriceDocs(): MauriceDoc[] {
  const dir = docsDir();
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => /^maurice-.*\.md$/.test(n)).sort();
  } catch {
    return [];
  }
  const key =
    dir +
    "|" +
    names
      .map((n) => {
        try {
          return `${n}:${statSync(join(dir, n)).mtimeMs}`;
        } catch {
          return n;
        }
      })
      .join(",");
  if (cache && cache.key === key) return cache.docs;

  const docs: MauriceDoc[] = [];
  for (const n of names) {
    let raw: string;
    try {
      raw = readFileSync(join(dir, n), "utf8");
    } catch {
      continue;
    }
    const { meta, maps, body } = parseFrontmatter(raw);
    const slug = n.replace(/\.md$/, "");
    // Only the index and its children: the sync script already filters, but a
    // live garden dir (MAURICE_DOCS_DIR) holds other maurice-* notes too.
    if (slug !== DOCS_INDEX_SLUG && meta.parent !== DOCS_INDEX_SLUG) continue;
    // `internal: true` keeps a note under the index out of every household's
    // Maurice Maurice (the sync script drops it from the snapshot as well).
    if (meta.internal === "true") continue;
    docs.push({
      slug,
      title: meta.title || slug,
      date: meta.date || null,
      body: body.trim(),
      digest: meta.digest === "true",
      covers: maps.covers ?? {},
    });
  }
  docs.sort((a, b) =>
    a.slug === DOCS_INDEX_SLUG ? -1 : b.slug === DOCS_INDEX_SLUG ? 1 : a.slug.localeCompare(b.slug),
  );
  cache = { key, docs };
  return docs;
}

/** What Maurice Maurice actually reads: the digest, then every note it does
 *  not cover or that moved on since — full notes when there is no digest. The
 *  index is left out when a digest stands in for it. */
export function docsForContext(): MauriceDoc[] {
  const all = loadMauriceDocs();
  const digest = all.find((d) => d.digest);
  if (!digest) return all;
  const delta = all.filter((d) => {
    if (d.digest || d.slug === DOCS_INDEX_SLUG) return false;
    const covered = digest.covers[d.slug];
    return !covered || (d.date != null && d.date > covered);
  });
  return [digest, ...delta];
}

/** One doc as a context block: a header naming the note (so the persona can
 *  cite it and follow [[wiki-links]] between notes), then its body. `delta`
 *  marks a full note riding beside a digest, and says so. */
export function docContextText(d: MauriceDoc, delta = false): string {
  const when = d.date ? ` (last updated ${d.date})` : "";
  const why = delta
    ? "\nLoaded in full: updated since the digest was written, so it prevails over the digest where they differ."
    : "";
  return `### Documentation note: ${d.title}${when}\nSlug: ${d.slug}${why}\n\n${d.body}`;
}

/** Whether a doc in a context set is a delta note: a full note beside a digest. */
export function isDelta(d: MauriceDoc, set: MauriceDoc[]): boolean {
  return !d.digest && set.some((x) => x.digest);
}

/** Rough token weight of a set of docs — the persona's "baked-in" figure for
 *  the apps' pills; same 3-chars-per-token estimate as the context window. */
export function docsWeight(docs: MauriceDoc[]): number {
  return docs.reduce((s, d) => s + Math.ceil(docContextText(d, isDelta(d, docs)).length / 3), 0);
}
