import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAppDir } from "../../lib/appDir";
import db from "../db";
import { ancillaryComplete, ancillaryModel, type AncillaryRequest, type AncillaryResult } from "./ancillary";
import { SYSTEM_SPENDER, recordSpend, verdict as budgetVerdict } from "./budget";
import { isDue } from "./corpusNightly";
import { memberLanguage } from "./domainBriefs";
import {
  attachProposals,
  conversationsSpokenFor,
  expireStale,
  insertProposal,
  openProposals,
  type Proposal,
  type ProposalStats,
} from "./domainProposals";
import { corpusCall } from "./mcpClient";
import { getModel } from "./models";
import { openConversation, openingGuard, type OpenRequest, type OpenResult } from "./openedConversations";
import { listUsers } from "./users";

// The nightly mapping — discovering a member's domains in their conversations
// (design of 19 September 2026, section 4a; the step-0 script made a service).
//
// For each member who may receive a conversation from Maurice (not a child,
// not a guest, none opened too recently, no proposal still open): take the
// conversations attached to no domain, ask the corpus to group them by their
// vectors (`corpus__map_conversations`: one centroid per conversation on the
// member's own turns, k-means on the sphere, a second level on any big
// block), keep the groups that recur over months and are still alive, and
// have the night model name and describe each (the `domain_mapping`
// invocation, under the system spender's cap). A group the model reads as
// several things is cut by the model when it is small enough for the model
// to see every title — the normal path for someone who talks little, as
// step 0 found on Paola — and left aside otherwise. What remains is written
// as proposals; when at least two are alive, Maurice opens a conversation
// (P2-A) with a message the same model writes: three domains that count now,
// the others that lived, the nuances. The three tools of that conversation
// live in domainProposals.ts.
//
// Nothing here creates a domain. A member who ignores the conversation is
// not reminded; their proposals expire after a few weeks and the next night
// maps again. Everything the night spends goes to the ledger's `system`
// spender, and the cap is checked before every call.

// ── Sizes and thresholds ─────────────────────────────────────────────────────

/** Conversations below which a corpus is "small": looser thresholds, and the
 *  model cuts the groups the vectors leave whole. */
export const SMALL_CORPUS = 200;

export interface Thresholds {
  minSize: number;
  minMonths: number;
  aliveDays: number;
}

/** Step 0's thresholds on a large corpus; gentler ones on a small one, where
 *  three conversations over two months are already a thread of a life. */
export function thresholdsFor(n: number): Thresholds {
  return n >= SMALL_CORPUS ? { minSize: 8, minMonths: 4, aliveDays: 180 } : { minSize: 3, minMonths: 2, aliveDays: 365 };
}

/** Proposals alive at least, for the night to open a conversation. */
export const MIN_ALIVE_PROPOSALS = 2;
/** Conversations at least before the night looks at a member. */
export const MIN_CONVERSATIONS = 6;
/** Presented in the opening message. */
export const PRESENTED = 3;
/** Groups named per night, alive first: the cost ceiling of a first night. */
export const MAX_NAMED = 18;
/** A group the model may cut itself: it must see every title. */
export const MODEL_SPLIT_MAX = 80;
/** Groups above this are clustered again by the corpus (the second level). */
export const SPLIT_ABOVE = 200;
/** A proposal unanswered this long is put away; the next night maps again. */
export const PROPOSAL_STALE_DAYS = 42;
/** Room for the reasoning tokens (DeepSeek bills them as output). */
const MAX_TOKENS = 4000;
/** A split lists up to eighty titles and reasons over each: DeepSeek used the
 *  whole 4 000 on the owner's first night and returned nothing. */
const SPLIT_MAX_TOKENS = 8000;

// ── What the run needs from the world ────────────────────────────────────────

export interface CorpusGroup {
  conversation_ids: string[];
  size: number;
  cohesion: number;
  depth: number;
  parent_size: number | null;
}

