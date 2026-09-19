/**
 * The garden owner's editing tools — what the toolbar in a garden page does:
 * flip a note public or private, delete it, reorder a MOC's children, resolve
 * a page to its file for an external editor, and the publishing helpers.
 *
 * These lived as Vite dev-server middlewares (`web/src/integrations/dev-tools.ts`)
 * until September 2026. Three things were wrong with that, and moving them here
 * fixes all three by construction:
 *
 *   - they carried no authentication of their own, trusting the proxy in front;
 *   - they only existed under `astro dev`, which is what kept every member's
 *     garden on a 270 MB dev server;
 *   - the browser called them at a root-absolute `/_dev/…`, which under
 *     `/g/<member>/` reached whichever engine served the DEFAULT garden — so
 *     in a household, a member's toolbar edited nobody's garden.
 *
 * Every function here takes the garden it acts on, and the route layer resolves
 * that from the session: you edit your own garden, never anyone else's.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { atomicWrite, autoCommit, type GardenRef } from "../../data-api/services/gardenFiche";

export type { GardenRef };

/** The repo root, when the server runs from a checkout (it may not). */
const REPO_ROOT = path.resolve(import.meta.dir, "../../..");

// ── URL → file ──────────────────────────────────────────────────

const URL_PREFIX_MAP: Record<string, string> = {
  blog: "blog", essays: "essays", essais: "essays", notes: "notes",
};

const RESOURCE_PREFIX_MAP: Record<string, string> = {
  movies: "movies", films: "movies", games: "games", jeux: "games",
  books: "books", livres: "books", articles: "articles",
  podcasts: "podcasts", series: "series", people: "people",
};

export const SHAREABLE_COLLECTIONS = new Set([
  "blog", "essays", "books", "movies", "games", "series", "podcasts", "articles",
]);

export interface ContentFile {
  filePath: string;
  isNotes: boolean;
  collection: string;
}

/** The page in `dir` whose frontmatter declares this translationKey, if any. */
function findPageByTranslationKey(dir: string, key: string): string | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null; // garden without a pages/ tree
  }
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const filePath = path.join(dir, entry);
    if (parseFrontmatter(fs.readFileSync(filePath, "utf-8")).translationKey === key) return filePath;
  }
  return null;
}

/**
 * Resolve a garden URL path to the file behind it, or null.
 *
 * The path comes from the browser's `location.pathname`, so it carries the
 * `/g/<member>/` base and possibly an `/fr` locale prefix. Anything that
 * resolves outside the garden is refused: every caller writes or deletes what
 * this returns, and the id is client-controlled.
 */
export function resolveContentFile(garden: GardenRef, urlPath: string): ContentFile | null {
  const root = path.resolve(garden.root);
  const result = resolveUnchecked(garden, urlPath);
  if (!result) return null;
  const abs = path.resolve(result.filePath);
  if (!abs.startsWith(root + path.sep)) return null;
  return { ...result, filePath: abs };
}

function resolveUnchecked(garden: GardenRef, rawPath: string): ContentFile | null {
  const contentRoot = garden.root;
  let urlPath = (rawPath || "/").split("?")[0]!;

  // Strip the garden base (/g/<member>) the browser sends.
  urlPath = urlPath.replace(new RegExp(`^/g/${garden.username}(?=/|$)`), "") || "/";

  // Strip the locale prefix. `/fr` alone is the French home, so it must match too.
  let locale = "en";
  const localeMatch = urlPath.match(/^\/fr(\/.*)?$/);
  if (localeMatch) {
    locale = "fr";
    urlPath = localeMatch[1] || "/";
  }
  urlPath = urlPath.replace(/\/$/, "");

  // Standalone pages (about, home) live in pages/<locale>/ and are rendered by
  // hand-written routes, so they never match the /prefix/{id} shape below.
  const singleSegment = urlPath.match(/^\/([^/]+)$/);
  if (!urlPath || singleSegment) {
    const pagesDir = path.join(contentRoot, "pages", locale);
    const filePath = singleSegment
      ? path.join(pagesDir, `${singleSegment[1]}.md`)
      : findPageByTranslationKey(pagesDir, "home");
    if (filePath && fs.existsSync(filePath)) {
      return { filePath, isNotes: false, collection: "pages" };
    }
    // Not a page — fall through: a bare /notes is a collection index, which has
    // no file of its own.
  }

  // /fiches/{collection}/{slug}
  const ficheMatch = urlPath.match(/^\/fiches\/([^/]+)\/(.+)$/);
  if (ficheMatch) {
    const filePath = path.join(contentRoot, ficheMatch[1]!, locale, `${ficheMatch[2]}.md`);
    return fs.existsSync(filePath) ? { filePath, isNotes: false, collection: ficheMatch[1]! } : null;
  }

  let collection: string | undefined;
  let id: string | undefined;
  const resourceMatch = urlPath.match(/^\/(resources|trouvailles)\/([^/]+)\/(.+)$/);
  if (resourceMatch) {
    collection = RESOURCE_PREFIX_MAP[resourceMatch[2]!];
    id = resourceMatch[3];
  } else {
    const simpleMatch = urlPath.match(/^\/([^/]+)\/(.+)$/);
    if (simpleMatch) {
      collection = URL_PREFIX_MAP[simpleMatch[1]!];
      id = simpleMatch[2];
    }
  }
  if (!collection || !id) return null;

  const dir = path.join(contentRoot, collection, locale);
  let filePath = path.join(dir, `${id}.md`);
  if (!fs.existsSync(filePath)) filePath = path.join(dir, `${id}.mdx`); // essays
  return fs.existsSync(filePath) ? { filePath, isNotes: collection === "notes", collection } : null;
}

