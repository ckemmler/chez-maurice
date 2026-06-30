export const defaultLocale = "en" as const;
export const locales = ["en", "fr"] as const;
export type Locale = (typeof locales)[number];

// Maps English path segments to French equivalents
export const routeMap: Record<string, string> = {
  resources: "trouvailles",
  books: "livres",
  articles: "articles",
  podcasts: "podcasts",
  movies: "films",
  series: "series",
  people: "personnes",
  essays: "essais",
  notes: "notes",
  fiches: "fiches",
  about: "a-propos",
  milestones: "jalons",
  blog: "blog",
};

// Reverse map: French → English
export const reverseRouteMap: Record<string, string> = Object.fromEntries(
  Object.entries(routeMap).map(([en, fr]) => [fr, en])
);