export interface MappingDeps {
  /** `corpus__map_conversations`, scoped to the member. */
  map: (memberId: string, conversationIds: string[]) => Promise<{ conversations: number; groups: CorpusGroup[] }>;
  /** The model call: `ancillaryComplete` in the server. */
  write: (req: AncillaryRequest) => Promise<AncillaryResult>;
  open: (req: OpenRequest) => Promise<OpenResult>;
  members: () => Array<{ id: string; role: string; is_child: boolean; display_name: string }>;
  now?: () => Date;
}

async function corpusMap(memberId: string, conversationIds: string[]) {
  const r = await corpusCall(memberId, "map_conversations", { conversation_ids: conversationIds, roles: ["user"], split_above: SPLIT_ABOVE });
  if (r?.error || r?.raw) throw new Error(String(r.error ?? r.raw));
  return { conversations: Number(r?.conversations ?? 0), groups: (r?.groups ?? []) as CorpusGroup[] };
}

const defaultDeps: MappingDeps = {
  map: corpusMap,
  write: ancillaryComplete,
  open: openConversation,
  members: () => listUsers(),
};

let deps: MappingDeps = defaultDeps;
/** Tests swap the corpus, the model and the opener for stubs. */
export function setMappingDeps(d: Partial<MappingDeps> | null): void {
  deps = d ? { ...defaultDeps, ...d } : defaultDeps;
}

// ── The member's unattached conversations ────────────────────────────────────

export interface Convo {
  id: string;
  title: string;
  origin: string;
  first: string; // ISO-ish, the member's first turn
  last: string;  // the member's last turn
  n_user: number;
  opening: string;
}

/** The conversations the mapping may read: the member's own (not a room),
 *  opened by them, bound to no domain, not spoken for by a proposal, with at
 *  least one turn of theirs. */
export function unattachedConversations(memberId: string): Convo[] {
  const rows = db
    .query(
      `SELECT c.id, COALESCE(c.title, '') AS title, COALESCE(c.origin, 'maurice') AS origin,
              MIN(m.created_at) AS first, MAX(m.created_at) AS last, COUNT(m.id) AS n_user
       FROM conversations c
       JOIN messages m ON m.conversation_id = c.id AND m.role = 'user'
       WHERE c.user_id = ? AND c.maurice_id IS NULL AND c.opened_by = 'member'
         AND (SELECT COUNT(*) FROM conversation_participants p WHERE p.conversation_id = c.id) <= 1
       GROUP BY c.id`,
    )
    .all(memberId) as Array<Omit<Convo, "opening">>;
  const taken = conversationsSpokenFor(memberId);
  return rows.filter((r) => !taken.has(r.id)).map((r) => ({ ...r, opening: "" }));
}

function openingOf(conversationId: string): string {
  const row = db
    .query(`SELECT content FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY created_at, rowid LIMIT 1`)
    .get(conversationId) as { content: string } | null;
  return squash(row?.content ?? "").slice(0, 300);
}

function squash(text: string): string {
  return text.replace(/```[\s\S]*?```/g, " ").replace(/!\[[^\]]*\]\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
}

// ── Reading a group ──────────────────────────────────────────────────────────

export interface GroupRead {
  ids: string[]; // ordered by closeness
  members: Convo[];
  stats: Omit<ProposalStats, "verdict"> & { size: number; verdict: "alive" | "lived" | "noise"; reason: string };
}

const DAY_MS = 24 * 60 * 60 * 1000;

function dayOf(s: string): Date {
  return new Date(s.includes("T") ? s : s.replace(" ", "T") + "Z");
}

/** Recurrence and recency, the two things step 0 settled on rather than
 *  volume: how many distinct months the group spans, how many conversations
 *  fall in the last ninety days, when it was last alive. */
