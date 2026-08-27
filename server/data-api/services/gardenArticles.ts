/**
 * Saving an article to the garden as a fiche.
 *
 * One article, one markdown file:
 *
 *   <garden>/articles/<locale>/<slug>-fiche.md          the fiche
 *   <garden>/articles/<locale>/<slug>-fiche/_fragments/ the full text
 *   <garden>/images/resources/articles/<locale>-<slug>.jpg
 *
 * The fiche is the back of a card that may never be written — capture first,
 * verdict later. `promote_fiche` in the garden MCP tool turns it into a
 * published entry if one is ever warranted, which is why the frontmatter shape
 * here matches what that tool expects to find.
 *
 * What the caller brings (a comment) goes in the body. What a service gave us
 * (author, publication, dates) goes in `meta`. The full text goes in a
 * fragment, so the fiche stays small enough that scanning every one of them for
 * a duplicate URL is cheap.
 */

import fs from "node:fs";
import path from "node:path";
import {
  ArticleRefusedError,
  canonicalizeUrl,
  extractArticleFromHtml,
  extractArticleFromUrl,
  slugify,
  type ArticleMeta,
} from "./articleExtract";
import {
  autoCommit,
  cardWebPath,
  ficheWebPath,
  fichePath,
  gardenFor,
  parseFiche,
  resourceImagePaths,
  downloadImage,
  writeFiche,
  writeFragment,
  type GardenRef,
} from "./gardenFiche";
import { indexGardenPaths } from "./gardenIndex";

const COLLECTION = "articles" as const;

/** Status of a fiche that holds a URL and a comment, but no article yet. */
export const NEEDS_CAPTURE = "needs-capture";
const DEFAULT_LOCALE = "fr";

export interface SaveArticleInput {
  url: string;
  /** A DOM the caller already rendered. When present the server does not fetch. */
  html?: string;
  /** The passage that prompted the save. */
  selection?: string;
  comment?: string;
  tags?: string[];
  locale?: string;
  /** ios-share | chrome | mcp | web — how it got here, for later triage. */
  source_client?: string;
  /** Overrides extraction when the caller knows better (rare). */
  title?: string;
}

export interface ArticleFicheRef {
  /** A fiche (the working surface) or a published card from an earlier save. */
  kind: "fiche" | "card";
  slug: string;
  locale: string;
  file: string;
  title: string;
  url: string;
  canonical_url: string;
  saved_at: string;
}

export interface SaveArticleResult extends ArticleFicheRef {
  duplicate: boolean;
  /** Saved as a bookmark: the page could not be read, only its URL is known. */
  needs_capture: boolean;
  /** A bookmark that this save just filled in. */
  completed: boolean;
  subtitle: string | null;
  author: string | null;
  publication: string | null;
  published_at: string | null;
  image: string | null;
  excerpt: string | null;
  lang: string | null;
  comment: string | null;
  tags: string[];
  word_count: number;
  fiche_path: string;
  fiche_web_path: string;
  card_web_path: string;
  /** Filled by the summarisation pass (not yet wired). */
  summary: string | null;
}

// ── Duplicate detection ──
//
// A filesystem scan, not an index. The fiches are small (the article text lives
// in a fragment), a garden holds hundreds not millions, and the request is
// about to fetch a web page anyway — so the scan is far from the critical path.
// The alternative, a table, would be a second source of truth with nothing to
// rebuild it from; web/src/lib/notes-fs.ts already reads this tree from disk
// for the same reason.

export function scanArticleFiches(garden: GardenRef): ArticleFicheRef[] {
  const collDir = path.join(garden.root, COLLECTION);
  if (!fs.existsSync(collDir)) return [];

  const out: ArticleFicheRef[] = [];
  for (const locale of fs.readdirSync(collDir)) {
    const dir = path.join(collDir, locale);
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
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

      const fm = parsed.frontmatter;
      const meta = (fm.meta ?? {}) as Record<string, any>;
      const isFiche = file.endsWith("-fiche.md");
      // A fiche keeps provider metadata under `meta`; a published card carries
      // the same fields flat. Both are "already saved" as far as a re-share is
      // concerned — the garden holds cards written by the earlier scrape route,
      // and they must deduplicate too or every one of them gets a twin.
      const url = String((isFiche ? meta.url : fm.url) ?? fm.url ?? meta.url ?? "");

      out.push({
        kind: isFiche ? "fiche" : "card",
        slug: file.slice(0, -(isFiche ? "-fiche.md" : ".md").length),
        locale,
        file: full,
        title: String(fm.title ?? ""),
        url,
        // Cards and older fiches predate the stored canonical form — derive it
        // on read so they still deduplicate against a fresh save.
        canonical_url: String(meta.canonical_url ?? "") || (url ? canonicalizeUrl(url) : ""),
        saved_at: String(fm.date ?? fm.date_read ?? ""),
      });
    }
  }
  return out;
}

