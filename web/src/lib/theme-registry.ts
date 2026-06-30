// Runtime theme registry.
//
// Every theme's view + layout components are imported eagerly, so any of them can
// be rendered for a given request without a rebuild. The active theme is chosen
// per request (middleware → Astro.locals.theme, from a cookie or ?theme=), which
// is what makes live, per-reader theme switching possible in the dynamic (SSR/dev)
// mode. In a static publish there is no request, so it falls back to DEFAULT_THEME
// (the build-time THEME env) — the chosen theme baked in.

const viewMods = import.meta.glob("../../themes/*/views/*.astro", { eager: true });
const layoutMods = import.meta.glob("../../themes/*/layouts/*.astro", { eager: true });

type CompMap = Record<string, Record<string, any>>;

function index(mods: Record<string, unknown>): CompMap {
  const map: CompMap = {};
  for (const [p, mod] of Object.entries(mods)) {
    const m = p.match(/themes\/([^/]+)\/(?:views|layouts)\/([^/]+)\.astro$/);
    if (!m) continue;
    const [, theme, name] = m;
    (map[theme] ??= {})[name] = (mod as { default: unknown }).default;
  }
  return map;
}

const VIEWS = index(viewMods);
const LAYOUTS = index(layoutMods);

// The active theme when none is chosen. "default" is the hidden view-base, so a
// fresh garden falls back to a real garden theme, not the plain base.
export const DEFAULT_THEME =
  (typeof process !== "undefined" && process.env.THEME) || "manuscript";

/** The active theme's view (e.g. "NoteDetail"), falling back to default's. */
export function resolveView(theme: string | undefined, name: string) {
  const t = theme || DEFAULT_THEME;
  return VIEWS[t]?.[name] ?? VIEWS["default"]?.[name];
}

/** The active theme's layout (e.g. "Base"), falling back to default's. */
export function resolveLayout(theme: string | undefined, name: string) {
  const t = theme || DEFAULT_THEME;
  return LAYOUTS[t]?.[name] ?? LAYOUTS["default"]?.[name];
}

/** Theme ids that ship at least one view (for a switcher UI). */
export function listThemes(): string[] {
  return Object.keys(VIEWS).sort((a, b) => (a === "default" ? -1 : a.localeCompare(b)));
}

// Each theme.json declares a `kind`: "garden" (the home lands on the notes/garden
// index) or "site" (a full personal website with a composed hero home).
const metaMods = import.meta.glob("../../themes/*/theme.json", { eager: true });
const KINDS: Record<string, string> = {};
for (const [p, mod] of Object.entries(metaMods)) {
  const m = p.match(/themes\/([^/]+)\/theme\.json$/);
  if (m) KINDS[m[1]] = ((mod as any).default ?? mod)?.kind ?? "garden";
}

/** A theme's kind — "garden" (notes-index home) or "site" (hero home). */
export function themeKind(theme: string | undefined): string {
  return KINDS[theme || DEFAULT_THEME] ?? "garden";
}
