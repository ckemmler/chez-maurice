/**
 * Stub script for importing content from Akita sources.
 *
 * This script will eventually:
 * - Read book metadata from Calibre/Akita corpus
 * - Import Readwise highlights
 * - Generate book/article pages from corpus entries
 *
 * For now, it demonstrates the intended structure.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const CONTENT_DIR = path.join(import.meta.dirname, "../src/content");
const AKITA_ROOT = path.join(import.meta.dirname, "../../.."); // Adjust based on actual layout

interface BookImport {
  title: string;
  author: string;
  dateRead: string;
  status: "read" | "reading" | "abandoned";
  tags: string[];
  rating?: number;
  notes?: string;
  highlights?: string[];
}

interface ArticleImport {
  title: string;
  author?: string;
  source: string;
  url: string;
  dateRead: string;
  tags: string[];
  notes?: string;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function generateBookMarkdown(book: BookImport): string {
  const frontmatter = [
    "---",
    `title: "${book.title.replace(/"/g, '\\"')}"`,
    `author: "${book.author.replace(/"/g, '\\"')}"`,
    `date_read: ${book.dateRead}`,
    `status: "${book.status}"`,
    `tags: [${book.tags.map((t) => `"${t}"`).join(", ")}]`,
  ];

  if (book.rating) {
    frontmatter.push(`rating: ${book.rating}`);
  }

  frontmatter.push("---", "");

  const content = [frontmatter.join("\n")];

  if (book.notes) {
    content.push(book.notes, "");
  }

  if (book.highlights?.length) {
    content.push("## Highlights", "");
    for (const highlight of book.highlights) {
      content.push(`> ${highlight}`, "");
    }
  }

  return content.join("\n");
}

function generateArticleMarkdown(article: ArticleImport): string {
  const frontmatter = [
    "---",
    `title: "${article.title.replace(/"/g, '\\"')}"`,
  ];

  if (article.author) {
    frontmatter.push(`author: "${article.author.replace(/"/g, '\\"')}"`);
  }

  frontmatter.push(
    `source: "${article.source}"`,
    `url: "${article.url}"`,
    `date_read: ${article.dateRead}`,
    `tags: [${article.tags.map((t) => `"${t}"`).join(", ")}]`,
    "---",
    ""
  );

  const content = [frontmatter.join("\n")];

  if (article.notes) {
    content.push(article.notes);
  }

  return content.join("\n");
}

async function importBooks(books: BookImport[]): Promise<void> {
  const booksDir = path.join(CONTENT_DIR, "books");
  fs.mkdirSync(booksDir, { recursive: true });

  for (const book of books) {
    const filename = `${slugify(book.title)}.md`;
    const filepath = path.join(booksDir, filename);
    const content = generateBookMarkdown(book);
    fs.writeFileSync(filepath, content);
    console.log(`Created: ${filename}`);
  }
}

async function importArticles(articles: ArticleImport[]): Promise<void> {
  const articlesDir = path.join(CONTENT_DIR, "articles");
  fs.mkdirSync(articlesDir, { recursive: true });

  for (const article of articles) {
    const filename = `${slugify(article.title)}.md`;
    const filepath = path.join(articlesDir, filename);
    const content = generateArticleMarkdown(article);
    fs.writeFileSync(filepath, content);
    console.log(`Created: ${filename}`);
  }
}

// Main entry point
async function main(): Promise<void> {
  console.log("Akita Import Script");
  console.log("===================");
  console.log("");
  console.log("This is a stub. Future implementation will:");
  console.log("- Connect to Akita corpus for book/article metadata");
  console.log("- Fetch Readwise highlights via the MCP server");
  console.log("- Generate content files with proper frontmatter");
  console.log("");
  console.log("For now, create content files manually in src/content/");
}

main().catch(console.error);
