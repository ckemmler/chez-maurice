/**
 * Ancillary models — the one door for every model call that is not the chat.
 *
 * Summaries of conversations and articles, flashcards, signal parsing, and the
 * Python tools' own classifiers and syntheses all used to name a model in a
 * constant and call api.anthropic.com by hand. A household whose key is for
 * Z.ai, or whose only model is local, could not run any of them, and no admin
 * screen would have shown why.
 *
 * Now each such function is an *invocation* listed below, with a tier saying
 * what it needs of a model. Each is pinned — on a fresh household and on the
 * first start of any household that never pinned one, to its tier's model in
 * the provider range further down — and the admin can repin any of them. An
 * invocation left unpinned runs on the household's ancillary model, which is
 * forced to exist (db.ts backfills it from the chat default), so resolution
 * never returns nothing.
 *
 * ancillaryComplete() then dispatches by the model's provider through the same
 * backends the chat uses — Anthropic, the OpenAI-compatible three, Ollama — so
 * whatever the admin picks actually runs.
 *
 * Python reads the same table (tools/shared/model_config.py), so a choice made
 * in the admin holds for the tools too.
 */

import db from "../db";
import { getModel, configuredProviders, householdDefaultModel } from "./models";
import { getHouseholdConfig, isOpenAIStyle, openaiStyleBaseUrl, openaiStyleKey } from "./claude";
import { openaiTurn } from "./openaiChat";
import { ollamaTurn } from "./ollama";

// ── The invocations ──────────────────────────────────────────────────────────

export type AncillaryTier = "light" | "standard" | "heavy";

export interface AncillaryInvocation {
  id: string;
  /** Where it runs: the server, or a Python tool that reads the table. */
  side: "server" | "tools";
  label: string;
  blurb: string;
  /** What the function needs of a model — a hint for the admin, nothing more. */
  tier: AncillaryTier;
}

export const ANCILLARY_INVOCATIONS: AncillaryInvocation[] = [
  // Server
  { id: "conversation_summary", side: "server", tier: "standard", label: "Conversation summary",
    blurb: "A long conversation loaded as context, summarised for the composer." },
  { id: "article_summary", side: "server", tier: "standard", label: "Article summary",
    blurb: "The one-paragraph summary written on a saved article's fiche." },
  { id: "flashcards", side: "server", tier: "heavy", label: "Flashcards",
    blurb: "Cards generated from a chapter, a book, a fiche or a fragment." },
  { id: "signal_parse", side: "server", tier: "light", label: "Signal parsing",
    blurb: "A free-text signal (sleep, mood, sport…) turned into a structured entry." },
  { id: "signal_nutrition", side: "server", tier: "standard", label: "Meal estimation",
    blurb: "A meal signal with its protein and calorie estimate." },
  // Python tools (models.yml's assignments, now settable here)
  { id: "dossier_title", side: "tools", tier: "light", label: "Dossier title", blurb: "Naming a research dossier." },
  { id: "topic_tags", side: "tools", tier: "light", label: "Topic tags", blurb: "Tagging a topic or an entry." },
  { id: "search_queries", side: "tools", tier: "light", label: "Search queries", blurb: "Turning a question into web searches." },
  { id: "git_descriptions", side: "tools", tier: "light", label: "Git descriptions", blurb: "Describing a repository's activity for the signals." },
  { id: "moc_evocations", side: "tools", tier: "light", label: "MOC evocations", blurb: "The line a map-of-content says about each note." },
  { id: "translation", side: "tools", tier: "light", label: "Translation", blurb: "Translating a note or a fiche." },
  { id: "dream_analysis", side: "tools", tier: "light", label: "Dream analysis", blurb: "Reading a dream written in the journal." },
  { id: "dossier_synthesis", side: "tools", tier: "standard", label: "Dossier synthesis", blurb: "Writing up a research dossier." },
  { id: "gap_analysis", side: "tools", tier: "standard", label: "Gap analysis", blurb: "What a dossier still lacks." },
  { id: "briefing_synthesis", side: "tools", tier: "standard", label: "Briefing synthesis", blurb: "The briefing's overview." },
  { id: "briefing_content", side: "tools", tier: "standard", label: "Briefing content", blurb: "The briefing's sections." },
  { id: "media_curation", side: "tools", tier: "standard", label: "Media curation", blurb: "Choosing and describing media for a dossier." },
  { id: "signal_report", side: "tools", tier: "standard", label: "Signal report", blurb: "The periodic report over the signals." },
  { id: "resonance_queries", side: "tools", tier: "standard", label: "Résonance queries", blurb: "What to look for when linking an entry to the garden." },
  { id: "resonance_filtering", side: "tools", tier: "standard", label: "Résonance filtering", blurb: "Keeping the links that resonate." },
  { id: "book_classification", side: "tools", tier: "standard", label: "Book classification", blurb: "Front matter, body, back matter — which chapters count." },
  { id: "research_orchestration", side: "tools", tier: "standard", label: "Research orchestration", blurb: "Driving a deep-research run." },
];

