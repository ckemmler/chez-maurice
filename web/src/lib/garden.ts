import fs from "node:fs";
import path from "node:path";
import { currentGarden } from "./garden-context";

/**
 * Which member's garden is being served. Per request (see garden-context.ts),
 * so one built engine serves a whole household; falls back to the GARDEN
 * environment variable outside a request — a static publish, a script — and
 * to the bundled `demo` garden when nothing says otherwise.
 */
export { currentGarden as GARDEN_OF_REQUEST };

/** Root of all gardens. MAURICE_GARDENS_DIR (set in production) wins; otherwise
 *  the cwd-relative `gardens/` used by dev and the public-site build. */
export function gardensRoot(): string {
  return process.env.MAURICE_GARDENS_DIR || path.join(process.cwd(), "gardens");
}

/** Absolute path to this garden (gardens/<member>). */
export function gardenRoot(): string {
  return path.join(gardensRoot(), currentGarden());
}

/** Absolute path to this garden's notes tree (gardens/<member>/notes). */
export function notesDir(): string {
  return path.join(gardenRoot(), "notes");
}

export interface GardenConfig {
  name: string;
  title: string;
  avatar: string | null;
  base?: string;
  domain?: string;
}

// One entry per member: a single engine serves them all, so a single cached
// config would hand the second member the first one's name.
const _configs = new Map<string, GardenConfig>();

/** This garden's identity (name, title, avatar) from gardens/gardens.json. */
export function gardenConfig(): GardenConfig {
  const member = currentGarden();
  const cached = _configs.get(member);
  if (cached) return cached;
  let cfg: Partial<GardenConfig> = {};
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(gardensRoot(), "gardens.json"), "utf8"),
    );
    cfg = manifest[member] ?? {};
  } catch {
    /* fall through to defaults */
  }
  const config: GardenConfig = {
    name: cfg.name || member,
    title: cfg.title || `${member}'s garden`,
    avatar: siteAvatarPath(cfg.avatar ?? null),
    base: cfg.base,
    domain: cfg.domain,
  };
  _configs.set(member, config);
  return config;
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
