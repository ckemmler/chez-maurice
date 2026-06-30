import { visit } from "unist-util-visit";

const ROUTE_MAP = {
  en: {
    film: "/resources/movies",
    movie: "/resources/movies",
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

        // The wiki-link itself → becomes a link node to /notes/<target>
        children.push({
          type: "link",
          url: `${prefix}/notes/${target}`,
          children: [{ type: "text", value: displayText || target }],
          data: {
            hProperties: {
              class: "wiki-link",
              "data-ref-type": "note",
              "data-ref-slug": target,
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
