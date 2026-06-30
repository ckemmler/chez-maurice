import { getCollection } from "astro:content";
import type { Locale } from "../i18n/config";
import { localizedPath, resourceItemPath, stripLocalePrefix } from "../i18n/utils";
import { isPublic, isEncrypted, isMoc as isMocFlag } from "../lib/flags";
import { listNotes } from "../lib/notes-fs";

export interface SearchEntry {
  id: string;
  title: string;
  collection: string;
  tags: string[];
  description?: string;
  url: string;
  public: boolean;
  private?: boolean;
  isMoc?: boolean;
  author?: string;
}

export async function buildSearchIndex(locale: Locale): Promise<SearchEntry[]> {
  const isDev = import.meta.env.DEV;
  const entries: SearchEntry[] = [];

  // Blog
  const blogPosts = await getCollection("blog", ({ data }) =>
    data.locale === locale && (isDev || isPublic(data))
  );
  for (const post of blogPosts) {
    entries.push({
      id: post.id,
      title: post.data.title,
      collection: "blog",
      tags: post.data.tags,
      description: post.data.description,
      url: localizedPath(locale, `/blog/${stripLocalePrefix(post.id)}`),
      public: isPublic(post.data),
    });
  }

  // Essays
  const essayPosts = await getCollection("essays", ({ data }) =>
    data.locale === locale && (isDev || isPublic(data))
  );
  for (const post of essayPosts) {
    entries.push({
      id: post.id,
      title: post.data.title,
      collection: "essays",
      tags: post.data.tags,
      description: post.data.description,
      url: localizedPath(locale, `/essays/${stripLocalePrefix(post.id)}`),
      public: isPublic(post.data),
    });
  }

  // Notes — read from disk (not the content layer) so the index never empties
  // out when the glob-loader store collapses during a burst of MCP edits.
  const noteEntries = listNotes(locale).filter((n) => isDev || isPublic(n.data));
  for (const note of noteEntries) {
    entries.push({
      id: note.id,
      title: note.data.title,
      collection: "notes",
      tags: note.data.tags,
      description: note.data.description,
      url: localizedPath(locale, `/notes/${stripLocalePrefix(note.id)}`),
      public: isPublic(note.data),
      private: isEncrypted(note.data),
      isMoc: isMocFlag(note.data),
    });
  }

  // Resource collections
  const resourceCollections = ["books", "articles", "podcasts", "movies", "series", "people"] as const;
  for (const col of resourceCollections) {
    const items = await getCollection(col, ({ data }) =>
      (data as any).locale === locale && (isDev || isPublic(data as any))
    );
    for (const item of items) {
      const data = item.data as any;
      const title = col === "people" ? data.name : data.title;
      entries.push({
        id: item.id,
        title,
        collection: col,
        tags: data.tags ?? [],
        url: resourceItemPath(locale, col, item.id),
        public: isPublic(data),
        author: data.author,
      });
    }
  }

  // Fiches (dev-only)
  if (isDev) {
    const fiches = await getCollection("fiches", ({ data }) =>
      data.locale === locale
    );
    for (const fiche of fiches) {
      entries.push({
        id: fiche.id,
        title: fiche.data.title,
        collection: "fiches",
        tags: fiche.data.tags ?? [],
        url: `${locale === "en" ? "" : `/${locale}`}/fiches/${fiche.id.replace(/\/(fr|en)\//, "/")}`,
        public: false,
      });
    }
  }

  return entries;
}
