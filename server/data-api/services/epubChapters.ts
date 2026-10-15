/**
 * An EPUB cut into chapters of plain text — what the reader, the summaries and
 * the flashcards read (`<artifacts>/chapters/NNNN-<title>.txt`).
 *
 * This used to be two programs of the private `tools/calibre`: `epubsplit.py
 * --split-by-section`, then `epub2txt --raw` on each piece — the second a
 * macOS binary, so no hosted household could extract a book. It is the same
 * cut, done here: the book's table of contents gives the cut points, and the
 * text between two of them, in spine order, is a chapter. What comes before
 * the first entry is a section called `none` — a project's header, a cover
 * page — which the reader and the summarizer already know to leave out
 * (`shouldSkipChapter` in calibre.ts).
 *
 * The table of contents is the EPUB 3 navigation document when there is one,
 * else the EPUB 2 NCX. A book with neither is cut at its spine documents.
 */

import path from "node:path";
import { DOMParser, parseHTML } from "linkedom";
import { ZipReader } from "./zipReader";

export interface EpubSection {
  title: string;
  text: string;
}

export class EpubError extends Error {}

// ── XML by local name ──
// linkedom does not resolve namespaces, and books spell their prefixes as they
// like (`opf:item`, `item`, `dc:title`), so elements are matched on the part
// after the colon.

type El = {
  tagName: string;
  getAttribute(n: string): string | null;
  getElementsByTagName(n: string): ArrayLike<El>;
  childNodes: ArrayLike<any>;
  textContent: string | null;
};

const local = (el: El) => el.tagName.toLowerCase().split(":").pop()!;

/** Every descendant element with that local name, in document order. Walked by
 *  hand: linkedom's `getElementsByTagName("*")` finds nothing in an XML
 *  document. */
function all(root: El, name: string): El[] {
  const out: El[] = [];
  const visit = (node: any) => {
    for (const child of Array.from(node.childNodes ?? []) as any[]) {
      if (child.nodeType !== 1) continue;
      if (local(child) === name) out.push(child);
      visit(child);
    }
  };
  visit(root);
  return out;
}

function children(el: El, name: string): El[] {
  return Array.from(el.childNodes).filter((n: any) => n.nodeType === 1 && local(n) === name) as El[];
}

function xml(text: string): El {
  return new DOMParser().parseFromString(text, "text/xml") as unknown as El;
}

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

/** A link inside the book resolved against the file it appears in:
 *  `{ file, fragment }`, the file as a path inside the archive. */
