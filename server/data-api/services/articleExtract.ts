/**
 * Article fetching + metadata extraction.
 *
 * Extracted from routes/articles-api.ts so the scrape route and the garden
 * article route share one pipeline instead of drifting apart (a third copy
 * already lives in the Python garden MCP tool, OG-only and weaker).
 *
 * Two entry points into the same extractor:
 *   - `extractArticleFromUrl(url)` — the server fetches, behind the SSRF guard.
 *   - `extractArticleFromHtml(url, html)` — the caller supplies a DOM it already
 *     rendered (browser extension, Safari share sheet). No fetch happens, which
 *     is the only way past a paywall or a Cloudflare interstitial: the garden
 *     holds two such captures ("Client Challenge", "Security Verification")
 *     saved as if they were articles.
 */

import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { lookup } from "node:dns/promises";
import net from "node:net";

export const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/** Refuse to parse a caller-supplied DOM larger than this (memory guard). */
const MAX_HTML_BYTES = 8 * 1024 * 1024;

// ── SSRF guard ──
// These routes fetch a caller-supplied URL (and its image), so without a guard
// an authenticated member — or the model via MCP — could reach loopback
// (Ollama :11434, /admin), LAN hosts, the tailnet, or cloud metadata
// (169.254.169.254). We reject non-http(s) URLs and any host that resolves to a
// loopback/private/link-local/CGNAT/reserved address, and re-validate every
// redirect hop (fetch's "follow" would otherwise hop straight past the check).
// Residual: a DNS-rebind between check and connect is still theoretically
// possible; acceptable for this authenticated, low-frequency path.
function ipIsBlocked(ip: string): boolean {
  let addr = ip;
  if (addr.startsWith("::ffff:")) addr = addr.slice(7); // unwrap IPv4-mapped IPv6
  if (net.isIPv4(addr)) {
    const p = addr.split(".").map(Number);
    if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
    const a = p[0] ?? -1;
    const b = p[1] ?? -1;
    if (a === 0 || a === 127) return true;               // this-host / loopback
    if (a === 10) return true;                            // private
    if (a === 172 && b >= 16 && b <= 31) return true;     // private
    if (a === 192 && b === 168) return true;              // private
    if (a === 169 && b === 254) return true;              // link-local + metadata
    if (a === 100 && b >= 64 && b <= 127) return true;    // CGNAT (tailnet)
    if (a >= 224) return true;                            // multicast / reserved
    return false;
  }
  if (net.isIPv6(addr)) {
    const low = addr.toLowerCase();
    return low === "::1" || low === "::" || low.startsWith("fe80") ||
      low.startsWith("fc") || low.startsWith("fd");        // loopback / link-local / ULA
  }
  return true; // unrecognized → block
}