/** A path the client handed back (social publish) is only usable inside the garden. */
export function confineToGarden(garden: GardenRef, candidate: string): string | null {
  const root = path.resolve(garden.root);
  const abs = path.resolve(candidate);
  return abs.startsWith(root + path.sep) ? abs : null;
}

// ── Frontmatter ─────────────────────────────────────────────────

/** Simple frontmatter key-value reader (between the --- fences). */
export function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const fm: Record<string, string> = {};
  for (const line of match[1]!.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    fm[key] = val;
  }
  return fm;
}

export function parseFlagsArray(content: string): string[] {
  const flow = content.match(/^flags:\s*\[([^\]]*)\]\s*$/m);
  if (flow) return flow[1]!.split(",").map((s) => s.trim()).filter(Boolean);
  const block = content.match(/^flags:\s*\n((?:\s+-\s+.+\n?)*)/m);
  if (block) return block[1]!.match(/^\s+-\s+(.+)$/gm)?.map((l) => l.replace(/^\s+-\s+/, "").trim()) ?? [];
  return [];
}

function replaceFlagsLine(content: string, flags: string[]): string {
  const line = `flags: [${flags.join(", ")}]`;
  if (/^flags:\s*\[.*\]\s*$/m.test(content)) return content.replace(/^flags:\s*\[.*\]\s*$/m, line);
  if (/^flags:\s*\n(?:\s+-\s+.+\n?)*/m.test(content)) {
    return content.replace(/^flags:\s*\n(?:\s+-\s+.+\n?)*/m, line + "\n");
  }
  if (/^tags:/m.test(content)) return content.replace(/^(tags:.*(?:\n\s+-\s+.+)*)$/m, `$1\n${line}`);
  return content.replace(/^---\n/, `---\n${line}\n`);
}

function toggleFlag(content: string, flag: string): { content: string; enabled: boolean } {
  const flags = parseFlagsArray(content);
  if (flags.includes(flag)) {
    return { content: replaceFlagsLine(content, flags.filter((f) => f !== flag)), enabled: false };
  }
  return { content: replaceFlagsLine(content, [...flags, flag]), enabled: true };
}

export function setFrontmatterField(content: string, key: string, value: string): string {
  const re = new RegExp(`^${key}:.*$`, "m");
  if (re.test(content)) return content.replace(re, `${key}: ${value}`);
  return content.replace(/\n---/, `\n${key}: ${value}\n---`);
}

// ── Actions ─────────────────────────────────────────────────────

export function publicState(garden: GardenRef, urlPath: string): { file: string; public: boolean } | null {
  const found = resolveContentFile(garden, urlPath);
  // Standalone pages have no publication state — their route renders them
  // either way — so the toggle stays hidden there.
  if (!found || found.collection === "pages") return null;
  const flags = parseFlagsArray(fs.readFileSync(found.filePath, "utf-8"));
  return { file: found.filePath, public: flags.includes("public") };
}

export function togglePublic(garden: GardenRef, urlPath: string): { file: string; public: boolean } | null {
  const found = resolveContentFile(garden, urlPath);
  if (!found) return null;
  const { content, enabled } = toggleFlag(fs.readFileSync(found.filePath, "utf-8"), "public");
  atomicWrite(found.filePath, content);
  autoCommit(garden, [found.filePath], `Set public ${enabled ? "on" : "off"}: ${path.basename(found.filePath)}`);
  return { file: found.filePath, public: enabled };
}

