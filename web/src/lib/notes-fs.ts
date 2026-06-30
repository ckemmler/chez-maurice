// Disk-backed notes reader — the garden's SSR source of truth.
//
// We deliberately do NOT go through Astro's experimental content layer
// (`getCollection("notes")`) for the live member-garden engine. Under rapid
// edits from the garden MCP tool, the glob-loader store intermittently
// collapses the collection to "empty" and never recovers until the dev server
// is restarted — which is exactly the "all my notes are gone / not found
// everywhere" meltdown. Reading the `.md` files straight off disk at request
// time has no store to corrupt: a note exists iff its file exists, and a single
// malformed note is skipped rather than taking the whole collection down.
//
// Rendering fidelity is preserved by running the same markdown pipeline Astro
// uses (`createMarkdownProcessor` + the `remarkCrossRef` plugin + the
// github-dark shiki theme), and by handing the plugin the file path so its
// locale detection (/en/ vs /fr/) keeps working.
import fs from "node:fs";
import path from "node:path";
import {
  createMarkdownProcessor,
  parseFrontmatter,
  type MarkdownProcessor,
} from "@astrojs/markdown-remark";
import remarkCrossRef from "@app/plugins/remark-cross-ref.mjs";
import { notesDir } from "@app/lib/garden";

export interface NoteData {
  title: string;
  date: Date;
  tags: string[];
  flags: string[];
  description?: string;
  status?: string;
  order?: number;
  image?: string;
  icon?: string;
  locale: string;
  translationKey?: string;
  // Notes carry extra frontmatter keys (e.g. `parent`) the schema drops; we
  // keep them so nothing silently disappears.
  [key: string]: unknown;
}

export interface NoteEntry {
  /** "<locale>/<slug>" — matches the old content-collection entry id. */
  id: string;
  /** slug only (no locale prefix). */
  slug: string;
  collection: "notes";
  data: NoteData;
  /** Raw markdown body (frontmatter stripped). */
  body: string;
  /** Rendered HTML — present only for `getNote` (lazy: list views skip it). */
  html?: string;
}

let _processor: Promise<MarkdownProcessor> | null = null;
function processor(): Promise<MarkdownProcessor> {
  _processor ??= createMarkdownProcessor({
    shikiConfig: { theme: "github-dark" },
    remarkPlugins: [remarkCrossRef],
  });
  return _processor;
}

/** Parse a note file's text into frontmatter data + raw body, or null if bad. */
function parseNote(text: string, id: string): { data: NoteData; body: string } | null {
  let raw: Record<string, unknown>;
  let body: string;
  try {
    const parsed = parseFrontmatter(text);
    raw = parsed.frontmatter as Record<string, unknown>;
    body = parsed.content;
  } catch {
    return null;
  }
  if (typeof raw.title !== "string") return null;

  const slug = id.includes("/") ? id.slice(id.indexOf("/") + 1) : id;
  const locale = typeof raw.locale === "string" ? raw.locale : id.split("/")[0] || "en";

  // Coerce the few fields views rely on; keep everything else as-authored.
  const data: NoteData = {
    ...raw,
    title: raw.title,
    date: raw.date ? new Date(raw.date as string) : new Date(0),
    tags: Array.isArray(raw.tags) ? (raw.tags as string[]) : [],
    flags: Array.isArray(raw.flags) ? (raw.flags as string[]) : [],
    locale,
  };
  return { data, body };
}

/** Absolute path to a locale's notes directory (gardens/<member>/notes/<locale>). */
function localeDir(locale: string): string {
  return path.join(notesDir(), locale);
}

/**
 * All notes for a locale, as lightweight entries (no rendered HTML). Reads the
 * directory fresh on every call so an MCP edit is visible immediately. A note
 * that fails to parse is skipped, not fatal.
 */
export function listNotes(locale: string): NoteEntry[] {
  const dir = localeDir(locale);
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: NoteEntry[] = [];
  for (const f of files) {
    if (!f.endsWith(".md") || f.endsWith("-fiche.md")) continue;
    const slug = f.slice(0, -3);
    const id = `${locale}/${slug}`;
    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, f), "utf8");
    } catch {
      continue;
    }
    const parsed = parseNote(text, id);
    if (!parsed) {
      console.warn(`[notes-fs] skipping unparseable note: ${id}`);
      continue;
    }
    out.push({ id, slug, collection: "notes", data: parsed.data, body: parsed.body });
  }
  return out;
}

/** All notes across both locales (lightweight, no HTML). */
export function listAllNotes(): NoteEntry[] {
  return [...listNotes("en"), ...listNotes("fr")];
}

/**
 * One note, fully rendered (HTML included). Returns null if the file is missing
 * or unparseable. `fileURL` is passed to the markdown processor so remarkCrossRef
 * can detect the locale from the path.
 */
export async function getNote(locale: string, slug: string): Promise<NoteEntry | null> {
  const file = path.join(localeDir(locale), `${slug}.md`);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const id = `${locale}/${slug}`;
  const parsed = parseNote(text, id);
  if (!parsed) return null;
  const { code } = await (await processor()).render(parsed.body, { fileURL: file });
  return {
    id,
    slug,
    collection: "notes",
    data: parsed.data,
    body: parsed.body,
    html: code,
  };
}
