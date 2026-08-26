import type { AstroIntegration } from "astro";
import { readFile, writeFile, mkdir, symlink, readlink, rm, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, extname, resolve } from "node:path";
import { glob } from "node:fs/promises";

const COLLECTIONS = [
  "books",
  "movies",
  "games",
  "series",
  "podcasts",
  "articles",
  "people",
];

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
    if (current === target) return;
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

export default function downloadImages(): AstroIntegration {
  return {
    name: "download-images",
    hooks: {
      "astro:config:setup": async ({ logger, command }) => {
        // Collections and their images live in the running member's garden.
        const member = process.env.GARDEN || "demo";
        const gardensRoot = process.env.MAURICE_GARDENS_DIR || join(process.cwd(), "gardens");
        const gardenDir = join(gardensRoot, member);
        const imagesDir = join(gardenDir, "images", "resources");

        // Entries reference their cover as /images/<member>/resources/… — an
        // absolute, member-scoped URL that has to resolve against Astro's
        // public/ dir. Real gardens live outside the checkout (in
        // MAURICE_GARDENS_DIR), so nothing under public/ pointed at them and
        // every cover 404'd; only the bundled `demo` garden had a symlink,
        // committed by hand long ago. Recreate the member's link on every start,
        // from the same config the collections themselves are loaded from, so
        // the two can't disagree about where a garden lives.
        await ensureImageLink(member, gardenDir, logger);
        await ensureAvatarLink(member, gardensRoot, logger);

        let downloaded = 0;

        for (const collection of COLLECTIONS) {
          const collectionDir = join(gardenDir, collection);
          if (!existsSync(collectionDir)) continue;

          for await (const entry of glob("**/*.md", { cwd: collectionDir })) {
            const filePath = join(collectionDir, entry);
            const content = await readFile(filePath, "utf-8");

            const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
            if (!fmMatch) continue;

            const imageMatch = fmMatch[1].match(
              /^image:\s+["']?(https?:\/\/[^\s"']+)["']?\s*$/m
            );
            if (!imageMatch) continue;

            const remoteUrl = imageMatch[1];
            const slug = entry.replace(/\.md$/, "").replace(/\//g, "-");
            const ext = extname(new URL(remoteUrl).pathname) || ".jpg";
            const localRelPath = `/images/${member}/resources/${collection}/${slug}${ext}`;
            const localAbsPath = join(imagesDir, collection, `${slug}${ext}`);

            if (existsSync(localAbsPath)) {
              // Already cached — just ensure frontmatter points to local path
              if (content.includes(remoteUrl)) {
                const updated = content.replace(remoteUrl, localRelPath);
                await writeFile(filePath, updated, "utf-8");
              }
              continue;
            }

            try {
              logger.info(`Downloading ${remoteUrl}`);
              const response = await fetch(remoteUrl);
              if (!response.ok) {
                logger.warn(
                  `Failed to download ${remoteUrl}: ${response.status}`
                );
                continue;
              }

              await mkdir(join(imagesDir, collection), { recursive: true });
              const buffer = Buffer.from(await response.arrayBuffer());
              await writeFile(localAbsPath, buffer);

              const updated = content.replace(remoteUrl, localRelPath);
              await writeFile(filePath, updated, "utf-8");
              downloaded++;
            } catch (err) {
              logger.warn(`Error downloading ${remoteUrl}: ${err}`);
            }
          }
        }

        if (downloaded > 0) {
          logger.info(`Downloaded ${downloaded} image(s)`);
        }
      },

      // Astro copies public/ wholesale into the output, following symlinks — so
      // the member's whole images tree lands in dist, note art included. Those
      // illustrate notes that are overwhelmingly private (none of this
      // household's carries `public`), and this output goes to a public site.
      // Pruning here, rather than by linking less, keeps the dev server's view
      // untouched: nothing outside dist/ is modified.
      "astro:build:done": async ({ dir, logger }) => {
        const member = process.env.GARDEN || "demo";
        const memberImages = join(fileURLToPath(dir), "images", member);
        if (!existsSync(memberImages)) return;
        for (const entry of await readdir(memberImages)) {
          if (entry === "resources") continue;
          await rm(join(memberImages, entry), { recursive: true, force: true });
          logger.info(`Pruned images/${member}/${entry} from the build`);
        }
      },
    },
  };
}
