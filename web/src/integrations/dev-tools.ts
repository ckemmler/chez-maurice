import type { AstroIntegration } from "astro";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export default function devTools(): AstroIntegration {
  return {
    name: "dev-tools",
    hooks: {
      "astro:server:setup": ({ server }) => {
        server.middlewares.use("/_dev/translate", (req, res) => {
          if (req.method !== "POST") {
            res.statusCode = 405;
            res.end("Method not allowed");
            return;
          }

          res.setHeader("Content-Type", "text/event-stream");
          res.setHeader("Cache-Control", "no-cache");
          res.setHeader("Connection", "keep-alive");

          const scriptPath = path.resolve(
            import.meta.dirname,
            "../../scripts/translate-content.ts"
          );

          const child = spawn("npx", ["tsx", scriptPath], {
            cwd: path.resolve(import.meta.dirname, "../.."),
            stdio: ["ignore", "pipe", "pipe"],
          });

          child.stdout.on("data", (chunk: Buffer) => {
            res.write(`data: ${chunk.toString().replace(/\n/g, "\ndata: ")}\n\n`);
          });

          child.stderr.on("data", (chunk: Buffer) => {
            res.write(`data: [ERR] ${chunk.toString().replace(/\n/g, "\ndata: [ERR] ")}\n\n`);
          });

          child.on("close", (code) => {
            res.write(`data: [DONE] exit code ${code}\n\n`);
            res.end();
          });
        });

        // --- Toggle public frontmatter field ---
        server.middlewares.use("/_dev/toggle-public", (req, res) => {
          if (req.method !== "POST") {
            res.statusCode = 405;
            res.end("Method not allowed");
            return;
          }

          let body = "";
          req.on("data", (chunk: Buffer) => (body += chunk.toString()));
          req.on("end", () => {
            try {
              const { path: urlPath } = JSON.parse(body);
              const result = resolveAndTogglePublic(urlPath);
              if (!result) {
                res.statusCode = 404;
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ error: "No content file found" }));
                return;
              }
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify(result));
            } catch (err) {
              res.statusCode = 500;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ error: String(err) }));
            }
          });
        });

        // --- Get private state (notes only) ---
        server.middlewares.use("/_dev/private-state", (req, res) => {
          if (req.method !== "POST") {
            res.statusCode = 405;
            res.end("Method not allowed");
            return;
          }

          let body = "";
          req.on("data", (chunk: Buffer) => (body += chunk.toString()));
          req.on("end", () => {
            try {
              const { path: urlPath } = JSON.parse(body);
              const result = resolveContentFile(urlPath);
              if (!result || !result.isNotes) {
                res.statusCode = 404;
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ error: "Not a notes page" }));
                return;
              }
              const content = fs.readFileSync(result.filePath, "utf-8");
              const flags = parseFlagsArray(content);
              const isPrivate = flags.includes("encrypted");
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ file: result.filePath, private: isPrivate }));
            } catch (err) {
              res.statusCode = 500;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ error: String(err) }));
            }
          });
        });

        // --- Toggle private frontmatter field (notes only) ---
        server.middlewares.use("/_dev/toggle-private", (req, res) => {
          if (req.method !== "POST") {
            res.statusCode = 405;
            res.end("Method not allowed");
            return;
          }

          let body = "";
          req.on("data", (chunk: Buffer) => (body += chunk.toString()));
          req.on("end", () => {
            try {
              const { path: urlPath } = JSON.parse(body);
              const result = resolveAndTogglePrivate(urlPath);
              if (!result) {
                res.statusCode = 404;
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ error: "Not a notes page" }));
                return;
              }
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify(result));
            } catch (err) {
              res.statusCode = 500;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ error: String(err) }));
            }
          });
        });

        // --- Resolve content file path for external editor ---
        server.middlewares.use("/_dev/content-path", (req, res) => {
          if (req.method !== "POST") {
            res.statusCode = 405;
            res.end("Method not allowed");
            return;
          }

          let body = "";
          req.on("data", (chunk: Buffer) => (body += chunk.toString()));
          req.on("end", () => {
            try {
              const { path: urlPath } = JSON.parse(body);
              const result = resolveContentFile(urlPath);
              if (!result) {
                res.statusCode = 404;
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ error: "No content file found" }));
                return;
              }
              // Return path relative to content root
              const contentRoot = path.resolve(import.meta.dirname, "../content");
              const rel = path.relative(contentRoot, result.filePath);
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ contentPath: rel }));
            } catch (err) {
              res.statusCode = 500;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ error: String(err) }));
            }
          });
        });

        // --- Reorder child notes (update order frontmatter) ---
        server.middlewares.use("/_dev/reorder-children", (req, res) => {
          if (req.method !== "POST") {
            res.statusCode = 405;
            res.end("Method not allowed");
            return;
          }

          let body = "";
          req.on("data", (chunk: Buffer) => (body += chunk.toString()));
          req.on("end", () => {
            try {
              const { items } = JSON.parse(body) as {
                items: { slug: string; order: number }[];
              };
              if (!Array.isArray(items)) {
                res.statusCode = 400;
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ error: "items array required" }));
                return;
              }

              const contentRoot = path.resolve(
                import.meta.dirname,
                "../content"
              );
              const updated: string[] = [];

              for (const { slug, order } of items) {
                // Try en first, then fr
                let filePath = path.join(contentRoot, "notes", "en", `${slug}.md`);
                if (!fs.existsSync(filePath)) {
                  filePath = path.join(contentRoot, "notes", "fr", `${slug}.md`);
                }
                if (!fs.existsSync(filePath)) continue;

                let content = fs.readFileSync(filePath, "utf-8");

                if (/^order:\s*\d+\s*$/m.test(content)) {
                  content = content.replace(
                    /^order:\s*\d+\s*$/m,
                    `order: ${order}`
                  );
                } else {
                  // Add order after status line, or after draft line
                  if (/^status:/m.test(content)) {
                    content = content.replace(
                      /^(status:.*$)/m,
                      `$1\norder: ${order}`
                    );
                  } else {
                    content = content.replace(/^---\n/, `---\norder: ${order}\n`);
                  }
                }

                fs.writeFileSync(filePath, content, "utf-8");
                updated.push(slug);
              }

              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ updated, count: updated.length }));
            } catch (err) {
              res.statusCode = 500;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ error: String(err) }));
            }
          });
        });

        // --- Social sharing state ---
        server.middlewares.use("/_dev/social-state", (req, res) => {
          if (req.method !== "POST") {
            res.statusCode = 405;
            res.end("Method not allowed");
            return;
          }

          let body = "";
          req.on("data", (chunk: Buffer) => (body += chunk.toString()));
          req.on("end", () => {
            try {
              const { path: urlPath } = JSON.parse(body);
              const result = resolveContentFile(urlPath);
              if (!result || !SHAREABLE_COLLECTIONS.has(result.collection)) {
                res.statusCode = 404;
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ error: "Not a shareable page" }));
                return;
              }
              const content = fs.readFileSync(result.filePath, "utf-8");
              const fm = parseFrontmatter(content);
              const flags = parseFlagsArray(content);
              const isPublic = flags.includes("public");
              const publicUrl = `https://candide.me${urlPath}`;
              res.setHeader("Content-Type", "application/json");
              res.end(
                JSON.stringify({
                  shared_twitter: fm.shared_twitter === "true",
                  shared_linkedin: fm.shared_linkedin === "true",
                  shared_twitter_url: fm.shared_twitter_url || null,
                  shared_linkedin_urn: fm.shared_linkedin_urn || null,
                  title: fm.title || "",
                  description: fm.description || "",
                  image: fm.image || null,
                  public: isPublic,
                  url: publicUrl,
                  content_path: result.filePath,
                })
              );
            } catch (err) {
              res.statusCode = 500;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ error: String(err) }));
            }
          });
        });

        // --- Social publish ---
        server.middlewares.use("/_dev/social-publish", (req, res) => {
          if (req.method !== "POST") {
            res.statusCode = 405;
            res.end("Method not allowed");
            return;
          }

          let body = "";
          req.on("data", (chunk: Buffer) => (body += chunk.toString()));
          req.on("end", () => {
            try {
              const {
                platform,
                text,
                image_url,
                article_url,
                content_path,
              } = JSON.parse(body);

              if (!["twitter", "linkedin"].includes(platform)) {
                res.statusCode = 400;
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ error: "Invalid platform" }));
                return;
              }

              const cliPath = path.resolve(
                import.meta.dirname,
                "../../../tools/social/publish_cli.py"
              );

              const args = [
                cliPath,
                "--platform",
                platform,
                "--text",
                text,
              ];
              if (image_url) args.push("--image-url", image_url);
              if (article_url) args.push("--article-url", article_url);

              const repoRoot = path.resolve(import.meta.dirname, "../../..");
              const pythonBin = path.join(repoRoot, ".venv/bin/python");
              const child = spawn(pythonBin, args, {
                cwd: path.resolve(repoRoot, "tools/social"),
                stdio: ["ignore", "pipe", "pipe"],
              });

              let stdout = "";
              let stderr = "";
              child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
              child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));

              child.on("close", (code) => {
                if (code !== 0) {
                  res.statusCode = 500;
                  res.setHeader("Content-Type", "application/json");
                  const errMsg = stdout || stderr || `Exit code ${code}`;
                  try {
                    // stdout may already be JSON error
                    res.end(errMsg);
                  } catch {
                    res.end(JSON.stringify({ error: errMsg }));
                  }
                  return;
                }

                // Update frontmatter in content file
                try {
                  const result = JSON.parse(stdout);
                  if (content_path && fs.existsSync(content_path)) {
                    let fileContent = fs.readFileSync(content_path, "utf-8");
                    if (platform === "twitter") {
                      fileContent = setFrontmatterField(fileContent, "shared_twitter", "true");
                      if (result.url) {
                        fileContent = setFrontmatterField(fileContent, "shared_twitter_url", `"${result.url}"`);
                      }
                    } else {
                      fileContent = setFrontmatterField(fileContent, "shared_linkedin", "true");
                      if (result.post_urn) {
                        fileContent = setFrontmatterField(fileContent, "shared_linkedin_urn", `"${result.post_urn}"`);
                      }
                    }
                    fs.writeFileSync(content_path, fileContent, "utf-8");
                  }

                  res.setHeader("Content-Type", "application/json");
                  res.end(JSON.stringify({ ok: true, ...result }));
                } catch (parseErr) {
                  res.statusCode = 500;
                  res.setHeader("Content-Type", "application/json");
                  res.end(JSON.stringify({ error: `Parse error: ${stdout}` }));
                }
              });
            } catch (err) {
              res.statusCode = 500;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ error: String(err) }));
            }
          });
        });

        // --- Delete note (file + associated image) ---
        server.middlewares.use("/_dev/delete-note", (req, res) => {
          if (req.method !== "POST") {
            res.statusCode = 405;
            res.end("Method not allowed");
            return;
          }

          let body = "";
          req.on("data", (chunk: Buffer) => (body += chunk.toString()));
          req.on("end", () => {
            try {
              const { path: urlPath } = JSON.parse(body);
              const result = resolveContentFile(urlPath);
              if (!result || !result.isNotes) {
                res.statusCode = 404;
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ error: "Not a notes page" }));
                return;
              }

              // Delete the note file
              fs.unlinkSync(result.filePath);

              // Delete associated image if it exists
              const noteId = path.basename(result.filePath, path.extname(result.filePath));
              const imagesDir = path.resolve(import.meta.dirname, "../content/images/notes");
              for (const ext of [".jpg", ".png", ".svg", ".webp"]) {
                const imgPath = path.join(imagesDir, `${noteId}${ext}`);
                if (fs.existsSync(imgPath)) {
                  fs.unlinkSync(imgPath);
                }
              }

              // Remove wikilinks referencing this note from other .md files
              const contentRoot = path.resolve(import.meta.dirname, "../content");
              const notesDir = path.join(contentRoot, "notes");
              const wikiLinkPattern = new RegExp(`^\\[\\[${noteId}(\\|[^\\]]*)?\\]\\]\\s*\\n?`, "gm");
              for (const locale of ["en", "fr"]) {
                const localeDir = path.join(notesDir, locale);
                if (!fs.existsSync(localeDir)) continue;
                for (const file of fs.readdirSync(localeDir)) {
                  if (!file.endsWith(".md") && !file.endsWith(".mdx")) continue;
                  const filePath = path.join(localeDir, file);
                  const content = fs.readFileSync(filePath, "utf-8");
                  if (content.includes(`[[${noteId}`)) {
                    const updated = content.replace(wikiLinkPattern, "");
                    fs.writeFileSync(filePath, updated, "utf-8");
                  }
                }
              }

              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ deleted: noteId }));
            } catch (err) {
              res.statusCode = 500;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ error: String(err) }));
            }
          });
        });

        // --- Get public state without toggling ---
        server.middlewares.use("/_dev/public-state", (req, res) => {
          if (req.method !== "POST") {
            res.statusCode = 405;
            res.end("Method not allowed");
            return;
          }

          let body = "";
          req.on("data", (chunk: Buffer) => (body += chunk.toString()));
          req.on("end", () => {
            try {
              const { path: urlPath } = JSON.parse(body);
              const result = resolveContentFile(urlPath);
              if (!result) {
                res.statusCode = 404;
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ error: "No content file found" }));
                return;
              }
              const content = fs.readFileSync(result.filePath, "utf-8");
              const flags = parseFlagsArray(content);
              const isPublic = flags.includes("public");
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ file: result.filePath, public: isPublic }));
            } catch (err) {
              res.statusCode = 500;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ error: String(err) }));
            }
          });
        });

        // --- Auto-regenerate coaching adherence pages on visit ---
        // Serve the page immediately; regenerate in the background.
        // Astro's HMR picks up file changes and hot-reloads the browser.
        const ADHERENCE_RE = /^\/fr\/notes\/bilan-(.+?)\/?$/;
        const repoRoot = path.resolve(import.meta.dirname, "../../..");
        const pythonBin = path.join(repoRoot, ".venv/bin/python");

        // Debounce: skip if already regenerated recently
        const recentlyRegenerated = new Map<string, number>();

        server.middlewares.use((req, res, next) => {
          // Strip query string before matching
          const urlPath = (req.url || "").split("?")[0];
          const match = ADHERENCE_RE.exec(urlPath);
          if (!match) return next();

          const slug = match[1];

          // Skip if regenerated in the last 30 seconds
          const regenTime = recentlyRegenerated.get(slug);
          if (regenTime && Date.now() - regenTime < 30_000) {
            return next();
          }

          // Serve page immediately, regenerate in background
          recentlyRegenerated.set(slug, Date.now());
          console.log(`[adherence] Regenerating bilan-${slug} in background`);
          const child = spawn(pythonBin, ["-m", "tools.signals.adherence", "--slug", slug], {
            cwd: repoRoot,
            stdio: ["ignore", "pipe", "pipe"],
            detached: true,
          });
          let stderr = "";
          child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
          child.on("exit", (code) => {
            if (code === 0) {
              console.log(`[adherence] bilan-${slug} regenerated OK`);
            } else {
              console.error(`[adherence] bilan-${slug} failed (exit ${code}): ${stderr.slice(0, 500)}`);
            }
          });
          child.on("error", (err) => {
            console.error(`[adherence] spawn error for bilan-${slug}:`, err.message);
          });
          child.unref();

          return next();
        });
      },
    },
  };
}