export function privateState(garden: GardenRef, urlPath: string): { file: string; private: boolean } | null {
  const found = resolveContentFile(garden, urlPath);
  if (!found || !found.isNotes) return null;
  const flags = parseFlagsArray(fs.readFileSync(found.filePath, "utf-8"));
  return { file: found.filePath, private: flags.includes("encrypted") };
}

export function togglePrivate(garden: GardenRef, urlPath: string): { file: string; private: boolean } | null {
  const found = resolveContentFile(garden, urlPath);
  if (!found || !found.isNotes) return null;
  const { content, enabled } = toggleFlag(fs.readFileSync(found.filePath, "utf-8"), "encrypted");
  atomicWrite(found.filePath, content);
  autoCommit(garden, [found.filePath], `Set encrypted ${enabled ? "on" : "off"}: ${path.basename(found.filePath)}`);
  return { file: found.filePath, private: enabled };
}

// ── Reviewing a note Maurice wrote (P2-C) ─────────────────
//
// A note seeded at a domain's adoption carries `meta.opened: false` — the
// fiche convention — until the member keeps it. Keeping is this: the marker
// line goes, by a string edit that leaves the rest of the file exactly as it
// was (the frontmatter may have been written by a person since). Correcting
// it through Maurice clears the mark too (tools/garden/server.py, update_note
// with a body); throwing it away is `deleteNote`.

/** The `meta:` block of a frontmatter, as [start, end) offsets of its own
 *  lines, or null when there is none. */
function metaBlockRange(fm: string): { start: number; end: number } | null {
  const m = fm.match(/^meta:[ \t]*\n/m);
  if (!m || m.index === undefined) return null;
  const start = m.index + m[0].length;
  let end = start;
  for (const line of fm.slice(start).split(/(?<=\n)/)) {
    if (!/^[ \t]+\S/.test(line)) break;
    end += line.length;
  }
  return { start, end };
}

/** Whether a note file is marked as written by Maurice and not reviewed. */
export function isUnreviewed(content: string): boolean {
  const head = content.match(/^---\n([\s\S]*?)\n---/);
  if (!head) return false;
  const fm = head[1] ?? "";
  const r = metaBlockRange(fm);
  return !!r && /^[ \t]+opened:[ \t]*false[ \t]*$/m.test(fm.slice(r.start, r.end));
}

/** Clear the mark — the `opened: false` line under `meta:`, and `meta:`
 *  itself when nothing is left under it. Unchanged content when there is
 *  no mark. */
export function clearUnreviewed(content: string): string {
  const head = content.match(/^---\n([\s\S]*?)\n---/);
  if (!head || head.index === undefined) return content;
  const fm = head[1] ?? "";
  const r = metaBlockRange(fm);
  if (!r) return content;
  const block = fm.slice(r.start, r.end);
  const next = block.replace(/^[ \t]+opened:[ \t]*false[ \t]*\n?/m, "");
  if (next === block) return content;
  const keepMeta = /\S/.test(next);
  const metaLine = fm.slice(0, r.start).match(/^meta:[ \t]*\n$/m);
  const fmNext = keepMeta
    ? fm.slice(0, r.start) + next + fm.slice(r.end)
    : fm.slice(0, r.start - (metaLine ? metaLine[0].length : 0)) + fm.slice(r.end);
  return content.slice(0, head.index + 4) + fmNext + content.slice(head.index + 4 + fm.length);
}

export function reviewState(garden: GardenRef, urlPath: string): { file: string; unreviewed: boolean } | null {
  const found = resolveContentFile(garden, urlPath);
  if (!found || !found.isNotes) return null;
  return { file: found.filePath, unreviewed: isUnreviewed(fs.readFileSync(found.filePath, "utf-8")) };
}

/** Keep the note: the mark goes, one commit. Idempotent. */
export function reviewNote(garden: GardenRef, urlPath: string): { file: string; unreviewed: boolean; reviewed: boolean } | null {
  const found = resolveContentFile(garden, urlPath);
  if (!found || !found.isNotes) return null;
  const content = fs.readFileSync(found.filePath, "utf-8");
  const next = clearUnreviewed(content);
  if (next === content) return { file: found.filePath, unreviewed: false, reviewed: false };
  atomicWrite(found.filePath, next);
  autoCommit(garden, [found.filePath], `Review note: ${path.basename(found.filePath, path.extname(found.filePath))}`);
  return { file: found.filePath, unreviewed: false, reviewed: true };
}

