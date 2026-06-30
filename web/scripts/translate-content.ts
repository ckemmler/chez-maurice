#!/usr/bin/env npx tsx
/**
 * Content auto-translation script using Claude API.
 *
 * Scans content directories for files with translationKey but no counterpart
 * in the other locale, then translates them using Claude.
 *
 * Usage:
 *   npx tsx scripts/translate-content.ts           # translate missing content
 *   npx tsx scripts/translate-content.ts --dry-run  # preview what would be translated
 *   npx tsx scripts/translate-content.ts --force    # retranslate even if cached
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";

import jsYaml from "js-yaml";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");

// Load .env from monorepo root (parent of akita-web)
const envPath = path.resolve(PROJECT_ROOT, "..", ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const match = line.match(/^\s*([^#=]+?)\s*=\s*(.*)\s*$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  }
}
const CONTENT_DIR = path.join(PROJECT_ROOT, "src", "content");
const STATE_FILE = path.join(PROJECT_ROOT, ".translation-state.json");

const COLLECTIONS = [
  "books", "articles", "blog", "essays",
  "podcasts", "movies", "series", "people", "pages",
];
const LOCALES = ["en", "fr"] as const;
type Locale = (typeof LOCALES)[number];

interface TranslationState {
  [filePath: string]: {
    hash: string;
    translatedTo: string; // path of the translated file
    timestamp: string;
  };
}

interface ContentFile {
  path: string;
  relativePath: string;
  collection: string;
  locale: Locale;
  translationKey: string;
  hash: string;
  content: string;
}

const isDryRun = process.argv.includes("--dry-run");
const isForce = process.argv.includes("--force");

function resolveModel(invocation: string, fallback = "claude-sonnet-4-5-20250929"): string {
  const configPath = path.resolve(PROJECT_ROOT, "..", "models.yml");
  try {
    const raw = jsYaml.load(fs.readFileSync(configPath, "utf-8")) as Record<string, any>;
    const models: Record<string, string> = raw?.models ?? {};
    const assignments: Record<string, string> = raw?.model_assignments ?? {};
    const alias = assignments[invocation];
    if (alias) return models[alias] ?? alias;
  } catch { /* config not found — use fallback */ }
  return fallback;
}

