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

import { existsSync } from "fs";
import { join } from "path";
import db from "../db";
import { getModel, configuredProviders, householdDefaultModel } from "./models";
import { getHouseholdConfig, isOpenAIStyle, openaiStyleBaseUrl, openaiStyleKey } from "./claude";
import { openaiTurn } from "./openaiChat";
import { ollamaTurn } from "./ollama";
import { newUsage, priceUsage, type TurnUsage } from "./pricing";

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
  /**
   * For a `tools` invocation: the directory, relative to the repo root, whose
   * code actually runs it. Thirteen of the `tools/*` entries are symlinks into
   * the private maurice-tools repo and the image's dockerignore keeps them out
   * (infra/container/Dockerfile), so a hosted household ships `tools/corpus`,
   * `tools/garden`, `tools/mcp_gateway` and `tools/shared` and nothing else.
   * An invocation whose directory is absent is not a setting on that instance:
   * it is a function that does not exist there, and listing it invites an
   * admin to choose a model for something that will never run.
   */
  needs?: string;
  /**
   * True while the tool still runs its own turn rather than asking the server
   * for one. The research pipelines are the case: they choose a provider from
   * their own settings (research_tracks/providers/base.py), so a model id from
   * here is only half the story and advising one from another provider would
   * have that id sent to whatever provider their config names. Nothing is
   * advised for these; they stay on the household model until they are
   * converted to the server's turn endpoint like the rest.
   */
  ownDispatch?: boolean;
  /**
   * A preference of its own, best first, tried before the tier's list. For
   * the night's functions: P0 bis (19 September 2026) had two candidates
   * write the same briefs, and DeepSeek V4 Flash keeps a brief where Mistral
   * Small summarises one — it dates, closes and opens threads, and really
   * rewrites at the incremental pass — for a third of a euro cent per domain
   * per night. The tier's list would have advised GPT-OSS, which nobody read.
   */
  prefer?: string[];
}

/** The night model P0 bis chose, and its fallback — see `prefer` above. */
const NIGHT_MODELS = [
  "deepseek-v4-flash-0731",              // scaleway — the brief that reads like one
  "mistral-small-3.2-24b-instruct-2506", // scaleway — five times cheaper, summarises
  "mistral-small-latest",                // mistral
];

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
  // The night (services/domainBriefs.ts): what Maurice writes on nobody's turn,
  // charged to the ledger's "system" spender and capped by the night's allowance.
  { id: "domain_brief", side: "server", tier: "standard", label: "Domain brief",
    blurb: "A domain's brief, rewritten at night from the previous one and the conversations that touched it since.",
    prefer: NIGHT_MODELS },
  { id: "domain_mapping", side: "server", tier: "standard", label: "Domain mapping",
    blurb: "Naming and describing the groups of conversations the night finds, to propose them as domains.",
    prefer: NIGHT_MODELS },
  // Python tools (models.yml's assignments, now settable here)
  { id: "dossier_title", side: "tools", tier: "light", label: "Dossier title", blurb: "Naming a research dossier.", needs: "tools/pipelines/research_tracks", ownDispatch: true },
  { id: "topic_tags", side: "tools", tier: "light", label: "Topic tags", blurb: "Tagging a topic or an entry.", needs: "tools/pipelines/research_tracks", ownDispatch: true },
  { id: "search_queries", side: "tools", tier: "light", label: "Search queries", blurb: "Turning a question into web searches.", needs: "tools/tracks", ownDispatch: true },
  { id: "git_descriptions", side: "tools", tier: "light", label: "Git descriptions", blurb: "Describing a repository's activity for the signals.", needs: "tools/signals" },
  { id: "moc_evocations", side: "tools", tier: "light", label: "MOC evocations", blurb: "The line a map-of-content says about each note.", needs: "tools/garden" },
  { id: "dream_analysis", side: "tools", tier: "light", label: "Dream analysis", blurb: "Reading a dream written in the journal.", needs: "tools/garden" },
  { id: "dossier_synthesis", side: "tools", tier: "standard", label: "Dossier synthesis", blurb: "Writing up a research dossier.", needs: "tools/pipelines/research_tracks", ownDispatch: true },
  { id: "gap_analysis", side: "tools", tier: "standard", label: "Gap analysis", blurb: "What a dossier still lacks.", needs: "tools/pipelines/research_tracks", ownDispatch: true },
  { id: "briefing_content", side: "tools", tier: "standard", label: "Briefing content", blurb: "The briefing's sections.", needs: "tools/pipelines/research_tracks", ownDispatch: true },
  { id: "media_curation", side: "tools", tier: "standard", label: "Media curation", blurb: "Choosing and describing media for a dossier.", needs: "tools/pipelines/research_tracks", ownDispatch: true },
  { id: "signal_report", side: "tools", tier: "standard", label: "Signal report", blurb: "The periodic report over the signals.", needs: "tools/pipelines/research_tracks", ownDispatch: true },
  { id: "resonance_queries", side: "tools", tier: "standard", label: "Résonance queries", blurb: "What to look for when linking an entry to the garden.", needs: "tools/pipelines/research_tracks", ownDispatch: true },
  { id: "resonance_filtering", side: "tools", tier: "standard", label: "Résonance filtering", blurb: "Keeping the links that resonate.", needs: "tools/pipelines/research_tracks", ownDispatch: true },
  { id: "book_classification", side: "tools", tier: "standard", label: "Book classification", blurb: "Front matter, body, back matter — which chapters count.", needs: "tools/calibre" },
];