export function readGroup(group: CorpusGroup, byId: Map<string, Convo>, today: Date, th: Thresholds): GroupRead {
  const members = group.conversation_ids.map((id) => byId.get(id)).filter((c): c is Convo => !!c);
  const months = new Set(members.map((c) => c.first.slice(0, 7)));
  const firsts = members.map((c) => c.first).sort();
  const lasts = members.map((c) => c.last).sort();
  const first = firsts[0] ?? "";
  const last = lasts[lasts.length - 1] ?? "";
  const ageDays = last ? Math.floor((today.getTime() - dayOf(last).getTime()) / DAY_MS) : Infinity;
  const recent90 = members.filter((c) => today.getTime() - dayOf(c.last).getTime() <= 90 * DAY_MS).length;
  const recent365 = members.filter((c) => today.getTime() - dayOf(c.last).getTime() <= 365 * DAY_MS).length;
  const imported = members.filter((c) => c.origin === "chatgpt" || c.origin === "anthropic").length;
  const n = members.length;
  let verdict: GroupRead["stats"]["verdict"];
  let reason: string;
  if (n < th.minSize) [verdict, reason] = ["noise", `${n} conversations, fewer than ${th.minSize}`];
  else if (months.size < th.minMonths) [verdict, reason] = ["noise", `active ${months.size} month(s), fewer than ${th.minMonths}`];
  else if (ageDays > th.aliveDays) [verdict, reason] = ["lived", `last conversation ${ageDays} days ago`];
  else [verdict, reason] = ["alive", `${months.size} active months, ${recent90} conversations in 90 days`];
  return {
    ids: group.conversation_ids.filter((id) => byId.has(id)),
    members,
    stats: {
      size: n,
      months_active: months.size,
      first,
      last,
      recent_90: recent90,
      recent_365: recent365,
      imported,
      cohesion: group.cohesion,
      verdict,
      reason,
      origin: group.depth > 0 ? "split" : "mapping",
    },
  };
}

// ── Naming with the model ────────────────────────────────────────────────────

export function namingSystem(name: string, language: string): string {
  return [
    `You help Maurice, a personal assistant, recognise the domains of ${name}'s life from an automatic grouping of their conversations. A domain is a part of their life they keep coming back to: a project, a practice, a role, a subject that follows them. It is neither a one-evening question nor a library category.`,
    `Answer in ${language}, plainly, addressing ${name} as "you" (the familiar form where the language has one — "tu" in French). Return one JSON object and nothing else.`,
  ].join("\n\n");
}

export function namingPrompt(g: GroupRead, name: string): string {
  const sample = g.members.slice(0, 20);
  const titles = sample.map((c) => `- ${c.title || "(untitled)"} (${c.first.slice(0, 7)})`).join("\n");
  const openings = sample
    .slice(0, 7)
    .map((c) => (c.opening ? `- "${c.opening.slice(0, 240)}"` : ""))
    .filter(Boolean)
    .join("\n");
  return [
    `Here is a group of ${g.stats.size} conversations of ${name}'s, active from ${g.stats.first?.slice(0, 7)} to ${g.stats.last?.slice(0, 7)} (${g.stats.months_active} distinct months, ${g.stats.recent_90} in the last 90 days). A sample:`,
    `Titles (closest to the group's centre):\n${titles}`,
    `First sentences of a few:\n${openings || "- (none)"}`,
    `Return a JSON object with these keys:\n- "name": a short domain name (2 to 5 words), as ${name} would say it;\n- "summary": a paragraph of 2 to 4 sentences on what this domain contains and what seems under way;\n- "is_domain": true if this is one coherent part of a life, false if it is a grab-bag or several unrelated things;\n- "split_hint": if it is several things, which ones in one sentence; else "".`,
  ].join("\n\n");
}

export function splitPrompt(g: GroupRead, name: string, hint: string): string {
  const lines = g.members.map((c, i) => `${i + 1}. ${c.title || c.opening.slice(0, 80) || "(untitled)"} (${c.first.slice(0, 7)})`).join("\n");
  return [
    `This group of ${g.members.length} conversations of ${name}'s is several things rather than one domain — you said: "${hint}". Here is every conversation, numbered:`,
    lines,
    `Cut it into 2 to 4 domains. A domain is a part of ${name}'s life they come back to; leave out what belongs to none (one-off questions). Return a JSON object: {"domains": [{"name": "…", "summary": "2 to 4 sentences", "conversations": [numbers]}]}. Every number at most once.`,
  ].join("\n\n");
}

export function parseJsonObject(text: string): any | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

