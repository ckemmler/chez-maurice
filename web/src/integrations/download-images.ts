import type { AstroIntegration } from "astro";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, extname } from "node:path";
import { glob } from "node:fs/promises";

const COLLECTIONS = [
  "books",
  "movies",
  "series",
  "podcasts",
  "articles",
  "people",
];

export default function downloadImages(): AstroIntegration {
  return {
    name: "download-images",
    hooks: {
      "astro:config:setup": async ({ logger }) => {
        // Collections and their images live in the running member's garden.
        const member = process.env.GARDEN || "demo";
        const gardensRoot = process.env.MAURICE_GARDENS_DIR || join(process.cwd(), "gardens");
        const gardenDir = join(gardensRoot, member);
        const imagesDir = join(gardenDir, "images", "resources");
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
    },
  };
}
