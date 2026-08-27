/**
 * Writing fiches into a member's garden, from the Bun side.
 *
 * The markdown file is the source of truth — there is no table mirroring it,
 * deliberately: the vector store is a rebuildable projection, a table would be
 * a second source with nothing to rebuild it from, and no other collection
 * (books, movies, podcasts) has one.
 *
 * Everything here mirrors the Python garden MCP tool (tools/garden/server.py):
 * same paths, same frontmatter shape, same fragment layout, same commit
 * semantics. Both write the same tree, so they have to agree.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { gardensRoot } from "../../src/services/gardensRoot";
import { getUser } from "../../src/services/users";
import { safeFetch, BROWSER_UA } from "./articleExtract";

/** Mirrors _RESOURCE_COLLECTIONS in the garden MCP tool. */
export const RESOURCE_COLLECTIONS = [
  "books", "articles", "movies", "games", "series", "podcasts", "people",
] as const;
export type ResourceCollection = (typeof RESOURCE_COLLECTIONS)[number];

export interface GardenRef {
  /** Absolute path of <gardens>/<username>. */
  root: string;
  username: string;
}

/** The member's garden directory, or null when they have none. */
export function gardenFor(memberId: string): GardenRef | null {
  const user = getUser(memberId);
  if (!user) return null;
  return { root: path.join(gardensRoot(), user.username), username: user.username };
}

// ── Path safety ──

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LOCALE_RE = /^[a-z]{2}(?:-[a-z]{2})?$/;

export function assertSlug(value: string): string {
  if (!SLUG_RE.test(value)) throw new Error(`invalid slug: ${value}`);
  return value;
}

export function assertLocale(value: string): string {
  const v = value.toLowerCase();
  if (!LOCALE_RE.test(v)) throw new Error(`invalid locale: ${value}`);
  return v;
}

/** Reject any path that escaped its garden — belt to the slug/locale braces. */
function assertWithin(target: string, base: string): string {
  const resolved = path.resolve(target);
  if (resolved !== path.resolve(base) && !resolved.startsWith(path.resolve(base) + path.sep)) {
    throw new Error("path escapes the garden");
  }
  return resolved;
}

export function fichePath(
  garden: GardenRef,
  collection: ResourceCollection,
  locale: string,
  slug: string,
): string {
  return assertWithin(
    path.join(garden.root, collection, assertLocale(locale), `${assertSlug(slug)}-fiche.md`),
    garden.root,
  );
}

// ── YAML emission ──
//
// Block style, not flow: `Bun.YAML.stringify` emits `{a: 1}`, and the garden's
// own readers are line-oriented regexes (server/src/services/composer/notes.ts
// matches /^title:/m, web/src/lib/subtree-scan.ts does the same). Flow style
// parses fine as YAML and would still make every fiche invisible to them. This
// reproduces what PyYAML writes on the Python side, which is what those readers
// were written against.

type Yamlish = string | number | boolean | null | undefined | Yamlish[] | { [k: string]: Yamlish };

/** Quote only when the plain scalar would be ambiguous or invalid. */
function yamlScalar(value: string): string {
  if (value === "") return '""';
  const risky =
    /^[\s>|*&!%@`#-]/.test(value) ||        // indicator at the start
    /[:#]\s/.test(value) ||                  // key-ish or comment-ish inside
    /:$/.test(value) ||
    /[\n\r\t"']/.test(value) ||
    /\s$/.test(value) ||
    /^(true|false|null|yes|no|on|off|~)$/i.test(value) ||
    /^[-+]?[\d.]+(e[-+]?\d+)?$/i.test(value) ||   // would parse as a number
    /^\d{4}-\d{2}-\d{2}/.test(value);             // would parse as a date
  if (!risky) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "")}"`;
}

function yamlValue(value: Yamlish, indent: string): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "string") return yamlScalar(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return "\n" + value.map((v) => `${indent}- ${yamlValue(v, indent + "  ").replace(/^\n/, "")}`).join("\n");
  }
  const keys = Object.keys(value).filter((k) => value[k] !== undefined);
  if (keys.length === 0) return "{}";
  return "\n" + keys.map((k) => entry(indent, k, yamlValue(value[k], indent + "  "))).join("\n");
}

/**
 * `key: value`, or `key:` when the value is a block that opens on the next line
 * — otherwise every parent key trails a space, which PyYAML never writes.
 */
function entry(indent: string, key: string, rendered: string): string {
  return rendered.startsWith("\n") ? `${indent}${key}:${rendered}` : `${indent}${key}: ${rendered}`;
}

export function dumpFrontmatter(fm: Record<string, Yamlish>): string {
  return Object.keys(fm)
    .filter((k) => fm[k] !== undefined)
    .map((k) => entry("", k, yamlValue(fm[k], "  ")))
    .join("\n");
}

// ── Reading ──

export interface ParsedFiche {
  frontmatter: Record<string, any>;
  body: string;
}

export function parseFiche(raw: string): ParsedFiche | null {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return null;
  let frontmatter: Record<string, any> = {};
  try {
    frontmatter = (Bun.YAML.parse(m[1] ?? "") as Record<string, any>) ?? {};
  } catch {
    return null;
  }
  return { frontmatter, body: m[2] ?? "" };
}

// ── Writing ──

