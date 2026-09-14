/**
 * Cover images that live somewhere else, brought home.
 *
 * An entry written from a URL (an article saved from the web, a book looked up
 * in a catalogue) carries `image: https://…`. A garden that depends on someone
 * else's server for its pictures is not self-contained: the link rots, the
 * reader is tracked fetching it, and an offline garden is full of holes. So the
 * file is downloaded into `<garden>/images/resources/<collection>/` and the
 * frontmatter rewritten to point at it.
 *
 * The writers already do this for what they write (`gardenArticles.ts`). This
 * is the sweep for everything else — entries written by hand, by an older
 * version, or by the MCP tool. It ran as an Astro integration at engine start
 * until September 2026, which meant the *renderer* rewrote the garden every
 * time it booted. Rendering reads; writing is the server's.
 */
import fs from "node:fs";
import path from "node:path";
import { atomicWrite, autoCommit, downloadImage, type GardenRef } from "../../data-api/services/gardenFiche";

const COLLECTIONS = ["books", "movies", "games", "series", "podcasts", "articles", "people"];
const REMOTE_IMAGE = /^image:\s+["']?(https?:\/\/[^\s"']+)["']?\s*$/m;

/**
 * Localise every remote cover in a garden. Best-effort and quiet: a download
 * that fails leaves the remote URL in place, to be retried next time.
 * Returns how many were brought home.
 */
export async function localiseRemoteImages(garden: GardenRef): Promise<number> {
  const touched: string[] = [];

  for (const collection of COLLECTIONS) {
    const dir = path.join(garden.root, collection);
    if (!fs.existsSync(dir)) continue;

    for (const rel of walk(dir)) {
      const filePath = path.join(dir, rel);
      let text: string;
      try {
        text = fs.readFileSync(filePath, "utf8");
      } catch {
        continue;
      }
      const front = text.match(/^---\n([\s\S]*?)\n---/);
      const remote = front?.[1]?.match(REMOTE_IMAGE)?.[1];
      if (!remote) continue;

      const slug = path.basename(rel).replace(/\.mdx?$/, "");
      const locale = rel.includes(path.sep) ? rel.split(path.sep)[0]! : "en";
      const ext = (path.extname(new URL(remote).pathname) || ".jpg").toLowerCase();
      const filename = `${locale}-${slug}${ext}`;
      const dest = path.join(garden.root, "images", "resources", collection, filename);
      const url = `/images/${garden.username}/resources/${collection}/${filename}`;

      if (!fs.existsSync(dest)) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        if (!(await downloadImage(remote, dest))) continue;
        touched.push(dest);
      }
      atomicWrite(filePath, text.replace(REMOTE_IMAGE, `image: ${url}`));
      touched.push(filePath);
    }
  }

  if (touched.length) {
    autoCommit(garden, touched, `Localise ${touched.length} remote image reference(s)`);
  }
  return touched.length;
}

function walk(dir: string, rel = ""): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const child = rel ? path.join(rel, e.name) : e.name;
    if (e.isDirectory()) out.push(...walk(dir, child));
    else if (e.name.endsWith(".md") || e.name.endsWith(".mdx")) out.push(child);
  }
  return out;
}
