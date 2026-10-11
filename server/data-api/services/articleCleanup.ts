/**
 * Clearing a saved article's text of what is not the article.
 *
 * Readability keeps most of a page's furniture out, not all of it: a rubric
 * above the title, the title again, a photo credit, the date, "Advertisement"
 * between two paragraphs, a newsletter box at the foot. The reader shows the
 * title, the publication and the date itself, so all of that is noise on top
 * of the text.
 *
 * The model is asked which blocks to leave out, by number — never to write
 * the text again. What stays is the author's words, untouched: a model that
 * rewrites nineteen minutes of reading will sooner or later shorten a
 * paragraph, and nobody would see it. It also makes the pass cheap (the answer
 * is a short list) and lets the code refuse an answer that goes too far.
 *
 * Runs after the save has answered, before the summary, on the admin's model
 * for the `article_cleanup` invocation.
 */

import fs from "node:fs";
import path from "node:path";
import { ancillaryComplete } from "../../src/services/ancillary";
import { atomicWrite, autoCommit, fragmentsDir, gardenFor, parseFiche, writeFiche } from "./gardenFiche";
import { indexGardenPaths } from "./gardenIndex";
import { countArticleHighlights } from "./articleHighlights";
import type { ArticleFicheRef } from "./gardenArticles";

/** What the model sees of each block: enough to tell a paragraph from a label. */
const PREVIEW_CHARS = 160;
/** A block this long is a paragraph. No answer drops one. */
const MAX_DROPPED_BLOCK_CHARS = 400;
/** Past this share of the text, the answer is not a cleanup and is ignored. */
const MAX_DROPPED_SHARE = 0.25;
/** Below this there is nothing to tell apart. */
const MIN_BLOCKS = 3;

const SYSTEM = [
  "You are given the text of a web article as numbered blocks, as a page extractor captured it.",
  "Some blocks are not part of the article and must be left out. Name them.",
  "",
  "Leave out:",
  "- what repeats the header the reader already sees: the rubric or section name, the title, the standfirst said twice, the author line, the date, the reading time;",
  "- photo and illustration credits, and captions of pictures that are not shown;",
  "- advertising markers (\"Advertisement\", \"Publicité\", \"Skip advertisement\", \"Sponsored\");",
  "- the site's own furniture: share and follow buttons, newsletter and subscription prompts, cookie and login notices, \"read also\" and related links, comment counts, audio player labels, corrections of the form \"A version of this article appears in print…\".",
  "",
  "Keep everything the author wrote: every paragraph, subheading, quotation, list item, question of an interview, and the author's note about themselves at the end.",
  "When in doubt, keep.",
  "",
  "Answer with JSON and nothing else: {\"drop\": [block numbers]}. An empty list when every block belongs.",
].join("\n");

export interface CleanupInput {
  title: string;
  publication?: string;
  author?: string;
  /** What the fiche already holds. A date or an author it does not hold stays in the text. */
  publishedAt?: string;
  text: string;
}

/** The text's blocks — what the extraction separated with a blank line. */
export function splitBlocks(text: string): string[] {
  return text.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
}