/**
 * Find a saved article by any of the URLs that could name it.
 *
 * More than one is needed because the URL a share hands over and the URL the
 * page calls itself are often different: a tracking link, an AMP variant, a
 * mobile host. The page's own `rel=canonical` is the authority, so once we have
 * loaded the page we look again with it — otherwise the same article gets saved
 * twice under two spellings.
 */
export function findArticleFiche(garden: GardenRef, ...urls: string[]): ArticleFicheRef | null {
  const keys = new Set(urls.map((u) => canonicalizeUrl(u)).filter(Boolean));
  if (!keys.size) return null;
  const matches = scanArticleFiches(garden).filter(
    (f) => keys.has(f.canonical_url) || (f.url && keys.has(canonicalizeUrl(f.url))),
  );
  return matches.find((f) => f.kind === "fiche") ?? matches[0] ?? null;
}

/** A bookmark awaiting a real capture, rather than a saved article. */
export function isStub(ref: ArticleFicheRef): boolean {
  const parsed = parseFiche(fs.readFileSync(ref.file, "utf-8"));
  if (!parsed) return false;
  const fm = parsed.frontmatter;
  const status = ref.kind === "fiche" ? (fm.meta ?? {}).status : fm.status;
  return String(status ?? "") === NEEDS_CAPTURE;
}

// ── Save ──

export class ArticleSaveError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 422 | 502) {
    super(message);
  }
}