export async function assertPublicHttpUrl(raw: string): Promise<void> {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error("invalid URL"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("only http(s) URLs are allowed");
  if (net.isIP(u.hostname)) {
    if (ipIsBlocked(u.hostname)) throw new Error("URL points at a non-public address");
    return;
  }
  const addrs = await lookup(u.hostname, { all: true });
  if (!addrs.length) throw new Error("URL host did not resolve");
  for (const a of addrs) if (ipIsBlocked(a.address)) throw new Error("URL resolves to a non-public address");
}

/** fetch() that validates the URL and every redirect hop against the SSRF guard. */
export async function safeFetch(raw: string, init: RequestInit = {}, maxRedirects = 5): Promise<Response> {
  let current = raw;
  for (let i = 0; i <= maxRedirects; i++) {
    await assertPublicHttpUrl(current);
    const resp = await fetch(current, { ...init, redirect: "manual" });
    const loc = resp.status >= 300 && resp.status < 400 ? resp.headers.get("location") : null;
    if (!loc) return resp;
    current = new URL(loc, current).toString();
  }
  throw new Error("too many redirects");
}

// ── Shape ──

export interface ArticleMeta {
  title: string;
  /** JSON-LD alternativeHeadline / dc.subtitle / sailthru.subtitle. Often empty. */
  subtitle: string;
  author: string;
  /** og:description — the teaser, not an AI summary. */
  description: string;
  image: string;
  /** Publication name: "Le Monde", "The Atlantic". */
  site_name: string;
  /** ISO date the article was published (not the day it was saved). */
  published_at: string;
  /** rel=canonical / og:url, before UTM stripping. */
  canonical_url: string;
  /** <html lang>. */
  lang: string;
  /** Full article text (Readability). */
  content: string;
  word_count: number;
}

// ── Extraction ──

export async function extractArticleFromUrl(url: string): Promise<ArticleMeta> {
  let current = url;
  let html = "";

  // Up to two hops, because a `<meta http-equiv="refresh">` is a redirect that
  // fetch() does not follow — GitHub Pages and many CMSes move articles that
  // way, and the page left behind extracts as a 0-word article titled
  // "Redirect".
  for (let hop = 0; ; hop++) {
    const resp = await safeFetch(current, {
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
      },
    });

    // An error page is not an article. Skipping this check is how the garden
    // ended up holding "Page Not Found"-class entries: the extractor happily
    // pulled a title out of whatever came back and saved it.
    //
    // A refusal is worth naming apart from a genuine 404: gatesnotes.com, for
    // one, answers 403 to anything that is not a browser. The page in a tab is
    // fine, so the message says where to save it from rather than leaving the
    // reader to guess that the article is unreachable.
    if (!resp.ok) {
      const where = `the site answered ${resp.status} ${resp.statusText}`.trim();
      if (REFUSAL_STATUSES.has(resp.status)) {
        throw new ArticleRefusedError(
          `${where} — it refuses anything that is not a browser, so save it from one: the page in your tab is already loaded`,
        );
      }
      throw new Error(where);
    }

    const contentType = (resp.headers.get("content-type") ?? "").toLowerCase();
    if (contentType && !/(^|\/)(x?html|xml)|text\/plain/.test(contentType)) {
      throw new Error(`not a web page (${contentType.split(";")[0]})`);
    }

    html = await resp.text();
    const refresh = hop < 2 ? metaRefreshTarget(html, current) : "";
    if (!refresh || refresh === current) break;
    current = refresh;
  }

  const article = extractArticleFromHtml(current, html);

  // A bot check answers 200 with a real HTML page, so only the shape of what
  // came back gives it away. Refusing here is what keeps "Client Challenge" and
  // "Security Verification" out of the collection — and the message names the
  // one thing that actually gets past it.
  if (looksLikeInterstitial(article)) {
    throw new ArticleRefusedError(
      `the site returned a bot check ("${article.title}") instead of the article — ` +
      `save it from the browser, where the page is already loaded`,
    );
  }

  return article;
}

