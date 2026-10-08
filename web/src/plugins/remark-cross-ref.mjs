import fs from "node:fs";
import path from "node:path";
import { visit } from "unist-util-visit";

const ROUTE_MAP = {
  en: {
    film: "/resources/movies",
    movie: "/resources/movies",
    game: "/resources/games",
    album: "/resources/music",
    music: "/resources/music",
    series: "/resources/series",
    book: "/resources/books",
    article: "/resources/articles",
    podcast: "/resources/podcasts",
    person: "/resources/people",
    essay: "/essays",
    blog: "/blog",
    note: "/notes",
  },
  fr: {
    film: "/trouvailles/films",
    movie: "/trouvailles/films",
    game: "/trouvailles/jeux",
    album: "/trouvailles/musique",
    music: "/trouvailles/musique",
    series: "/trouvailles/series",
    book: "/trouvailles/livres",
    article: "/trouvailles/articles",
    podcast: "/trouvailles/podcasts",
    person: "/trouvailles/personnes",
    essay: "/essais",
    blog: "/blog",
    note: "/notes",
  },
};

const CROSS_REF_RE = /^([a-z]+):([a-z0-9-]+)$/;

// Matches [[note-id]] or [[note-id|Display Text]]
const WIKI_LINK_RE = /\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g;

// ── Garden-wide wiki-link resolution ──
//
// [[target]] used to mean "a note" unconditionally. Now that Maurice and
// Carnet write [[wiki-links]] to fiches and cards across every collection
// (the Résonances flow), a link resolves the way Obsidian resolves it: by
// file basename anywhere in the vault. A scan of the garden builds
// basename → {collection, locale, slug, isFiche}; unresolved targets keep
// the historical /notes/ fallback so nothing that worked before breaks.

/** Collection directory → URL path per locale (cards; fiches go to /fiches). */
const COLLECTION_PATH = {
  en: {
    books: "/resources/books", articles: "/resources/articles", movies: "/resources/movies",
    games: "/resources/games", music: "/resources/music", series: "/resources/series", podcasts: "/resources/podcasts",
    people: "/resources/people", essays: "/essays", blog: "/blog", notes: "/notes",
  },
  fr: {
    books: "/trouvailles/livres", articles: "/trouvailles/articles", movies: "/trouvailles/films",
    games: "/trouvailles/jeux", music: "/trouvailles/musique", series: "/trouvailles/series", podcasts: "/trouvailles/podcasts",
    people: "/trouvailles/personnes", essays: "/essais", blog: "/blog", notes: "/notes",
  },
};

const GARDEN_COLLECTIONS = Object.keys(COLLECTION_PATH.en);

const IN_GARDEN = new RegExp(`^(.*)/(?:${GARDEN_COLLECTIONS.join("|")})/(?:en|fr)/[^/]+\\.mdx?$`);

/** The garden a file belongs to, read off its own path
 *  (`<garden>/<collection>/<locale>/<file>.md`). One engine serves every
 *  member of a household (docs/garden-server-mode.md), so the GARDEN
 *  environment variable names nobody in particular there: going by it, every
 *  link written in a member's garden was looked up in the default one, found
 *  nothing, and fell back to /notes/ — a fiche in people/ then led nowhere
 *  (6 October 2026). The variable is the fallback for a file outside any
 *  garden, as before. */
function gardenDir(filePath) {
  const m = String(filePath ?? "").split(path.sep).join("/").match(IN_GARDEN);
  if (m) return m[1];
  const root = process.env.MAURICE_GARDENS_DIR || path.join(process.cwd(), "gardens");
  return path.join(root, process.env.GARDEN || "demo");
}

const _indexes = new Map(); // garden dir → { at, map: Map<basename, [{collection, locale, slug, isFiche}]> }
const INDEX_TTL_MS = 5000;

/** basename → entries, per garden. Rebuilt at most every few seconds; an MCP
 *  or Carnet write shows up on the next render without restarting the engine. */
