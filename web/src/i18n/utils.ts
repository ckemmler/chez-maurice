import { defaultLocale, routeMap, reverseRouteMap, type Locale } from "./config";
import { ui } from "./ui";

/**
 * Look up a UI string by locale and key.
 */
export function t(locale: Locale, key: string): string {
  return ui[locale][key] ?? ui[defaultLocale][key] ?? key;
}

/**
 * Get the locale from a URL path.
 */
export function getLocaleFromPath(path: string): Locale {
  const segments = path.split("/").filter(Boolean);
  if (segments[0] === "fr") return "fr";
  return "en";
}

/**
 * Translate an English path to a localized path.
 * e.g. localizedPath("fr", "/resources/books") → "/fr/trouvailles/livres"
 * e.g. localizedPath("en", "/resources/books") → "/resources/books"
 */
export function localizedPath(locale: Locale, enPath: string): string {
  if (locale === "en") return enPath;

  const segments = enPath.split("/").filter(Boolean);
  const translated = segments.map((seg) => routeMap[seg] ?? seg);
  return `/fr/${translated.join("/")}`;
}

/**
 * Get the alternate locale path for language switching.
 * e.g. getAlternatePath("/fr/trouvailles/livres") → "/resources/books"
 * e.g. getAlternatePath("/resources/books") → "/fr/trouvailles/livres"
 */
export function getAlternatePath(currentPath: string): string {
  // Strip .html extension if present (build format: "file")
  const cleanPath = currentPath.replace(/\.html$/, "");
  const segments = cleanPath.split("/").filter(Boolean);

  if (segments[0] === "fr") {
    // French → English: remove "fr" prefix and reverse-translate segments
    const frSegments = segments.slice(1);
    const enSegments = frSegments.map((seg) => reverseRouteMap[seg] ?? seg);
    return `/${enSegments.join("/")}` || "/";
  } else {
    // English → French: add "fr" prefix and translate segments
    const frSegments = segments.map((seg) => routeMap[seg] ?? seg);
    return `/fr/${frSegments.join("/")}` || "/fr";
  }
}

/**
 * Format a date according to locale.
 */
export function formatDate(date: Date, locale: Locale, options?: Intl.DateTimeFormatOptions): string {
  const defaultOptions: Intl.DateTimeFormatOptions = { year: "numeric", month: "short" };
  const localeStr = locale === "fr" ? "fr-FR" : "en-US";
  return date.toLocaleDateString(localeStr, options ?? defaultOptions);
}

/**
 * Format a full date (with day) according to locale.
 */
export function formatFullDate(date: Date, locale: Locale): string {
  return formatDate(date, locale, { year: "numeric", month: "long", day: "numeric" });
}

/**
 * Format a short date (month + year) according to locale.
 */
export function formatShortDate(date: Date, locale: Locale): string {
  return formatDate(date, locale, { year: "numeric", month: "short" });
}

/**
 * Get the base path for a resource type in the given locale.
 */
export function resourcePath(locale: Locale, resource: string): string {
  return localizedPath(locale, `/resources/${resource}`);
}

/**
 * Get the detail path for a resource item.
 */
export function resourceItemPath(locale: Locale, resource: string, id: string): string {
  return localizedPath(locale, `/resources/${resource}/${stripLocalePrefix(id)}`);
}

/**
 * Strip the locale subdirectory prefix from a content collection ID.
 * e.g. "en/hello-world" → "hello-world", "fr/bonjour" → "bonjour"
 */
export function stripLocalePrefix(id: string): string {
  return id.replace(/^(en|fr)\//, "");
}