/** Write via a sibling temp file + rename, so a reader never sees a half file. */
export function atomicWrite(target: string, content: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, "utf-8");
  fs.renameSync(tmp, target);
}

export function writeFiche(target: string, fm: Record<string, Yamlish>, body: string): void {
  const lead = body.startsWith("\n") ? body : body ? `\n${body}\n` : "\n";
  atomicWrite(target, `---\n${dumpFrontmatter(fm)}\n---\n${lead}`);
}

/** `<collection>/<locale>/<slug>-fiche/_fragments/` — where the MCP tool looks. */
export function fragmentsDir(ficheFile: string): string {
  return path.join(path.dirname(ficheFile), path.basename(ficheFile, ".md"), "_fragments");
}

export function writeFragment(ficheFile: string, summary: string, body: string): string {
  const dir = fragmentsDir(ficheFile);
  fs.mkdirSync(dir, { recursive: true });
  const nums = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".frag"))
    .map((f) => Number(path.basename(f, ".frag")))
    .filter((n) => Number.isInteger(n));
  const next = String((nums.length ? Math.max(...nums) : 0) + 1).padStart(3, "0");
  const target = path.join(dir, `${next}.frag`);
  atomicWrite(target, `---\nsummary: "${summary.replace(/"/g, '\\"')}"\n---\n${body}`);
  return target;
}

// ── Images ──

/** Where promote_fiche already expects to find a cover, and the URL for it. */
export function resourceImagePaths(
  garden: GardenRef,
  collection: ResourceCollection,
  locale: string,
  slug: string,
): { file: string; url: string } {
  const filename = `${assertLocale(locale)}-${assertSlug(slug)}.jpg`;
  return {
    file: assertWithin(
      path.join(garden.root, "images", "resources", collection, filename),
      garden.root,
    ),
    url: `/images/${garden.username}/resources/${collection}/${filename}`,
  };
}

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

/** Download a cover. Returns the garden-relative URL, or "" on any failure. */
export async function downloadImage(imageUrl: string, dest: string): Promise<boolean> {
  try {
    const resp = await safeFetch(imageUrl, { headers: { "User-Agent": BROWSER_UA } });
    if (!resp.ok) return false;
    const type = resp.headers.get("content-type") ?? "";
    if (type && !type.startsWith("image/")) return false;
    const buf = await resp.arrayBuffer();
    if (!buf.byteLength || buf.byteLength > MAX_IMAGE_BYTES) return false;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, Buffer.from(buf));
    return true;
  } catch {
    return false;
  }
}

// ── Git ──
//
// Resolution starts at the member's own garden, never at the gardens root:
// gardens are one repo per member, because git's unit of access is the
// repository — a single repo over all of them would hand every member everyone
// else's notes. Falls back to the root so a dev checkout with one repo over the
// whole tree still commits. Mirrors _gardens_git_root in the MCP tool.

function gitRoot(gardenRootPath: string): string | null {
  for (const cwd of [gardenRootPath, gardensRoot()]) {
    try {
      if (!fs.existsSync(cwd)) continue;
      const out = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf-8" });
      if (out.status === 0 && out.stdout.trim()) return out.stdout.trim();
    } catch {
      continue;
    }
  }
  return null;
}

function hasRemote(root: string): boolean {
  const out = spawnSync("git", ["remote"], { cwd: root, encoding: "utf-8" });
  return out.status === 0 && !!out.stdout.trim();
}

/**
 * Commit (and push, when a remote exists) garden changes — only when the
 * gardens dir is a git repo. Outside one this is a no-op: the files are already
 * on disk, which is what matters.
 */
export function autoCommit(garden: GardenRef, paths: string[], message: string): void {
  const root = gitRoot(garden.root);
  if (!root) return;
  try {
    // Skip stray paths rather than aborting the whole commit on one of them.
    const rel = paths
      .map((p) => path.relative(root, p))
      .filter((p) => p && !p.startsWith(".."));
    if (!rel.length) return;
    spawnSync("git", ["add", "--", ...rel], { cwd: root });
    if (spawnSync("git", ["diff", "--cached", "--quiet"], { cwd: root }).status !== 0) {
      spawnSync("git", ["commit", "-m", message], { cwd: root });
      if (hasRemote(root)) spawnSync("git", ["push"], { cwd: root });
    }
  } catch (err) {
    console.warn("[garden] auto-commit failed:", (err as Error).message);
  }
}

// ── Web paths ──

/** French URL segment per collection, mirroring web/src/i18n/config.ts. */
const FR_SEGMENT: Record<string, string> = {
  books: "livres", articles: "articles", podcasts: "podcasts",
  movies: "films", games: "jeux", series: "series", people: "personnes",
};

/** Browser path of the fiche — /fiches is not locale-renamed, unlike resources. */
export function ficheWebPath(
  garden: GardenRef,
  collection: ResourceCollection,
  locale: string,
  slug: string,
): string {
  const prefix = locale === "en" ? "" : `/${locale}`;
  return `/g/${garden.username}${prefix}/fiches/${collection}/${slug}-fiche`;
}

export function cardWebPath(
  garden: GardenRef,
  collection: ResourceCollection,
  locale: string,
  slug: string,
): string {
  return locale === "fr"
    ? `/g/${garden.username}/fr/trouvailles/${FR_SEGMENT[collection] ?? collection}/${slug}`
    : `/g/${garden.username}/resources/${collection}/${slug}`;
}