async function main() {
  console.log(isDryRun ? "🔍 Dry run mode — no files will be written\n" : "🌐 Starting content translation...\n");

  // Load cached state
  const state = loadState();

  // Scan all content files
  const files = scanContentFiles();
  console.log(`Found ${files.length} content files with translationKey\n`);

  // Group by translationKey
  const byKey = new Map<string, ContentFile[]>();
  for (const file of files) {
    const existing = byKey.get(file.translationKey) ?? [];
    existing.push(file);
    byKey.set(file.translationKey, existing);
  }

  // Find files needing translation
  const toTranslate: { source: ContentFile; targetLocale: Locale }[] = [];

  for (const [key, variants] of byKey) {
    const localesPresent = new Set(variants.map((v) => v.locale));

    for (const variant of variants) {
      const otherLocale: Locale = variant.locale === "en" ? "fr" : "en";

      if (!localesPresent.has(otherLocale)) {
        // No counterpart exists
        const cached = state[variant.path];
        if (!isForce && cached && cached.hash === variant.hash) {
          // Already translated and source hasn't changed
          continue;
        }
        toTranslate.push({ source: variant, targetLocale: otherLocale });
      } else if (!isForce) {
        // Check if source changed since last translation
        const cached = state[variant.path];
        if (cached && cached.hash !== variant.hash) {
          toTranslate.push({ source: variant, targetLocale: variant.locale === "en" ? "fr" : "en" });
        }
      }
    }
  }

  if (toTranslate.length === 0) {
    console.log("✅ All content is up to date — nothing to translate.");
    return;
  }

  console.log(`📝 ${toTranslate.length} file(s) to translate:\n`);
  for (const { source, targetLocale } of toTranslate) {
    console.log(`  ${source.relativePath} → ${targetLocale}`);
  }

  if (isDryRun) {
    console.log("\n🔍 Dry run complete. Run without --dry-run to translate.");
    return;
  }

  // Initialize Claude client
  const client = new Anthropic();

  for (const { source, targetLocale } of toTranslate) {
    console.log(`\n🔄 Translating: ${source.relativePath} → ${targetLocale}`);

    try {
      const translated = await translateContent(client, source, targetLocale);
      const targetPath = getTargetPath(source, targetLocale, translated.slug);

      // Ensure directory exists
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });

      // Write translated file
      fs.writeFileSync(targetPath, translated.content, "utf-8");
      console.log(`  ✅ Written: ${path.relative(PROJECT_ROOT, targetPath)}`);

      // Update state
      state[source.path] = {
        hash: source.hash,
        translatedTo: targetPath,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      console.error(`  ❌ Failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  // Save state
  saveState(state);
  console.log("\n✅ Translation complete.");
}

function loadState(): TranslationState {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function saveState(state: TranslationState): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

function hashFile(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function scanContentFiles(): ContentFile[] {
  const files: ContentFile[] = [];

  for (const collection of COLLECTIONS) {
    for (const locale of LOCALES) {
      const dir = path.join(CONTENT_DIR, collection, locale);
      if (!fs.existsSync(dir)) continue;

      const entries = fs.readdirSync(dir).filter((f) => f.endsWith(".md") || f.endsWith(".mdx"));
      for (const entry of entries) {
        const filePath = path.join(dir, entry);
        const content = fs.readFileSync(filePath, "utf-8");
        const frontmatter = parseFrontmatter(content);

        if (!frontmatter.translationKey) continue;

        files.push({
          path: filePath,
          relativePath: path.relative(PROJECT_ROOT, filePath),
          collection,
          locale,
          translationKey: frontmatter.translationKey,
          hash: hashFile(content),
          content,
        });
      }
    }
  }

  return files;
}

function parseFrontmatter(content: string): Record<string, any> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};

  const result: Record<string, any> = {};
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value: any = line.slice(colonIdx + 1).trim();
    // Strip quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

async function translateContent(
  client: Anthropic,
  source: ContentFile,
  targetLocale: Locale
): Promise<{ content: string; slug: string }> {
  const sourceLang = source.locale === "en" ? "English" : "French";
  const targetLang = targetLocale === "en" ? "English" : "French";

  const response = await client.messages.create({
    model: resolveModel("translation"),
    max_tokens: 4096,
    messages: [
      {
        role: "user",
        content: `Translate this markdown file from ${sourceLang} to ${targetLang}.

Rules:
- Preserve ALL frontmatter fields exactly (dates, URLs, ratings, numbers, booleans, image paths)
- Do NOT modify the "image" field — keep the exact same path
- Translate the "title" field value
- Translate the "description" field value if present
- Change the "locale" field to "${targetLocale}"
- Add "isTranslation: true" to frontmatter
- Keep the "translationKey" field unchanged
- Translate the markdown body content naturally
- Preserve all markdown formatting (headers, links, blockquotes, lists, code blocks)
- Preserve any internal site links but translate their path segments if they are human-readable
- Do NOT add any explanation — return ONLY the complete translated markdown file
- Also provide a translated URL slug for the filename (lowercase, hyphenated, no accents)

Return your response in this exact format:
SLUG: translated-slug-here
---
(frontmatter)
---
(body)

Here is the file to translate:

${source.content}`,
      },
    ],
  });

  const text = response.content[0].type === "text" ? response.content[0].text : "";

  // Parse slug from response
  const slugMatch = text.match(/^SLUG:\s*(.+)/m);
  const slug = slugMatch?.[1]?.trim() ?? path.basename(source.path, path.extname(source.path));

  // Extract the markdown content (everything after the SLUG line)
  const mdStart = text.indexOf("---");
  const content = mdStart !== -1 ? text.slice(mdStart) : text;

  return { content, slug };
}

function getTargetPath(source: ContentFile, targetLocale: Locale, slug: string): string {
  const ext = path.extname(source.path);
  return path.join(CONTENT_DIR, source.collection, targetLocale, `${slug}${ext}`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