const SHAREABLE_COLLECTIONS = new Set(["blog", "essays", "books", "movies", "series", "podcasts", "articles"]);

const URL_PREFIX_MAP: Record<string, string> = {
  blog: "blog",
  essays: "essays",
  essais: "essays",
  notes: "notes",
};

const RESOURCE_PREFIX_MAP: Record<string, string> = {
  movies: "movies",
  films: "movies",
  books: "books",
  livres: "books",
  articles: "articles",
  podcasts: "podcasts",
  series: "series",
  people: "people",
};

function resolveContentFile(
  urlPath: string
): { filePath: string; isNotes: boolean; collection: string } | null {
  const contentRoot = path.resolve(import.meta.dirname, "../content");

  // Strip locale prefix
  let locale = "en";
  const localeMatch = urlPath.match(/^\/fr(\/.*)/);
  if (localeMatch) {
    locale = "fr";
    urlPath = localeMatch[1];
  }

  // Remove trailing slash
  urlPath = urlPath.replace(/\/$/, "");

  // Check /fiches/{collection}/{slug} — re-insert locale to find content file
  const ficheMatch = urlPath.match(/^\/fiches\/([^/]+)\/(.+)$/);
  if (ficheMatch) {
    const filePath = path.join(contentRoot, ficheMatch[1], locale, `${ficheMatch[2]}.md`);
    return fs.existsSync(filePath) ? { filePath, isNotes: false, collection: ficheMatch[1] } : null;
  }

  let collection: string | undefined;
  let id: string | undefined;

  // Check /resources/{type}/{id} or /trouvailles/{type}/{id}
  if (!collection) {
    const resourceMatch = urlPath.match(
      /^\/(resources|trouvailles)\/([^/]+)\/(.+)$/
    );
    if (resourceMatch) {
      const typeSlug = resourceMatch[2];
      collection = RESOURCE_PREFIX_MAP[typeSlug];
      id = resourceMatch[3];
    } else {
      // Check /prefix/{id}
      const simpleMatch = urlPath.match(/^\/([^/]+)\/(.+)$/);
      if (simpleMatch) {
        collection = URL_PREFIX_MAP[simpleMatch[1]];
        id = simpleMatch[2];
      }
    }
  }

  if (!collection || !id) return null;

  const dir = path.join(contentRoot, collection, locale);

  // Try .md first, then .mdx (essays use .mdx)
  let filePath = path.join(dir, `${id}.md`);
  if (!fs.existsSync(filePath)) {
    filePath = path.join(dir, `${id}.mdx`);
  }
  return fs.existsSync(filePath) ? { filePath, isNotes: collection === "notes", collection } : null;
}