export function isAncillaryInvocation(id: string): boolean {
  return ANCILLARY_INVOCATIONS.some((i) => i.id === id);
}

// ── The range: which model each tier deserves, per provider ──────────────────
// Left alone, every one of the invocations above ran on the household's chat
// model, because that is what the ancillary default was backfilled from. That
// is the wrong economics: naming a dossier or tagging a topic on Opus, GLM 5.3
// or Qwen 397B costs a flagship's price for a sentence, and is no better at
// it. So each provider that ships a fixed roster gets a range — a small model
// for the light work, a middling one for the writing, a strong one for the
// few jobs that reason — and `applyRecommendedPins` writes those choices into
// the pins table, where the admin can see and override every one of them.
//
// Written into the table rather than resolved on the fly on purpose: the
// Python tools read `ancillary_models` straight from maurice.db
// (tools/shared/model_config.py), so a rule that lived only in this file would
// hold for the server and not for them.
//
// Ollama has no range: its roster is whatever the host has pulled, so there is
// no id to name here. Those households keep the household-default behaviour.
export const ANCILLARY_RANGE: Record<string, Record<AncillaryTier, string>> = {
  anthropic: {
    light: "claude-haiku-4-5-20251001",
    standard: "claude-sonnet-4-6",
    heavy: "claude-sonnet-4-6", // Opus stays for the chat: nothing here needs it
  },
  openai: { light: "gpt-4o-mini", standard: "gpt-4o", heavy: "gpt-4o" },
  mistral: { light: "mistral-small-latest", standard: "mistral-small-latest", heavy: "mistral-large-latest" },
  zai: { light: "glm-5.3-flash", standard: "glm-5.3-flash", heavy: "glm-5.3" },
  // Scaleway, the fleet's own range and the reason this exists: Mistral Small
  // 3.2 for the one-liners, GPT-OSS 120B for the prose — cheap per output
  // token, which is what a summary spends — and Qwen 3.5 397B for flashcards,
  // the one job here that genuinely reasons. All served from Paris.
  scaleway: {
    light: "mistral-small-3.2-24b-instruct-2506",
    standard: "gpt-oss-120b",
    heavy: "qwen3.5-397b-a17b",
  },
};

/** The provider whose range this household should use: the one its chat model
 *  speaks, when that provider has a range and a key. Null when none applies —
 *  a household on Ollama alone, or on a model added by hand. */
export function rangeProvider(): string | null {
  const chat = getModel(householdDefaultModel());
  const provider = chat?.provider;
  if (!provider || !ANCILLARY_RANGE[provider]) return null;
  return configuredProviders().has(provider) ? provider : null;
}

/**
 * The providers the Python side can actually reach. An invocation that runs
 * `side: "tools"` is dispatched by the tools themselves, and every one of them
 * builds an `anthropic.Anthropic` client around the id this table hands it
 * (maurice-tools, ~15 files) — they read the model name from here but not the
 * provider. Pinning such an invocation to a Scaleway or GLM id would send that
 * id to api.anthropic.com and fail there. So the range only advises those
 * invocations while the household's range IS Anthropic; the rest stay on the
 * household model until the tools learn to call the server for their turns.
 */