export function isAncillaryInvocation(id: string): boolean {
  return ANCILLARY_INVOCATIONS.some((i) => i.id === id);
}

/** The repo root this server was installed from — `/app` in the image. */
const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

/**
 * The invocations this instance can actually run. Everything the server does
 * itself, plus the tools whose code shipped with it. A household that has no
 * `tools/pipelines/research_tracks` has no dossier synthesis to configure, and
 * saying otherwise in the admin is an offer it cannot keep. Cached: the
 * filesystem does not change under a running server.
 */
let presentCache: AncillaryInvocation[] | null = null;
export function presentInvocations(): AncillaryInvocation[] {
  presentCache ??= ANCILLARY_INVOCATIONS.filter(
    (i) => !i.needs || existsSync(join(REPO_ROOT, i.needs)),
  );
  return presentCache;
}

// ── Preferred models: what each tier deserves ────────────────────────────────
// Left alone, every one of the invocations above ran on the household's chat
// model, because that is what the ancillary default was backfilled from. That
// is the wrong economics: naming a dossier or tagging a topic on a flagship
// costs a flagship's output price for one sentence and is no better at it.
//
// So each tier has a list of preferred models, best first, and an invocation
// takes the first one its household can actually call. A list rather than a
// range per provider, because the question is "what should summarise a
// conversation here", not "which provider does this household belong to".
//
// Who is in, and who is not:
//  - **Scaleway** leads every tier. European, served from Paris, and cheap
//    where it matters.
//  - **Mistral** follows, for a household that has that key and not the other.
//  - **Z.ai** is absent: GLM 5.3 and its Flash are both large models, and a
//    dossier title on either is the thing being avoided.
//  - **Anthropic and OpenAI are absent by decision, not by size** (18 September
//    2026): American, and dear for work a small European model does as well.
//    A household whose only keys are those is advised nothing and keeps its
//    own model, and the admin screen says which key would change that.
//
// `applyRecommendedPins` writes the choices into the pins table, where the
// admin sees and overrides every one of them. Written into the table rather
// than resolved on the fly on purpose: the Python tools read
// `ancillary_models` straight from maurice.db (tools/shared/model_config.py),
// so a rule that lived only in this file would hold for the server and not for
// them.
//
// Ollama is absent for a different reason: its roster is whatever the host has
// pulled, so there is no id to name here.
export const PREFERRED: Record<AncillaryTier, string[]> = {
  // A sentence, a title, three tags. The cheapest capable model wins.
  light: [
    "mistral-small-3.2-24b-instruct-2506", // scaleway, reads images too
    "mistral-small-latest",                // mistral
  ],
  // A paragraph of prose: summaries, syntheses, briefings. Output tokens are
  // what these spend, so the order follows the output price.
  standard: [
    "gpt-oss-120b",                        // scaleway — OpenAI's weights, Paris
    "mistral-small-latest",                // mistral
  ],
  // The few that genuinely reason — flashcards today, and nothing else.
  heavy: [
    "qwen3.5-397b-a17b",                   // scaleway
    "mistral-large-latest",                // mistral
  ],
};