export interface Named {
  name: string;
  summary: string;
  is_domain: boolean | null;
  split_hint: string;
}

export function parseNaming(text: string): Named | null {
  const d = parseJsonObject(text);
  if (!d || typeof d.name !== "string" || !d.name.trim()) return null;
  return {
    name: d.name.trim().slice(0, 80),
    summary: typeof d.summary === "string" ? d.summary.trim() : "",
    is_domain: typeof d.is_domain === "boolean" ? d.is_domain : null,
    split_hint: typeof d.split_hint === "string" ? d.split_hint.trim() : "",
  };
}

export function parseSplit(text: string, n: number): Array<{ name: string; summary: string; indexes: number[] }> {
  const d = parseJsonObject(text);
  const list = Array.isArray(d?.domains) ? d.domains : [];
  const used = new Set<number>();
  const out: Array<{ name: string; summary: string; indexes: number[] }> = [];
  for (const it of list) {
    if (!it || typeof it.name !== "string" || !it.name.trim()) continue;
    const idx: number[] = [];
    for (const raw of Array.isArray(it.conversations) ? it.conversations : []) {
      const x = Number(raw);
      if (!Number.isInteger(x) || x < 1 || x > n || used.has(x)) continue;
      used.add(x);
      idx.push(x);
    }
    if (!idx.length) continue;
    out.push({ name: it.name.trim().slice(0, 80), summary: typeof it.summary === "string" ? it.summary.trim() : "", indexes: idx });
  }
  return out;
}

// ── The opening message ──────────────────────────────────────────────────────

export function openerSystem(name: string, language: string): string {
  return [
    `You are Maurice, ${name}'s personal assistant. Tonight you looked over their past conversations — the ones imported from other assistants and the ones lived with you — and saw a few parts of their life you seem to follow. You are opening a conversation to propose them as *domains*: a domain is a part of their life you follow closely, with a short brief you keep on it that they can read and correct in the app. Nothing exists until they say yes.`,
    `Write in ${language}, addressing ${name} as "you" (the familiar form where the language has one — "tu" in French), in your own voice: warm, plain, no flattery, no filler, no emoji. Markdown is fine (a short list for the three domains). 150 to 250 words. No title. Say what you did in one sentence, present the three domains with what you understood of each in one or two sentences, mention that others lived at some point and name them briefly, raise the nuances you see (a group that might be two things, two that might be one, one that may not be a domain), and end by inviting them to adopt, rename, cut, merge or refuse — in this conversation, in their words. Ask nothing you could not act on here.`,
  ].join("\n\n");
}

export function openerPrompt(presented: Proposal[], others: Proposal[], name: string, sampleTitles: (p: Proposal) => string[]): string {
  const card = (p: Proposal) =>
    `- ${p.name} — ${p.conversation_ids.length} conversations, ${p.stats.first?.slice(0, 7)} → ${p.stats.last?.slice(0, 7)}, ${p.stats.recent_90 ?? 0} in the last 90 days.${p.stats.split_hint ? ` Might be several things: ${p.stats.split_hint}` : ""}\n  ${p.summary}\n  Sample: ${sampleTitles(p).join("; ")}`;
  return [
    `The three domains to present, alive now:\n${presented.map(card).join("\n")}`,
    others.length
      ? `Others you found — alive but not presented, or lived at some point (name them briefly, no detail):\n${others.map((p) => `- ${p.name} (${p.conversation_ids.length} conversations, ${p.stats.verdict === "lived" ? "quiet since " + p.stats.last?.slice(0, 7) : "alive"})`).join("\n")}`
      : `You found nothing else worth naming.`,
    `Write your opening message to ${name}.`,
  ].join("\n\n");
}

// ── One member ───────────────────────────────────────────────────────────────

export type MemberOutcome =
  | "opened"        // proposals written and the conversation opened
  | "proposed"      // proposals written, the opening failed (tried again next night)
  | "waiting"       // a proposal is still open in a conversation
  | "guarded"       // the guard refused (child, guest, too soon)
  | "too_few"       // not enough conversations to look at
  | "not_mature"    // fewer than two alive groups, or nothing the model calls a domain
  | "capped"        // the night's cap refused a call
  | "failed";