const TOOLS_CAN_CALL = new Set(["anthropic"]);

/** Whether the range may speak for an invocation at all — see TOOLS_CAN_CALL. */
export function rangeCovers(inv: AncillaryInvocation, provider: string): boolean {
  return inv.side === "server" || TOOLS_CAN_CALL.has(provider);
}

/** What an invocation should run on, before any pin: its tier's model in the
 *  household's range. Null when no range applies or the model is not seeded. */
export function recommendedModel(invocation: string): string | null {
  const inv = ANCILLARY_INVOCATIONS.find((i) => i.id === invocation);
  const provider = rangeProvider();
  if (!inv || !provider || !rangeCovers(inv, provider)) return null;
  return usable(ANCILLARY_RANGE[provider]![inv.tier]);
}

/** Pin every invocation the range covers. Returns the ids actually changed, so
 *  the admin is told what moved rather than just "saved". */
export function applyRecommendedPins(): string[] {
  const changed: string[] = [];
  for (const inv of ANCILLARY_INVOCATIONS) {
    const want = recommendedModel(inv.id);
    if (!want || pinnedModel(inv.id) === want) continue;
    setPinnedModel(inv.id, want);
    changed.push(inv.id);
  }
  return changed;
}

/**
 * Put the range in place once, on a household that has never had a pin. New
 * instances therefore start fine-grained, and an existing one is moved off
 * "everything on the chat model" the first time it starts on this code — both
 * recorded as ordinary pins the admin can read and change.
 */
export function seedAncillaryPinsOnce(): string[] {
  const row = db
    .query(`SELECT ancillary_pins_seeded FROM households WHERE id = 'default'`)
    .get() as { ancillary_pins_seeded: number } | null;
  if (row?.ancillary_pins_seeded) return [];
  const changed = applyRecommendedPins();
  // Only claim it is done when a range actually applied; a household with no
  // key yet must get its pins the day it has one.
  if (changed.length) {
    db.run(`UPDATE households SET ancillary_pins_seeded = 1 WHERE id = 'default'`);
  }
  return changed;
}

// ── Resolution ───────────────────────────────────────────────────────────────

/** A model the household can actually call: in the roster, with a key. */
function usable(id: string | null | undefined): string | null {
  if (!id) return null;
  const m = getModel(id);
  if (!m) return null;
  return configuredProviders().has(m.provider) ? id : null;
}

export function householdAncillaryModel(): string | null {
  const row = db
    .query(`SELECT ancillary_model FROM households WHERE id = 'default'`)
    .get() as { ancillary_model: string | null } | null;
  return row?.ancillary_model ?? null;
}

export function pinnedModel(invocation: string): string | null {
  const row = db
    .query(`SELECT model_id FROM ancillary_models WHERE invocation = ?`)
    .get(invocation) as { model_id: string } | null;
  return row?.model_id ?? null;
}

/**
 * The model an invocation runs on. Pin → household ancillary model → chat
 * default, skipping anything that is not in the roster or whose provider has
 * no key — a pin to a model whose key was since removed must not take the
 * function down with it. Never null: the chat default is NOT NULL in the
 * schema, and householdDefaultModel() has a last-resort literal of its own.
 */
export function ancillaryModel(invocation: string): string {
  return (
    usable(pinnedModel(invocation)) ??
    usable(householdAncillaryModel()) ??
    usable(householdDefaultModel()) ??
    householdDefaultModel()
  );
}

export function setPinnedModel(invocation: string, modelId: string | null): void {
  if (!modelId) {
    db.run(`DELETE FROM ancillary_models WHERE invocation = ?`, [invocation]);
    return;
  }
  db.run(
    `INSERT INTO ancillary_models (invocation, model_id, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(invocation) DO UPDATE SET model_id = excluded.model_id, updated_at = datetime('now')`,
    [invocation, modelId],
  );
}

export function setHouseholdAncillaryModel(modelId: string): void {
  db.run(`UPDATE households SET ancillary_model = ? WHERE id = 'default'`, [modelId]);
}

