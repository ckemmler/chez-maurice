import fs from "node:fs";
import path from "node:path";
import { notesDir } from "./garden";

export interface SubtreeNode {
  slug: string;
  title: string;
  isMoc: boolean;
  icon?: string;
  url: string;
  missing?: boolean;
  children: SubtreeNode[];
}

const WIKI_RE = /\[\[([a-z0-9-]+)(?:\|[^\]]+)?\]\]/g;

interface Frontmatter {
  title: string;
  flags: string[];
  isMoc: boolean;
  icon?: string;
}

function parseFlags(val: string): string[] {
  // Flow style: [public, moc, encrypted]
  const flow = val.match(/^\[([^\]]*)\]$/);
  if (flow) {
    return flow[1].split(",").map(s => s.trim()).filter(Boolean);
  }
  return [];
}

function parseFrontmatter(raw: string): { fm: Frontmatter; body: string } | null {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return null;
  const lines = match[1].split("\n");
  let title = "";
  let flags: string[] = [];
  let icon: string | undefined;
  for (const line of lines) {
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (!kv) continue;
    const [, key, val] = kv;
    if (key === "title") title = val.replace(/^["']|["']$/g, "");
    else if (key === "flags") flags = parseFlags(val.trim());
    else if (key === "icon") icon = val.replace(/^["']|["']$/g, "").trim();
  }
  // Also handle block-style flags (- moc)
  const blockFlagsMatch = match[1].match(/^flags:\s*\n((?:\s*-\s*.+\n?)*)/m);
  if (blockFlagsMatch) {
    flags = blockFlagsMatch[1].match(/^\s*-\s*(.+)$/gm)?.map(l => l.replace(/^\s*-\s*/, "").trim()) ?? [];
  }
  const isMoc = flags.includes("moc");
  return { fm: { title, flags, isMoc, icon: icon || undefined }, body: match[2] };
}

function resolveFile(contentBase: string, locale: string, slug: string): string | null {
  for (const ext of [".md", ".mdx"]) {
    const p = path.join(contentBase, locale, `${slug}${ext}`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function buildNode(
  slug: string,
  locale: string,
  contentBase: string,
  visited: Set<string>,
): SubtreeNode {
  if (visited.has(slug)) {
    return { slug, title: slug, isMoc: false, url: `/${locale}/notes/${slug}`, children: [] };
  }
  visited.add(slug);

  const filePath = resolveFile(contentBase, locale, slug);
  if (!filePath) {
    return { slug, title: slug, isMoc: false, url: `/${locale}/notes/${slug}`, missing: true, children: [] };
  }

  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = parseFrontmatter(raw);
  if (!parsed) {
    return { slug, title: slug, isMoc: false, url: `/${locale}/notes/${slug}`, children: [] };
  }

  const { fm, body } = parsed;
  const node: SubtreeNode = {
    slug,
    title: fm.title,
    isMoc: fm.isMoc,
    icon: fm.icon,
    url: `/${locale}/notes/${slug}`,
    children: [],
  };

  // Only recurse into children for MOCs
  if (fm.isMoc) {
    const childSlugs: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = WIKI_RE.exec(body)) !== null) {
      if (!childSlugs.includes(m[1])) childSlugs.push(m[1]);
    }
    node.children = childSlugs.map((s) => buildNode(s, locale, contentBase, visited));
  }

  return node;
}

export function scanSubtree(rootSlug: string, locale: string): SubtreeNode | null {
  const contentBase = notesDir();
  if (!resolveFile(contentBase, locale, rootSlug)) return null;
  return buildNode(rootSlug, locale, contentBase, new Set());
}

export function countNodes(node: SubtreeNode): number {
  return 1 + node.children.reduce((sum, c) => sum + countNodes(c), 0);
}