export async function saveArticleFiche(
  memberId: string,
  input: SaveArticleInput,
): Promise<SaveArticleResult> {
  const garden = gardenFor(memberId);
  if (!garden) throw new ArticleSaveError("No garden for this member", 404);

  const rawUrl = (input.url ?? "").trim();
  if (!rawUrl) throw new ArticleSaveError("url is required", 400);
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    throw new ArticleSaveError("url is not a valid URL", 400);
  }

  const locale = (input.locale || DEFAULT_LOCALE).toLowerCase();
  const comment = (input.comment ?? "").trim();
  const tags = (input.tags ?? []).map((t) => t.trim()).filter(Boolean);

  // Already saved? Carry the new comment onto the existing fiche rather than
  // refusing the save — re-sharing something is usually a second thought about
  // it, not a mistake.
  const found = findArticleFiche(garden, rawUrl);
  // A bookmark is not a duplicate — it is this same save, unfinished. Fall
  // through and let the capture fill it in.
  const stub = found && isStub(found) ? found : null;
  if (found && !stub) {
    if (comment) appendComment(memberId, garden, found, comment);
    return describeExisting(garden, found, { duplicate: true });
  }

  // Extract. A caller-supplied DOM wins: it is already past whatever paywall or
  // bot check would meet a server-side fetch.
  let article: ArticleMeta | null = null;
  let captureError = "";
  try {
    article = input.html
      ? extractArticleFromHtml(rawUrl, input.html)
      : await extractArticleFromUrl(rawUrl);
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    // The guard rejecting a loopback/private/non-http target is a bad request,
    // not an upstream failure.
    if (/non-public address|only http\(s\)|invalid URL/.test(msg)) {
      throw new ArticleSaveError(`Failed to read the article: ${msg}`, 400);
    }
    // The caller handed us a DOM and we still could not read it: that is
    // exceptional, and worth surfacing rather than papering over.
    if (input.html) throw new ArticleSaveError(`Failed to read the article: ${msg}`, 502);
    // Only a refusal becomes a bookmark. A 404, a DNS failure, a mistyped host
    // — those are not articles waiting to be captured, and a bookmark to one
    // would be the junk this collection has already been cleaned of once.
    if (!(e instanceof ArticleRefusedError)) {
      throw new ArticleSaveError(`Failed to read the article: ${msg}`, 502);
    }
    captureError = msg;
  }

  // Nothing could be read, but the reader still made a deliberate gesture and
  // may have written a comment. Losing both because a site refuses robots is
  // the wrong trade: keep a bookmark, flagged, and let a later capture from a
  // browser complete it.
  if (!article) {
    return writeStub(memberId, garden, {
      rawUrl, parsedUrl, locale, comment, tags, input, captureError, stub,
    });
  }

  // Now that the page has been read, look again under the name it gives itself:
  // the shared URL may have been a tracking link or an AMP variant.
  if (!stub && article.canonical_url && canonicalizeUrl(article.canonical_url) !== canonicalizeUrl(rawUrl)) {
    const byCanonical = findArticleFiche(garden, article.canonical_url);
    if (byCanonical && !isStub(byCanonical)) {
      if (comment) appendComment(memberId, garden, byCanonical, comment);
      return describeExisting(garden, byCanonical, { duplicate: true });
    }
  }

  const title = (input.title || article.title).trim();
  if (!title) throw new ArticleSaveError("Could not extract a title from the URL", 422);

  const publication = article.site_name || parsedUrl.hostname.replace(/^www\./, "");
  // Completing a bookmark keeps its path, so links and its comment history hold.
  const slug = stub ? stub.slug : uniqueSlug(garden, locale, slugify(title) || slugify(publication) || "article");
  const file = stub ? stub.file : fichePath(garden, COLLECTION, locale, slug);
  const written: string[] = [];

  // Cover — best effort, an article without one is still worth keeping.
  let imageUrl = "";
  if (article.image) {
    const abs = absolutizeImage(article.image, rawUrl);
    const dest = resourceImagePaths(garden, COLLECTION, locale, slug);
    if (abs && (await downloadImage(abs, dest.file))) {
      imageUrl = dest.url;
      written.push(dest.file);
    }
  }

  const savedAt = new Date().toISOString().slice(0, 10);
  const meta: Record<string, any> = {
    url: rawUrl,
    // The page's own rel=canonical wins: it is what the site calls the article,
    // and it is stable across the tracking links and mobile hosts a share hands over.
    canonical_url: canonicalizeUrl(article.canonical_url || rawUrl),
    subtitle: article.subtitle || undefined,
    author: article.author || undefined,
    publication,
    published_at: article.published_at || undefined,
    saved_at: savedAt,
    image: imageUrl || undefined,
    excerpt: article.description || undefined,
    word_count: article.word_count || undefined,
    lang: article.lang || undefined,
    status: "inbox",
    source_client: input.source_client || undefined,
    // `summary` is left out until there is one; the summarisation pass adds it.
  };

  writeFiche(
    file,
    {
      title,
      resource_collection: COLLECTION,
      resource_id: slug,
      date: savedAt,
      tags,
      locale,
      meta,
    },
    stub
      ? keptBody(stub, comment)
      : ficheBody({ comment, selection: input.selection, excerpt: article.description }),
  );
  written.push(file);

  // The full text as a fragment: indexable, and out of the fiche so the
  // duplicate scan above stays a cheap read.
  if (article.content) {
    written.push(writeFragment(file, `Texte intégral — ${publication}`, article.content));
  }

  autoCommit(
    garden,
    written,
    stub ? `Complete article fiche: ${COLLECTION}/${slug}` : `Save article fiche: ${COLLECTION}/${slug}`,
  );
  indexGardenPaths(memberId, written);

  return {
    kind: "fiche",
    slug,
    locale,
    file,
    title,
    url: rawUrl,
    canonical_url: meta.canonical_url,
    saved_at: savedAt,
    duplicate: false,
    needs_capture: false,
    completed: !!stub,
    subtitle: article.subtitle || null,
    author: article.author || null,
    publication,
    published_at: article.published_at || null,
    image: imageUrl || null,
    excerpt: article.description || null,
    lang: article.lang || null,
    comment: comment || null,
    tags,
    word_count: article.word_count,
    summary: null,
    fiche_path: path.relative(garden.root, file),
    fiche_web_path: ficheWebPath(garden, COLLECTION, locale, slug),
    card_web_path: cardWebPath(garden, COLLECTION, locale, slug),
  };
}

// ── Bookmarks ──
//
// A site that refuses robots (gatesnotes.com answers 403 to anything that is
// not a browser) used to cost the reader the whole save — the URL, the comment,
// the gesture. A bookmark keeps all three under an explicit flag, and reads as
// unfinished rather than as a bad article.

