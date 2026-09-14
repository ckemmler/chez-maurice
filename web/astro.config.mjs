// @ts-check
import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";
import node from "@astrojs/node";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import remarkCrossRef from "./src/plugins/remark-cross-ref.mjs";
import encryptPrivate from "./src/integrations/encrypt-private.ts";
import gardenImageLinks from "./src/integrations/garden-image-links.ts";

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
  integrations: [gardenImageLinks(), encryptPrivate()],
  site: process.env.SITE_URL || "http://localhost:4321",
  // No base. A member's garden is served under /g/<member>/, but that prefix
  // is now a property of the REQUEST, not of the build: one engine serves
  // every member of a household (src/middleware.ts + lib/garden-context.ts).
  // The proxy strips the prefix before forwarding and the middleware puts it
  // back into the HTML, so Astro's own asset URLs stay at the root where a
  // single build can share them.
  // WEB_SSR=1 (the everyday/dynamic garden servers) renders per request so live
  // theme switching (?theme= / cookie) works; unset = static publish (a baked
  // theme). Content [id] pages are dual-mode: getStaticPaths for the static
  // build, a request-time param lookup under SSR.
  output: process.env.WEB_SSR === "1" ? "server" : "static",
  // The garden engine is a plain node server: one process per household,
  // reading the gardens off the local disk. Cloudflare's adapter targets
  // workerd, which has no `node:fs` at runtime — impossible for the engine,
  // and right for the public publish, which goes to Cloudflare Pages. (That
  // build needs an adapter too: a handful of routes are server-rendered
  // there, so it is not a pure static site.)
  adapter: process.env.WEB_SSR === "1" ? node({ mode: "standalone" }) : cloudflare(),
  // Hosts the dev server accepts. In the garden topology this engine is only ever
  // reached through the authenticated Bun reverse proxy (server/index.ts) — the
  // single gated ingress that the tunnel / Tailnet / custom domain points at, never
  // this port directly. Vite's host check (a DNS-rebinding guard for internet-facing
  // dev servers) is therefore redundant here, and pinning hostnames would break
  // every self-hosted deployment on its own host. So accept any host by default:
  // zero-config on any Tailnet/Cloudflare/custom domain, with the Host header left
  // intact so `api-base` (Astro.url.hostname) stays correct. Set ALLOWED_HOSTS to a
  // comma-separated allowlist (leading "." = subdomain wildcard, e.g. ".example.com")
  // to pin an explicit list if you deliberately expose this port outside the proxy.
  // (Must be the first-class top-level option, not vite.server.allowedHosts, which
  // Astro would override with its own default of [].)
  server: {
    allowedHosts: process.env.ALLOWED_HOSTS
      ? process.env.ALLOWED_HOSTS.split(",").map((s) => s.trim()).filter(Boolean)
      : true,
  },
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
    // `@theme` = the active theme folder; `@app` = the engine (src). Both root
    // at process.cwd(), NOT import.meta.dirname, which resolves to a realpath
    // and escapes a symlinked path, dropping the CSS ("No Astro CSS at index 0").
    resolve: {
      // The private overlays (maurice-tools, maurice-web) symlink files into
      // this tree; without this, Vite follows one to its realpath in the other
      // repo and its relative imports (../../layouts/Base.astro, …) break.
      // Harmless when no symlinks are present (the public checkout).
      preserveSymlinks: true,
      // `@theme` is handled by themeResolver() (with default fallback); `@app`
      // is the engine (src). Both root at the shell via process.cwd().
      alias: {
        "@app": resolve(process.cwd(), "src"),
      },
    },
    server: {
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
