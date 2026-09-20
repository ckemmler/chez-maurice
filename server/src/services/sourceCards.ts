import { existsSync } from "node:fs";
import { join } from "node:path";
import { gardensRoot } from "./gardensRoot";
import type { WebSearchResponse } from "./webSearch";

// ── The source card ─────────────────────────────────────────────────────────
//
// A search answers with a list of things the member could go and look at, and
// until now the app rendered that list the way it rendered every other tool
// result: a folded disclosure triangle over a key/value dump, forty fields per
// row, the useful three among them. Meanwhile the web search rendered as
// nothing at all — its result never became a data block, so the only trace of
// twenty-seven consulted pages was whatever the model chose to retype.
//
// This turns both into one shape the client can draw: a row of cards with a
// picture, a title and where it came from. The model is unaffected — it keeps
// receiving the tool's own text; the card rides the parallel `data` channel.
//
// The shape is deliberately flat and self-sufficient. Anything the card needs
// to draw itself is resolved here — the image URL especially — because the app
// cannot reach into a garden to find out whether a cover exists.

export interface SourceCardItem {
  /** What to put on the card. Never empty: falls back to the file's name. */
  title: string;
  /** The line under it: author, publication, year, conversation date. */
  subtitle?: string;
  /** What kind of thing this is — drives the icon and the wording. */
  kind: "note" | "fiche" | "card" | "fragment" | "conversation" | "book" | "dossier" | "thought" | "web";
  /** A cover, as a path this server serves openly, or an absolute URL. */
  image?: string;
  /** Where to open it, when there is somewhere to open. */
  url?: string;
  /** A few words of the passage that matched. */
  snippet?: string;
  /** Cosine similarity for a corpus hit; absent for the web. */
  score?: number;
}

export interface SourceCard {
  card: "sources";
  /** Which search this came from — the client words the two differently. */
  origin: "corpus" | "web";
  query?: string;
  count: number;
  results: SourceCardItem[];
}

/** How many cards ride to the client. The row scrolls, but a hundred cards is
 *  a hundred covers to fetch for a glance. */
const MAX_CARDS = 12;

/** How much of the matching passage travels. Enough to recognise it, not
 *  enough to make the card a paragraph. */
const SNIPPET_CHARS = 180;

/** A frontmatter value as a string. Numbers count: a year is written `2023`
 *  in one fiche and `"2023"` in the next, and a subtitle that silently drops
 *  the first is the kind of bug nobody reports. */
function clean(v: unknown): string {
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return "";
}

function firstString(row: any, keys: string[]): string {
  for (const k of keys) {
    const v = clean(row?.[k]);
    if (v) return v;
  }
  return "";
}

function snippet(text: unknown): string | undefined {
  const t = clean(text).replace(/\s+/g, " ");
  if (!t) return undefined;
  return t.length <= SNIPPET_CHARS ? t : t.slice(0, SNIPPET_CHARS).trimEnd() + "…";
}

/** The member a corpus hit belongs to, read off its absolute file path:
 *  `<gardensRoot>/<member>/…`. The corpus indexes one member's garden per
 *  store, but the path is the only place the answer is actually written. */
function memberFromPath(filePath: string): string {
  const root = gardensRoot();
  if (!filePath.startsWith(root)) return "";
  const rest = filePath.slice(root.length).replace(/^\/+/, "");
  const first = rest.split("/")[0] ?? "";
  return first && first !== ".." ? first : "";
}

/**
 * The cover of a corpus hit, as an app-reachable path — or nothing.
 *
 * The garden keeps every cover in one place: `<garden>/images/resources/…`,
 * written into the frontmatter as `/images/<member>/resources/…`. That URL is
 * authenticated, which is no use to an AsyncImage — it sends no credentials —
 * so it is rewritten to the open twin, `/api/garden-images/<member>/…`.
 *
 * Two ways in, in this order. The frontmatter's own `image`, which cards and
 * article fiches carry and which is the only dialect of the four that resolves
 * (the others are a Google Books `thumbnail`, a TMDB `poster_path` and a
 * Wikimedia `image_filename`, none of them a URL without inventing a CDN
 * prefix). Failing that, the conventional name — `<collection>/<locale>-<slug>`
 * — since a fiche names its cover after itself. The identifier is spelled
 * three ways across sources (`resource_id` on a fiche, `slug` on a note,
 * `translationKey` on a card), so all three are tried.
 *
 * Whichever way, the file is stat-ed before the path is handed out: a card
 * with a broken image is worse than a card with an icon in a box.
 */