/**
 * Delete a note: the file, its illustration, and the index lines that pointed
 * at it — one commit, because a link that outlives its target is a broken
 * garden.
 */
export function deleteNote(garden: GardenRef, urlPath: string): { deleted: string } | null {
  const found = resolveContentFile(garden, urlPath);
  if (!found || !found.isNotes) return null;

  fs.unlinkSync(found.filePath);
  const touched = [found.filePath];
  const noteId = path.basename(found.filePath, path.extname(found.filePath));

  const imagesDir = path.join(garden.root, "images", "notes");
  for (const ext of [".jpg", ".png", ".svg", ".webp"]) {
    const img = path.join(imagesDir, `${noteId}${ext}`);
    if (fs.existsSync(img)) {
      fs.unlinkSync(img);
      touched.push(img);
    }
  }

  // A wiki-link alone on its line is an index entry and goes with the note; an
  // inline mention is prose and is left for its author to deal with.
  const linkLine = new RegExp(`^\\[\\[${noteId}(\\|[^\\]]*)?\\]\\]\\s*\\n?`, "gm");
  for (const locale of ["en", "fr"]) {
    const dir = path.join(garden.root, "notes", locale);
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".md") && !file.endsWith(".mdx")) continue;
      const filePath = path.join(dir, file);
      const content = fs.readFileSync(filePath, "utf-8");
      if (!content.includes(`[[${noteId}`)) continue;
      const updated = content.replace(linkLine, "");
      if (updated === content) continue;
      atomicWrite(filePath, updated);
      touched.push(filePath);
    }
  }

  autoCommit(garden, touched, `Delete note: ${noteId}`);
  return { deleted: noteId };
}

/**
 * Renumber a MOC's children. Until September 2026 this resolved slugs under
 * `web/src/content` — empty since the gardens moved out — so it answered
 * success and wrote nothing, and a drag-reorder was silently lost on reload.
 */
export function reorderChildren(
  garden: GardenRef,
  items: Array<{ slug: string; order: number }>,
): { updated: string[]; count: number } {
  const updated: string[] = [];
  const touched: string[] = [];

  for (const { slug, order } of items) {
    if (!/^[a-z0-9-]+$/i.test(slug) || !Number.isFinite(order)) continue;
    let filePath = path.join(garden.root, "notes", "en", `${slug}.md`);
    if (!fs.existsSync(filePath)) filePath = path.join(garden.root, "notes", "fr", `${slug}.md`);
    if (!fs.existsSync(filePath)) continue;

    let content = fs.readFileSync(filePath, "utf-8");
    if (/^order:\s*\d+\s*$/m.test(content)) {
      content = content.replace(/^order:\s*\d+\s*$/m, `order: ${order}`);
    } else if (/^status:/m.test(content)) {
      content = content.replace(/^(status:.*$)/m, `$1\norder: ${order}`);
    } else {
      content = content.replace(/^---\n/, `---\norder: ${order}\n`);
    }
    atomicWrite(filePath, content);
    updated.push(slug);
    touched.push(filePath);
  }

  // One commit for the whole reorder: the children only make sense renumbered
  // together.
  if (touched.length) autoCommit(garden, touched, `Reorder ${updated.length} child note(s)`);
  return { updated, count: updated.length };
}

// ── An external editor ──────────────────────────────────────────

function gitRoot(file: string): string | null {
  const out = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: path.dirname(file), encoding: "utf-8",
  });
  return out.status === 0 && out.stdout.trim() ? out.stdout.trim() : null;
}

/** The name Working Copy gives a clone: the remote's basename, else the dir's. */
function gitRepoName(root: string): string {
  const out = spawnSync("git", ["remote", "get-url", "origin"], { cwd: root, encoding: "utf-8" });
  const url = out.status === 0 ? out.stdout.trim() : "";
  return url ? path.basename(url).replace(/\.git$/, "") : path.basename(root);
}

/**
 * Everything the toolbar needs to hand a note to a native editor: Obsidian
 * opens an absolute path, Working Copy opens <repo>/<path-inside-the-repo>.
 */
