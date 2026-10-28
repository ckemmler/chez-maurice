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
 * The model is the admin's choice for the `article_summary` invocation, run
 * through services/ancillary.ts on whichever provider it belongs to.
 */

import fs from "node:fs";
import path from "node:path";
import { ancillaryCompleteRetrying, ancillaryModel } from "../../src/services/ancillary";
import { recordSpend } from "../../src/services/budget";
import { userLocale } from "../../src/services/i18n";
import type { TurnUsage } from "../../src/services/pricing";
import { autoCommit, fragmentsDir, gardenFor, parseFiche, writeFiche } from "./gardenFiche";
import { extractArticleFromUrl } from "./articleExtract";
import { indexGardenPaths } from "./gardenIndex";
import { ArticleSaveError, scanArticleFiches, type ArticleFicheRef } from "./gardenArticles";


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
  /** The essence in a paragraph, or the substance at length. Long when unsaid. */
  length?: SummaryLength;
  /** The member's language (`fr`, `en`…): the short summary is written in it —
   *  it is read at a glance, in the language they read everything else in. */
  readerLang?: string;
}

const LANGUAGE_NAMES: Record<string, string> = {
  fr: "français", en: "English", de: "Deutsch", es: "español", it: "italiano", nl: "Nederlands", pt: "português",
};

/**
 * Two summaries, read one after the other (19 October 2026). The **short**
 * one is the essence, a paragraph: what the page shows first. The **long**
 * one is meant to be read instead of the article — its arguments, figures and
 * conclusion — behind "See more…": the step between the essence and the whole
 * text, which was missing.
 */
export type SummaryLength = "short" | "long";

/**
 * Which summaries a fiche holds. Version 1 was the paragraph alone; version 2
 * (one day, 19 October 2026) the long summary alone, in `summary`; version 3
 * both — the paragraph in `summary`, the long one in `summary_long`; version 4
 * (the same evening) the paragraph in the member's language (`summary_lang`),
 * the long one still in the article's. A fiche of an older version gets what
 * it lacks the next time the article is opened in Carnet, keeping what still
 * holds: a version 2 or 3 long text stays the long one; the paragraph is
 * written again in the member's language.
 */
export const SUMMARY_VERSION = 4;

/**
 * How long the summary may run, in words: about an eighth of the article,
 * never under 150 nor over 600. A 600-word piece gets 150 words — its
 * argument, not a teaser; a 5 000-word investigation gets 600.
 */
export function summaryWordBudget(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.min(600, Math.max(150, Math.round(words / 8 / 10) * 10));
}

function buildPrompt(input: SummaryInput): string {
  const language = input.lang?.startsWith("fr")
    ? "français"
    : input.lang?.startsWith("en")
      ? "English"
      : "the language the article itself is written in";
  if (input.length === "short") {
    return buildShortPrompt(input, LANGUAGE_NAMES[input.readerLang ?? ""] ?? language);
  }
  const budget = summaryWordBudget(input.text);

  return [
    `Here is an article${input.publication ? ` from ${input.publication}` : ""}, titled "${input.title}".`,
    "",
    "Write a summary of it for a reader who will read the summary instead of the article.",
    "Reading it must be enough to know what the article says — its substance, not a vague idea of it:",
    "the thesis or the news; the arguments, evidence, facts and figures that carry it; who says what,",
    "when that matters; the conclusion it reaches, and any reservation or open question it leaves.",
    "Keep the concrete details. A summary that says \"the author examines several causes\" is useless;",
    "one that names the causes and says which the author holds to be decisive is what is wanted.",
    "",
    // The ceiling is what keeps the length honest: asked for "a summary" alone,
    // a model writes the same 120 words for a brief and for a long investigation.
    `Length: at most ${budget} words, in proportion to what the article actually contains — a thin`,
    "article gets a short summary, never padding.",
    "Form: a few paragraphs of plain prose, separated by blank lines. No title, no headings, no bullet",
    "points, no bold.",
    "",
    `Write it in ${language}.`,
    "Do not describe the article from the outside: no \"this article explains…\", no \"the author",
    "discusses…\". Start straight in on the content. No preamble and no closing remark.",
    "Return the summary and nothing else.",
    "",
    "---",
    "",
    input.text,
  ].join("\n");
}

