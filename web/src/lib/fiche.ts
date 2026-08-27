import fs from "node:fs";
import path from "node:path";
import { marked } from "marked";
import { GARDEN, gardensRoot } from "./garden";

/**
 * Reading the parts of a fiche that do not come through the content layer.
 *
 * Shared by every theme's FicheDetail view. They each carried their own copy,
 * and each copy looked for fragments under `process.cwd()/src/content` — a path
 * that stopped existing when gardens moved out of the checkout, so no fragment
 * has rendered on any theme since. One implementation, one place to be wrong.
 */

export interface Fragment {
  summary: string;
  html: string;
}

/** `<gardens>/<member>/<collection>/<locale>/<slug>-fiche/_fragments/`. */
export function fragmentsDirFor(ficheId: string): string {
  return path.join(gardensRoot(), GARDEN, ficheId, "_fragments");
}

export function parseFragments(dir: string): Fragment[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f: string) => f.endsWith(".frag"))
    .sort()
    .map((f: string) => {
      const raw = fs.readFileSync(path.join(dir, f), "utf-8");
      const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
      let summary = "";
      let body = raw;
      if (m) {
        const sumLine = m[1].split("\n").find((l: string) => l.startsWith("summary:"));
        summary = sumLine?.replace(/^summary:\s*["']?|["']?\s*$/g, "") ?? "";
        body = m[2];
      }
      return { summary, html: marked.parse(body.trim(), { async: false }) as string };
    });
}

export function fragmentsFor(ficheId: string): Fragment[] {
  return parseFragments(fragmentsDirFor(ficheId));
}

// ── The `meta:` block, rendered ──
//
// A fiche's frontmatter carries whatever the provider gave us — Google Books,
// TMDB, Podcast Index, or an article's own OG/JSON-LD — under one open-ended
// `meta:` key. The views showed none of it: an article fiche displayed its
// title and the date it was saved, and nothing about who wrote it, where, or
// when.

export interface FicheHeadline {
  subtitle: string;
  /** Author / director / host / publication — whoever made the thing. */
  byline: string[];
  /** The year the work itself is from, not the day it was filed. */
  when: string;
  /** The AI summary, once the summariser has written one. */
  summary: string;
  /** Teaser from the source, shown only when there is no summary yet. */
  excerpt: string;
  url: string;
  host: string;
}

const BYLINE_KEYS = ["author", "director", "host", "artist", "publication", "source", "publisher"];
const WHEN_KEYS = ["published_at", "year", "release_date", "first_air_date"];

const str = (v: unknown): string =>
  v === null || v === undefined || typeof v === "object" ? "" : String(v).trim();

export function ficheHeadline(data: any): FicheHeadline {
  const meta = (data?.meta ?? {}) as Record<string, unknown>;

  const byline: string[] = [];
  for (const key of BYLINE_KEYS) {
    const value = str(meta[key]);
    if (value && !byline.includes(value) && value !== str(data?.title)) byline.push(value);
    if (byline.length === 2) break;
  }

  const when = str(WHEN_KEYS.map((k) => meta[k]).find((v) => str(v))).slice(0, 10);
  const url = str(meta.url);
  let host = "";
  try {
    if (url) host = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    host = "";
  }

  return {
    subtitle: str(meta.subtitle),
    byline,
    when,
    summary: str(meta.summary),
    excerpt: str(meta.excerpt) || str(meta.description),
    url,
    host,
  };
}
