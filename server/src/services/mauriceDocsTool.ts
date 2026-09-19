/**
 * The documentation tool — `maurice_docs`.
 *
 * Until 19 September 2026 a question about Maurice himself went to Maurice
 * Maurice, a built-in persona that carried the whole system documentation in
 * its context (~27 000 tokens on every turn of its conversations) and ran on
 * a model the server locked. The domains design (roadmap P3-A) replaces the
 * persona with a tool: the everyday Maurice holds `maurice_docs` in every
 * conversation, for every member, and calls it on the strength of its
 * description alone when the question is about Maurice. The tool runs a
 * **sub-turn** — one ancillary completion with the digest and the notes newer
 * than it as its system prompt, and the question as its prompt — on the model
 * the `maurice_docs` invocation resolves to (services/ancillary.ts: pinned by
 * default to what was Maurice Maurice's model, the admin can change it), and
 * hands the answer back as the tool result, which the everyday Maurice relays
 * in his own voice. Asked for a `note`, it returns that note in full without
 * a model call, for the detail a condensed answer leaves out.
 *
 * The sub-turn is a call the member's turn provoked, so it goes through the
 * ledger as theirs: the fuse is consulted before it (their own cap, the
 * household's, the instance's) and what it cost is recorded under their id.
 * It does not appear in the chat turn's own usage figure — that figure is one
 * provider and one model — only in the ledger.
 */

import { ancillaryComplete, ancillaryModel, type AncillaryResult } from "./ancillary";
import { recordSpend, verdict } from "./budget";
import { docCatalogue, docContextText, docsForContext, findDoc, isDelta, type MauriceDoc } from "./mauriceDocs";
import { getModel } from "./models";

export const MAURICE_DOCS_TOOL_NAME = "maurice_docs";
export const MAURICE_DOCS_INVOCATION = "maurice_docs";

/** How long an answer may run: a documentation answer is a few paragraphs at
 *  most; the everyday Maurice trims it further. */
const MAX_ANSWER_TOKENS = 1500;

/** The tool as the model sees it. The description is the whole trigger: the
 *  loop calls the tool on its strength alone, so it says when, and says that
 *  memory is not a source for this. The note catalogue rides in it so the
 *  model can ask for one by slug. Same shape as web_search in claude.ts; the
 *  function-shaped wrapper for the other providers is derived from it there. */
export function mauriceDocsTool() {
  const notes = docCatalogue()
    .map((d) => `${d.slug.replace(/^maurice-/, "")} (${d.title})`)
    .join(", ");
  return {
    name: MAURICE_DOCS_TOOL_NAME,
    description:
      "Ask Maurice's own documentation. Use this whenever the question is about Maurice himself — the household AI system you are: what he can do, how a feature works (conversations and rooms, the garden and its notes, Carnet, domains and their briefs, the tools, the models and providers, the corpus, backups, the admin console, hosting and the container), how to set something up or where a setting lives, what is built and what is not, or why he was designed the way he is. " +
      "You have no reliable knowledge of this system beyond what this tool returns: never answer such a question from memory or from what an assistant like you usually is. " +
      "Give the question as the person asked it, with the context that makes it precise. The answer comes back grounded in the documentation, with the notes it drew on; relay it in your own voice and keep what it says about what ships, what is experimental and what does not exist yet. " +
      `Pass \`note\` instead to get one note in full, for detail the answer left out — one of: ${notes || "(no notes available)"}.`,
    input_schema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question about Maurice, as precisely as the person put it." },
        note: { type: "string", description: "A note's slug, to get that note in full instead of an answer (e.g. \"server\", \"domains\")." },
      },
    },
  };
}

