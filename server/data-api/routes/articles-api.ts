/**
 * POST /api/v1/articles/scrape
 *
 * Fetches a URL, extracts metadata (OG, JSON-LD, meta tags), runs
 * Mozilla Readability for full-text extraction, downloads the image,
 * creates an article entry in the content repo, and commits + pushes.
 */

import { Hono } from "hono";
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { lookup } from "node:dns/promises";
import net from "node:net";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";

const repoRoot = resolve(import.meta.dir, "..", "..", "..");
const contentRepo = resolve(repoRoot, "web", "src", "content");

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const app = new Hono();

// ── SSRF guard ──
// This route fetches a caller-supplied URL (and its image), so without a guard
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
    const [a, b] = p;
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

async function assertPublicHttpUrl(raw: string): Promise<void> {
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
async function safeFetch(raw: string, init: RequestInit = {}, maxRedirects = 5): Promise<Response> {
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

// ── Article metadata extraction ──

interface ArticleMeta {
  title: string;
  author: string;
  description: string;
  image: string;
  site_name: string;
  content: string; // full article text (markdown-ish)
}

async function extractArticle(url: string): Promise<ArticleMeta> {
  const resp = await safeFetch(url, {
    headers: {
      "User-Agent": BROWSER_UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
    },
  });
  const html = await resp.text();

  // 1. Extract OG metadata via regex (fast, works on raw HTML)
  const og = extractOgTags(html);

  // 2. Extract JSON-LD structured data
  const jsonLd = extractJsonLd(html);

  // 3. Extract standard meta tags as fallback
  const meta = extractMetaTags(html);

  // 4. Run Readability for full-text + title fallback
  const { document } = parseHTML(html);
  const reader = new Readability(document);
  const article = reader.parse();

  // Merge: prefer OG > JSON-LD > Readability > meta > empty
  const title =
    og.title ||
    jsonLd.headline ||
    article?.title ||
    meta.title ||
    "";

  const author =
    og.author ||
    jsonLd.author ||
    article?.byline ||
    meta.author ||
    "";

  const description =
    og.description ||
    jsonLd.description ||
    article?.excerpt ||
    meta.description ||
    "";

  const image =
    og.image ||
    jsonLd.image ||
    meta.image ||
    "";

  const site_name =
    og.site_name ||
    jsonLd.publisher ||
    meta.site_name ||
    "";

  // Convert Readability HTML to clean text
  const content = article?.textContent?.trim() || "";

  return { title, author, description, image, site_name, content };
}

// ── Extraction helpers ──

function extractOgTags(html: string): Record<string, string> {
  const og: Record<string, string> = {};

  // <meta property="og:title" content="...">
  for (const m of html.matchAll(
    /<meta\s+(?:property|name)=["']og:(\w+)["']\s+content=["']([^"']*)["']/gi,
  )) {
    og[m[1]] = decodeEntities(m[2]);
  }
  // <meta content="..." property="og:title">
  for (const m of html.matchAll(
    /<meta\s+content=["']([^"']*)["'].*?(?:property|name)=["']og:(\w+)["']/gi,
  )) {
    og[m[2]] ??= decodeEntities(m[1]);
  }

  // Twitter cards as fallback
  for (const m of html.matchAll(
    /<meta\s+(?:property|name)=["']twitter:(\w+)["']\s+content=["']([^"']*)["']/gi,
  )) {
    const key = m[1] === "text" ? "description" : m[1];
    og[key] ??= decodeEntities(m[2]);
  }
  for (const m of html.matchAll(
    /<meta\s+content=["']([^"']*)["'].*?(?:property|name)=["']twitter:(\w+)["']/gi,
  )) {
    const key = m[2] === "text" ? "description" : m[2];
    og[key] ??= decodeEntities(m[1]);
  }

  return og;
}

function extractJsonLd(html: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const m of html.matchAll(
    /<script\s+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    try {
      const data = JSON.parse(m[1]);
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (item["@type"] === "NewsArticle" || item["@type"] === "Article" || item["@type"] === "BlogPosting" || item["@type"] === "WebPage") {
          result.headline ??= item.headline || item.name || "";
          result.description ??= item.description || "";
          result.author ??= typeof item.author === "string"
            ? item.author
            : item.author?.name || (Array.isArray(item.author) ? item.author[0]?.name : "") || "";
          result.publisher ??= typeof item.publisher === "string"
            ? item.publisher
            : item.publisher?.name || "";
          result.image ??= typeof item.image === "string"
            ? item.image
            : item.image?.url || (Array.isArray(item.image) ? item.image[0]?.url || item.image[0] : "") || "";
        }
      }
    } catch {
      // Invalid JSON-LD, skip
    }
  }

  return result;
}

function extractMetaTags(html: string): Record<string, string> {
  const meta: Record<string, string> = {};

  // <title>
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleMatch) meta.title = decodeEntities(titleMatch[1].trim());

  // <meta name="description|author" content="...">
  for (const m of html.matchAll(
    /<meta\s+name=["'](description|author)["']\s+content=["']([^"']*)["']/gi,
  )) {
    meta[m[1].toLowerCase()] ??= decodeEntities(m[2]);
  }
  for (const m of html.matchAll(
    /<meta\s+content=["']([^"']*)["']\s+name=["'](description|author)["']/gi,
  )) {
    meta[m[2].toLowerCase()] ??= decodeEntities(m[1]);
  }

  // <meta property="article:author" content="...">
  for (const m of html.matchAll(
    /<meta\s+property=["']article:author["']\s+content=["']([^"']*)["']/gi,
  )) {
    meta.author ??= decodeEntities(m[1]);
  }

  // <link rel="icon" or "apple-touch-icon"> for site identity
  // (not extracting here — site_name from OG/JSON-LD is better)

  return meta;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/");
}

// ── Helpers ──

function slugify(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function yamlStr(s: string): string {
  if (/[:#\[\]{},"'|>&*!%@`]/.test(s) || s.includes("\n")) {
    return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return s;
}

async function downloadImage(imageUrl: string, dest: string): Promise<boolean> {
  try {
    const resp = await safeFetch(imageUrl, {
      headers: { "User-Agent": BROWSER_UA },
    });
    if (!resp.ok) return false;
    const buf = await resp.arrayBuffer();
    mkdirSync(resolve(dest, ".."), { recursive: true });
    writeFileSync(dest, Buffer.from(buf));
    return true;
  } catch {
    return false;
  }
}

function autoCommit(paths: string[], message: string): void {
  const relPaths = paths
    .filter((p) => p.startsWith(contentRepo))
    .map((p) => p.slice(contentRepo.length + 1));
  relPaths.push("images/");

  spawnSync("git", ["add", ...relPaths], { cwd: contentRepo });

  const diff = spawnSync("git", ["diff", "--cached", "--quiet"], { cwd: contentRepo });
  if (diff.status !== 0) {
    spawnSync("git", ["commit", "-m", message], { cwd: contentRepo });
    spawnSync("git", ["push"], { cwd: contentRepo });
  }
}

// ── Route ──

app.post("/scrape", async (c) => {
  const body = await c.req.json<{
    url?: string;
    tags?: string[];
    locale?: string;
    public?: boolean;
    content?: string;
  }>();

  if (!body.url) {
    return c.json({ error: "url is required" }, 400);
  }

  // 1. Fetch and extract article
  let article: ArticleMeta;
  try {
    article = await extractArticle(body.url);
  } catch (e: any) {
    return c.json({ error: `Failed to fetch URL: ${e.message}` }, 502);
  }

  if (!article.title) {
    return c.json({ error: "Could not extract title from URL" }, 422);
  }

  const locale = body.locale ?? "fr";
  const slug = slugify(article.title);

  // 2. Download image
  let imageRel = "";
  if (article.image) {
    let imageUrl = article.image;
    if (imageUrl.startsWith("/")) {
      const parsed = new URL(body.url);
      imageUrl = `${parsed.protocol}//${parsed.host}${imageUrl}`;
    }
    const imgFilename = `${locale}-${slug}.jpg`;
    const imgDest = resolve(contentRepo, "images", "resources", "articles", imgFilename);
    const ok = await downloadImage(imageUrl, imgDest);
    if (ok) {
      imageRel = `/images/content/resources/articles/${imgFilename}`;
    }
  }

  // 3. Build frontmatter
  const today = new Date().toISOString().slice(0, 10);
  const fmLines = [
    `title: ${yamlStr(article.title)}`,
    `source: ${yamlStr(article.site_name || new URL(body.url).hostname)}`,
    `url: ${yamlStr(body.url)}`,
    `date_read: ${today}`,
    `public: ${body.public ? "true" : "false"}`,
    `status: inbox`,
  ];
  if (article.author) fmLines.push(`author: ${yamlStr(article.author)}`);
  if (imageRel) fmLines.push(`image: ${yamlStr(imageRel)}`);
  if (body.tags?.length) {
    fmLines.push(`tags: [${body.tags.map((t) => yamlStr(t)).join(", ")}]`);
  }
  fmLines.push(`locale: "${locale}"`);
  fmLines.push(`translationKey: ${slug}`);

  // Use provided content > Readability full text > description
  const articleBody = body.content || article.content || article.description;
  let fileContent = `---\n${fmLines.join("\n")}\n---\n`;
  if (articleBody) fileContent += `\n${articleBody}\n`;

  // 4. Write file
  const articleDir = resolve(contentRepo, "articles", locale);
  mkdirSync(articleDir, { recursive: true });
  const filePath = resolve(articleDir, `${slug}.md`);

  if (existsSync(filePath)) {
    return c.json({ error: `Article already exists: ${slug}` }, 409);
  }

  writeFileSync(filePath, fileContent, "utf-8");

  // 5. Commit & push
  autoCommit([filePath], `Publish articles: ${slug}`);

  return c.json(
    {
      slug,
      title: article.title,
      author: article.author || null,
      source: article.site_name || null,
      image: imageRel || null,
      path: `articles/${locale}/${slug}.md`,
    },
    201,
  );
});

// ── Update article status ──

app.put("/scrape/:slug/status", async (c) => {
  const slug = c.req.param("slug");
  const body = await c.req.json<{ status?: string; locale?: string }>();

  const validStatuses = ["inbox", "read", "archive", "discarded"];
  if (!body.status || !validStatuses.includes(body.status)) {
    return c.json({ error: `status must be one of: ${validStatuses.join(", ")}` }, 400);
  }

  const locale = body.locale ?? "fr";
  const filePath = resolve(contentRepo, "articles", locale, `${slug}.md`);

  if (!existsSync(filePath)) {
    // Try other locales
    const articlesDir = resolve(contentRepo, "articles");
    let found = "";
    if (existsSync(articlesDir)) {
      for (const loc of readdirSync(articlesDir)) {
        const candidate = resolve(articlesDir, loc, `${slug}.md`);
        if (existsSync(candidate)) {
          found = candidate;
          break;
        }
      }
    }
    if (!found) {
      return c.json({ error: `Article not found: ${slug}` }, 404);
    }
    // Use the found path
    return updateArticleStatus(c, found, slug, body.status);
  }

  return updateArticleStatus(c, filePath, slug, body.status);
});

function updateArticleStatus(c: any, filePath: string, slug: string, status: string) {
  const content = readFileSync(filePath, "utf-8");
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) {
    return c.json({ error: "Could not parse frontmatter" }, 500);
  }

  const fm = fmMatch[1];
  const body = content.slice(fmMatch[0].length);

  // Replace or add status field
  let newFm: string;
  if (/^status:\s*.+$/m.test(fm)) {
    newFm = fm.replace(/^status:\s*.+$/m, `status: ${status}`);
  } else {
    newFm = fm + `\nstatus: ${status}`;
  }

  const newContent = `---\n${newFm}\n---${body}`;
  writeFileSync(filePath, newContent, "utf-8");

  autoCommit([filePath], `Update article status: ${slug} → ${status}`);

  return c.json({ slug, status });
}

export default app;
