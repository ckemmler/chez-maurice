/**
 * A member's public pages on the household's own host: `/@<member>/…`.
 *
 * What a member publishes from Carnet (the shared side of an entry, flagged
 * `public`) has to be readable somewhere. A member with a domain of their own
 * has their site. Everyone else, in a household hosted for them, gets this: a
 * static site built from their garden, kept in the data directory and served
 * by this server to anyone, with no session.
 *
 * Static on purpose. The build is the one that already makes a public site out
 * of a garden: it is never the owner's view, it includes only what carries the
 * `public` flag, it never includes a fiche, and it keeps only the images its
 * own pages point at. What is private is not filtered out when a page is
 * served; it was never written.
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { getDataDir } from "../lib/config";
import { gardensRoot } from "../../src/services/gardensRoot";
import type { GardenRef } from "./gardenFiche";

const WEB = path.resolve(import.meta.dir, "../../../web");

/**
 * The host the public pages are served on, or null when this household does
 * not publish any. Off unless asked for: a household at home is reachable by
 * whoever its owner let in, and serving pages to anyone there is not a default
 * to take for them. A hosted household sets `MAURICE_PUBLIC_PAGES=1`.
 */
export function publicPagesHost(): string | null {
  const host = (process.env.MAURICE_PUBLIC_HOST ?? "").trim();
  if (process.env.MAURICE_PUBLIC_PAGES !== "1" || !host || host === "localhost") return null;
  return host;
}

/** `https://<host>/@<member>` — where a member's pages are, or null. A child's
 *  account does not publish. */
export function defaultSite(user: { username: string; is_child?: boolean }): string | null {
  const host = publicPagesHost();
  if (!host || user.is_child || !memberName(user.username)) return null;
  return `https://${host}/@${user.username}`;
}

// ── Where the pages are kept ──

/** Vite's own paths start with `/@` too (`/@vite`, `/@id`, `/@fs`): a member
 *  by one of those names would shadow the engine's. */
const RESERVED = new Set(["vite", "id", "fs", "react-refresh"]);

function memberName(value: string): string | null {
  return /^[a-z0-9][a-z0-9_-]*$/.test(value) && !RESERVED.has(value) ? value : null;
}

export function publicPagesDir(username: string): string {
  return path.join(getDataDir(), "public-pages", username);
}

/**
 * The file a path under `/@<member>/` names, or null. The path as given, then
 * with `.html` (the build writes /about as about.html), then its index.html.
 * Nothing outside the member's folder, and no dot-files.
 */
export function resolvePublicFile(pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const m = decoded.match(/^\/@([^/]+)(?:\/(.*))?$/);
  const member = m ? memberName(m[1]!) : null;
  if (!member) return null;
  const rel = (m![2] ?? "").replace(/\/+$/, "");
  if (rel.split("/").some((seg) => seg.startsWith(".") || seg === "")) {
    if (rel !== "") return null;
  }

  let base: string;
  try {
    base = fs.realpathSync(publicPagesDir(member));
  } catch {
    return null;   // nothing published
  }
  const candidates = rel ? [rel, `${rel}.html`, path.join(rel, "index.html")] : ["index.html"];
  for (const candidate of candidates) {
    let full: string;
    try {
      full = fs.realpathSync(path.join(base, candidate));
    } catch {
      continue;
    }
    if (full.startsWith(base + path.sep) && fs.statSync(full).isFile()) return full;
  }
  return null;
}

/** The response for a request under `/@…`, or null to let it through. */
export function servePublicPage(pathname: string): Response | null {
  if (!pathname.startsWith("/@")) return null;
  const file = resolvePublicFile(pathname);
  if (!file) return null;
  return new Response(Bun.file(file), {
    headers: {
      // A publish replaces the folder; let a visitor see it soon.
      "Cache-Control": file.includes(`${path.sep}_astro${path.sep}`) ? "public, max-age=31536000, immutable" : "public, max-age=60",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

// ── Building them ──

/**
 * Build the member's pages and put them in place. Built beside the live
 * folder and swapped in only when the build succeeded, so a failed build
 * leaves what was published where it was.
 */
export function buildPublicPages(garden: GardenRef): Promise<void> {
  const member = memberName(garden.username);
  const host = publicPagesHost();
  if (!member || !host) return Promise.reject(new Error("Public pages are not set up for this household"));

  const live = publicPagesDir(member);
  const next = `${live}.building`;
  const old = `${live}.old`;
  fs.rmSync(next, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(live), { recursive: true });

  // The engine's own settings must not leak into this build: with WEB_SSR it
  // would render as the owner's server and include the fiches.
  const { WEB_SSR: _ssr, GARDEN_OWNER: _owner, ...env } = process.env;

  return new Promise((resolve, reject) => {
    const child = spawn(path.join(WEB, "node_modules", ".bin", "astro"), ["build", "--outDir", next], {
      cwd: WEB,
      env: {
        ...env,
        NODE_ENV: "production",
        PUBLIC_STATIC: "1",
        GARDEN: member,
        GARDEN_BASE: `/@${member}`,
        THEME: process.env.PUBLIC_PAGES_THEME ?? "default",
        SITE_URL: `https://${host}`,
        MAURICE_GARDENS_DIR: gardensRoot(),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let tail = "";
    const keep = (chunk: Buffer) => { tail = (tail + chunk.toString()).slice(-2000); };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.on("error", (err) => { fs.rmSync(next, { recursive: true, force: true }); reject(err); });
    child.on("close", (code) => {
      if (code !== 0 || !fs.existsSync(path.join(next, "index.html"))) {
        fs.rmSync(next, { recursive: true, force: true });
        reject(new Error(tail.trim().split("\n").slice(-3).join(" ⏎ ") || `build exited with ${code}`));
        return;
      }
      try {
        fs.rmSync(old, { recursive: true, force: true });
        if (fs.existsSync(live)) fs.renameSync(live, old);
        fs.renameSync(next, live);
        fs.rmSync(old, { recursive: true, force: true });
        resolve();
      } catch (err) {
        reject(err as Error);
      }
    });
  });
}
