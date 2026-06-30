import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

const localeEnum = z.enum(["en", "fr"]).default("en");
const translationKey = z.string().optional();
const flagsSchema = z.array(z.enum(["public", "encrypted", "moc", "translation", "archived"])).default([]);

const devOnly = ["**/!(*-fiche).md"];
const devOnlyMdx = ["**/!(*-fiche).{md,mdx}"];

// Every content collection lives under the member's garden (gardens/<member>/).
// Defaults to the bundled `demo` garden so a plain build/dev renders out of the box.
const member = process.env.GARDEN || "demo";
const gardenRoot = `./gardens/${member}`;
const notesBase = `${gardenRoot}/notes`;
const pagesBase = `${gardenRoot}/pages`;

const fichesPattern = process.env.NODE_ENV === "production"
  ? "___noop___"
  : ["{books,articles,movies,series,podcasts,people}/**/*-fiche.md"];

const books = defineCollection({
  loader: glob({ pattern: devOnly, base: `${gardenRoot}/books` }),
  schema: z.object({
    title: z.string(),
    author: z.string(),
    date_read: z.coerce.date(),
    status: z.enum(["read", "reading", "abandoned"]),
    tags: z.array(z.string()).default([]),
    flags: flagsSchema,
    rating: z.number().min(1).max(5).optional(),
    image: z.string().optional(),
    shared_twitter: z.boolean().default(false),
    shared_linkedin: z.boolean().default(false),
    shared_twitter_url: z.string().url().optional(),
    shared_linkedin_urn: z.string().optional(),
    locale: localeEnum,
    translationKey: translationKey,
  }),
});

const articles = defineCollection({
  loader: glob({ pattern: devOnly, base: `${gardenRoot}/articles` }),
  schema: z.object({
    title: z.string(),
    author: z.string().optional(),
    source: z.string(),
    url: z.string().url(),
    date_read: z.coerce.date(),
    status: z.enum(["inbox", "read", "archive", "discarded"]).default("inbox"),
    tags: z.array(z.string()).default([]),
    flags: flagsSchema,
    image: z.string().optional(),
    shared_twitter: z.boolean().default(false),
    shared_linkedin: z.boolean().default(false),
    shared_twitter_url: z.string().url().optional(),
    shared_linkedin_urn: z.string().optional(),
    locale: localeEnum,
    translationKey: translationKey,
  }),
});

const blog = defineCollection({
  loader: glob({ pattern: devOnly, base: `${gardenRoot}/blog` }),
  schema: z.object({
    title: z.string(),
    date: z.coerce.date(),
    tags: z.array(z.string()).default([]),
    flags: flagsSchema,
    description: z.string().optional(),
    image: z.string().optional(),
    shared_twitter: z.boolean().default(false),
    shared_linkedin: z.boolean().default(false),
    shared_twitter_url: z.string().url().optional(),
    shared_linkedin_urn: z.string().optional(),
    locale: localeEnum,
    translationKey: translationKey,
  }),
});

const essays = defineCollection({
  loader: glob({ pattern: devOnlyMdx, base: `${gardenRoot}/essays` }),
  schema: z.object({
    title: z.string(),
    date: z.coerce.date(),
    last_updated: z.coerce.date().optional(),
    tags: z.array(z.string()).default([]),
    section: z.string(),
    flags: flagsSchema,
    description: z.string().optional(),
    image: z.string().optional(),
    shared_twitter: z.boolean().default(false),
    shared_linkedin: z.boolean().default(false),
    shared_twitter_url: z.string().url().optional(),
    shared_linkedin_urn: z.string().optional(),
    locale: localeEnum,
    translationKey: translationKey,
  }),
});

