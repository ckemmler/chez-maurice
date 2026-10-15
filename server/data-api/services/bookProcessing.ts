/**
 * Extracting a book's chapters and summarizing them — in the server, so a
 * hosted household can do both.
 *
 * Both used to be the private `tools/calibre` (Python), which the production
 * image leaves out, and the summary called Nebius with its own key, past the
 * household's provider and its budget. Here:
 *
 *   - **extraction** cuts the EPUB with `epubChapters.ts` and writes
 *     `chapters/NNNN-<title>.txt` into the book's artifact directory;
 *   - **summarization** goes through the `chapter_summary` ancillary
 *     invocation — the household's default model unless the admin pins another
 *     — under the member's budget, and writes
 *     `chapter_summaries/<chapter>.summary.txt` plus its `metadata.json` entry.
 *
 * The prompts, the chaining and the chunking are the Python pipeline's
 * (`prompts.py`, `nebius_summarize.py`, pipeline `context-chained-v1`), so a
 * book summarized here reads like one summarized at home: every chapter is
 * condensed with the summaries of the chapters before it as context, and a
 * chapter already summarized is read for context and left alone — which also
 * makes a run resumable after a restart.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { ancillaryComplete, ancillaryModel } from "../../src/services/ancillary";
import { recordSpend, verdict } from "../../src/services/budget";
import { getModel } from "../../src/services/models";
import { getBookFile, getBookMetadata, getLibraryRoot, shouldSkipChapter } from "./calibre";
import { artifactsDirForBookPath, CHAPTERS_DIR, invalidateArtifactsListing, SUMMARIES_DIR } from "./calibreArtifacts";
import { chapterFileName, epubSections } from "./epubChapters";

export class BookProcessingError extends Error {
  constructor(message: string, public readonly status = 422) {
    super(message);
  }
}

async function bookDir(bookId: number) {
  const meta = await getBookMetadata(bookId);
  if (!meta) throw new BookProcessingError("Book not found", 404);
  return { meta, dir: artifactsDirForBookPath(getLibraryRoot(), meta.bookPath) };
}

// ── Extraction ──

/** Cut the book's EPUB into chapters. A previous extraction is replaced only
 *  once the new one is written, so a failure leaves the old chapters in place. */
export async function extractChapters(bookId: number): Promise<{ chapters: number; format: "EPUB" }> {
  const { dir } = await bookDir(bookId);
  const epub = await getBookFile(bookId, "EPUB");
  if (!epub) throw new BookProcessingError("This book has no EPUB file to split into chapters.");

  const sections = epubSections(await fs.readFile(epub));
  if (!sections.length) throw new BookProcessingError("No text was found in this book.");

  const chaptersDir = path.join(dir, CHAPTERS_DIR);
  const staging = path.join(dir, `.chapters-${process.pid}-${Date.now()}`);
  await fs.mkdir(staging, { recursive: true });
  try {
    for (const [i, s] of sections.entries()) {
      await fs.writeFile(path.join(staging, chapterFileName(i + 1, s.title)), s.text, "utf-8");
    }
    await fs.rm(chaptersDir, { recursive: true, force: true });
    await fs.rename(staging, chaptersDir);
  } catch (err) {
    await fs.rm(staging, { recursive: true, force: true });
    throw err;
  }
  invalidateArtifactsListing();
  return { chapters: sections.length, format: "EPUB" };
}

// ── Summarization ──

const PIPELINE = "context-chained-v1";
const CHUNK_WORDS = 60_000;

const SYSTEM_PROMPT =
  "You are a skilled writer producing condensed chapter summaries. " +
  "Write as if you were the book's author distilling your own work — " +
  "use the same tone, vocabulary, and perspective as the original text. " +
  "Your summaries are 300–500 words of flowing prose. " +
  'Never refer to "the chapter" or "the author" — just convey the substance directly. ' +
  "Always write in the same language as the chapter text.";

/** The user message: the story so far, then the chapter. Word for word the
 *  Python pipeline's `build_summarization_prompt`. */
export function summarizationPrompt(chapterText: string, prior: Array<[string, string]>, fiction: boolean): string {
  const parts: string[] = [];
  if (prior.length) {
    parts.push(`## ${fiction ? "Story so far" : "Book so far"}\n`);
    parts.push("Here is what has happened in the book up to this point:\n");
    for (const [name, summary] of prior) parts.push(`### ${name}\n${summary}\n`);
    parts.push("---\n");
  }
  parts.push("## Current chapter\n");
  parts.push(
    fiction
      ? "Condense this chapter into 300–500 words of flowing narrative prose. " +
        "Retell what happens — who does what, key events, what changes, what's revealed. " +
        "Write in present tense, in the voice and style of the original. " +
        "Do NOT use bullet points, lists, or meta-commentary about the text.\n"
      : "Condense this chapter into 300–500 words of flowing prose. " +
        "Capture the key arguments, how ideas build on or complicate what came before, " +
        "new concepts introduced, and any unresolved tensions. " +
        "Write in the voice and style of the original — as a condensed version, not a review. " +
        "Do NOT use bullet points, lists, or meta-commentary about the text.\n",
  );
  parts.push(chapterText);
  return parts.join("\n");
}

