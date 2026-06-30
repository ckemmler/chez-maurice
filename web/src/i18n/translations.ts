import { getCollection } from "astro:content";
import type { Locale } from "./config";
import { stripLocalePrefix, localizedPath } from "./utils";

type ContentCollection =
  | "blog"
  | "essays"
  | "books"
  | "articles"
  | "podcasts"
  | "movies"
  | "series"
  | "people"
  | "pages";

const resourceCollections = new Set([
  "books",
  "articles",
  "podcasts",
  "movies",
  "series",
  "people",
]);

/**
 * Look up the alternate-locale URL for a content entry.
 * Returns the full path (e.g. "/fr/blog/jai-une-vie-aussi") or null if no counterpart exists.
 */
export async function getAlternateContentPath(
  collection: ContentCollection,
  translationKey: string | undefined,
  currentLocale: Locale
): Promise<string | null> {
  if (!translationKey) return null;

  const targetLocale: Locale = currentLocale === "en" ? "fr" : "en";

  const entries = await getCollection(collection, ({ data }: any) => {
    return data.translationKey === translationKey && data.locale === targetLocale;
  });

  if (entries.length === 0) return null;

  const counterpart = entries[0];
  const slug = stripLocalePrefix(counterpart.id);

  if (collection === "blog") {
    return localizedPath(targetLocale, `/blog/${slug}`);
  }

  if (collection === "essays") {
    return localizedPath(targetLocale, `/essays/${slug}`);
  }

  if (resourceCollections.has(collection)) {
    return localizedPath(targetLocale, `/resources/${collection}/${slug}`);
  }

  // Pages have hardcoded routes — return null and let page components handle it
  return null;
}