export interface MemberResult {
  member_id: string;
  outcome: MemberOutcome;
  reason?: string;
  conversations: number;
  groups: number;
  named: number;
  proposals: number;
  presented: string[];
  conversation_id?: string | null;
  cost_usd: number;
}

interface CallResult {
  text: string;
  cost: number;
}

/** One model call under the night's cap, charged to the system spender. */
async function call(invocation: string, system: string, prompt: string, temperature: number, maxTokens = MAX_TOKENS): Promise<CallResult | { capped: string } | { failed: string; cost: number }> {
  const modelId = ancillaryModel(invocation);
  const provider = getModel(modelId)?.provider ?? null;
  const v = budgetVerdict(provider, modelId, 0, SYSTEM_SPENDER);
  if (!v.ok) return { capped: v.reason ?? "capped" };
  let r: AncillaryResult;
  try {
    r = await deps.write({ invocation, system, prompt, maxTokens, temperature });
  } catch (err) {
    return { failed: (err as Error).message, cost: 0 };
  }
  recordSpend(r.usage, SYSTEM_SPENDER);
  const cost = r.usage?.cost ?? 0;
  // A reply with nothing usable was still billed: the ledger has it, and so
  // does the night's count.
  if (r.stop === "refusal" || !r.text.trim()) return { failed: `the model returned nothing usable (${r.stop})`, cost };
  return { text: r.text, cost };
}

function sampleTitles(byId: Map<string, Convo>) {
  return (p: Proposal) =>
    p.conversation_ids
      .slice(0, 5)
      .map((id) => byId.get(id)?.title || "")
      .filter(Boolean);
}

/**
 * Map one member's conversations and, when the criterion is met, open the
 * conversation that proposes what was found. `dryRun` maps and names but
 * writes no proposal and opens nothing (the model calls are still made and
 * charged). Never throws.
 */
