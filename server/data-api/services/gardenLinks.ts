/**
 * Résonances — wiki-links written into the garden's markdown.
 *
 * The gesture: reading something, a passage calls up another entry ("this
 * feeds my Sugar fiche") → pick the target, add a note. What lands on disk is
 * a dated block under `## Résonances` on the *target's* working face, with a
 * literal [[wiki-link]] back to the source:
 *
 *     ## Résonances
 *
 *     2026-09-04 — de [[china-article-fiche|A.I. Is Everywhere in China]] :
 *
 *     > the highlighted passage
 *
 *     the note
 *
 * The markdown is the single source of truth — no link table. Obsidian
 * resolves the [[link]] natively (the garden is a vault), computes backlinks
 * and the graph from it; the site resolves the same syntax in remark; and a
 * later scan can rebuild anything else from the files. Writing on the target
 * (not the source) is deliberate: the resonance is read when you come back to
 * Sugar, and the backlink direction comes for free.
 */

import fs from "node:fs";
import path from "node:path";
import { autoCommit, markOpened, parseFiche, writeFiche, type GardenRef } from "./gardenFiche";
import { listGardenEntries, type GardenEntry } from "./gardenEntries";
import { indexGardenPaths } from "./gardenIndex";

const HEADING = "## Résonances";

export class GardenLinkError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 422) {
    super(message);
  }
}

// ── Targets (autocomplete) ──

export interface LinkTarget {
  collection: string;
  locale: string;
  slug: string;
  title: string;
  date: string;
  /** The basename a [[wiki-link]] to this target should use. */
  link_basename: string;
  has_fiche: boolean;
}

/**
 * Entries matching a query, for the picker. Title-prefix and word-start
 * matches rank before mere substring hits; ties break on recency.
 *
 * Unopened fiches stay out: "this feeds my X" wants the entries the member has
 * actually taken up, and every article ever shared would drown those.
 */
export function searchLinkTargets(garden: GardenRef, query: string, limit = 20): LinkTarget[] {
  const q = query.trim().toLowerCase();
  const scored: { score: number; t: LinkTarget }[] = [];

  for (const e of listGardenEntries(garden)) {
    if (!e.opened) continue;
    const title = e.title.toLowerCase();
    let score: number;
    if (!q) score = 1;
    else if (title.startsWith(q)) score = 3;
    else if (title.split(/\s+/).some((w) => w.startsWith(q)) || e.slug.startsWith(q)) score = 2;
    else if (title.includes(q) || e.slug.includes(q)) score = 1;
    else continue;

    scored.push({
      score,
      t: {
        collection: e.collection,
        locale: e.locale,
        slug: e.slug,
        title: e.title,
        date: e.date,
        link_basename: e.fiche ? `${e.slug}-fiche` : e.slug,
        has_fiche: !!e.fiche,
      },
    });
  }

  return scored
    .sort((a, b) => b.score - a.score || (a.t.date < b.t.date ? 1 : -1))
    .slice(0, limit)
    .map((s) => s.t);
}

// ── Writing a resonance ──

export interface ResonanceInput {
  to: { locale: string; slug: string; collection?: string };
  comment?: string;
  quote?: string;
  /** Where the thought came from — label always, basename when it lives in the garden. */
  source?: { label: string; basename?: string };
}

export interface ResonanceResult {
  file: string;
  web_path: string | null;
  target: { collection: string; locale: string; slug: string; title: string };
}

function findEntry(entries: GardenEntry[], to: ResonanceInput["to"]): GardenEntry | null {
  return (
    entries.find(
      (e) =>
        e.slug === to.slug &&
        e.locale === to.locale &&
        (!to.collection || e.collection === to.collection),
    ) ?? null
  );
}

/**
 * A garden book fiche matching a title — how a Calibre-side source (a book
 * highlight) gets its [[wiki-link]] when the book also lives in the garden.
 */