function buildShortPrompt(input: SummaryInput, language: string): string {
  return [
    `Here is an article${input.publication ? ` from ${input.publication}` : ""}, titled "${input.title}".`,
    "",
    // The word ceiling carries the weight here. Asked only for "3 to 5
    // sentences", the model obliges with three sentences of eighty words each.
    "Write a short summary of it: 3 to 5 sentences, at most 110 words, as a single paragraph.",
    "It is the essence, read first: what the article argues or reports and what it concludes, so that",
    "one knows at once what it is about and whether to read more.",
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

export async function summarizeArticleText(input: SummaryInput): Promise<string | SummaryResult> {
  const text = input.text.trim();
  if (!text) throw new Error("no article text to summarise");
  if (text.length > MAX_TEXT_CHARS) {
    throw new Error(
      `article text is ${text.length} characters, above the ${MAX_TEXT_CHARS} guard — not summarising a partial document`,
    );
  }

  return generator({ ...input, text, length: input.length ?? "long" });
}

export interface SummaryResult { text: string; usage: TurnUsage | null }
export type ArticleSummaryGenerator = (input: SummaryInput) => Promise<string | SummaryResult>;

/** Through the ancillary door: the admin's model for `article_summary`, on
 *  whichever provider it belongs to. Room for adaptive thinking plus up to
 *  600 words — on a thinking model those tokens count against max_tokens. */
const modelGenerator: ArticleSummaryGenerator = async (input) => {
  const result = await ancillaryCompleteRetrying({
    invocation: "article_summary",
    prompt: buildPrompt(input),
    maxTokens: 8000,
    effort: "low",
  });

  if (result.stop === "refusal") throw new Error("model declined to summarise");
  const summary = result.text;
  if (!summary) throw new Error("model returned an empty summary");
  // A truncated paragraph is non-empty, so it would pass the check above, get
  // committed, and stick — `summarizeAndStore` skips regeneration once a
  // summary exists, so a retry without `force` would hand back the same stub of
  // a sentence.
  if (result.stop === "max_tokens") {
    throw new Error("the summary hit the token ceiling and would be cut off mid-sentence");
  }
  return { text: summary, usage: result.usage };
};

let generator: ArticleSummaryGenerator = modelGenerator;
/** Tests swap the model call for a stub. */
export function setArticleSummaryGenerator(g: ArticleSummaryGenerator | null): void {
  generator = g ?? modelGenerator;
}

// ── Reading the article text back ──

/**
 * The article's own text: the fiche's first fragment, written at save time.
 * The fragments after it are not the article — a conversation's summary, what
 * Maurice filed — and read as part of it they would end up in the reader and
 * in the article's summary. "" when there is no fragment.
 */
export function readFullText(ficheFile: string): string {
  const dir = fragmentsDir(ficheFile);
  if (!fs.existsSync(dir)) return "";
  const first = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".frag"))
    .sort()[0];
  if (!first) return "";
  const raw = fs.readFileSync(path.join(dir, first), "utf-8");
  return raw.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
}

// ── Write-back ──

/**
 * Summarise one saved article and write the result into its frontmatter.
 *
 * `force` regenerates over an existing summary. Without it an article whose
 * summary is of the current version is left alone, so a retry is safe to run
 * over the whole collection; one of an older version is rewritten.
 *
 * One pass per fiche at a time: the save's background pass (cleanup, then
 * summary) and Carnet opening the article a few seconds later both land here,
 * and the second waits on the first rather than summarising the uncleaned text
 * beside it.
 */
export function summarizeAndStore(
  memberId: string,
  ref: ArticleFicheRef,
  opts: { force?: boolean } = {},
): Promise<StoredSummaries> {
  const running = passes.get(ref.file);
  if (running) {
    // Whatever it came to: a failed pass leaves the next to try for itself,
    // and a forced one need not run twice back to back.
    return running.catch(() => {}).then(() => summarizeAndStore(memberId, ref, { force: false }));
  }
  return single(ref.file, () => summarize(memberId, ref, opts));
}

export interface StoredSummaries { summary: string; summaryLong: string; regenerated: boolean }

/** What each fiche's running pass is, so the next one waits on it. */
const passes = new Map<string, Promise<unknown>>();

function single<T>(file: string, run: () => Promise<T>): Promise<T> {
  const task = run().finally(() => {
    if (passes.get(file) === task) passes.delete(file);
  });
  passes.set(file, task);
  return task;
}