/**
 * Since 18 September 2026 a `side: "tools"` invocation is no different: the
 * tools ask the server for their turn (src/routes/ancillary.ts) rather than
 * building an Anthropic client around the id they were given, so every
 * provider the server can dispatch is available to them too. The list below is
 * the household's whole answer, for both sides.
 */
function callableHere(id: string): boolean {
  const m = getModel(id);
  return !!m && configuredProviders().has(m.provider);
}

/** What an invocation should run on, before any pin: the first preferred model
 *  of its tier this household can call. Null when it can call none of them. */
export function recommendedModel(invocation: string): string | null {
  const inv = ANCILLARY_INVOCATIONS.find((i) => i.id === invocation);
  if (!inv || inv.ownDispatch) return null;
  return [...(inv.prefer ?? []), ...PREFERRED[inv.tier]].find(callableHere) ?? null;
}

/** Does any function have advice to take? The admin screen asks before it
 *  offers the button. */
export function hasRecommendations(): boolean {
  return presentInvocations().some((i) => recommendedModel(i.id) !== null);
}

/**
 * The one loop behind the button, the first-start seed and the refresh: pin
 * each eligible invocation to its advice, as "auto". Returns the ids actually
 * changed, so the admin is told what moved rather than just "saved".
 */
function repin(eligible: (inv: AncillaryInvocation) => boolean): string[] {
  const changed: string[] = [];
  for (const inv of presentInvocations()) {
    if (!eligible(inv)) continue;
    const want = recommendedModel(inv.id);
    if (!want || pinnedModel(inv.id) === want) continue;
    setPinnedModel(inv.id, want, "auto");
    changed.push(inv.id);
  }
  return changed;
}

/** Pin every invocation that has a preferred model — the admin's button, which
 *  is allowed to move a person's own pins because a person pressed it. */
export function applyRecommendedPins(): string[] {
  return repin(() => true);
}

/**
 * Put the range in place once, on a household that has never had a pin. New
 * instances therefore start fine-grained, and an existing one is moved off
 * "everything on the chat model" the first time it starts on this code — both
 * recorded as ordinary pins the admin can read and change.
 *
 * Only the invocations with no pin at all. The form has existed since 13
 * September 2026, so a household may reach this code with pins a person set by
 * hand, and a start is nobody pressing a button: those rows stay exactly as
 * they are (db.ts marks them "admin" when no seed ever ran here).
 */