const podcasts = defineCollection({
  loader: glob({ pattern: devOnly, base: `${gardenRoot}/podcasts` }),
  schema: z.object({
    title: z.string(),
    host: z.string().optional(),
    url: z.string().url().optional(),
    date_listened: z.coerce.date(),
    tags: z.array(z.string()).default([]),
    flags: flagsSchema,
    image: z.string().optional(),
    shared_twitter: z.boolean().default(false),
    shared_linkedin: z.boolean().default(false),
    shared_twitter_url: z.string().url().optional(),
    shared_linkedin_urn: z.string().optional(),
    locale: localeEnum,
    translationKey: translationKey,
    show: z.string().optional(),
    episode_title: z.string().optional(),
    episode_number: z.number().optional(),
    season: z.number().optional(),
    guests: z.array(z.string()).default([]),
  }),
});

const movies = defineCollection({
  loader: glob({ pattern: devOnly, base: `${gardenRoot}/movies` }),
  schema: z.object({
    title: z.string(),
    director: z.string().optional(),
    year: z.number().optional(),
    date_watched: z.coerce.date(),
    tags: z.array(z.string()).default([]),
    flags: flagsSchema,
    rating: z.number().min(1).max(5).optional(),
    image: z.string().optional(),
    shared_twitter: z.boolean().default(false),
    shared_linkedin: z.boolean().default(false),
    shared_twitter_url: z.string().url().optional(),
    shared_linkedin_urn: z.string().optional(),
    locale: localeEnum,
    translationKey: translationKey,
  }),
});

const series = defineCollection({
  loader: glob({ pattern: devOnly, base: `${gardenRoot}/series` }),
  schema: z.object({
    title: z.string(),
    platform: z.string().optional(),
    seasons_watched: z.number().optional(),
    status: z.enum(["watching", "watched", "abandoned"]).default("watched"),
    date_watched: z.coerce.date(),
    tags: z.array(z.string()).default([]),
    flags: flagsSchema,
    rating: z.number().min(1).max(5).optional(),
    image: z.string().optional(),
    shared_twitter: z.boolean().default(false),
    shared_linkedin: z.boolean().default(false),
    shared_twitter_url: z.string().url().optional(),
    shared_linkedin_urn: z.string().optional(),
    locale: localeEnum,
    translationKey: translationKey,
    show: z.string().optional(),
    episode_title: z.string().optional(),
    episode_number: z.number().optional(),
    season: z.number().optional(),
  }),
});

const notes = defineCollection({
  loader: glob({ pattern: devOnlyMdx, base: notesBase }),
  schema: z.object({
    title: z.string(),
    date: z.coerce.date(),
    tags: z.array(z.string()).default([]),
    flags: flagsSchema,
    description: z.string().optional(),
    status: z.enum(["proposed", "ready", "in_progress", "review", "done"]).optional(),
    order: z.number().int().optional(),
    image: z.string().optional(),
    icon: z.string().optional(),
    locale: localeEnum,
    translationKey: translationKey,
  }),
});

const pages = defineCollection({
  loader: glob({ pattern: devOnly, base: pagesBase }),
  schema: z.object({
    title: z.string().optional(),
    description: z.string().optional(),
    locale: localeEnum,
    translationKey: translationKey,
    flags: flagsSchema,
  }),
});

const people = defineCollection({
  loader: glob({ pattern: devOnly, base: `${gardenRoot}/people` }),
  schema: z.object({
    name: z.string(),
    role: z.string().optional(),
    url: z.string().url().optional(),
    tags: z.array(z.string()).default([]),
    flags: flagsSchema,
    image: z.string().optional(),
    locale: localeEnum,
    translationKey: translationKey,
  }),
});

const fiches = defineCollection({
  loader: glob({ pattern: fichesPattern, base: gardenRoot }),
  schema: z.object({
    title: z.string(),
    resource_collection: z.enum(["books", "articles", "movies", "series", "podcasts", "people"]),
    resource_id: z.string(),
    date: z.coerce.date(),
    tags: z.array(z.string()).default([]),
    locale: localeEnum,
    // Pre-fetched metadata (populated at creation, used by promote_fiche)
    meta: z.record(z.unknown()).optional(),
    // CardDAV contact UID (links fiche to a personal contact)
    carddav_uid: z.string().optional(),
  }),
});

export const collections = { books, articles, blog, essays, notes, podcasts, movies, series, people, pages, fiches };