export async function mapMember(memberId: string, opts: { dryRun?: boolean; force?: boolean } = {}): Promise<MemberResult & { dry?: Array<Named & { stats: ProposalStats }> }> {
  const now = deps.now ?? (() => new Date());
  const today = now();
  const res: MemberResult & { dry?: Array<Named & { stats: ProposalStats }> } = {
    member_id: memberId,
    outcome: "failed",
    conversations: 0,
    groups: 0,
    named: 0,
    proposals: 0,
    presented: [],
    cost_usd: 0,
  };
  const member = deps.members().find((m) => m.id === memberId);
  const name = member?.display_name || "the member";
  const language = memberLanguage(memberId);

  // A proposal still open in a conversation: nothing to do but wait, unless
  // it has waited too long. Proposals without a conversation (the opening
  // failed last time) are opened again without mapping anew — through the
  // guard, which the opener applies.
  expireStale(memberId, PROPOSAL_STALE_DAYS, today);
  const open = openProposals(memberId);
  if (open.length && !opts.dryRun) {
    if (open.some((p) => p.conversation_id)) return { ...res, outcome: "waiting", proposals: open.length, reason: "a proposal is still open" };
    return finishOpening(res, memberId, name, language, open, new Map(), opts);
  }

  // The guard, before anything is spent: a child or a guest gets nothing,
  // and a member who received a conversation recently waits.
  const guard = openingGuard(memberId, today);
  if (!guard.ok && !opts.force) return { ...res, outcome: "guarded", reason: guard.reason };

  const convos = unattachedConversations(memberId);
  res.conversations = convos.length;
  if (convos.length < MIN_CONVERSATIONS) return { ...res, outcome: "too_few", reason: `${convos.length} conversations, fewer than ${MIN_CONVERSATIONS}` };
  const byId = new Map(convos.map((c) => [c.id, c]));

  let groups: CorpusGroup[];
  try {
    const r = await deps.map(memberId, convos.map((c) => c.id));
    groups = r.groups;
  } catch (err) {
    return { ...res, outcome: "failed", reason: `corpus: ${(err as Error).message}` };
  }
  res.groups = groups.length;
  const th = thresholdsFor(convos.length);
  const read = groups.map((g) => readGroup(g, byId, today, th));
  const order = (a: GroupRead, b: GroupRead) => (b.stats.recent_90 ?? 0) - (a.stats.recent_90 ?? 0) || b.stats.size - a.stats.size;
  const alive = read.filter((g) => g.stats.verdict === "alive").sort(order);
  const lived = read.filter((g) => g.stats.verdict === "lived").sort(order);
  // Maturity, before spending: at least two groups that recur and live.
  if (alive.length < MIN_ALIVE_PROPOSALS) {
    return { ...res, outcome: "not_mature", reason: `${alive.length} alive group(s) of ${read.length}, ${lived.length} lived` };
  }

  // Name the alive groups first, then the lived ones, up to the ceiling.
  const toName = [...alive, ...lived].slice(0, MAX_NAMED);
  for (const g of toName) g.members.forEach((c) => { if (!c.opening) c.opening = openingOf(c.id); });
  const candidates: Array<{ named: Named; ids: string[]; stats: ProposalStats }> = [];
  for (const g of toName) {
    const r = await call("domain_mapping", namingSystem(name, language), namingPrompt(g, name), 0.3);
    if ("capped" in r) return { ...res, outcome: "capped", reason: r.capped, named: res.named };
    if ("failed" in r) { res.cost_usd += r.cost; console.warn(`[mapping] naming failed for ${name}: ${r.failed}`); continue; }
    res.cost_usd += r.cost;
    res.named++;
    const named = parseNaming(r.text);
    if (!named) continue;
    const stats: ProposalStats = { ...g.stats, verdict: g.stats.verdict === "lived" ? "lived" : "alive", is_domain: named.is_domain, split_hint: named.split_hint, night: today.toISOString().slice(0, 10) };
    if (named.is_domain !== false) {
      candidates.push({ named, ids: g.ids, stats });
      continue;
    }
    // A grab-bag. Small enough for the model to see every title: let it cut.
    if (g.members.length > MODEL_SPLIT_MAX || g.stats.verdict !== "alive") {
      console.log(`[mapping] "${named.name}" (${g.members.length}) is not a domain for the model; left aside${named.split_hint ? `: ${named.split_hint}` : ""}`);
      continue;
    }
    const s = await call("domain_mapping", namingSystem(name, language), splitPrompt(g, name, named.split_hint || named.summary), 0.3, SPLIT_MAX_TOKENS);
    if ("capped" in s) return { ...res, outcome: "capped", reason: s.capped };
    if ("failed" in s) { res.cost_usd += s.cost; console.warn(`[mapping] split failed for ${name}: ${s.failed}`); continue; }
    res.cost_usd += s.cost;
    for (const part of parseSplit(s.text, g.members.length)) {
      const ids = part.indexes.map((i) => g.members[i - 1]!.id);
      if (ids.length < th.minSize) continue;
      const sub = readGroup({ conversation_ids: ids, size: ids.length, cohesion: g.stats.cohesion ?? 0, depth: 1, parent_size: g.members.length }, byId, today, th);
      if (sub.stats.verdict === "noise") continue;
      candidates.push({
        named: { name: part.name, summary: part.summary, is_domain: true, split_hint: "" },
        ids,
        stats: { ...sub.stats, verdict: sub.stats.verdict === "lived" ? "lived" : "alive", is_domain: true, origin: "model_split", night: stats.night },
      });
    }
  }

  const aliveCands = candidates.filter((c) => c.stats.verdict === "alive");
  if (aliveCands.length < MIN_ALIVE_PROPOSALS) {
    return { ...res, outcome: "not_mature", reason: `${aliveCands.length} alive domain(s) after naming, ${candidates.length - aliveCands.length} lived` };
  }
  if (opts.dryRun) {
    return { ...res, outcome: "proposed", proposals: candidates.length, dry: candidates.map((c) => ({ ...c.named, stats: c.stats })) };
  }

  // Write the proposals: the three alive ones that count now are presented.
  const sorted = [...candidates].sort((a, b) => {
    const av = a.stats.verdict === "alive" ? 0 : 1;
    const bv = b.stats.verdict === "alive" ? 0 : 1;
    return av - bv || (b.stats.recent_90 ?? 0) - (a.stats.recent_90 ?? 0) || (b.stats.size ?? 0) - (a.stats.size ?? 0);
  });
  const proposals = sorted.map((c, i) =>
    insertProposal({
      member_id: memberId,
      name: c.named.name,
      summary: c.named.summary,
      conversation_ids: c.ids,
      presented: i < PRESENTED && c.stats.verdict === "alive",
      stats: c.stats,
    }),
  );
  res.proposals = proposals.length;
  console.log(`[mapping] ${name}: ${proposals.length} proposal(s) from ${res.groups} group(s) of ${convos.length} conversations (${res.named} named, $${res.cost_usd.toFixed(4)})`);
  return finishOpening(res, memberId, name, language, proposals, byId, opts);
}

