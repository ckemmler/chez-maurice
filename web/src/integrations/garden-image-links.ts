/**
 * Make the member's images reachable from the engine's public/ dir, and keep
 * the published build free of private note art. Symlinks only.
 *
 * It used to also walk every collection at engine start, download any cover
 * still pointing at someone else's server, and rewrite the garden's markdown —
 * the renderer editing the content it renders, on every boot. That moved to
 * the server (`server/src/services/gardenImages.ts`), which is where writes
 * belong and where the on-write download already lived.
 */
import type { AstroIntegration } from "astro";
import { symlink, readlink, rm, readdir, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

/** Point public/images/<member> at that member's garden images.
 *
 * Always the whole tree, whatever the command. An earlier version linked only
 * images/resources for a build, to keep private note art out of the published
 * site — but dev and build share this one public/ dir, so running a build
 * reshaped what the already-running dev server was serving and note images
 * started 404ing until the next restart. The build now prunes its OWN output
 * instead (see astro:build:done), which touches nothing anyone else reads.
 */
async function ensureImageLink(
  member: string,
  gardenDir: string,
  logger: { info: (m: string) => void; warn: (m: string) => void },
): Promise<void> {
  const publicImages = resolve(process.cwd(), "public", "images");
  const link = resolve(publicImages, member);
  const target = resolve(gardenDir, "images");
  if (!existsSync(target)) return; // a garden with no images yet

  try {
    const current = await readlink(link).catch(() => null);
    // Compare where the link POINTS, not how it is written: the committed
    // `demo` link is relative, and comparing the literal string rewrote it
    // absolute on every start — a tracked file, dirtied by running the engine.
    if (current !== null && resolve(publicImages, current) === target) return;
    // Clear anything else sitting there — including the directory the old
    // build-mode code used to leave behind.
    if (current !== null || existsSync(link)) {
      await rm(link, { recursive: true, force: true });
    }
    await mkdir(publicImages, { recursive: true });
    await symlink(target, link);
    logger.info(`Linked /images/${member} → ${target}`);
  } catch (err) {
    logger.warn(`Could not link /images/${member}: ${err}`);
  }
}

/** Link this member's avatar into public/avatars so the SITE serves it.
 *
 * gardens.json points at /api/avatars/<file>, which is the server's route: not
 * reachable under a garden base (Astro prefixes it), and absent entirely from
 * the public build, which is static files on Cloudflare Pages. See
 * siteAvatarPath in lib/garden.ts for the other half.
 *
 * Only this member's file is linked, never the directory: the household's other
 * avatars are real family photos and have no business in a public build.
 */
async function ensureAvatarLink(
  member: string,
  gardensRoot: string,
  logger: { info: (m: string) => void; warn: (m: string) => void },
): Promise<void> {
  let configured: string | undefined;
  try {
    const manifest = JSON.parse(
      await readFile(join(gardensRoot, "gardens.json"), "utf-8"),
    );
    configured = manifest?.[member]?.avatar;
  } catch {
    return; // no manifest, nothing to link
  }
  const file = configured?.split("/").filter(Boolean).pop();
  if (!file) return;

  // Avatars sit in the app's data dir, beside the gardens rather than inside
  // them. Try the sibling first, then the default install location.
  const candidates = [
    resolve(gardensRoot, "..", "avatars", file),
    resolve(process.env.HOME || "", ".maurice", "avatars", file),
  ];
  const source = candidates.find((c) => existsSync(c));
  if (!source) {
    logger.warn(`Avatar ${file} not found — the header will fall back to initials`);
    return;
  }

  const dir = resolve(process.cwd(), "public", "avatars");
  const link = join(dir, file);
  try {
    await mkdir(dir, { recursive: true });
    const current = await readlink(link).catch(() => null);
    if (current === source) return;
    if (current !== null || existsSync(link)) await rm(link, { force: true });
    await symlink(source, link);
    logger.info(`Linked /avatars/${file} → ${source}`);
  } catch (err) {
    logger.warn(`Could not link /avatars/${file}: ${err}`);
  }
}

export default function gardenImageLinks(): AstroIntegration {
  return {
    name: "garden-image-links",
    hooks: {
      "astro:config:setup": async ({ logger }) => {
        // One engine serves the whole household, so every member's images have
        // to resolve — not just the fallback member's. A garden that is not in
        // the manifest yet (or has no images) is simply skipped.
        const gardensRoot = process.env.MAURICE_GARDENS_DIR || join(process.cwd(), "gardens");
        let members: string[] = [];
        try {
          members = Object.keys(JSON.parse(readFileSync(join(gardensRoot, "gardens.json"), "utf8")));
        } catch {
          /* no manifest (a public build, a fresh checkout) — the env member alone */
        }
        const fallback = process.env.GARDEN || "demo";
        if (!members.includes(fallback)) members.push(fallback);

        // Entries reference their cover as /images/<member>/resources/… — an
        // absolute, member-scoped URL that has to resolve against Astro's
        // public/ dir. Real gardens live outside the checkout (in
        // MAURICE_GARDENS_DIR), so nothing under public/ pointed at them and
        // every cover 404'd; only the bundled `demo` garden had a symlink,
        // committed by hand long ago. Recreate the member's link on every start,
        // from the same config the collections themselves are loaded from, so
        // the two can't disagree about where a garden lives.
        for (const member of members) {
          await ensureImageLink(member, join(gardensRoot, member), logger);
          await ensureAvatarLink(member, gardensRoot, logger);
        }
      },

      // Astro copies public/ wholesale into the output, following symlinks — so
      // the member's whole images tree lands in dist, note art included. Those
      // illustrate notes that are overwhelmingly private (none of this
      // household's carries `public`), and this output goes to a public site.
      // Pruning here, rather than by linking less, keeps the dev server's view
      // untouched: nothing outside dist/ is modified.
      "astro:build:done": async ({ dir, logger }) => {
        const images = join(fileURLToPath(dir), "images");
        if (!existsSync(images)) return;
        for (const member of await readdir(images)) {
          const memberImages = join(images, member);
          let entries: string[];
          try {
            entries = await readdir(memberImages);
          } catch {
            continue; // not a directory
          }
          for (const entry of entries) {
            if (entry === "resources") continue;
            await rm(join(memberImages, entry), { recursive: true, force: true });
            logger.info(`Pruned images/${member}/${entry} from the build`);
          }
        }
      },
    },
  };
}
