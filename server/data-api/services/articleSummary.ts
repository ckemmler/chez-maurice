/**
 * AI summary for a saved article.
 *
 * Runs *after* the save has already answered. A share sheet has to close in
 * well under a second and a summary takes several, so the fiche is written and
 * committed first, then this pass reopens it and fills `summary` in.
 *
 * It writes only into the frontmatter, never the body: by the time it lands the
 * body may have been edited by hand or carry a second comment, and a rewrite
 * would clobber that. The file is re-read from disk at write time for the same
 * reason — the in-memory copy from the save is already stale.
 *
 * Raw fetch rather than the Anthropic SDK, matching the two call sites this
 * server already has (services/claude.ts, signalParser.ts) and keeping a
 * self-hosted install free of another runtime dependency.
 */

import fs from "node:fs";
import path from "node:path";
import { getHouseholdConfig } from "../../src/services/claude";
import { autoCommit, fragmentsDir, gardenFor, parseFiche, writeFiche } from "./gardenFiche";
import { extractArticleFromUrl } from "./articleExtract";
import { indexGardenPaths } from "./gardenIndex";
import { ArticleSaveError, scanArticleFiches, type ArticleFicheRef } from "./gardenArticles";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const SUMMARY_MODEL = "claude-opus-5";

/**
 * Runaway guard, not a context limit — the model takes 1M tokens and the
 * longest real article is a small fraction of that. Past this the input is not
 * an article, so we refuse rather than silently summarise a slice of it.
 */
const MAX_TEXT_CHARS = 400_000;

// ── Generation ──

export interface SummaryInput {
  title: string;
  publication?: string;
  text: string;
  /** Article language (BCP-47-ish, from <html lang>). Steers the output language. */
  lang?: string;
}

function buildPrompt(input: SummaryInput): string {
  const language = input.lang?.startsWith("fr")
    ? "français"
    : input.lang?.startsWith("en")
      ? "English"
      : "the language the article itself is written in";

  return [
    `Here is an article${input.publication ? ` from ${input.publication}` : ""}, titled "${input.title}".`,
    "",
    // The word ceiling carries the weight here. Asked only for "3 to 5
    // sentences", the model obliges with three sentences of eighty words each —
    // technically compliant, and twice the length of a summary worth reading at
    // a glance.
    "Write a short summary of it: 3 to 5 sentences, at most 110 words, as a single paragraph.",
    "",
    `Write it in ${language}.`,
    "Say what the article actually argues or reports — the substance, the specific claims, the",
    "conclusion it reaches. Do not describe the article from the outside: no \"this article",
    "explains…\", no \"the author discusses…\". Start straight in on the content.",
    "Do not add a title, a preamble, bullet points, or any closing remark.",
    "Return the paragraph and nothing else.",
    "",
    "---",
    "",
    input.text,
  ].join("\n");
}