function buildPrompt(input: CleanupInput, blocks: string[]): string {
  const head = [
    `Title: ${input.title}`,
    input.publication ? `Publication: ${input.publication}` : "",
    input.author ? `Author: ${input.author}` : "",
    input.publishedAt ? `Published: ${input.publishedAt}` : "",
    // The header is only noise where the fiche says the same thing. What the
    // page's metadata did not give exists nowhere else: it stays in the text,
    // where a search by date or by name will still find it.
    input.publishedAt ? "" : "The publication date is not known from elsewhere: KEEP the block that gives it.",
    input.author ? "" : "The author is not known from elsewhere: KEEP the block that names them.",
  ].filter(Boolean);
  const lines = blocks.map((b, i) => {
    const flat = b.replace(/\s+/g, " ");
    return `[${i}] ${flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS)}… (${flat.length} characters)` : flat}`;
  });
  return [...head, "", ...lines].join("\n");
}

/** The numbers the model named, out of whatever it wrapped them in. */
export function parseDropList(answer: string, blockCount: number): number[] | null {
  const json = answer.match(/\{[\s\S]*\}/)?.[0];
  if (!json) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed?.drop)) return null;
  const seen = new Set<number>();
  for (const n of parsed.drop) {
    if (Number.isInteger(n) && n >= 0 && n < blockCount) seen.add(n);
  }
  return [...seen].sort((a, b) => a - b);
}

/**
 * Apply a drop list, within the limits above: a long block always stays, and
 * an answer that would remove too much of the text is refused whole (`null`).
 */
export function applyDropList(blocks: string[], drop: number[]): string[] | null {
  const out = new Set(drop.filter((i) => (blocks[i] ?? "").length <= MAX_DROPPED_BLOCK_CHARS));
  const total = blocks.reduce((n, b) => n + b.length, 0);
  const dropped = [...out].reduce((n, i) => n + (blocks[i] ?? "").length, 0);
  if (total && dropped / total > MAX_DROPPED_SHARE) return null;
  return blocks.filter((_, i) => !out.has(i));
}

/** The text without its furniture, or `null` when there is nothing to change. */
export async function cleanArticleText(input: CleanupInput): Promise<string | null> {
  const blocks = splitBlocks(input.text);
  if (blocks.length < MIN_BLOCKS) return null;

  const result = await ancillaryComplete({
    invocation: "article_cleanup",
    system: SYSTEM,
    prompt: buildPrompt(input, blocks),
    maxTokens: 2000,
    temperature: 0,
    reasoning: "none",
  });
  if (result.stop === "refusal") throw new Error("model declined to sort the blocks");
  if (result.stop === "max_tokens") throw new Error("the block list hit the token ceiling");

  const drop = parseDropList(result.text, blocks.length);
  if (!drop) throw new Error("model did not answer with a drop list");
  if (!drop.length) return null;
  const kept = applyDropList(blocks, drop);
  if (!kept) throw new Error(`model wanted ${drop.length} of ${blocks.length} blocks out, too much to be a cleanup`);
  return kept.length === blocks.length ? null : kept.join("\n\n");
}

// ── The fragment ──

/** The one fragment a save writes, or "" when the text is not held that way. */
function soleFragment(ficheFile: string): string {
  const dir = fragmentsDir(ficheFile);
  if (!fs.existsSync(dir)) return "";
  const frags = fs.readdirSync(dir).filter((f) => f.endsWith(".frag"));
  const [only] = frags;
  return only && frags.length === 1 ? path.join(dir, only) : "";
}

/**
 * Put a new text in the article's fragment, keeping the fragment's header.
 * Returns the file written, "" when the article has no single fragment.
 */
export function replaceFullText(ficheFile: string, text: string): string {
  const frag = soleFragment(ficheFile);
  if (!frag) return "";
  const header = fs.readFileSync(frag, "utf-8").match(/^---\n[\s\S]*?\n---\n?/)?.[0] ?? "";
  atomicWrite(frag, `${header}${text}`);
  return frag;
}

/**
 * Whether the stored text may still be replaced. A highlight is filed by its
 * character offsets in the text it was made on: once there is one, the text
 * stays as it is.
 */
export function textIsReplaceable(memberId: string, ref: ArticleFicheRef): boolean {
  if (ref.kind !== "fiche") return false;
  return !countArticleHighlights(memberId).get(`${ref.locale}/${ref.slug}`);
}

/**
 * Replace a text captured flat — one run, no paragraph in it, as every save
 * was before the extraction kept blocks — with a capture that has them.
 * Returns whether it did.
 */
export function retakeFlatText(memberId: string, ref: ArticleFicheRef, content: string): boolean {
  const garden = gardenFor(memberId);
  if (!garden || ref.kind !== "fiche" || splitBlocks(content).length < MIN_BLOCKS) return false;
  const frag = soleFragment(ref.file);
  if (!frag) return false;
  const stored = fs.readFileSync(frag, "utf-8").replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
  if (!stored || /\n\s*\n/.test(stored)) return false;
  if (!textIsReplaceable(memberId, ref)) return false;
  replaceFullText(ref.file, content);
  autoCommit(garden, [frag], `Retake article text: ${ref.slug}`);
  indexGardenPaths(memberId, [frag]);
  return true;
}

/**
 * Clean one saved article's text and write it back. Returns whether the text
 * changed. Never throws for an article that simply cannot be cleaned.
 */
export async function cleanAndStore(memberId: string, ref: ArticleFicheRef): Promise<boolean> {
  const garden = gardenFor(memberId);
  if (!garden || ref.kind !== "fiche") return false;
  const frag = soleFragment(ref.file);
  if (!frag) return false;

  const parsed = parseFiche(fs.readFileSync(ref.file, "utf-8"));
  if (!parsed) return false;
  const meta = (parsed.frontmatter.meta ?? {}) as Record<string, any>;
  const before = fs.readFileSync(frag, "utf-8").replace(/^---\n[\s\S]*?\n---\n?/, "").trim();

  const cleaned = await cleanArticleText({
    title: String(parsed.frontmatter.title ?? ref.title),
    publication: String(meta.publication ?? "") || undefined,
    author: String(meta.author ?? "") || undefined,
    publishedAt: String(meta.published_at ?? "") || undefined,
    text: before,
  });
  if (!cleaned) return false;

  // The model took seconds: the member may have opened the article and marked
  // a passage meanwhile.
  if (!textIsReplaceable(memberId, ref)) return false;
  replaceFullText(ref.file, cleaned);
  const written = [frag];

  // Re-read, as the summary does: the fiche may have changed since.
  const fresh = parseFiche(fs.readFileSync(ref.file, "utf-8"));
  if (fresh) {
    fresh.frontmatter.meta = {
      ...(fresh.frontmatter.meta ?? {}),
      word_count: cleaned.split(/\s+/).filter(Boolean).length,
    };
    writeFiche(ref.file, fresh.frontmatter, fresh.body);
    written.push(ref.file);
  }

  autoCommit(garden, written, `Clean article text: ${ref.slug}`);
  indexGardenPaths(memberId, written);
  return true;
}
