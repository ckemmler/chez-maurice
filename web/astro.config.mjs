// @ts-check
import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import remarkCrossRef from "./src/plugins/remark-cross-ref.mjs";
import devTools from "./src/integrations/dev-tools.ts";
import encryptPrivate from "./src/integrations/encrypt-private.ts";
import downloadImages from "./src/integrations/download-images.ts";

// Theme resolver: `@theme/<path>` → the active theme's file if it exists, else
// the default theme's (so a theme overrides views/layouts/styles selectively and
// inherits the rest). Rooted at process.cwd() so it works from a garden shell.
function themeResolver() {
  const active = process.env.THEME || "default";
  return {
    name: "maurice-theme-resolver",
    enforce: "pre",
    resolveId(id) {
      if (!id.startsWith("@theme/")) return null;
      const rel = id.slice("@theme/".length);
      const cwd = process.cwd();
      const inActive = resolve(cwd, "themes", active, rel);
      return existsSync(inActive) ? inActive : resolve(cwd, "themes", "default", rel);
    },
  };
}

// TLS certs (shared with the API server). Point MAURICE_TLS_CERT / MAURICE_TLS_KEY
// at a cert + key (e.g. `tailscale cert` or Let's Encrypt); falls back to plain HTTP.
const certsDir = resolve(import.meta.dirname, "..", "api", "certs");
const certFile = process.env.MAURICE_TLS_CERT || resolve(certsDir, "server.crt");
const keyFile = process.env.MAURICE_TLS_KEY || resolve(certsDir, "server.key");
const hasTls = existsSync(certFile) && existsSync(keyFile);

// https://astro.build/config
export default defineConfig({
  devToolbar: { enabled: false },
  integrations: [downloadImages(), devTools(), encryptPrivate()],
  site: process.env.SITE_URL || "http://localhost:4321",
  // A member's garden is served under /g/<member>/ on the private tunnel
  // (GARDEN_BASE); unset for Candide's tunnel and every public build, so
  // candide.me stays at root. Astro prefixes assets/routes; the rehype plugin
  // prefixes in-content links to match.
  base: process.env.GARDEN_BASE || undefined,
  // WEB_SSR=1 (the everyday/dynamic garden servers) renders per request so live
  // theme switching (?theme= / cookie) works; unset = static publish (a baked
  // theme). Content [id] pages are dual-mode: getStaticPaths for the static
  // build, a request-time param lookup under SSR.
  output: process.env.WEB_SSR === "1" ? "server" : "static",
  adapter: cloudflare(),
  // Per-member cache so concurrent engine instances don't race on the shared
  // node_modules/.astro + .vite dirs (an ENOTEMPTY crash otherwise). Candide
  // (no GARDEN) keeps the defaults; each member gets its own.
  cacheDir: process.env.GARDEN ? `./node_modules/.astro-${process.env.GARDEN}` : undefined,
  build: {
    format: "file", // Clean URLs: /about.html served as /about
  },
  markdown: {
    shikiConfig: {
      theme: "github-dark",
    },
    remarkPlugins: [remarkCrossRef],
  },
  vite: {
    plugins: [themeResolver()],
    cacheDir: process.env.GARDEN ? `./node_modules/.vite-${process.env.GARDEN}` : undefined,
    // Member gardens run from a symlink-shell root (.garden-roots/<member>/),
    // where src/ is a symlink to the shared web/src. Without this, Vite follows
    // the symlink to its realpath — which sits OUTSIDE the shell root — and
    // serves assets via /@fs/<realpath> URLs, which breaks Astro's stylesheet
    // collection (global.css is dropped entirely → no chrome). Preserving
    // symlinks keeps modules rooted at the shell, so assets stay /src/-relative
    // like Candide's. (Now always on — see preserveSymlinks below.)
    // `@theme` = the active theme folder (THEME env, default "default"); `@app`
    // = the engine (src). Swapping themes is just pointing `@theme` elsewhere.
    // Root at process.cwd() (the per-member shell root when a garden runs from
    // .garden-roots/<member>/, web/ for Candide) — NOT import.meta.dirname, which
    // resolves to the realpath and escapes the symlinked shell, dropping the CSS
    // ("No Astro CSS at index 0"). themes/ is symlinked into each shell like src/.
    resolve: {
      // Always preserve symlinks. Member garden shells symlink src/, and the
      // private overlays (maurice-tools, maurice-web) symlink tool/web paths into
      // the tree; without this, Vite follows a symlinked file to its realpath in
      // the overlay repo and its relative imports (../../layouts/Base.astro, …)
      // break. Harmless when no symlinks are present (the public checkout).
      preserveSymlinks: true,
      // `@theme` is handled by themeResolver() (with default fallback); `@app`
      // is the engine (src). Both root at the shell via process.cwd().
      alias: {
        "@app": resolve(process.cwd(), "src"),
      },
    },
    server: {
      // Hosts the dev server accepts when proxied behind a public hostname.
      // Set ALLOWED_HOSTS to a comma-separated list (a leading "." allows all
      // subdomains, e.g. ".example.com"). Empty by default for a local run.
      allowedHosts: (process.env.ALLOWED_HOSTS || "").split(",").map((s) => s.trim()).filter(Boolean),
      ...(hasTls && {
        https: {
          cert: readFileSync(certFile),
          key: readFileSync(keyFile),
        },
      }),
    },
  },
  i18n: {
    defaultLocale: "en",
    locales: ["en", "fr"],
    routing: { prefixDefaultLocale: false },
  },
});
