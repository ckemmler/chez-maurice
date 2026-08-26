import fs from "node:fs";
import path from "node:path";

/**
 * Which member's garden this engine instance serves. Defaults to the bundled
 * `demo` garden, so a plain `astro dev`/`astro build` (no GARDEN) renders the
 * example garden. Set GARDEN=<member> to serve a real one.
 */
export const GARDEN = process.env.GARDEN || "demo";

/** Root of all gardens. MAURICE_GARDENS_DIR (set in production) wins; otherwise
 *  the cwd-relative `gardens/` used by dev and the public-site build. */
export function gardensRoot(): string {
  return process.env.MAURICE_GARDENS_DIR || path.join(process.cwd(), "gardens");
}

/** Absolute path to this garden's notes tree (gardens/<member>/notes). */
export function notesDir(): string {
  return path.join(gardensRoot(), GARDEN, "notes");
}

export interface GardenConfig {
  name: string;
  title: string;
  avatar: string | null;
  base?: string;
  domain?: string;
}

let _config: GardenConfig | null = null;

/** This garden's identity (name, title, avatar) from gardens/gardens.json. */
export function gardenConfig(): GardenConfig {
  if (_config) return _config;
  let cfg: Partial<GardenConfig> = {};
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(gardensRoot(), "gardens.json"), "utf8"),
    );
    cfg = manifest[GARDEN] ?? {};
  } catch {
    /* fall through to defaults */
  }
  _config = {
    name: cfg.name || GARDEN,
    title: cfg.title || `${GARDEN}'s garden`,
    avatar: siteAvatarPath(cfg.avatar ?? null),
    base: cfg.base,
    domain: cfg.domain,
  };
  return _config;
}

/**
 * The avatar as a path this SITE serves, not one the API does.
 *
 * gardens.json stores `/api/avatars/<file>` — right for the app and the server,
 * wrong here twice over. Under a garden base Astro prefixes `src`, so it asks
 * for /g/<member>/api/avatars/… which the engine does not serve; and on the
 * public build there is no API at all, only static files on Cloudflare Pages.
 * Either way the header showed a broken image.
 *
 * The integration links the file into public/avatars, so a plain site-relative
 * path is correct in both: Astro prefixes the base in dev, and leaves it alone
 * for the public build where BASE_URL is "/".
 */
function siteAvatarPath(configured: string | null): string | null {
  if (!configured) return null;
  const file = configured.split("/").filter(Boolean).pop();
  return file ? `/avatars/${file}` : null;
}

/** Initials for the avatar fallback when no image is configured. */
export function gardenInitials(): string {
  const parts = gardenConfig().name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");
  return letters || "?";
}
