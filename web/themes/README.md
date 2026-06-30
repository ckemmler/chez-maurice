# Themes

A **theme** is a folder of presentation files — layouts, styles, tokens, and
per-page-type view templates. It is completely separate from content (the
gardens). Switching themes is just **pointing the build at a different folder**;
the content, routing, i18n, and privacy engine never change.

> **Authoring a new theme?** See [`AUTHORING.md`](./AUTHORING.md) for the full
> contract (token surface, view list + fallback, `theme.json` `kind`) and the
> brief template to hand a designer / Claude Design.

`default` is the neutral base + shared fallback (a `garden`-kind theme); other
themes override its tokens and views and inherit the rest. (`candide` — the
full-`site` reference — is private and overlaid in, not shipped publicly.)

## How selection works

`astro.config.mjs` defines two Vite aliases:

- **`@theme`** → `themes/<THEME>` where `THEME` is the env var (default `default`).
- **`@app`** → `src` (the engine: content config, i18n, privacy, shared chrome).

So `THEME=manuscript astro build` resolves every `@theme/...` import against
`themes/manuscript/` instead of `themes/default/`. Everyday/dynamic per-request
switching (SSR) will swap this static alias for a runtime registry — same idea,
chosen later than build time.

## What a theme owns (today)

- `theme.json` — id, name, author, description.
- `global.css` — the token set (`--color-*`, `--font-*`, spacing) + base typography.
- `layouts/Base.astro` — the page shell: `<head>`, fonts, dark-mode script, the
  chrome it includes, and the body structure. It receives `{ title, description,
  locale, alternatePath }` and renders the page into its default `<slot/>`.

Themes pull engine pieces (content, i18n utils, shared chrome like `Nav`) from
`@app/...`. As we migrate per-page-type templates, themes will gain a `views/`
folder (Home, ProseDetail, CollectionIndex, MediaDetail, …), each resolved the
same way via `@theme/views/...`.

## Authoring a new theme

1. Copy `themes/default/` to `themes/<your-id>/`.
2. Edit `theme.json`, `global.css`, and `layouts/Base.astro` (and later `views/`).
3. Build it: `THEME=<your-id> npm run build` (or run dev with `THEME` set).

`src/layouts/Base.astro` is a one-line shim that renders `@theme/layouts/Base.astro`
— no page or engine file needs to change to add a theme.