function wikiIndex(dir) {
  const cached = _indexes.get(dir);
  if (cached && Date.now() - cached.at < INDEX_TTL_MS) return cached.map;
  const map = new Map();
  for (const collection of GARDEN_COLLECTIONS) {
    for (const locale of ["en", "fr"]) {
      let files;
      try {
        files = fs.readdirSync(path.join(dir, collection, locale));
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.endsWith(".md")) continue;
        const basename = f.slice(0, -3);
        const isFiche = basename.endsWith("-fiche");
        const slug = isFiche ? basename.slice(0, -"-fiche".length) : basename;
        const list = map.get(basename) ?? [];
        list.push({ collection, locale, slug, isFiche });
        map.set(basename, list);
      }
    }
  }
  _indexes.set(dir, { at: Date.now(), map });
  return map;
}

/** URL for a [[target]] seen from a file in `locale`, or null if unknown. */
export function resolveWikiTarget(target, locale, filePath) {
  const hits = wikiIndex(gardenDir(filePath)).get(target);
  if (!hits?.length) return null;
  // Prefer the reader's locale; fall back to whichever locale has the file.
  const hit = hits.find((h) => h.locale === locale) ?? hits[0];
  const prefix = hit.locale === "en" ? "" : `/${hit.locale}`;
  if (hit.isFiche) {
    return { url: `${prefix}/fiches/${hit.collection}/${target}`, hit };
  }
  const base = (COLLECTION_PATH[hit.locale] || COLLECTION_PATH.en)[hit.collection];
  if (!base) return null;
  return { url: `${prefix}${base}/${hit.slug}`, hit };
}

export default function remarkCrossRef() {
  return (tree, file) => {
    // Resolve locale from file path (e.g. .../notes/fr/foo.md → fr)
    const filePath = file.history?.[0] ?? "";
    // Match locale from path — /fr/ or /en/ anywhere in the file path
    const localeMatch = filePath.match(/\/(fr|en)\//);
    const locale = localeMatch?.[1] ?? "en";
    const prefix = locale === "en" ? "" : `/${locale}`;

    // 1. Transform cross-ref links (e.g. note:foo-bar)
    visit(tree, "link", (node) => {
      // A source the mail pass cites, `maurice-mail:<id>`: the server's page
      // for that message, in a new tab (server/src/routes/people.ts).
      if (typeof node.url === "string" && node.url.startsWith("maurice-mail:")) {
        node.url = `/api/people/mail/${node.url.slice("maurice-mail:".length)}`;
        node.data ??= {};
        node.data.hProperties ??= {};
        Object.assign(node.data.hProperties, { class: "mail-source", target: "_blank", rel: "noopener" });
        return;
      }
      const match = CROSS_REF_RE.exec(node.url);
      if (!match) return;

      const [, collection, slug] = match;
      const routes = ROUTE_MAP[locale] || ROUTE_MAP.en;
      const base = routes[collection];
      if (!base) return;

      node.url = `${prefix}${base}/${slug}`;
      node.data ??= {};
      node.data.hProperties ??= {};
      Object.assign(node.data.hProperties, {
        class: `cross-ref cross-ref--${collection}`,
        "data-ref-type": collection,
        "data-ref-slug": slug,
      });
    });

    // 2. Transform [[wiki-links]] in text nodes
    visit(tree, "text", (node, index, parent) => {
      if (!parent || index == null) return;

      const value = node.value;
      if (!value.includes("[[")) return;

      const children = [];
      let lastIndex = 0;

      for (const match of value.matchAll(WIKI_LINK_RE)) {
        const [full, target, displayText] = match;
        const start = match.index;

        // Text before the wiki-link
        if (start > lastIndex) {
          children.push({ type: "text", value: value.slice(lastIndex, start) });
        }

        // The wiki-link itself — resolved by basename across the whole garden
        // (Obsidian semantics); an unknown target keeps the old /notes/ guess.
        const resolved = resolveWikiTarget(target, locale, filePath);
        children.push({
          type: "link",
          url: resolved ? resolved.url : `${prefix}/notes/${target}`,
          children: [{ type: "text", value: displayText || target }],
          data: {
            hProperties: {
              class: "wiki-link",
              "data-ref-type": resolved ? resolved.hit.collection : "note",
              "data-ref-slug": resolved ? resolved.hit.slug : target,
            },
          },
        });

        lastIndex = start + full.length;
      }

      if (children.length === 0) return;

      // Remaining text after last match
      if (lastIndex < value.length) {
        children.push({ type: "text", value: value.slice(lastIndex) });
      }

      // Replace this text node with the new children
      parent.children.splice(index, 1, ...children);
    });
  };
}
