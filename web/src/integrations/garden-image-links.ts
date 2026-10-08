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
import { symlink, readlink, rm, readdir, mkdir, readFile, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative, resolve, sep } from "node:path";

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
    // Compare where the link POINTS, not how it is written.
    if (current !== null && resolve(publicImages, current) === target) return;
    // A RELATIVE link here is the repository's own — `demo` is committed,
    // pointing at the bundled garden — and belongs to whoever wrote it. The
    // integration writes absolute links and only ever replaces its own;
    // otherwise running the engine dirtied a tracked file on every start, and
    // left an absolute path that is wrong on any other machine.
    if (current !== null && !current.startsWith("/")) return;
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

// ── What a public build may carry ──

/** Every file under a directory, as absolute paths. Symlinks are not followed:
 *  by build:done the output holds copies, and a stray link is nobody's file. */
async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    const full = join(dir, name);
    const info = await stat(full).catch(() => null);
    if (!info) continue;
    if (info.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

// What a visitor is served. Not the scripts: the adapter's own manifest lists
// every file of public/, which would make each of them look used.
const TEXT = /\.(html|json|xml|css|txt)$/;

/**
 * The image and avatar paths the built pages actually point at, as paths
 * relative to the output (`images/<member>/resources/books/x.jpg`). A page
 * names its cover as /images/…, possibly under a base and possibly inside an
 * absolute URL (og:image), so the match is on the path, wherever it sits.
 */
async function referencedAssets(outDir: string): Promise<Set<string>> {
  const used = new Set<string>();
  const pattern = /\/((?:images|avatars)\/[^"'()\s<>?#\\]+)/g;
  for (const file of await walk(outDir)) {
    if (!TEXT.test(file) || file.includes(`${sep}_worker.js${sep}`)) continue;
    const text = await readFile(file, "utf-8").catch(() => "");
    for (const m of text.matchAll(pattern)) {
      const raw = m[1]!;
      used.add(raw);
      try {
        used.add(decodeURI(raw));
      } catch {
        /* not an encoded path */
      }
    }
  }
  return used;
}

async function removeEmptyDirs(dir: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const full = join(dir, name);
    const info = await stat(full).catch(() => null);
    if (info?.isDirectory()) await removeEmptyDirs(full);
  }
  if ((await readdir(dir).catch(() => ["x"])).length === 0) await rm(dir, { recursive: true, force: true });
}

/**
 * A public build is one member's published pages. public/ is the household's:
 * it links every member's images, and every member's avatar. Copied as it
 * stands, a member's site carried the covers of everyone else's entries, and
 * of their own unpublished ones; the avatars — family photographs — were spared
 * only because the link that would have brought them in threw before it was
 * made.
 *
 * So the output keeps what its own pages point at, and nothing else: an image
 * or an avatar no built page names is not part of what was published.
 */
async function keepOnlyReferenced(outDir: string, logger: { info: (m: string) => void }): Promise<void> {
  const used = await referencedAssets(outDir);
  for (const top of ["images", "avatars"]) {
    const root = join(outDir, top);
    if (!existsSync(root)) continue;
    let removed = 0;
    for (const file of await walk(root)) {
      const rel = relative(outDir, file).split(sep).join("/");
      if (used.has(rel)) continue;
      await rm(file, { force: true });
      removed++;
    }
    await removeEmptyDirs(root);
    if (removed) logger.info(`Left ${removed} unreferenced file(s) under ${top}/ out of the build`);
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
        // The engine's own build (WEB_SSR) serves the household and keeps the
        // rule below. A static build is published: it keeps only what its
        // pages use.
        if (process.env.WEB_SSR !== "1") {
          await keepOnlyReferenced(fileURLToPath(dir), logger);
          return;
        }
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