interface StubInput {
  rawUrl: string;
  parsedUrl: URL;
  locale: string;
  comment: string;
  tags: string[];
  input: SaveArticleInput;
  captureError: string;
  stub: ArticleFicheRef | null;
}

function writeStub(memberId: string, garden: GardenRef, i: StubInput): SaveArticleResult {
  // A bookmark on a bookmark is just another thought about it.
  if (i.stub) {
    if (i.comment) appendComment(memberId, garden, i.stub, i.comment);
    return { ...describeExisting(garden, i.stub, { duplicate: true }), needs_capture: true };
  }

  const publication = i.parsedUrl.hostname.replace(/^www\./, "");
  const title = (i.input.title || "").trim() || titleFromUrl(i.parsedUrl) || publication;
  const slug = uniqueSlug(garden, i.locale, slugify(title) || slugify(publication) || "article");
  const file = fichePath(garden, COLLECTION, i.locale, slug);
  const savedAt = new Date().toISOString().slice(0, 10);

  const meta: Record<string, any> = {
    url: i.rawUrl,
    canonical_url: canonicalizeUrl(i.rawUrl),
    publication,
    saved_at: savedAt,
    status: NEEDS_CAPTURE,
    capture_error: i.captureError || undefined,
    source_client: i.input.source_client || undefined,
  };

  writeFiche(
    file,
    { title, resource_collection: COLLECTION, resource_id: slug, date: savedAt, tags: i.tags, locale: i.locale, meta },
    ficheBody({ comment: i.comment, selection: i.input.selection }),
  );
  autoCommit(garden, [file], `Bookmark article (not readable yet): ${COLLECTION}/${slug}`);
  indexGardenPaths(memberId, [file]);

  return {
    kind: "fiche",
    slug,
    locale: i.locale,
    file,
    title,
    url: i.rawUrl,
    canonical_url: meta.canonical_url,
    saved_at: savedAt,
    duplicate: false,
    needs_capture: true,
    completed: false,
    subtitle: null,
    author: null,
    publication,
    published_at: null,
    image: null,
    excerpt: null,
    lang: null,
    comment: i.comment || null,
    tags: i.tags,
    word_count: 0,
    summary: null,
    fiche_path: path.relative(garden.root, file),
    fiche_web_path: ficheWebPath(garden, COLLECTION, i.locale, slug),
    card_web_path: cardWebPath(garden, COLLECTION, i.locale, slug),
  };
}

/** A readable title out of the URL, for a page we never got to read. */
function titleFromUrl(url: URL): string {
  const segments = url.pathname.split("/").filter(Boolean);
  // Trailing route words (reader, index, amp, a numeric id) name the page's
  // plumbing, not the article; walk back to the last segment that reads as words.
  for (let n = segments.length - 1; n >= 0; n--) {
    const seg = decodeURIComponent(segments[n] ?? "").replace(/\.\w{1,5}$/, "");
    const words = seg.split(/[-_]+/).filter((w) => w.length > 1 && !/^\d+$/.test(w));
    if (words.length >= 2) {
      return words.join(" ").replace(/^./, (c) => c.toUpperCase());
    }
  }
  return "";
}

/** The body a bookmark already had, plus whatever the completing save adds. */
function keptBody(stub: ArticleFicheRef, comment: string): string {
  const parsed = parseFiche(fs.readFileSync(stub.file, "utf-8"));
  let body = parsed?.body.trim() ?? "";
  if (comment && !body.includes(comment)) {
    body += `${body ? "\n\n" : ""}${body.includes(COMMENT_HEADING) ? "" : `${COMMENT_HEADING}\n\n`}${comment}`;
  }
  return body ? `\n${body}\n` : "\n";
}

// ── Body composition ──

const COMMENT_HEADING = "## Commentaire";

function ficheBody(parts: { comment: string; selection?: string; excerpt?: string }): string {
  const blocks: string[] = [];

  // A lead, so a fiche saved without a comment is not blank on the page.
  const lead = (parts.selection || parts.excerpt || "").trim();
  if (lead) blocks.push(quote(lead));

  if (parts.comment) blocks.push(`${COMMENT_HEADING}\n\n${parts.comment}`);

  return blocks.length ? `\n${blocks.join("\n\n")}\n` : "\n";
}