function coverPath(row: any): string | undefined {
  const member = memberFromPath(clean(row?.file_path));
  if (!member) return undefined;
  const openPath = (rest: string) => {
    if (!existsSync(join(gardensRoot(), member, "images", "resources", rest))) return undefined;
    return `/api/garden-images/${member}/${rest}`;
  };

  // Stated outright by the frontmatter.
  const stated = firstString(row, ["image"]);
  const prefix = `/images/${member}/resources/`;
  if (stated.startsWith(prefix)) {
    const found = openPath(stated.slice(prefix.length));
    if (found) return found;
  }

  // Or named by convention.
  const collection = firstString(row, ["resource_collection", "collection"]);
  const slug = firstString(row, ["resource_id", "slug", "translationKey"]);
  const locale = firstString(row, ["locale", "lang"]) || "fr";
  if (!collection || !slug) return undefined;
  return openPath(`${collection}/${locale}-${slug}.jpg`);
}

/** The line under the title: who made the thing, and when. Ordered by what
 *  tells two results apart, not by what a record happens to carry. */
function corpusSubtitle(row: any): string | undefined {
  const bits: string[] = [];
  const who = firstString(row, ["author", "publication", "host", "director", "developer"]);
  if (who) bits.push(who);
  const when = firstString(row, ["year", "date", "published_at", "saved_at"]).slice(0, 10);
  if (when) bits.push(when);
  return bits.length ? bits.join(" · ") : undefined;
}

const CORPUS_KINDS = new Set(["note", "fiche", "card", "fragment", "conversation", "book", "dossier", "thought"]);

function corpusKind(row: any): SourceCardItem["kind"] {
  const t = clean(row?.source_type);
  return CORPUS_KINDS.has(t) ? (t as SourceCardItem["kind"]) : "note";
}

function corpusTitle(row: any): string {
  const t = firstString(row, ["title", "conversation_title", "book_title"]);
  if (t) return t;
  const path = clean(row?.file_path);
  const base = path.split("/").pop() ?? "";
  return base.replace(/\.(md|txt|frag)$/i, "").replace(/-fiche$/, "") || "Sans titre";
}

/**
 * Turn a `corpus__search` payload into a card, or return null when the shape
 * is not the one we know — a changed tool should degrade to the generic
 * renderer, never to a wrong card.
 */
export function corpusSourceCard(data: unknown, query?: string): SourceCard | null {
  const all = (data as any)?.results;
  if (!Array.isArray(all) || all.length === 0) return null;
  // A search returns chunks, and a long article is a dozen of them: four cards
  // for one Guardian piece is not four sources. Keep the first hit of each
  // source — the corpus sorts by score, so the first is its best passage — and
  // count distinct sources, which is what "6 sources" ought to mean.
  //
  // What identifies a source depends on what it is. A file has its path; a
  // conversation has no file at all, so it identifies by `conversation_id`,
  // and without that clause the same thread came back three times in a row
  // under three different chunk ids.
  const seen = new Set<string>();
  const rows: any[] = [];
  for (const row of all) {
    const key = clean(row?.conversation_id) || clean(row?.file_path) || clean(row?.chunk_id);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    rows.push(row);
  }
  const results: SourceCardItem[] = rows.slice(0, MAX_CARDS).map((row: any) => {
    const item: SourceCardItem = { title: corpusTitle(row), kind: corpusKind(row) };
    const sub = corpusSubtitle(row);
    if (sub) item.subtitle = sub;
    const cover = coverPath(row);
    if (cover) item.image = cover;
    const s = snippet(row?.text);
    if (s) item.snippet = s;
    // An article kept in the garden remembers where it was read: that is
    // somewhere to open, unlike a note, which lives only here.
    const href = firstString(row, ["url", "canonical_url"]);
    if (/^https?:\/\//.test(href)) item.url = href;
    if (typeof row?.score === "number") item.score = Math.round(row.score * 1000) / 1000;
    return item;
  });
  return { card: "sources", origin: "corpus", query, count: rows.length, results };
}

/** The bare domain of a URL, for the line under a web result. */
export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * The same card for a web search. Tavily carries no image and no favicon, so
 * the card leans on the domain: the client draws the site's initial, which is
 * honest about what we actually know and costs no third-party request from
 * the member's phone.
 */
export function webSourceCard(res: WebSearchResponse, query?: string): SourceCard | null {
  if (!res.results?.length) return null;
  const results: SourceCardItem[] = res.results.slice(0, MAX_CARDS).map((r) => {
    const item: SourceCardItem = { title: r.title || domainOf(r.url) || r.url, kind: "web" };
    const d = domainOf(r.url);
    if (d) item.subtitle = d;
    if (r.url) item.url = r.url;
    const s = snippet(r.content);
    if (s) item.snippet = s;
    return item;
  });
  return { card: "sources", origin: "web", query, count: res.results.length, results };
}
