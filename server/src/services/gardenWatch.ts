/**
 * Telling an open garden page that its note just changed.
 *
 * A garden is edited while you are reading it — by Maurice through the MCP
 * tool, by the owner in an editor, by the toolbar. Under `astro dev` the
 * browser learned about it through Vite's HMR socket, which is a development
 * feature the built engine does not have (and should not: it exists to push
 * changed *modules*, not content).
 *
 * So the server says it instead. One watcher per garden, shared by every
 * reader of it, publishing `{collection, locale, slug}` as a file changes.
 * Deliberately small: no diffing, no content, no ordering guarantees. A
 * missed event costs a manual refresh, which is why the whole thing may fail
 * to start (a platform without recursive watching) without anyone noticing
 * more than that.
 */
import fs from "node:fs";
import path from "node:path";
import { gardensRoot } from "./gardensRoot";

export interface GardenChange {
  /** "notes", "books", … — the directory under the garden. */
  collection: string;
  locale: string;
  /** The entry's slug, without extension. */
  slug: string;
}

type Listener = (change: GardenChange) => void;

const watchers = new Map<string, { watcher: fs.FSWatcher; listeners: Set<Listener> }>();

/**
 * Call `listener` whenever a markdown file in `member`'s garden changes.
 * Returns the unsubscribe function; the watcher closes with the last listener.
 */
export function watchGarden(member: string, listener: Listener): () => void {
  let entry = watchers.get(member);
  if (!entry) {
    const root = path.join(gardensRoot(), member);
    let watcher: fs.FSWatcher;
    try {
      watcher = fs.watch(root, { recursive: true, persistent: false });
    } catch (err) {
      // No recursive watch on this platform: the page simply does not
      // auto-refresh. Everything else works.
      console.warn(`[garden-watch] cannot watch ${member}:`, (err as Error).message);
      return () => {};
    }
    const listeners = new Set<Listener>();
    watcher.on("error", (err) => console.warn(`[garden-watch] ${member}:`, err.message));
    watcher.on("change", (_event, filename) => {
      const rel = typeof filename === "string" ? filename : filename?.toString();
      if (!rel) return;
      const change = parse(rel);
      if (!change) return;
      for (const l of listeners) {
        try { l(change); } catch { /* one bad listener must not stop the rest */ }
      }
    });
    entry = { watcher, listeners };
    watchers.set(member, entry);
  }
  entry.listeners.add(listener);
  return () => {
    const current = watchers.get(member);
    if (!current) return;
    current.listeners.delete(listener);
    if (current.listeners.size === 0) {
      try { current.watcher.close(); } catch {}
      watchers.delete(member);
    }
  };
}

/** "notes/en/nara-deer.md" → the change it describes, or null if not content. */
function parse(rel: string): GardenChange | null {
  if (!rel.endsWith(".md") && !rel.endsWith(".mdx")) return null;
  if (path.basename(rel).startsWith(".")) return null; // atomic-write temp file
  const parts = rel.split(path.sep);
  if (parts.length < 2) return null;
  const slug = path.basename(parts[parts.length - 1]!).replace(/\.mdx?$/, "");
  const collection = parts[0]!;
  const locale = parts.length >= 3 ? parts[1]! : "en";
  return { collection, locale, slug };
}