export function seedAncillaryPinsOnce(): string[] {
  const row = db
    .query(`SELECT ancillary_pins_seeded FROM households WHERE id = 'default'`)
    .get() as { ancillary_pins_seeded: number } | null;
  if (row?.ancillary_pins_seeded) return [];
  const changed = repin((inv) => pinnedModel(inv.id) === null);
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

/**
 * Pin an invocation. `source` says who decided: "admin" is a person's choice
 * and nothing in here ever moves it again; "auto" is this file's own advice,
 * which `refreshAutoPins` revises when the advice changes. The admin screen
 * passes "auto" when the value it submits is what was advised anyway — being
 * of the same opinion is not a decision to freeze.
 */
export function setPinnedModel(
  invocation: string,
  modelId: string | null,
  source: "admin" | "auto" = "admin",
): void {
  if (!modelId) {
    db.run(`DELETE FROM ancillary_models WHERE invocation = ?`, [invocation]);
    return;
  }
  db.run(
    `INSERT INTO ancillary_models (invocation, model_id, updated_at, source) VALUES (?, ?, datetime('now'), ?)
     ON CONFLICT(invocation) DO UPDATE SET model_id = excluded.model_id, updated_at = datetime('now'), source = excluded.source`,
    [invocation, modelId, source],
  );
}

/** Who chose the current pin, if there is one. */
export function pinSource(invocation: string): "admin" | "auto" | null {
  const row = db
    .query(`SELECT source FROM ancillary_models WHERE invocation = ?`)
    .get(invocation) as { source: "admin" | "auto" } | null;
  return row?.source ?? null;
}

/**
 * Bring the pins nobody chose back in line with what is advised now. Aline is
 * why: her five pins were written by an earlier version of this file, which
 * read her GLM chat and advised GLM for everything, and she should not have to
 * press a button to be moved onto the Scaleway models her household can call.
 * An "admin" pin is left exactly where it is, and a pin that was deleted stays
 * deleted — this only revises, it never re-creates.
 */
export function refreshAutoPins(): string[] {
  return repin((inv) => pinSource(inv.id) === "auto");
}

export function setHouseholdAncillaryModel(modelId: string): void {
  db.run(`UPDATE households SET ancillary_model = ? WHERE id = 'default'`, [modelId]);
}

/** Every invocation with what it currently resolves to, for the admin. */
export function ancillaryTable(): Array<AncillaryInvocation & { pinned: string | null; effective: string }> {
  return presentInvocations().map((i) => ({ ...i, pinned: pinnedModel(i.id), effective: ancillaryModel(i.id) }));
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
  /**
   * Run on this model instead of the invocation's pin. For an experiment
   * that compares models on the same prompt — the domains' night model was
   * chosen this way, three briefs by two models each — not for a function
   * to pick its own model: the admin's pin is the rule, this is the exception
   * that says so in the call. The model must be in the roster and its
   * provider must have a key, exactly as a pin must.
   */
  model?: string;
}

export interface AncillaryResult {
  text: string;
  model: string;
  provider: string;
  /** Why the model stopped: `end` is the normal case. `refusal` and
   *  `max_tokens` are what callers check before trusting the text. */
  stop: "end" | "max_tokens" | "refusal" | "other";
  /** What the turn cost, when the provider reported tokens: the same shape
   *  the chat meters, priced by pricing.ts (null cost = unpriced model). */
  usage: TurnUsage | null;
}

function usageOf(provider: string, model: string, input: number, output: number, cached = 0): TurnUsage {
  const u = newUsage(provider, model);
  u.rounds = 1;
  u.input = Math.max(0, input - cached);
  u.output = output;
  u.cache_read = cached;
  return priceUsage(u);
}

/** The model a request runs on: its override, checked as a pin would be, else
 *  the invocation's resolution. */
function requestedModel(req: AncillaryRequest): string {
  if (!req.model) return ancillaryModel(req.invocation);
  const model = getModel(req.model);
  if (!model) throw new AncillaryError(`unknown model "${req.model}"`, 400);
  if (!configuredProviders().has(model.provider)) {
    throw new AncillaryError(`no ${model.provider} key configured for this household`, 422);
  }
  return req.model;
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
  const modelId = requestedModel(req);
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
      usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
    };
    const text = result.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("").trim();
    const stop: AncillaryResult["stop"] =
      result.stop_reason === "refusal" ? "refusal"
      : result.stop_reason === "max_tokens" ? "max_tokens"
      : result.stop_reason === "end_turn" || result.stop_reason === "stop_sequence" ? "end"
      : "other";
    const u = result.usage;
    const usage = u
      ? usageOf(provider, modelId, (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0), u.output_tokens ?? 0, u.cache_read_input_tokens ?? 0)
      : null;
    return { text, model: modelId, provider, stop, usage };
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
    // Local tokens are free rather than unpriced, and uncounted here.
    return { text: text.trim(), model: modelId, provider, stop, usage: usageOf(provider, modelId, 0, 0) };
  }

  if (isOpenAIStyle(provider)) {
    const key = openaiStyleKey(provider, config);
    if (!key) throw new AncillaryError(`no ${provider} API key configured for this household`, 422);
    const baseUrl = openaiStyleBaseUrl(provider, config);
    let text = "";
    let stop: AncillaryResult["stop"] = "end";
    let usage: TurnUsage | null = null;
    for await (const ev of openaiTurn(baseUrl, key, modelId, messages, [], req.temperature)) {
      if (ev.type === "text") text += ev.text;
      else if (ev.type === "turn_end") {
        text = ev.content || text;
        if (ev.usage) usage = usageOf(provider, modelId, ev.usage.prompt, ev.usage.completion, ev.usage.cached);
      }
      else if (ev.type === "error") throw new AncillaryError(`${provider} error: ${ev.message}`);
    }
    if (!text.trim()) stop = "other";
    return { text: text.trim(), model: modelId, provider, stop, usage };
  }

  throw new AncillaryError(`unknown provider "${provider}" for model ${modelId}`, 500);
}