function resolveAndTogglePublic(
  urlPath: string
): { file: string; public: boolean } | null {
  const result = resolveContentFile(urlPath);
  if (!result) return null;

  let content = fs.readFileSync(result.filePath, "utf-8");
  const { content: updated, enabled } = toggleFlag(content, "public");
  fs.writeFileSync(result.filePath, updated, "utf-8");
  return { file: result.filePath, public: enabled };
}

function resolveAndTogglePrivate(
  urlPath: string
): { file: string; private: boolean } | null {
  const result = resolveContentFile(urlPath);
  if (!result || !result.isNotes) return null;

  let content = fs.readFileSync(result.filePath, "utf-8");
  const { content: updated, enabled } = toggleFlag(content, "encrypted");
  fs.writeFileSync(result.filePath, updated, "utf-8");
  return { file: result.filePath, private: enabled };
}

/** Simple frontmatter key-value parser (reads between --- fences). */
function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const fm: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    fm[key] = val;
  }
  return fm;
}

/** Parse the flags array from frontmatter content. */
function parseFlagsArray(content: string): string[] {
  // Flow style: flags: [public, moc]
  const flowMatch = content.match(/^flags:\s*\[([^\]]*)\]\s*$/m);
  if (flowMatch) {
    return flowMatch[1].split(",").map(s => s.trim()).filter(Boolean);
  }
  // Block style: flags:\n  - public\n  - moc
  const blockMatch = content.match(/^flags:\s*\n((?:\s+-\s+.+\n?)*)/m);
  if (blockMatch) {
    return blockMatch[1].match(/^\s+-\s+(.+)$/gm)?.map(l => l.replace(/^\s+-\s+/, "").trim()) ?? [];
  }
  return [];
}