function quote(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`.trimEnd())
    .join("\n");
}

/** Add a dated line under `## Commentaire`, creating the section if needed. */
function appendComment(memberId: string, garden: GardenRef, ref: ArticleFicheRef, comment: string): void {
  let raw: string;
  try {
    raw = fs.readFileSync(ref.file, "utf-8");
  } catch {
    return;
  }
  const parsed = parseFiche(raw);
  if (!parsed) return;
  if (parsed.body.includes(comment)) return; // same thought, sent twice

  const line = `${new Date().toISOString().slice(0, 10)} — ${comment}`;
  const body = parsed.body.includes(COMMENT_HEADING)
    ? `${parsed.body.trimEnd()}\n\n${line}\n`
    : `${parsed.body.trimEnd()}\n\n${COMMENT_HEADING}\n\n${line}\n`;

  writeFiche(ref.file, parsed.frontmatter, `\n${body.replace(/^\n+/, "")}`);
  autoCommit(garden, [ref.file], `Add comment to article fiche: ${ref.slug}`);
  indexGardenPaths(memberId, [ref.file]);
}

// ── Helpers ──

function describeExisting(
  garden: GardenRef,
  ref: ArticleFicheRef,
  extra: { duplicate: boolean },
): SaveArticleResult {
  const parsed = parseFiche(fs.readFileSync(ref.file, "utf-8"));
  const fm = parsed?.frontmatter ?? {};
  const meta = (fm.meta ?? {}) as Record<string, any>;
  return {
    ...ref,
    duplicate: extra.duplicate,
    needs_capture: String(meta.status ?? fm.status ?? "") === NEEDS_CAPTURE,
    completed: false,
    title: String(fm.title ?? ref.title),
    subtitle: meta.subtitle ?? null,
    author: meta.author ?? null,
    publication: meta.publication ?? null,
    published_at: meta.published_at ?? null,
    image: meta.image ?? null,
    excerpt: meta.excerpt ?? null,
    lang: meta.lang ?? null,
    comment: null,
    tags: Array.isArray(fm.tags) ? fm.tags.map(String) : [],
    word_count: Number(meta.word_count ?? 0),
    summary: meta.summary ?? null,
    fiche_path: path.relative(garden.root, ref.file),
    fiche_web_path: ficheWebPath(garden, COLLECTION, ref.locale, ref.slug),
    card_web_path: cardWebPath(garden, COLLECTION, ref.locale, ref.slug),
  };
}

/** `slug`, or `slug-2`, `slug-3`… when a different article already took it. */
function uniqueSlug(garden: GardenRef, locale: string, base: string): string {
  const dir = path.join(garden.root, COLLECTION, locale);
  const taken = (slug: string) =>
    fs.existsSync(path.join(dir, `${slug}-fiche.md`)) || fs.existsSync(path.join(dir, `${slug}.md`));
  if (!taken(base)) return base;
  for (let n = 2; n < 100; n++) {
    const candidate = `${base.slice(0, 76)}-${n}`;
    if (!taken(candidate)) return candidate;
  }
  throw new ArticleSaveError("Could not find a free slug for this article", 422);
}

function absolutizeImage(image: string, articleUrl: string): string {
  try {
    return new URL(image, articleUrl).toString();
  } catch {
    return "";
  }
}

// ── Status ──

export const ARTICLE_STATUSES = ["inbox", "read", "archive", "discarded"] as const;
export type ArticleStatus = (typeof ARTICLE_STATUSES)[number];

/** Move a saved article along: inbox → read → archive (or discarded). */
export function setArticleStatus(
  memberId: string,
  slug: string,
  status: ArticleStatus,
  locale?: string,
): { slug: string; locale: string; status: string } {
  const garden = gardenFor(memberId);
  if (!garden) throw new ArticleSaveError("No garden for this member", 404);

  const ref = scanArticleFiches(garden).find(
    (f) => f.slug === slug && (!locale || f.locale === locale),
  );
  if (!ref) throw new ArticleSaveError(`Article not found: ${slug}`, 404);

  const parsed = parseFiche(fs.readFileSync(ref.file, "utf-8"));
  if (!parsed) throw new ArticleSaveError(`Could not parse fiche: ${slug}`, 422);

  const fm = parsed.frontmatter;
  if (ref.kind === "fiche") fm.meta = { ...(fm.meta ?? {}), status };
  else fm.status = status;
  writeFiche(ref.file, fm, parsed.body);
  autoCommit(garden, [ref.file], `Update article status: ${slug} → ${status}`);
  indexGardenPaths(memberId, [ref.file]);

  return { slug: ref.slug, locale: ref.locale, status };
}
