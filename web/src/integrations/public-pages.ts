/**
 * A member's public pages, built to live under `/@<member>/` on the
 * household's own host (`PUBLIC_STATIC=1`, `GARDEN_BASE=/@<member>`).
 *
 * The engine has no base of its own: under `/g/<member>/` the prefix belongs
 * to the request, and the middleware writes it into the HTML it renders. A
 * static build has no request, but the middleware still runs while each page
 * is prerendered, so the same rule applies with the prefix taken from
 * `GARDEN_BASE`. (An Astro `base` does not do it: only Astro's own assets
 * move, and the hundreds of links the templates write by hand stay at the
 * root.)
 *
 * What the middleware cannot reach is finished here, once the pages are
 * written: the stylesheet link Astro adds after it, and the two attributes the
 * search widget reads its addresses from. Same rule as the middleware: prefix
 * what is root-absolute and not already under the base.
 */
import type { AstroIntegration } from "astro";
import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/** Files the build leaves beside the pages that nobody is served. */
const LEFTOVERS = new Set([
  "_redirects", "content-assets.mjs", "content-modules.mjs", ".gitkeep",
  // The fiches index is the owner's: here, an empty page nobody links to.
  "fiches.html",
]);

const ATTR = /\b(href|src|data-index-url|data-base)="(\/[^"]*)"/g;

export function withBase(html: string, base: string, origin = ""): string {
  let out = html.replace(ATTR, (m, attr: string, url: string) =>
    url.startsWith("//") || url === base || url.startsWith(`${base}/`) ? m : `${attr}="${base}${url}"`);
  // The page's own absolute addresses (canonical, alternates, og:url) are made
  // from the site's origin and a root path: the member's prefix is missing
  // from them too.
  if (origin) {
    out = out.split(`="${origin}/`).map((part, i) =>
      i === 0 || part.startsWith(`${base.slice(1)}/`) || part.startsWith(`${base.slice(1)}"`) ? part : `${base.slice(1)}/${part}`,
    ).join(`="${origin}/`);
  }
  return out;
}

async function eachFile(dir: string, visit: (file: string, name: string) => Promise<void>): Promise<void> {
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const full = join(dir, name);
    const info = await stat(full).catch(() => null);
    if (!info) continue;
    if (info.isDirectory()) await eachFile(full, visit);
    else await visit(full, name);
  }
}

export default function publicPages(): AstroIntegration {
  return {
    name: "public-pages",
    hooks: {
      "astro:build:done": async ({ dir, logger }) => {
        const base = (process.env.GARDEN_BASE ?? "").replace(/\/+$/, "");
        if (process.env.PUBLIC_STATIC !== "1" || !base) return;
        let rewritten = 0;
        await eachFile(fileURLToPath(dir), async (file, name) => {
          if (LEFTOVERS.has(name)) {
            await rm(file, { force: true });
            return;
          }
          if (!name.endsWith(".html")) return;
          const html = await readFile(file, "utf-8");
          const next = withBase(html, base, (process.env.SITE_URL ?? "").replace(/\/+$/, ""));
          if (next !== html) {
            await writeFile(file, next);
            rewritten++;
          }
        });
        logger.info(`Finished the ${base} prefix in ${rewritten} page(s)`);
      },
    },
  };
}
