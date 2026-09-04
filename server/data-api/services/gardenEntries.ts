/**
 * Browsing the whole garden as entries — the Carnet Garden section's view.
 *
 * An entry is one subject, which may exist as two files: the published card
 * (`<slug>.md`, what the site renders) and the working fiche
 * (`<slug>-fiche.md`, the back of the card). "Sugar" the series is one entry
 * with both faces; a fiche never promoted is an entry with only that face.
 * The app opens either face in the browser (web_path) or in an editor via the
 * repo-relative path (file) — Working Copy on iOS, Obsidian on the Mac, both
 * of which hold the same git checkout this server writes to.
 */

import fs from "node:fs";
import path from "node:path";
import {
  cardWebPath,
  ficheWebPath,
  gardenFor,
  parseFiche,
  RESOURCE_COLLECTIONS,
  type GardenRef,
  type ResourceCollection,
} from "./gardenFiche";

/** Everything under the garden root that reads as a collection of entries. */
export const GARDEN_COLLECTIONS = [
  ...RESOURCE_COLLECTIONS,
  "blog", "essays", "notes", "pages",
] as const;
export type GardenCollection = (typeof GARDEN_COLLECTIONS)[number];

const RESOURCE_SET = new Set<string>(RESOURCE_COLLECTIONS);

/** French URL segment for the non-resource collections (mirrors web/src/i18n/config.ts). */
const FR_TEXT_SEGMENT: Record<string, string> = {
  blog: "blog", essays: "essais", notes: "notes",
};

export interface GardenEntryFace {
  /** Where the site renders it, under /g/<username> — null when it has no page. */
  web_path: string | null;
  /** Repo-relative path, for editors holding the garden checkout. */
  file: string;
}

export interface GardenEntry {
  collection: GardenCollection;
  locale: string;
  slug: string;
  title: string;
  date: string;
  tags: string[];
  image: string | null;
  card: GardenEntryFace | null;
  fiche: GardenEntryFace | null;
}

function webPathFor(
  garden: GardenRef,
  collection: GardenCollection,
  locale: string,
  slug: string,
  kind: "card" | "fiche",
): string | null {
  if (kind === "fiche") {
    // The fiches page is a catch-all over <collection>/<slug>-fiche, resource
    // or not — same URL shape either way.
    return ficheWebPath(garden, collection as ResourceCollection, locale, slug);
  }
  if (RESOURCE_SET.has(collection)) {
    return cardWebPath(garden, collection as ResourceCollection, locale, slug);
  }
  // `pages` are the site's own chrome (home, about) — no stable per-slug URL
  // worth advertising; they stay reachable through their file.
  if (collection === "pages") return null;
  const segment = locale === "fr" ? (FR_TEXT_SEGMENT[collection] ?? collection) : collection;
  const prefix = locale === "en" ? "" : `/${locale}`;
  return `/g/${garden.username}${prefix}/${segment}/${slug}`;
}

/**
 * Every entry in the member's garden, newest first. One filesystem pass, like
 * scanArticleFiches and for the same reason: the fiches are small, a garden
 * holds hundreds of files, and the tree on disk is the single source of truth.
 */
export function listGardenEntries(garden: GardenRef): GardenEntry[] {
  const out: GardenEntry[] = [];

  for (const collection of GARDEN_COLLECTIONS) {
    const collDir = path.join(garden.root, collection);
    if (!fs.existsSync(collDir)) continue;

    for (const locale of fs.readdirSync(collDir)) {
      const dir = path.join(collDir, locale);
      try {
        if (!fs.statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }

      // Group the directory's files by subject: sugar.md and sugar-fiche.md
      // are two faces of the entry "sugar".
      const bySlug = new Map<string, GardenEntry>();
      const entryFor = (slug: string): GardenEntry => {
        let e = bySlug.get(slug);
        if (!e) {
          e = {
            collection, locale, slug,
            title: "", date: "", tags: [], image: null,
            card: null, fiche: null,
          };
          bySlug.set(slug, e);
        }
        return e;
      };

      for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith(".md")) continue;
        const full = path.join(dir, file);
        let parsed;
        try {
          parsed = parseFiche(fs.readFileSync(full, "utf-8"));
        } catch {
          continue;
        }
        if (!parsed) continue;
        const fm = parsed.frontmatter as Record<string, any>;
        const meta = (fm.meta ?? {}) as Record<string, any>;

        const isFiche = file.endsWith("-fiche.md");
        const slug = file.slice(0, -(isFiche ? "-fiche.md" : ".md").length);
        const e = entryFor(slug);
        const face: GardenEntryFace = {
          web_path: webPathFor(garden, collection, locale, slug, isFiche ? "fiche" : "card"),
          file: path.relative(garden.root, full),
        };
        if (isFiche) e.fiche = face;
        else e.card = face;

        // The card is the published face — where both exist, its title and
        // date win. Tags and image are best-of-either: a card often carries
        // neither while its fiche does.
        if (!isFiche || !e.title) {
          e.title = String(fm.title ?? meta.title ?? slug);
          e.date = String(
            fm.date ?? fm.date_watched ?? fm.date_read ?? fm.date_played ?? meta.saved_at ?? "",
          );
        }
        const tags = Array.isArray(fm.tags) ? fm.tags.map(String) : [];
        if (tags.length && (!e.tags.length || !isFiche)) e.tags = tags;
        if (!e.image) e.image = fm.image ?? meta.image ?? null;
      }

      out.push(...bySlug.values());
    }
  }

  return out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

export { gardenFor };