/** Fiction is a tag. Calibre's own (`Fiction`) and the subject headings a
 *  library imports (`England -- Fiction`) both say so; `Non-fiction` does not. */
export function isFiction(tags: string[]): boolean {
  const lower = tags.map((t) => t.toLowerCase());
  return lower.some((t) => /\bfiction\b/.test(t)) && !lower.some((t) => /\bnon-?fiction\b/.test(t));
}

function chunkWords(text: string, size = CHUNK_WORDS): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += size) chunks.push(words.slice(i, i + size).join(" "));
  return chunks;
}

async function writeMeta(summariesDir: string, stem: string, model: string, contextChapters: number) {
  const file = path.join(summariesDir, "metadata.json");
  let meta: Record<string, unknown> = {};
  try { meta = JSON.parse(await fs.readFile(file, "utf-8")); } catch { /* none yet */ }
  meta[stem] = {
    model,
    timestamp: new Date().toISOString().slice(0, 19),
    pipeline: PIPELINE,
    context_chapters: contextChapters,
  };
  await fs.writeFile(file, JSON.stringify(meta, null, 2) + "\n", "utf-8");
}

export interface SummarizeResult {
  created: number;
  skipped: number;
  model: string;
}

/**
 * Summarize every chapter that has no summary yet, in order, in `memberId`'s
 * name. Stops at the first failure — a refusal, an empty answer, the budget —
 * with what was written so far kept, so asking again resumes there.
 */
export async function summarizeChapters(
  bookId: number,
  memberId: string,
  /** The model call — the ancillary door; a test hands in its own. */
  complete: typeof ancillaryComplete = ancillaryComplete,
): Promise<SummarizeResult> {
  const { meta, dir } = await bookDir(bookId);
  const chaptersDir = path.join(dir, CHAPTERS_DIR);
  const summariesDir = path.join(dir, SUMMARIES_DIR);

  let files: string[];
  try {
    files = (await fs.readdir(chaptersDir))
      .filter((f) => f.toLowerCase().endsWith(".txt") && !f.includes(".summary"))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    throw new BookProcessingError("No chapters yet: extract them first.", 409);
  }
  const chapters: Array<{ file: string; text: string }> = [];
  for (const file of files) {
    const text = await fs.readFile(path.join(chaptersDir, file), "utf-8");
    if (!shouldSkipChapter(file, Buffer.byteLength(text, "utf-8"))) chapters.push({ file, text });
  }
  if (!chapters.length) throw new BookProcessingError("No chapters yet: extract them first.", 409);

  await fs.mkdir(summariesDir, { recursive: true });
  const modelId = ancillaryModel("chapter_summary");
  const provider = getModel(modelId)?.provider ?? null;
  const fiction = isFiction(meta.tags);
  const jobId = `chapter-summary:${bookId}`;

  const prior: Array<[string, string]> = [];
  let created = 0;
  let skipped = 0;

  const ask = async (prompt: string): Promise<string> => {
    const v = verdict(provider, modelId, 0, memberId);
    if (!v.ok) throw new BookProcessingError(v.reason ?? "The spending limit is reached.", 429);
    const r = await complete({
      invocation: "chapter_summary",
      system: SYSTEM_PROMPT,
      prompt,
      maxTokens: 4000,
      temperature: 0.3,
    });
    recordSpend(r.usage, memberId, jobId);
    if (r.stop === "refusal") throw new BookProcessingError(`${r.model} declined to summarize this chapter.`, 502);
    if (!r.text.trim()) throw new BookProcessingError(`${r.model} returned an empty summary.`, 502);
    return r.text.trim();
  };

  for (const { file, text } of chapters) {
    const stem = file.replace(/\.txt$/i, "");
    const name = stem.replace(/^\d+-/, "");
    const summaryFile = path.join(summariesDir, `${stem}.summary.txt`);

    try {
      prior.push([name, await fs.readFile(summaryFile, "utf-8")]);
      skipped++;
      continue;
    } catch { /* not summarized yet */ }

    const words = text.split(/\s+/).filter(Boolean).length;
    let summary: string;
    if (words > CHUNK_WORDS) {
      // Only the first piece gets the story so far, as in the Python pipeline.
      const pieces: string[] = [];
      for (const [i, chunk] of chunkWords(text).entries()) {
        pieces.push(await ask(summarizationPrompt(chunk, i === 0 ? prior : [], fiction)));
      }
      summary = pieces.join("\n\n---\n\n");
    } else {
      summary = await ask(summarizationPrompt(text, prior, fiction));
    }

    await fs.writeFile(summaryFile, summary, "utf-8");
    await writeMeta(summariesDir, stem, modelId, prior.length);
    prior.push([name, summary]);
    created++;
  }

  return { created, skipped, model: modelId };
}