const DOCS_SYSTEM_HEAD = `You answer, for Maurice — the household AI system this documentation describes — a question a member asked him about himself. Your answer is handed to Maurice as a tool result; he relays it to the person in his own voice, so write the answer itself: no greeting, no "according to the documentation", no offer to help further.

Your knowledge is the system documentation loaded below, written by Maurice's maker and dated: usually a digest that condenses the whole set to its facts, plus any note loaded in full because it was updated after the digest — where the two differ, the full note is right. Ground every answer in it. Quote or paraphrase what the notes say, and name the note you are drawing on (its slug) when it helps, so that Maurice can ask for it in full. Read the "ships vs. exists" distinctions and the "gaps" sections carefully: say plainly when something is experimental, private, or not built yet, and never present a planned feature as a working one.

When the documentation does not answer a question, say so rather than guessing; suggest where the answer would live (which surface, which note) and offer what you do know that is adjacent. If a detail in the docs looks out of date compared to what the question describes, say which is more likely and why.

Be practical: someone asking "how do I…" wants the actual steps on the actual surface (the app, Carnet, the web admin, a script), in order. Someone asking "why…" wants the reasoning the notes give — the vision, the trade-offs, the constraints. Keep answers proportionate: a short question deserves a short answer, and nothing here should run past a few paragraphs.

Answer in the language the question is written in. The documentation is in English; translate its terms naturally rather than quoting English where a plain word exists, but keep code identifiers, paths, commands and route names exactly as written.`;

/** The system prompt of the sub-turn: the head above, then the digest and the
 *  notes newer than it. Byte-stable between two questions on the same set,
 *  which is what lets a provider cache it. */
export function docsSystemPrompt(docs: MauriceDoc[] = docsForContext()): string {
  if (!docs.length) return DOCS_SYSTEM_HEAD + "\n\n(No documentation is available on this instance.)";
  const blocks = docs.map((d) => docContextText(d, isDelta(d, docs)));
  return `${DOCS_SYSTEM_HEAD}\n\n## The documentation\n\n${blocks.join("\n\n———\n\n")}`;
}

export interface DocsAnswer {
  text: string;
  isError: boolean;
  /** What the sub-turn cost (null when no model ran: a note in full, a refusal). */
  usage: AncillaryResult["usage"] | null;
  model: string | null;
}

/** The one door for a test to stand in for the provider. */
export type DocsCompleter = (req: {
  invocation: string;
  system: string;
  prompt: string;
  maxTokens: number;
  temperature?: number;
  cacheSystem?: boolean;
}) => Promise<AncillaryResult>;

/**
 * Answer a question about Maurice from the documentation, or return one note
 * in full. `memberId` is whose turn provoked the call: the fuse is theirs and
 * so is the ledger row.
 */
export async function askMauriceDocs(
  input: { question?: string; note?: string },
  memberId: string | null | undefined,
  complete: DocsCompleter = ancillaryComplete,
): Promise<DocsAnswer> {
  const none = { usage: null, model: null };
  const note = input.note?.trim();
  if (note) {
    const d = findDoc(note);
    if (!d) {
      const known = docCatalogue().map((x) => x.slug.replace(/^maurice-/, "")).join(", ");
      return { text: `No documentation note "${note}". The notes are: ${known || "none on this instance"}.`, isError: true, ...none };
    }
    return { text: docContextText(d), isError: false, ...none };
  }

  const question = input.question?.trim();
  if (!question) {
    return { text: "Give a question about Maurice, or the slug of a note to read in full.", isError: true, ...none };
  }
  const docs = docsForContext();
  if (!docs.length) {
    return { text: "No documentation is available on this instance, so this cannot be answered from it.", isError: true, ...none };
  }

  // The fuse: the member's own cap, the household's, the instance's. A turn
  // that provokes a sub-turn is two billed requests, and the second must not
  // walk through a cap the first was checked against.
  const modelId = ancillaryModel(MAURICE_DOCS_INVOCATION);
  const provider = getModel(modelId)?.provider ?? "anthropic";
  const fuse = verdict(provider, modelId, 0, memberId);
  if (!fuse.ok) return { text: fuse.reason ?? "Spending limit reached.", isError: true, ...none };

  try {
    const r = await complete({
      invocation: MAURICE_DOCS_INVOCATION,
      system: docsSystemPrompt(docs),
      prompt: `Question: ${question}`,
      maxTokens: MAX_ANSWER_TOKENS,
      temperature: 0.3,
      cacheSystem: true,
    });
    recordSpend(r.usage, memberId ?? null);
    if (r.stop === "refusal" || !r.text) {
      return { text: "The documentation could not be consulted for this question.", isError: true, usage: r.usage, model: r.model };
    }
    const text = r.stop === "max_tokens" ? `${r.text}\n\n(The answer was cut short; ask for a note in full for the rest.)` : r.text;
    return { text, isError: false, usage: r.usage, model: r.model };
  } catch (err: any) {
    return { text: `The documentation could not be consulted: ${err?.message || "failed"}`, isError: true, ...none };
  }
}