/** Toggle a flag in the flags array. Returns updated content and new state. */
function toggleFlag(content: string, flag: string): { content: string; enabled: boolean } {
  const flags = parseFlagsArray(content);
  let enabled: boolean;

  if (flags.includes(flag)) {
    // Remove the flag
    const newFlags = flags.filter(f => f !== flag);
    enabled = false;
    content = replaceFlagsLine(content, newFlags);
  } else {
    // Add the flag
    flags.push(flag);
    enabled = true;
    content = replaceFlagsLine(content, flags);
  }

  return { content, enabled };
}

/** Replace or insert the flags line in frontmatter (flow style). */
function replaceFlagsLine(content: string, flags: string[]): string {
  const flagsLine = `flags: [${flags.join(", ")}]`;
  // Replace existing flags line (flow style)
  if (/^flags:\s*\[.*\]\s*$/m.test(content)) {
    return content.replace(/^flags:\s*\[.*\]\s*$/m, flagsLine);
  }
  // Replace block-style flags
  if (/^flags:\s*\n(?:\s+-\s+.+\n?)*/m.test(content)) {
    return content.replace(/^flags:\s*\n(?:\s+-\s+.+\n?)*/m, flagsLine + "\n");
  }
  // No flags line — insert after tags or at top of frontmatter
  if (/^tags:/m.test(content)) {
    // Insert after the tags block
    return content.replace(/^(tags:.*(?:\n\s+-\s+.+)*)$/m, `$1\n${flagsLine}`);
  }
  return content.replace(/^---\n/, `---\n${flagsLine}\n`);
}

/** Set or add a frontmatter field in file content. */
function setFrontmatterField(content: string, key: string, value: string): string {
  const regex = new RegExp(`^${key}:.*$`, "m");
  if (regex.test(content)) {
    return content.replace(regex, `${key}: ${value}`);
  }
  // Add before the closing ---
  return content.replace(/\n---/, `\n${key}: ${value}\n---`);
}