export async function summarizeArticleText(input: SummaryInput): Promise<string> {
  const text = input.text.trim();
  if (!text) throw new Error("no article text to summarise");
  if (text.length > MAX_TEXT_CHARS) {
    throw new Error(
      `article text is ${text.length} characters, above the ${MAX_TEXT_CHARS} guard — not summarising a partial document`,
    );
  }

  const { apiKey } = getHouseholdConfig();
  if (!apiKey) throw new Error("no Anthropic API key configured for this household");

  const response = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: SUMMARY_MODEL,
      // Room for adaptive thinking plus a short paragraph. Thinking is on by
      // default on this model and its tokens count against max_tokens.
      max_tokens: 4000,
      output_config: { effort: "low" },
      messages: [{ role: "user", content: buildPrompt({ ...input, text }) }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Anthropic API error: ${response.status} ${await response.text()}`);
  }

  const result = (await response.json()) as {
    stop_reason?: string;
    stop_details?: { category?: string | null; explanation?: string };
    content: Array<{ type: string; text?: string }>;
  };

  if (result.stop_reason === "refusal") {
    throw new Error(`model declined to summarise (${result.stop_details?.category ?? "unspecified"})`);
  }

  const summary = result.content
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("")
    .trim();

  if (!summary) throw new Error("model returned an empty summary");
  return summary;
}

// ── Reading the article text back ──

/** The full text saved alongside the fiche, or "" when there is no fragment. */
export function readFullText(ficheFile: string): string {
  const dir = fragmentsDir(ficheFile);
  if (!fs.existsSync(dir)) return "";
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".frag"))
    .sort()
    .map((f) => {
      const raw = fs.readFileSync(path.join(dir, f), "utf-8");
      return raw.replace(/^---\n[\s\S]*?\n---\n?/, "");
    })
    .join("\n\n")
    .trim();
}

// ── Write-back ──

/**
 * Summarise one saved article and write the result into its frontmatter.
 *
 * `force` regenerates over an existing summary. Without it an article that
 * already has one is left alone, so a retry is safe to run over the whole
 * collection.
 */
export async function summarizeAndStore(
  memberId: string,
  ref: ArticleFicheRef,
  opts: { force?: boolean } = {},
): Promise<{ summary: string; regenerated: boolean }> {
  const garden = gardenFor(memberId);
  if (!garden) throw new ArticleSaveError("No garden for this member", 404);

  const existing = readStoredSummary(ref);
  if (existing && !opts.force) return { summary: existing, regenerated: false };

  const parsed = parseFiche(fs.readFileSync(ref.file, "utf-8"));
  if (!parsed) throw new ArticleSaveError(`Could not parse: ${ref.slug}`, 422);
  const fm = parsed.frontmatter;
  const meta = (fm.meta ?? {}) as Record<string, any>;

  // The fragment holds the text captured at save time. A card written by the
  // older route has none, so fall back to re-fetching — which is also the only
  // path available when the fragment was never written (an extraction that
  // yielded metadata but no body).
  let text = readFullText(ref.file);
  const url = String(meta.url ?? fm.url ?? "");
  if (!text) {
    if (!url) throw new ArticleSaveError(`No text and no URL for: ${ref.slug}`, 422);
    text = (await extractArticleFromUrl(url)).content;
  }

  const summary = await summarizeArticleText({
    title: String(fm.title ?? ref.title),
    publication: String(meta.publication ?? fm.source ?? "") || undefined,
    text,
    lang: String(meta.lang ?? "") || undefined,
  });

  // Re-read: this runs seconds to minutes after the save, and the fiche may
  // have picked up a second comment or a hand edit in the meantime.
  const fresh = parseFiche(fs.readFileSync(ref.file, "utf-8"));
  if (!fresh) throw new ArticleSaveError(`Could not parse: ${ref.slug}`, 422);

  const stamp = {
    summary,
    summary_model: SUMMARY_MODEL,
    summary_at: new Date().toISOString().slice(0, 10),
  };
  if (ref.kind === "fiche") {
    fresh.frontmatter.meta = { ...(fresh.frontmatter.meta ?? {}), ...stamp };
  } else {
    Object.assign(fresh.frontmatter, stamp);
  }

  writeFiche(ref.file, fresh.frontmatter, fresh.body);
  autoCommit(garden, [ref.file], `Summarise article: ${ref.slug}`);
  // The summary is now part of the fiche's searchable metadata preamble.
  indexGardenPaths(memberId, [ref.file]);

  return { summary, regenerated: !!existing };
}

function readStoredSummary(ref: ArticleFicheRef): string {
  const parsed = parseFiche(fs.readFileSync(ref.file, "utf-8"));
  if (!parsed) return "";
  const fm = parsed.frontmatter;
  return String((ref.kind === "fiche" ? (fm.meta ?? {}).summary : fm.summary) ?? "");
}

/** Look one up by slug, for the on-demand route. */
export function findArticleBySlug(
  memberId: string,
  slug: string,
  locale?: string,
): ArticleFicheRef {
  const garden = gardenFor(memberId);
  if (!garden) throw new ArticleSaveError("No garden for this member", 404);
  const ref = scanArticleFiches(garden).find(
    (f) => f.slug === slug && (!locale || f.locale === locale),
  );
  if (!ref) throw new ArticleSaveError(`Article not found: ${slug}`, 404);
  return ref;
}

// ── Background scheduling ──

const inFlight = new Set<Promise<unknown>>();

/**
 * Kick off a summary without making the caller wait for it.
 *
 * Deliberately fire-and-forget: the share sheet that triggered the save has
 * already been told the article is in. A failure here leaves the fiche without
 * a `summary` key — visible, and retryable through the summary route.
 */
export function scheduleArticleSummary(memberId: string, ref: ArticleFicheRef): void {
  const task = summarizeAndStore(memberId, ref)
    .then((r) => {
      if (r.summary) console.log(`[articles] summarised ${ref.slug}`);
    })
    .catch((err) => {
      console.warn(`[articles] could not summarise ${ref.slug}:`, (err as Error).message);
    })
    .finally(() => inFlight.delete(task));
  inFlight.add(task);
}

/** Await every scheduled summary. For tests and for a clean shutdown. */
export async function whenSummariesSettled(): Promise<void> {
  while (inFlight.size) await Promise.allSettled([...inFlight]);
}