/** Write the opening message with the model and open the conversation. */
async function finishOpening(
  res: MemberResult,
  memberId: string,
  name: string,
  language: string,
  proposals: Proposal[],
  byId: Map<string, Convo>,
  opts: { force?: boolean },
): Promise<MemberResult> {
  const presented = proposals.filter((p) => p.presented).slice(0, PRESENTED);
  const others = proposals.filter((p) => !presented.includes(p));
  res.proposals = proposals.length;
  res.presented = presented.map((p) => p.name);
  const titles = byId.size ? sampleTitles(byId) : sampleTitlesFromDb(memberId);
  const r = await call("domain_mapping", openerSystem(name, language), openerPrompt(presented, others, name, titles), 0.6);
  if ("capped" in r) return { ...res, outcome: "capped", reason: r.capped };
  if ("failed" in r) return { ...res, outcome: "proposed", reason: `opener: ${r.failed}`, cost_usd: res.cost_usd + r.cost };
  res.cost_usd += r.cost;
  const opened = await deps.open({ memberId, text: r.text.trim(), title: null, force: opts.force });
  if (!opened.ok) return { ...res, outcome: opened.reason === "empty" ? "proposed" : "guarded", reason: opened.reason };
  attachProposals(proposals.map((p) => p.id), opened.conversation.id);
  console.log(`[mapping] ${name}: conversation ${opened.conversation.id} opened with ${presented.length} domain(s) presented`);
  return { ...res, outcome: "opened", conversation_id: opened.conversation.id };
}

function sampleTitlesFromDb(memberId: string) {
  return (p: Proposal) => {
    const take = p.conversation_ids.slice(0, 5);
    if (!take.length) return [];
    const rows = db
      .query(`SELECT id, COALESCE(title, '') AS title FROM conversations WHERE user_id = ? AND id IN (${take.map(() => "?").join(",")})`)
      .all(memberId, ...take) as Array<{ id: string; title: string }>;
    return rows.map((r) => r.title).filter(Boolean);
  };
}

// ── The night ────────────────────────────────────────────────────────────────
//
// An hour after the briefs (04:00), two after the corpus (03:00): the store
// has last evening's conversations. Same shape as the other two nights.

const HOUR = 5;
const TICK_MS = 10 * 60 * 1000;
const FIRST_TICK_MS = 60_000;

export type MappingNightlyOutcome = "done" | "capped" | "failed" | "no_members";

export interface MappingNightlyStats {
  members: number;
  opened: number;
  proposals: number;
  waiting: number;
  skipped: number;
  cost_usd: number;
  results: MemberResult[];
}

export interface MappingNightlyState {
  last_run_at: string | null;
  last_outcome: MappingNightlyOutcome | null;
  last_error: string | null;
  last_stats: MappingNightlyStats | null;
  duration_ms: number | null;
}

let nightly: Promise<MappingNightlyOutcome> | null = null;
let state: MappingNightlyState | null = null;

export function mappingNightlyOn(): boolean {
  if (process.env.MAURICE_DOMAIN_MAPPING?.trim() === "off") return false;
  if (process.env.NODE_ENV === "test") return false;
  return true;
}

