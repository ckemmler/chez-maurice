import { promises as fs } from "node:fs";
import path from "node:path";

import type { BookMetadata, ChapterInfo } from "./calibre";

const TEMPLATE_PATH =
  process.env.CALIBRE_ARTIFACT_TEMPLATE ??
  path.resolve(
    process.cwd(),
    "../tools/calibre/templates/book_browser.html",
  );

let cachedTemplate: string | null = null;

async function loadTemplate(): Promise<string> {
  if (cachedTemplate) {
    return cachedTemplate;
  }

  cachedTemplate = await fs.readFile(TEMPLATE_PATH, "utf-8");
  return cachedTemplate;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

interface RenderOptions {
  book: BookMetadata;
  chapters: ChapterInfo[];
  apiBaseUrl: string;
  apiKey: string;
  bookId: number;
}

export async function renderBookBrowserArtifact(
  options: RenderOptions,
): Promise<string> {
  const template = await loadTemplate();
  const { book, chapters, apiBaseUrl, apiKey, bookId } = options;
  const authors = book.authors.join(", ");

  const chapterPayload = JSON.stringify(
    chapters.map((chapter) => ({
      index: chapter.index,
      title: chapter.title,
      wordCount: chapter.wordCount,
      hasSummary: chapter.hasSummary,
    })),
  );

  const replacements: Record<string, string> = {
    book_title: escapeHtml(book.title),
    authors: escapeHtml(authors),
    chapter_count: `${chapters.length}`,
    api_base_url: JSON.stringify(apiBaseUrl),
    api_key: JSON.stringify(apiKey),
    book_id: `${bookId}`,
    chapters_json: chapterPayload,
  };

  let rendered = template;
  for (const [key, value] of Object.entries(replacements)) {
    const pattern = new RegExp(`{{${key}}}`, "g");
    rendered = rendered.replace(pattern, value);
  }

  return rendered;
}