/** Every invocation with what it currently resolves to, for the admin. */
export function ancillaryTable(): Array<AncillaryInvocation & { pinned: string | null; effective: string }> {
  return ANCILLARY_INVOCATIONS.map((i) => ({ ...i, pinned: pinnedModel(i.id), effective: ancillaryModel(i.id) }));
}

// ── The call ─────────────────────────────────────────────────────────────────

export interface AncillaryRequest {
  invocation: string;
  prompt: string;
  system?: string;
  maxTokens: number;
  temperature?: number;
  /** Anthropic-only hint (adaptive thinking budget); other providers ignore it. */
  effort?: "low" | "medium" | "high";
}

export interface AncillaryResult {
  text: string;
  model: string;
  provider: string;
  /** Why the model stopped: `end` is the normal case. `refusal` and
   *  `max_tokens` are what callers check before trusting the text. */
  stop: "end" | "max_tokens" | "refusal" | "other";
}

export class AncillaryError extends Error {
  constructor(message: string, public readonly status: number = 502) {
    super(message);
  }
}

/**
 * Run one ancillary request on the model the invocation resolves to, through
 * that model's provider. One prompt in, one text out — the ancillary functions
 * are single-turn and never use tools.
 */
export async function ancillaryComplete(req: AncillaryRequest): Promise<AncillaryResult> {
  const modelId = ancillaryModel(req.invocation);
  const model = getModel(modelId);
  const provider = model?.provider ?? "anthropic";
  const config = getHouseholdConfig();

  if (provider === "anthropic") {
    if (!config.apiKey) throw new AncillaryError("no Anthropic API key configured for this household", 422);
    const body: Record<string, unknown> = {
      model: modelId,
      max_tokens: req.maxTokens,
      messages: [{ role: "user", content: req.prompt }],
    };
    if (req.system) body.system = req.system;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.effort) body.output_config = { effort: req.effort };
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": config.apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new AncillaryError(`Anthropic API error: ${response.status} ${await response.text()}`);
    const result = (await response.json()) as {
      stop_reason?: string;
      content: Array<{ type: string; text?: string }>;
    };
    const text = result.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("").trim();
    const stop: AncillaryResult["stop"] =
      result.stop_reason === "refusal" ? "refusal"
      : result.stop_reason === "max_tokens" ? "max_tokens"
      : result.stop_reason === "end_turn" || result.stop_reason === "stop_sequence" ? "end"
      : "other";
    return { text, model: modelId, provider, stop };
  }

  const messages: Array<{ role: string; content: string }> = [];
  if (req.system) messages.push({ role: "system", content: req.system });
  messages.push({ role: "user", content: req.prompt });

  if (provider === "ollama") {
    let text = "";
    let stop: AncillaryResult["stop"] = "end";
    for await (const ev of ollamaTurn(modelId, messages, [], req.maxTokens)) {
      if (ev.type === "text") text += ev.text;
      else if (ev.type === "turn_end") text = ev.content || text;
      else if (ev.type === "error") throw new AncillaryError(`Ollama error: ${ev.message}`);
    }
    if (!text.trim()) stop = "other";
    return { text: text.trim(), model: modelId, provider, stop };
  }

  if (isOpenAIStyle(provider)) {
    const key = openaiStyleKey(provider, config);
    if (!key) throw new AncillaryError(`no ${provider} API key configured for this household`, 422);
    const baseUrl = openaiStyleBaseUrl(provider, config);
    let text = "";
    let stop: AncillaryResult["stop"] = "end";
    for await (const ev of openaiTurn(baseUrl, key, modelId, messages, [], req.temperature)) {
      if (ev.type === "text") text += ev.text;
      else if (ev.type === "turn_end") text = ev.content || text;
      else if (ev.type === "error") throw new AncillaryError(`${provider} error: ${ev.message}`);
    }
    if (!text.trim()) stop = "other";
    return { text: text.trim(), model: modelId, provider, stop };
  }

  throw new AncillaryError(`unknown provider "${provider}" for model ${modelId}`, 500);
}