export function findBookEntryByTitle(garden: GardenRef, title: string): GardenEntry | null {
  const t = title.trim().toLowerCase();
  if (!t) return null;
  return (
    listGardenEntries(garden).find((e) => e.collection === "books" && e.title.toLowerCase() === t) ??
    null
  );
}

/**
 * Open the fiche a [[basename]] names, when it is an unopened one. Returns the
 * absolute file it rewrote, or null when nothing needed to change.
 */
function openSourceFiche(
  garden: GardenRef,
  entries: GardenEntry[],
  basename: string,
  preferLocale: string,
): string | null {
  if (!basename.endsWith("-fiche")) return null;
  const slug = basename.slice(0, -"-fiche".length);
  // A [[link]] carries no locale; when the slug exists under two, the one
  // beside the target is the likelier source.
  const candidates = entries.filter((e) => e.slug === slug && e.fiche && !e.opened);
  const entry = candidates.find((e) => e.locale === preferLocale) ?? candidates[0];
  if (!entry?.fiche) return null;

  const file = path.join(garden.root, entry.fiche.file);
  let parsed;
  try {
    parsed = parseFiche(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
  if (!parsed || !markOpened(parsed.frontmatter)) return null;
  writeFiche(file, parsed.frontmatter, parsed.body);
  return file;
}

export function appendResonance(
  memberId: string,
  garden: GardenRef,
  input: ResonanceInput,
): ResonanceResult {
  const comment = (input.comment ?? "").trim();
  const quote = (input.quote ?? "").trim();
  if (!comment && !quote) throw new GardenLinkError("comment or quote required", 400);

  // One scan serves both the target lookup and the source's, below.
  const entries = listGardenEntries(garden);
  const entry = findEntry(entries, input.to);
  if (!entry) {
    throw new GardenLinkError(`No garden entry for ${input.to.locale}/${input.to.slug}`, 404);
  }
  // The fiche is the working face; an entry that only has a card takes the
  // resonance at the bottom of the card.
  const face = entry.fiche ?? entry.card;
  if (!face) throw new GardenLinkError("Entry has no file", 422);
  const file = path.join(garden.root, face.file);

  const raw = fs.readFileSync(file, "utf-8");
  const parsed = parseFiche(raw);
  if (!parsed) throw new GardenLinkError(`Could not parse: ${face.file}`, 422);

  const date = new Date().toISOString().slice(0, 10);
  const from = input.source
    ? input.source.basename
      ? ` — de [[${input.source.basename}|${input.source.label}]]`
      : ` — de *${input.source.label}*`
    : "";
  const blocks: string[] = [`${date}${from} :`];
  if (quote) blocks.push(quote.split("\n").map((l) => `> ${l}`.trimEnd()).join("\n"));
  if (comment) blocks.push(comment);
  const block = blocks.join("\n\n");

  // Same convention as the comment history: sections are appended
  // chronologically, so the heading-last invariant lets us append at the end.
  const body = parsed.body.includes(HEADING)
    ? `${parsed.body.trimEnd()}\n\n${block}\n`
    : `${parsed.body.trimEnd()}\n\n${HEADING}\n\n${block}\n`;

  // Writing on the target opens it (it was a target only by being picked from
  // the opened ones, but the fiche can also be named directly).
  markOpened(parsed.frontmatter);
  writeFiche(file, parsed.frontmatter, `\n${body.replace(/^\n+/, "")}`);
  const written = [file];

  // A resonance sent *from* an unopened article is a thought about that
  // article too: the note lands on the target, the opening lands on the source.
  const sourceFile = input.source?.basename
    ? openSourceFiche(garden, entries, input.source.basename, entry.locale)
    : null;
  if (sourceFile) written.push(sourceFile);

  autoCommit(garden, written, `Resonance on ${entry.collection}/${entry.slug}`);
  indexGardenPaths(memberId, written);

  return {
    file: face.file,
    web_path: face.web_path,
    target: { collection: entry.collection, locale: entry.locale, slug: entry.slug, title: entry.title },
  };
}