async function summarize(
  memberId: string,
  ref: ArticleFicheRef,
  opts: { force?: boolean },
): Promise<StoredSummaries> {
  const garden = gardenFor(memberId);
  if (!garden) throw new ArticleSaveError("No notes for this member", 404);

  const readerLang = userLocale(memberId);
  const existing = readStoredSummary(ref, readerLang);
  if (existing.current && !opts.force) {
    return { summary: existing.summary, summaryLong: existing.long, regenerated: false };
  }

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

  // What an older version left is kept, unless asked to start over: a
  // version 2 text is the long summary, a version 3 long one too. The
  // paragraph stays only when it is in the member's language already.
  const keptShort = opts.force ? "" : existing.version >= 4 && existing.lang === readerLang ? existing.summary : "";
  const keptLong = opts.force ? "" : existing.version === 2 ? existing.summary : existing.long;
  const input = {
    readerLang,
    title: String(fm.title ?? ref.title),
    publication: String(meta.publication ?? fm.source ?? "") || undefined,
    text,
    lang: String(meta.lang ?? "") || undefined,
  };
  // Asked for by the member — by sharing the article, or by opening it — so
  // charged to them, as the other passes run on their behalf are.
  const make = async (length: SummaryLength): Promise<string> => {
    const made = await summarizeArticleText({ ...input, length });
    if (typeof made === "string") return made;
    recordSpend(made.usage, memberId, null, "articles");
    return made.text;
  };
  const [summary, summaryLong] = await Promise.all([
    keptShort || make("short"),
    keptLong || make("long"),
  ]);

  // Re-read: this runs seconds to minutes after the save, and the fiche may
  // have picked up a second comment or a hand edit in the meantime.
  const fresh = parseFiche(fs.readFileSync(ref.file, "utf-8"));
  if (!fresh) throw new ArticleSaveError(`Could not parse: ${ref.slug}`, 422);

  const stamp = {
    summary,
    summary_long: summaryLong,
    summary_lang: readerLang,
    summary_model: ancillaryModel("article_summary"),
    summary_at: new Date().toISOString().slice(0, 10),
    summary_version: SUMMARY_VERSION,
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

  return { summary, summaryLong, regenerated: !!existing.summary };
}

function readStoredSummary(ref: ArticleFicheRef, readerLang: string): StoredSummary {
  const parsed = parseFiche(fs.readFileSync(ref.file, "utf-8"));
  if (!parsed) return { summary: "", long: "", version: 0, lang: null, current: false };
  const fm = parsed.frontmatter;
  return storedSummaryOf(ref.kind === "fiche" ? (fm.meta ?? {}) : fm, readerLang);
}

export interface StoredSummary {
  /** The paragraph — or, on a version 2 fiche, the long text. */
  summary: string;
  long: string;
  version: number;
  /** The language the paragraph is written in, from version 4. */
  lang: string | null;
  /** Both are there, of the current version, the paragraph in the reader's language. */
  current: boolean;
}

/** The summaries a fiche's meta (or a card's frontmatter) carries, as read by
 *  a member whose language is `readerLang`. */
export function storedSummaryOf(meta: Record<string, any>, readerLang?: string): StoredSummary {
  const summary = String(meta.summary ?? "");
  const long = String(meta.summary_long ?? "");
  const version = summary ? Number(meta.summary_version ?? 1) : 0;
  const lang = meta.summary_lang ? String(meta.summary_lang) : null;
  const current = !!summary && !!long && version >= SUMMARY_VERSION && (!readerLang || lang === readerLang);
  return { summary, long, version, lang, current };
}

/** Look one up by slug, for the on-demand route. */
export function findArticleBySlug(
  memberId: string,
  slug: string,
  locale?: string,
): ArticleFicheRef {
  const garden = gardenFor(memberId);
  if (!garden) throw new ArticleSaveError("No notes for this member", 404);
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
 *
 * `first` runs before it and may fail without consequence: the text cleanup,
 * so that the summary reads the article and not the page around it — and so
 * that the two never write the fiche at the same moment.
 */
export function scheduleArticleSummary(
  memberId: string,
  ref: ArticleFicheRef,
  opts: { first?: () => Promise<unknown>; summarise?: boolean } = {},
): void {
  const before = opts.first
    ? opts.first().catch((err) => {
        console.warn(`[articles] could not clean ${ref.slug}:`, (err as Error).message);
      })
    : Promise.resolve();
  // Registered as the fiche's pass from the start, cleanup included: a summary
  // asked for meanwhile waits for the cleaned text.
  const pass = single(ref.file, () =>
    before.then(() => (opts.summarise === false ? { summary: "" } : summarize(memberId, ref, {}))));
  const task = pass
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