function resolveHref(fromFile: string, href: string): { file: string; fragment: string } {
  const [rawPath, rawFragment = ""] = href.split("#");
  const decode = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };
  const file = rawPath
    ? path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), decode(rawPath)))
    : fromFile;
  return { file: file.replace(/^\.\//, ""), fragment: decode(rawFragment) };
}

const anchorKey = (file: string, fragment: string) => `${file}#${fragment}`;

// ── The book's text, as a stream ──
// Every spine document is walked in order into one stream of tokens: a
// paragraph of text, or an anchor (an element's id, or the start of a file).
// A table-of-contents entry is then a position in that stream, and a chapter
// is the paragraphs between two positions.

type Token = { kind: "text"; text: string } | { kind: "anchor"; key: string };

const BLOCK = new Set([
  "p", "div", "section", "article", "header", "footer", "aside", "main", "nav",
  "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "li", "ul", "ol",
  "dl", "dt", "dd", "table", "tr", "td", "th", "figure", "figcaption", "hr",
  "address", "body",
]);
const SKIP = new Set(["script", "style", "head", "title", "svg", "math", "template"]);

function documentTokens(file: string, html: string): Token[] {
  const { document } = parseHTML(html);
  const out: Token[] = [{ kind: "anchor", key: anchorKey(file, "") }];
  let buf = "";
  const flush = () => {
    const t = buf.split("\n").map(collapse).filter(Boolean).join("\n");
    if (t) out.push({ kind: "text", text: t });
    buf = "";
  };

  const walk = (node: any, pre: boolean) => {
    if (node.nodeType === 3) {
      buf += pre ? node.textContent : node.textContent.replace(/\s+/g, " ");
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = String(node.tagName).toLowerCase().split(":").pop()!;
    if (SKIP.has(tag)) return;
    const id = node.getAttribute("id") || (tag === "a" ? node.getAttribute("name") : null);
    const block = BLOCK.has(tag);
    if (block || id) flush();
    if (id) out.push({ kind: "anchor", key: anchorKey(file, id) });
    if (tag === "br") { buf += "\n"; return; }
    for (const child of Array.from(node.childNodes)) walk(child, pre || tag === "pre");
    if (block) flush();
  };

  walk(document.body ?? document.documentElement, false);
  flush();
  return out;
}

// ── The package ──

interface Package {
  opfPath: string;
  spine: string[];
  manifest: Map<string, { href: string; type: string; properties: string }>;
  ncx: string | null;
  nav: string | null;
}

function readPackage(zip: ZipReader): Package {
  const container = zip.text("META-INF/container.xml");
  if (!container) throw new EpubError("not an EPUB: META-INF/container.xml is missing");
  const rootfile = all(xml(container), "rootfile")[0]?.getAttribute("full-path");
  if (!rootfile) throw new EpubError("not an EPUB: no rootfile in container.xml");
  const opfText = zip.text(rootfile);
  if (!opfText) throw new EpubError(`the package document ${rootfile} is missing`);
  const opf = xml(opfText);

  const manifest = new Map<string, { href: string; type: string; properties: string }>();
  for (const item of all(opf, "item")) {
    const id = item.getAttribute("id");
    const href = item.getAttribute("href");
    if (!id || !href) continue;
    manifest.set(id, {
      href: resolveHref(rootfile, href).file,
      type: item.getAttribute("media-type") ?? "",
      properties: item.getAttribute("properties") ?? "",
    });
  }

  const spineEl = all(opf, "spine")[0];
  const spine = all(opf, "itemref")
    .map((r) => manifest.get(r.getAttribute("idref") ?? "")?.href)
    .filter((h): h is string => !!h && zip.has(h));
  if (!spine.length) throw new EpubError("the book has no readable spine");

  const navItem = [...manifest.values()].find((m) => m.properties.split(/\s+/).includes("nav"));
  const ncxId = spineEl?.getAttribute("toc");
  const ncxItem = (ncxId && manifest.get(ncxId)) ||
    [...manifest.values()].find((m) => m.type === "application/x-dtbncx+xml");
  return {
    opfPath: rootfile,
    spine,
    manifest,
    nav: navItem && zip.has(navItem.href) ? navItem.href : null,
    ncx: ncxItem && zip.has(ncxItem.href) ? ncxItem.href : null,
  };
}

/** The table of contents, flattened in reading order: `{ title, key }`. */
function tableOfContents(zip: ZipReader, pkg: Package): Array<{ title: string; key: string }> {
  if (pkg.nav) {
    const { document } = parseHTML(zip.text(pkg.nav)!);
    const navs = Array.from(document.getElementsByTagName("nav")) as any[];
    const toc = navs.find((n) => /\btoc\b/.test(`${n.getAttribute("epub:type") ?? ""} ${n.getAttribute("role") ?? ""}`)) ?? navs[0];
    if (toc) {
      const entries = (Array.from(toc.getElementsByTagName("a")) as any[])
        .filter((a) => a.getAttribute("href"))
        .map((a) => {
          const { file, fragment } = resolveHref(pkg.nav!, a.getAttribute("href"));
          return { title: collapse(a.textContent ?? ""), key: anchorKey(file, fragment) };
        });
      if (entries.length) return entries;
    }
  }
  if (pkg.ncx) {
    const ncx = xml(zip.text(pkg.ncx)!);
    return all(ncx, "navpoint")
      .map((point) => {
        const label = children(point, "navlabel")[0];
        const title = collapse((label && all(label, "text")[0]?.textContent) ?? label?.textContent ?? "");
        const src = children(point, "content")[0]?.getAttribute("src");
        if (!src) return null;
        const { file, fragment } = resolveHref(pkg.ncx!, src);
        return { title, key: anchorKey(file, fragment) };
      })
      .filter((e): e is { title: string; key: string } => !!e);
  }
  return [];
}

function joinText(tokens: Token[]): string {
  const paragraphs = tokens.flatMap((t) => (t.kind === "text" ? [t.text] : []));
  return paragraphs.length ? paragraphs.join("\n\n") + "\n" : "";
}

/** The book's chapters, in reading order. Empty sections are dropped. */
export function epubSections(epub: Buffer): EpubSection[] {
  const zip = new ZipReader(epub);
  const pkg = readPackage(zip);

  const stream: Token[] = [];
  const firstHeading = new Map<string, string>();
  for (const file of pkg.spine) {
    const tokens = documentTokens(file, zip.text(file) ?? "");
    stream.push(...tokens);
    const heading = tokens.find((t) => t.kind === "text");
    if (heading?.kind === "text") firstHeading.set(file, heading.text.split("\n")[0]!.slice(0, 120));
  }
  const position = new Map<string, number>();
  stream.forEach((t, i) => { if (t.kind === "anchor" && !position.has(t.key)) position.set(t.key, i); });

  // Cut points: each table-of-contents entry that lands somewhere in the
  // stream, in stream order. Two entries at one place (a part and its first
  // chapter) make one cut, named by the first.
  const cuts: Array<{ at: number; title: string }> = [];
  for (const entry of tableOfContents(zip, pkg)) {
    const at = position.get(entry.key) ?? position.get(entry.key.replace(/#.*$/, "#"));
    if (at === undefined || cuts.some((c) => c.at === at)) continue;
    cuts.push({ at, title: entry.title });
  }
  cuts.sort((a, b) => a.at - b.at);

  // No usable table of contents: one chapter per spine document.
  if (!cuts.length) {
    for (const file of pkg.spine) {
      cuts.push({ at: position.get(anchorKey(file, ""))!, title: firstHeading.get(file) ?? "" });
    }
  }

  const sections: EpubSection[] = [];
  if (cuts[0]!.at > 0) sections.push({ title: "", text: joinText(stream.slice(0, cuts[0]!.at)) });
  cuts.forEach((cut, i) => {
    sections.push({ title: cut.title, text: joinText(stream.slice(cut.at, cuts[i + 1]?.at ?? stream.length)) });
  });
  return sections
    .filter((s) => s.text.trim())
    .map((s) => ({ title: s.title || "none", text: s.text }));
}

/** `NNNN-<title>.txt`: the number orders the files, the title is what the
 *  reader shows. Separators and control characters would break the path, a
 *  very long title the filesystem. */
export function chapterFileName(position: number, title: string): string {
  const safe = title
    .replace(/[\/\\\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100)
    .replace(/[ .]+$/, "");
  return `${String(position).padStart(4, "0")}-${safe || "none"}.txt`;
}