export function editorTargets(garden: GardenRef, filePath: string): {
  contentPath: string; absPath: string; repo: string | null; repoPath: string | null;
} {
  const root = gitRoot(filePath);
  return {
    contentPath: path.relative(garden.root, filePath),
    absPath: filePath,
    repo: root ? process.env.WORKING_COPY_REPO || gitRepoName(root) : null,
    repoPath: root ? path.relative(root, filePath) : null,
  };
}

// ── Publishing (the owner's own pipeline, from the checkout) ─────

/** The public site a shared link points at. */
function publicSite(): string {
  return (process.env.MAURICE_PUBLIC_SITE || "https://candide.me").replace(/\/+$/, "");
}

export function socialState(garden: GardenRef, urlPath: string): Record<string, unknown> | null {
  const found = resolveContentFile(garden, urlPath);
  if (!found || !SHAREABLE_COLLECTIONS.has(found.collection)) return null;
  const content = fs.readFileSync(found.filePath, "utf-8");
  const fm = parseFrontmatter(content);
  // The public URL is the path as the public site serves it — without the
  // /g/<member> base the browser is on.
  const publicPath = urlPath.replace(new RegExp(`^/g/${garden.username}(?=/|$)`), "") || "/";
  return {
    shared_twitter: fm.shared_twitter === "true",
    shared_linkedin: fm.shared_linkedin === "true",
    shared_twitter_url: fm.shared_twitter_url || null,
    shared_linkedin_urn: fm.shared_linkedin_urn || null,
    title: fm.title || "",
    description: fm.description || "",
    image: fm.image || null,
    public: parseFlagsArray(content).includes("public"),
    url: `${publicSite()}${publicPath}`,
    content_path: found.filePath,
  };
}

/** Record a published post in the file's frontmatter. */
export function recordShare(
  garden: GardenRef, contentPath: string, platform: "twitter" | "linkedin",
  result: { url?: string; post_urn?: string },
): void {
  const safe = confineToGarden(garden, contentPath);
  if (!safe || !fs.existsSync(safe)) return;
  let content = fs.readFileSync(safe, "utf-8");
  if (platform === "twitter") {
    content = setFrontmatterField(content, "shared_twitter", "true");
    if (result.url) content = setFrontmatterField(content, "shared_twitter_url", `"${result.url}"`);
  } else {
    content = setFrontmatterField(content, "shared_linkedin", "true");
    if (result.post_urn) content = setFrontmatterField(content, "shared_linkedin_urn", `"${result.post_urn}"`);
  }
  atomicWrite(safe, content);
  autoCommit(garden, [safe], `Record social share: ${path.basename(safe)}`);
}

/** The repo's python, or null when the server does not run from a checkout. */
export function repoPython(): string | null {
  const candidates = [process.env.MAURICE_PYTHON, path.join(REPO_ROOT, ".venv/bin/python")];
  for (const p of candidates) if (p && fs.existsSync(p)) return p;
  return null;
}

export { REPO_ROOT };


// ── Coaching adherence pages ────────────────────────────────────
//
// `/fr/notes/bilan-<slug>` is generated by a python pipeline from signals the
// owner records. Visiting the page asks for a fresh one: the page is served
// immediately from whatever is on disk, the regeneration runs behind it, and
// the note is up to date on the next visit. Debounced, best-effort,
// owner-only, and silently absent on an install that is not a checkout.

const ADHERENCE_RE = /^(?:\/g\/[^/]+)?\/fr\/notes\/bilan-([a-z0-9-]+)\/?$/i;
const regeneratedAt = new Map<string, number>();
const ADHERENCE_DEBOUNCE_MS = 30_000;

export function maybeRegenerateAdherence(urlPath: string, isOwner: boolean): void {
  if (!isOwner) return;
  const slug = ADHERENCE_RE.exec(urlPath.split("?")[0]!)?.[1];
  if (!slug) return;
  const last = regeneratedAt.get(slug);
  if (last && Date.now() - last < ADHERENCE_DEBOUNCE_MS) return;

  const python = repoPython();
  if (!python) return;
  regeneratedAt.set(slug, Date.now());
  try {
    const proc = Bun.spawn([python, "-m", "tools.signals.adherence", "--slug", slug], {
      cwd: REPO_ROOT, stdout: "ignore", stderr: "pipe",
    });
    void (async () => {
      const err = await new Response(proc.stderr).text();
      const code = await proc.exited;
      if (code !== 0) console.error(`[adherence] bilan-${slug} failed (exit ${code}): ${err.slice(0, 300)}`);
    })();
  } catch (err) {
    console.error(`[adherence] bilan-${slug} could not start:`, (err as Error).message);
  }
}