function stateFile(): string {
  return join(getAppDir(), "domain-mapping-nightly.json");
}

function loadState(): MappingNightlyState {
  if (state) return state;
  try {
    if (existsSync(stateFile())) {
      state = JSON.parse(readFileSync(stateFile(), "utf8"));
      return state!;
    }
  } catch {
    // A corrupt state file costs one extra run, nothing more.
  }
  state = { last_run_at: null, last_outcome: null, last_error: null, last_stats: null, duration_ms: null };
  return state;
}

function saveState(next: MappingNightlyState): void {
  state = next;
  try {
    mkdirSync(dirname(stateFile()), { recursive: true });
    writeFileSync(stateFile(), JSON.stringify(next, null, 2) + "\n");
  } catch (err) {
    console.warn(`[mapping] nightly: could not save state: ${(err as Error).message}`);
  }
}

export function mappingNightlyStatus(): MappingNightlyState & { on: boolean; running: boolean } {
  return { ...loadState(), on: mappingNightlyOn(), running: nightly !== null };
}

async function doNight(): Promise<MappingNightlyOutcome> {
  const now = deps.now ?? (() => new Date());
  const started = now();
  const finish = (outcome: MappingNightlyOutcome, error: string | null, stats: MappingNightlyStats | null) => {
    saveState({
      last_run_at: started.toISOString(),
      last_outcome: outcome,
      last_error: error,
      last_stats: stats,
      duration_ms: now().getTime() - started.getTime(),
    });
    return outcome;
  };
  // Children and guests are refused by the guard inside mapMember, and
  // counted as skipped; they are listed here so the card can say so.
  const members = deps.members();
  const stats: MappingNightlyStats = { members: members.length, opened: 0, proposals: 0, waiting: 0, skipped: 0, cost_usd: 0, results: [] };
  if (!members.length) return finish("no_members", null, stats);
  let lastError: string | null = null;
  let capped = false;
  for (const m of members) {
    const r = await mapMember(m.id);
    stats.results.push(r);
    stats.cost_usd += r.cost_usd;
    if (r.outcome === "opened") { stats.opened++; stats.proposals += r.proposals; }
    else if (r.outcome === "proposed") { stats.proposals += r.proposals; lastError = `${m.id}: ${r.reason ?? "not opened"}`; }
    else if (r.outcome === "waiting") stats.waiting++;
    else if (r.outcome === "capped") { capped = true; lastError = r.reason ?? "capped"; console.warn(`[mapping] nightly: stopped — ${lastError}`); break; }
    else if (r.outcome === "failed") { lastError = `${m.id}: ${r.reason ?? "failed"}`; console.warn(`[mapping] nightly: ${lastError}`); }
    else stats.skipped++;
  }
  const ms = now().getTime() - started.getTime();
  console.log(
    `[mapping] nightly: ${stats.opened} conversation(s) opened, ${stats.proposals} proposal(s), ${stats.waiting} waiting, ${stats.skipped} skipped ` +
      `across ${stats.members} member(s) for $${stats.cost_usd.toFixed(4)} in ${Math.round(ms / 1000)}s`,
  );
  return finish(capped ? "capped" : lastError ? "failed" : "done", lastError, stats);
}

/** Map every member now. Never throws; a run already going is shared. */
export function runDomainMapping(): Promise<MappingNightlyOutcome> {
  if (!nightly) {
    nightly = doNight().finally(() => {
      nightly = null;
    });
  }
  return nightly;
}

/** Tick every ten minutes; run once per local day from HOUR on. */
export function scheduleDomainMappingNightly(): void {
  if (!mappingNightlyOn()) {
    console.log("[mapping] nightly mapping off");
    return;
  }
  const tick = () => {
    if (nightly) return;
    if (!isDue(new Date(), loadState().last_run_at, HOUR)) return;
    runDomainMapping().catch((err) => console.error(`[mapping] nightly: ${(err as Error).message}`));
  };
  setTimeout(() => {
    tick();
    setInterval(tick, TICK_MS).unref();
  }, FIRST_TICK_MS).unref();
}