/** The URL of a `<meta http-equiv="refresh" content="0; url=…">`, absolute. */
function metaRefreshTarget(html: string, base: string): string {
  for (const attrs of parseTags(html.slice(0, 64 * 1024), "meta")) {
    if ((attrs["http-equiv"] ?? "").toLowerCase() !== "refresh") continue;
    const target = (attrs.content ?? "").match(/url\s*=\s*['"]?([^'";]+)/i)?.[1];
    if (!target) continue;
    try {
      return new URL(target.trim(), base).toString();
    } catch {
      return "";
    }
  }
  return "";
}

/** Statuses that mean "not from you", rather than "not there". */
const REFUSAL_STATUSES = new Set([401, 402, 403, 407, 429, 451]);

/**
 * The site would not serve us, but would serve a browser.
 *
 * Distinguished from every other extraction failure because it is the only one
 * the reader can act on — and the only one worth keeping a bookmark for. A 404
 * is a dead URL; a bookmark to it would be the same junk as an interstitial
 * saved as an article.
 */
export class ArticleRefusedError extends Error {}

const INTERSTITIAL_TITLES = [
  /^client challenge$/,
  /^security verification$/,
  /^just a moment/,
  /^one moment, please/,
  /^attention required/,
  /^checking your browser/,
  /^(bot|human) verification$/,
  /^are you a (robot|human)/,
  /^access denied$/,
  /^ddos-?guard/,
  /^please enable (js|javascript|cookies)/,
  /^verifying you are human/,
];

/** A bot wall: a known interstitial title over a page with no article in it. */
function looksLikeInterstitial(article: ArticleMeta): boolean {
  const title = article.title.trim().toLowerCase();
  if (!title) return false;
  return article.word_count < 150 && INTERSTITIAL_TITLES.some((re) => re.test(title));
}

export function extractArticleFromHtml(url: string, html: string): ArticleMeta {
  if (html.length > MAX_HTML_BYTES) {
    throw new Error(`HTML too large (${html.length} bytes, max ${MAX_HTML_BYTES})`);
  }

  const og = extractOgTags(html);
  const jsonLd = extractJsonLd(html);
  const meta = extractMetaTags(html);

  // Readability wants a base URI to resolve relative hrefs; linkedom won't infer
  // one from a string, so inject <base> when the page has none.
  const { document } = parseHTML(withBase(html, url));
  let article: ReturnType<Readability["parse"]> = null;
  try {
    article = new Readability(document).parse();
  } catch {
    // Malformed DOM — fall through to the meta-only path below.
  }

  // Merge: prefer OG > JSON-LD > Readability > meta > empty
  const title = og.title || jsonLd.headline || article?.title || meta.title || "";
  const subtitle = jsonLd.alternativeHeadline || meta.subtitle || "";
  const author = og.author || jsonLd.author || article?.byline || meta.author || "";
  const description = og.description || jsonLd.description || article?.excerpt || meta.description || "";
  const image = og.image || jsonLd.image || meta.image || "";
  const site_name = og.site_name || jsonLd.publisher || meta.site_name || article?.siteName || "";
  const published_at = normalizeDate(
    og.published_time || jsonLd.datePublished || meta.published_time || "",
  );
  const canonical_url = meta.canonical || og.url || url;
  const lang = (html.match(/<html[^>]*\blang=["']([a-zA-Z-]{2,8})["']/i)?.[1] || meta.lang || "")
    .slice(0, 8)
    .toLowerCase();

  const content = article?.textContent?.trim() || "";

  return {
    title: title.trim(),
    subtitle: subtitle.trim(),
    author: author.trim(),
    description: description.trim(),
    image: image.trim(),
    site_name: site_name.trim(),
    published_at,
    canonical_url,
    lang,
    content,
    word_count: content ? content.split(/\s+/).filter(Boolean).length : 0,
  };
}

/** Insert a <base href> so Readability resolves relative URLs in supplied HTML. */
function withBase(html: string, url: string): string {
  if (/<base\s/i.test(html)) return html;
  const headOpen = html.match(/<head[^>]*>/i);
  if (!headOpen) return html;
  const at = headOpen.index! + headOpen[0].length;
  return `${html.slice(0, at)}<base href="${url.replace(/"/g, "&quot;")}">${html.slice(at)}`;
}

/** Coerce a date-ish string to YYYY-MM-DD; "" when it isn't a real date. */
function normalizeDate(raw: string): string {
  if (!raw) return "";
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return "";
  const year = new Date(t).getUTCFullYear();
  if (year < 1900 || year > 2200) return "";
  return new Date(t).toISOString().slice(0, 10);
}

// ── Extraction helpers ──
//
// Attributes are parsed properly rather than matched with one regex per shape.
// The previous approach — `content=["']([^"']*)["']` — truncated at the first
// apostrophe inside a double-quoted value, so every French title lost
// everything from its first elision on ("Le titre de l'article" → "Le titre de
// l"). It also needed a mirrored regex per attribute order, and still missed
// any third ordering.

/** Split a tag's attribute string into a lowercased name → decoded value map. */
function parseAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  for (const m of source.matchAll(re)) {
    const key = m[1]?.toLowerCase();
    if (key) attrs[key] ??= decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return attrs;
}

/** Every <meta>/<link> tag, quote-aware so a `>` inside a value doesn't end it. */
function parseTags(html: string, tagName: "meta" | "link"): Record<string, string>[] {
  const re = new RegExp(`<${tagName}\\b((?:[^>"']|"[^"]*"|'[^']*')*)>`, "gi");
  return [...html.matchAll(re)].map((m) => parseAttrs(m[1] ?? ""));
}

/**
 * og:*, article:* and twitter:* keys, prefix stripped and merged in that order
 * of preference. `twitter:text` is folded onto `description`, as before.
 */
function extractOgTags(html: string): Record<string, string> {
  const og: Record<string, string> = {};
  const put = (key: string, value: string) => {
    if (key && value) og[key] ??= value;
  };

  for (const prefix of ["og:", "article:", "twitter:"]) {
    for (const attrs of parseTags(html, "meta")) {
      const rawKey = attrs.property ?? attrs.name ?? attrs.itemprop ?? "";
      if (!rawKey.toLowerCase().startsWith(prefix)) continue;
      const key = rawKey.slice(prefix.length).toLowerCase();
      put(key === "text" ? "description" : key, attrs.content ?? "");
    }
  }

  return og;
}

const LD_TYPES = new Set(["NewsArticle", "Article", "BlogPosting", "ReportageNewsArticle", "WebPage"]);

function extractJsonLd(html: string): Record<string, string> {
  const result: Record<string, string> = {};

  const name = (v: any): string =>
    typeof v === "string" ? v : Array.isArray(v) ? name(v[0]) : v?.name || "";
  const urlOf = (v: any): string =>
    typeof v === "string" ? v : Array.isArray(v) ? urlOf(v[0]) : v?.url || "";

  for (const m of html.matchAll(
    /<script\s+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    try {
      const data = JSON.parse(m[1] ?? "null");
      // Yoast and friends nest everything under @graph rather than a top-level array.
      const items: any[] = [];
      for (const entry of Array.isArray(data) ? data : [data]) {
        if (entry && Array.isArray(entry["@graph"])) items.push(...entry["@graph"]);
        else items.push(entry);
      }
      for (const item of items) {
        const types = Array.isArray(item?.["@type"]) ? item["@type"] : [item?.["@type"]];
        if (!types.some((t: string) => LD_TYPES.has(t))) continue;
        result.headline ||= item.headline || item.name || "";
        result.alternativeHeadline ||= item.alternativeHeadline || "";
        result.description ||= item.description || "";
        result.author ||= name(item.author);
        result.publisher ||= name(item.publisher);
        result.image ||= urlOf(item.image);
        result.datePublished ||= item.datePublished || item.dateCreated || "";
      }
    } catch {
      // Invalid JSON-LD, skip
    }
  }

  return result;
}

/** Publication date under its many vendor names. */
const DATE_KEYS = new Set([
  "date", "pubdate", "publishdate", "publish-date", "publish_date",
  "dc.date", "dc.date.issued", "datepublished", "parsely-pub-date", "sailthru.date",
]);

/** Subtitle / standfirst / deck. */
const SUBTITLE_KEYS = new Set([
  "subtitle", "dc.subtitle", "sailthru.subtitle", "parsely-subtitle",
]);

function extractMetaTags(html: string): Record<string, string> {
  const meta: Record<string, string> = {};

  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch?.[1]) meta.title = decodeEntities(titleMatch[1].trim());

  for (const attrs of parseTags(html, "meta")) {
    const key = (attrs.name ?? attrs.property ?? attrs.itemprop ?? "").toLowerCase();
    const content = attrs.content ?? "";
    if (!key || !content) continue;
    if (key === "description" || key === "author") meta[key] ??= content;
    else if (DATE_KEYS.has(key)) meta.published_time ??= content;
    else if (SUBTITLE_KEYS.has(key)) meta.subtitle ??= content;
  }

  for (const attrs of parseTags(html, "link")) {
    if ((attrs.rel ?? "").toLowerCase() === "canonical" && attrs.href) {
      meta.canonical ??= attrs.href;
    }
  }

  return meta;
}


export function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2F;/gi, "/")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, "&"); // last: so &amp;lt; decodes to &lt;, not <
}

// ── URL handling ──

/** Tracking parameters that identify the sharer, not the article. */
const TRACKING_PARAMS = [
  /^utm_/i, /^fbclid$/i, /^gclid$/i, /^dclid$/i, /^msclkid$/i, /^igshid$/i,
  /^mc_[ce]id$/i, /^_hs(enc|mi)$/i, /^ref$/i, /^ref_src$/i, /^s$/i,
  /^cmpid$/i, /^campaign_id$/i, /^smid$/i, /^spm$/i, /^at_medium$/i, /^at_campaign$/i,
];

/**
 * The key two saves of the same article must agree on.
 *
 * Everything that varies with *how you got there* is dropped: scheme, `www.`,
 * tracking params, the fragment, a trailing slash. What identifies the article
 * — host, path, and any remaining query (an id, a page number) — is kept.
 */
export function canonicalizeUrl(raw: string): string {
  let u: URL;
  try { u = new URL(raw); } catch { return raw.trim(); }

  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING_PARAMS.some((re) => re.test(key))) u.searchParams.delete(key);
  }
  u.searchParams.sort();
  const query = u.searchParams.toString();
  const path = u.pathname.replace(/\/+$/, "") || "/";

  return `${host}${path}${query ? `?${query}` : ""}`;
}

export function slugify(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80)
    .replace(/-$/, "");
}
