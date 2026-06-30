# Authoring a Maurice theme

This is the brief to hand a designer (human or **Claude Design**) to create a new
theme. A theme is **presentation only** — fonts, colours, layout, and per-page
templates. It never touches content (the gardens), routing, i18n, or the privacy
engine. Switching themes is just selecting a different folder.

---

## What a theme is

A theme is a self-contained folder `themes/<id>/`:

```
themes/<id>/
  theme.json            # metadata (below)
  global.css            # design tokens + base typography
  layouts/Base.astro    # the page shell (<head>, fonts, chrome, body)
  views/*.astro         # per-page-type templates (optional — see fallback)
```

You implement only the files you want to restyle. **Anything you omit is
inherited from the `default` base theme** (`resolveView`/`resolveLayout` in
`src/lib/theme-registry.ts` fall back to `default`). So a lean garden theme can
be just `theme.json` + `global.css` + `layouts/Base.astro` + `views/Home.astro`
and still render every page.

## `theme.json`

```json
{
  "id": "<id>",            // must equal the folder name
  "name": "Human Name",
  "author": "...",
  "kind": "garden",        // "garden" | "site"  — see below
  "description": "One or two sentences on the look and intent."
}
```

- **`kind: "garden"`** — a digital-garden theme. The home/landing is the garden
  (the notes/wiki), not a full marketing homepage. This is what most people want.
- **`kind: "site"`** — a full personal website that lands on a composed home
  index (like `candide`, the private reference example).

## Design tokens (`global.css` `:root`)

Restyle by overriding this token set (light + `html.dark` variants). Keep the
names; the views and shared chrome read them.

```
--font-body, --font-heading, --font-sans, --font-mono
--color-text, --color-text-muted, --color-text-quiet
--color-bg, --color-bg-alt, --color-border, --color-link
--max-width            /* the reading measure, e.g. 48rem */
--spacing-xs … --spacing-xl
```

Dark mode is required: provide the `html.dark { … }` block and the
`@media (prefers-color-scheme: dark)` fallback (see `default/global.css`). If you
use a webfont, `@import` it at the top of `global.css` (the base uses the system
stack and ships none).

## `layouts/Base.astro`

The page shell. It receives `{ title, description, locale, alternatePath }`,
renders the page into its `<slot/>`, and must:

- set up `<head>` (title/description/fonts/dark-mode script),
- include the shared chrome from the engine — import `Nav` (and any shared
  widgets) from `@app/...`, never fork them,
- render `<slot/>` for the page body.

`@app` = the engine (`src/`); `@theme` = the active theme folder. Pull engine
pieces from `@app`, theme pieces are local.

## Views (`views/*.astro`)

The full set the base implements (override any subset):

```
Home
NotesList   NoteDetail
BlogList    BlogPost
EssaysList  EssayDetail
ResourcesHub
BooksList   BookDetail      ArticlesList  ArticleDetail
PodcastsList PodcastDetail  MoviesList    MovieDetail
SeriesList  SeriesDetail    PeopleList    PersonDetail
FichesList  FicheDetail
```

For a **garden theme**, restyling `Home` + `NotesList` + `NoteDetail` is usually
enough — inherit the rest. A **site theme** typically overrides most of them.

## Build, preview, switch

```sh
THEME=<id> npm run build      # static build pinned to one theme
npm run dev                   # then switch live with ?theme=<id> (SSR/dev)
```

`listThemes()` enumerates every theme with ≥1 view — that's the source for any
in-app theme switcher.

## References

- `themes/default/` — the neutral base (full view set). Start here; copy it if
  you want a full-coverage theme.
- `themes/manuscript/` — a **lean** theme example: just `theme.json` +
  `global.css` + `Base.astro` (no `views/`), inheriting every view from the base.
  The model to copy for a garden theme.

## Constraints (please respect)

- Touch only `themes/<id>/`. Do not edit `src/`, content, or other themes.
- Keep within the documented token set and the view names above.
- Dark mode must work. The build (`THEME=<id> npm run build`) must be clean.
- No external network calls beyond a font `@import`.

---

## Per-theme brief template

Fill one of these per theme you want and hand it over:

```
Theme id:        <kebab-id>
Name:            <human name>
Kind:            garden | site
Mood / intent:   <1–2 sentences>
Type:            heading font + body font (pairing)
Palette:         bg, text, link, accent (light) + dark-mode intent
Measure:         reading width (e.g. 46–60rem) + density
Masthead/Home:   <how the landing should feel>
Views to restyle: Home, NotesList, NoteDetail, …  (rest inherited)
```

For the first release we want **3–4 simple garden themes** (`kind: garden`),
visually distinct from each other and from `default`, each lean (tokens +
`Base` + `Home` + the Notes views), inheriting the rest from the base.
