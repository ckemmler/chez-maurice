import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAppDir } from "../../lib/appDir";
import db from "../db";
import { ancillaryComplete, ancillaryModel, type AncillaryRequest, type AncillaryResult } from "./ancillary";
import { SYSTEM_SPENDER, recordSpend, verdict as budgetVerdict } from "./budget";
import { isDue } from "./corpusNightly";
import { memberLanguage, memberLocale, refreshBrief } from "./domainBriefs";
import { attachMail, listMailThreads, mapMailThreads, type MailThread } from "./domainMail";
import { openerPrompt, openerStrings, openerSystem, openingTitle, parseOpener, renderFollowUp, renderOpening } from "./domainOpener";
import {
  attachProposals,
  conversationsSpokenFor,
  expireStale,
  insertProposal,
  listProposals,
  mailSpokenFor,
  memberConversationCount,
  openProposals,
  sayInConversation,
  updateProposal,
  type Proposal,
  type ProposalStats,
} from "./domainProposals";
import { getMaurice } from "./maurices";
import { isMailNightlyDue, mailNightlyOn, mailNightlyStatus } from "./mailScan";
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
// (P2-A) whose first message the server renders from the proposals — every
// alive one with its weight, the lived ones named apart — around three short
// parts the same model writes: the introduction, the nuances, the invitation
// (domainOpener.ts, P2-D). The tools of that conversation live in
// domainProposals.ts.
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

/** The mail's thresholds (27 September 2026). A thread is denser than a
 *  conversation — a dozen messages over months — and its months are those of
 *  its timeline, so four threads over two months already say something; a
 *  thread quiet for a year is lived. */
export const MAIL_THRESHOLDS: Thresholds = { minSize: 4, minMonths: 2, aliveDays: 365 };
/** Thread digests at least before the night looks at the mail. */
export const MIN_MAIL_THREADS = 8;
/** Mail groups named per night. */
export const MAX_NAMED_MAIL = 14;

/** Proposals alive at least, for the night to open a conversation. */
export const MIN_ALIVE_PROPOSALS = 2;
/** Conversations at least before the night looks at a member. */
export const MIN_CONVERSATIONS = 6;
/** Alive proposals at least, for the night to open a conversation. Every
 *  alive proposal is presented in the opening message since P2-D. */
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
  /** The member's thread digests (services/domainMail.ts). */
  threads: (memberId: string) => MailThread[];
  /** `corpus__map_notes` on those digests; ids are garden-relative paths. */
  mapMail: (memberId: string, threads: MailThread[]) => Promise<{ notes: number; groups: CorpusGroup[] }>;
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
  threads: listMailThreads,
  mapMail: mapMailThreads,
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
  /** A mail thread's digest rather than a conversation: `id` is its garden
   *  path, `first`/`last` the ends of its timeline, `opening` what it is about. */
  kind?: "mail";
  /** The months it was active in; a conversation counts its first. */
  months?: string[];
  /** A digest's absolute path, as the corpus indexes it. */
  file?: string;
}

/** The member's thread digests the mapping may read: dated, and neither in a
 *  proposal (open, adopted or refused) nor attached to a domain. */
export function unattachedThreads(memberId: string): Convo[] {
  const taken = mailSpokenFor(memberId);
  return deps
    .threads(memberId)
    .filter((t) => t.dates.length && !taken.has(t.path))
    .map((t) => ({
      id: t.path,
      title: t.title,
      origin: "mail",
      first: t.dates[0]!,
      last: t.dates[t.dates.length - 1]!,
      n_user: t.dates.length,
      opening: t.about.slice(0, 300),
      kind: "mail" as const,
      months: [...new Set(t.dates.map((d) => d.slice(0, 7)))],
      file: t.file,
    }));
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
  const months = new Set(members.flatMap((c) => c.months ?? [c.first.slice(0, 7)]));
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
  if (n < th.minSize) [verdict, reason] = ["noise", `${n} items, fewer than ${th.minSize}`];
  else if (months.size < th.minMonths) [verdict, reason] = ["noise", `active ${months.size} month(s), fewer than ${th.minMonths}`];
  else if (ageDays > th.aliveDays) [verdict, reason] = ["lived", `last active ${ageDays} days ago`];
  else [verdict, reason] = ["alive", `${months.size} active months, ${recent90} active in 90 days`];
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

/** A domain or proposal already there, for the mail's naming to recognise. */
export interface Existing {
  name: string;
  summary: string;
}

export function namingPrompt(g: GroupRead, name: string, existing: Existing[] = []): string {
  const mail = g.members.some((c) => c.kind === "mail");
  const sample = g.members.slice(0, 20);
  const titles = sample.map((c) => `- ${c.title || "(untitled)"} (${c.first.slice(0, 7)}${mail && c.last.slice(0, 7) !== c.first.slice(0, 7) ? ` → ${c.last.slice(0, 7)}` : ""})`).join("\n");
  const openings = sample
    .slice(0, 7)
    .map((c) => (c.opening ? `- "${c.opening.slice(0, 240)}"` : ""))
    .filter(Boolean)
    .join("\n");
  const what = mail
    ? `Here is a group of ${g.stats.size} email threads of ${name}'s — each one summarised by you from the messages of a thread in their mailbox — active from ${g.stats.first?.slice(0, 7)} to ${g.stats.last?.slice(0, 7)} (${g.stats.months_active} distinct months, ${g.stats.recent_90} active in the last 90 days). A sample:`
    : `Here is a group of ${g.stats.size} conversations of ${name}'s, active from ${g.stats.first?.slice(0, 7)} to ${g.stats.last?.slice(0, 7)} (${g.stats.months_active} distinct months, ${g.stats.recent_90} in the last 90 days). A sample:`;
  const known = existing.length
    ? `Domains ${name} already has, or that you already proposed:\n${existing.map((e) => `- ${e.name}${e.summary ? `: ${e.summary.replace(/\s+/g, " ").slice(0, 160)}` : ""}`).join("\n")}`
    : "";
  const sameAs = existing.length
    ? `\n- "same_as": if this group is the same part of their life as one of the domains listed above, its name exactly as written there; else "".`
    : "";
  return [
    what,
    `Titles (closest to the group's centre):\n${titles}`,
    `${mail ? "What a few are about" : "First sentences of a few"}:\n${openings || "- (none)"}`,
    ...(known ? [known] : []),
    `Return a JSON object with these keys:\n- "name": a short domain name (2 to 5 words), as ${name} would say it;\n- "summary": a paragraph of 2 to 4 sentences on what this domain contains and what seems under way;\n- "is_domain": true if this is one coherent part of a life, false if it is a grab-bag or several unrelated things;\n- "split_hint": if it is several things, which ones in one sentence; else "".${sameAs}`,
  ].join("\n\n");
}

export function splitPrompt(g: GroupRead, name: string, hint: string): string {
  const mail = g.members.some((c) => c.kind === "mail");
  const noun = mail ? "email threads" : "conversations";
  const lines = g.members.map((c, i) => `${i + 1}. ${c.title || c.opening.slice(0, 80) || "(untitled)"} (${c.first.slice(0, 7)})`).join("\n");
  return [
    `This group of ${g.members.length} ${noun} of ${name}'s is several things rather than one domain — you said: "${hint}". Here is every one, numbered:`,
    lines,
    `Cut it into 2 to 4 domains. A domain is a part of ${name}'s life they come back to; leave out what belongs to none (${mail ? "one-off exchanges, notifications" : "one-off questions"}). Return a JSON object: {"domains": [{"name": "…", "summary": "2 to 4 sentences", "conversations": [numbers]}]}. Every number at most once.`,
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
  /** The existing domain or proposal the model says this group is. */
  same_as?: string;
}

export function parseNaming(text: string): Named | null {
  const d = parseJsonObject(text);
  if (!d || typeof d.name !== "string" || !d.name.trim()) return null;
  return {
    name: d.name.trim().slice(0, 80),
    summary: typeof d.summary === "string" ? d.summary.trim() : "",
    is_domain: typeof d.is_domain === "boolean" ? d.is_domain : null,
    split_hint: typeof d.split_hint === "string" ? d.split_hint.trim() : "",
    ...(typeof d.same_as === "string" && d.same_as.trim() ? { same_as: d.same_as.trim() } : {}),
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
// Rendered by the server since P2-D (domainOpener.ts); re-exported for the
// callers that knew them here.

export { openerPrompt, openerSystem, renderOpening };

// ── One member ───────────────────────────────────────────────────────────────

export type MemberOutcome =
  | "opened"        // proposals written and the conversation opened
  | "proposed"      // proposals written, the opening failed (tried again next night)
  | "waiting"       // a proposal is still open in a conversation
  | "followed_up"   // proposals open, the mail brought more: said in the same conversation
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
    [...p.conversation_ids, ...(p.mail ?? [])]
      .slice(0, 5)
      .map((id) => byId.get(id)?.title || "")
      .filter(Boolean);
}

interface Candidate {
  named: Named;
  /** Conversation ids, or garden paths of thread digests on the mail pass. */
  ids: string[];
  kind: "conversation" | "mail";
  stats: ProposalStats;
}

interface NamingRun {
  candidates: Candidate[];
  named: number;
  cost: number;
  capped?: string;
}

/**
 * Name the groups worth it — the alive first, then the lived, up to `max` —
 * and let the model cut a small grab-bag. Shared by the two passes: the
 * conversations and the mail. `existing` (the mail pass) lets the model say
 * a group is a domain or proposal already there.
 */
async function nameGroups(
  read: GroupRead[],
  byId: Map<string, Convo>,
  th: Thresholds,
  ctx: { name: string; language: string; today: Date; kind: Candidate["kind"]; max: number; existing?: Existing[] },
): Promise<NamingRun> {
  const run: NamingRun = { candidates: [], named: 0, cost: 0 };
  const order = (a: GroupRead, b: GroupRead) => (b.stats.recent_90 ?? 0) - (a.stats.recent_90 ?? 0) || b.stats.size - a.stats.size;
  const alive = read.filter((g) => g.stats.verdict === "alive").sort(order);
  const lived = read.filter((g) => g.stats.verdict === "lived").sort(order);
  const toName = [...alive, ...lived].slice(0, ctx.max);
  for (const g of toName) g.members.forEach((c) => { if (!c.opening && c.kind !== "mail") c.opening = openingOf(c.id); });
  const night = ctx.today.toISOString().slice(0, 10);
  for (const g of toName) {
    const r = await call("domain_mapping", namingSystem(ctx.name, ctx.language), namingPrompt(g, ctx.name, ctx.existing ?? []), 0.3);
    if ("capped" in r) return { ...run, capped: r.capped };
    if ("failed" in r) { run.cost += r.cost; console.warn(`[mapping] naming failed for ${ctx.name}: ${r.failed}`); continue; }
    run.cost += r.cost;
    run.named++;
    const named = parseNaming(r.text);
    if (!named) continue;
    const stats: ProposalStats = { ...g.stats, verdict: g.stats.verdict === "lived" ? "lived" : "alive", is_domain: named.is_domain, split_hint: named.split_hint, night };
    // Something already there: the mail is filed under it, whatever else the model said.
    if (named.is_domain !== false || named.same_as) {
      run.candidates.push({ named, ids: g.ids, kind: ctx.kind, stats });
      continue;
    }
    // A grab-bag. Small enough for the model to see every title: let it cut.
    if (g.members.length > MODEL_SPLIT_MAX || g.stats.verdict !== "alive") {
      console.log(`[mapping] "${named.name}" (${g.members.length}) is not a domain for the model; left aside${named.split_hint ? `: ${named.split_hint}` : ""}`);
      continue;
    }
    const sp = await call("domain_mapping", namingSystem(ctx.name, ctx.language), splitPrompt(g, ctx.name, named.split_hint || named.summary), 0.3, SPLIT_MAX_TOKENS);
    if ("capped" in sp) return { ...run, capped: sp.capped };
    if ("failed" in sp) { run.cost += sp.cost; console.warn(`[mapping] split failed for ${ctx.name}: ${sp.failed}`); continue; }
    run.cost += sp.cost;
    for (const part of parseSplit(sp.text, g.members.length)) {
      const ids = part.indexes.map((i) => g.members[i - 1]!.id);
      if (ids.length < th.minSize) continue;
      const sub = readGroup({ conversation_ids: ids, size: ids.length, cohesion: g.stats.cohesion ?? 0, depth: 1, parent_size: g.members.length }, byId, ctx.today, th);
      if (sub.stats.verdict === "noise") continue;
      run.candidates.push({
        named: { name: part.name, summary: part.summary, is_domain: true, split_hint: "" },
        ids,
        kind: ctx.kind,
        stats: { ...sub.stats, verdict: sub.stats.verdict === "lived" ? "lived" : "alive", is_domain: true, origin: "model_split", night },
      });
    }
  }
  return run;
}

/** The mail pass, first half: the member's unattached thread digests
 *  grouped among themselves by the corpus, and read. Nothing when there are
 *  too few. */
async function mailReads(memberId: string, threads: Convo[], today: Date): Promise<{ read: GroupRead[]; byId: Map<string, Convo>; groups: number } | { failed: string }> {
  const byId = new Map(threads.map((t) => [t.id, t]));
  if (threads.length < MIN_MAIL_THREADS) return { read: [], byId, groups: 0 };
  let groups: CorpusGroup[];
  try {
    groups = (await deps.mapMail(memberId, threads.map((t) => ({ path: t.id, file: t.file ?? "", title: t.title, about: t.opening, dates: [] })))).groups;
  } catch (err) {
    return { failed: `corpus (mail): ${(err as Error).message}` };
  }
  return { read: groups.map((g) => readGroup(g, byId, today, MAIL_THRESHOLDS)), byId, groups: groups.length };
}

const aliveIn = (read: GroupRead[]) => read.filter((g) => g.stats.verdict === "alive").length;

/** What the mail pass may recognise: the member's domains, and the proposals
 *  still open. */
function existingFor(memberId: string): Array<Existing & { domainId?: string; proposal?: Proposal }> {
  const domains = db
    .query(`SELECT id, name, COALESCE(prompt, '') AS prompt FROM maurices WHERE kind = 'domain' AND created_by = ?`)
    .all(memberId) as Array<{ id: string; name: string; prompt: string }>;
  return [
    ...domains.map((d) => ({ name: d.name, summary: d.prompt, domainId: d.id })),
    ...openProposals(memberId).map((p) => ({ name: p.name, summary: p.summary, proposal: p })),
  ];
}

const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[«»"'’.]/g, "").replace(/\s+/g, " ").trim();

/**
 * File the mail groups the model recognised under what was already there:
 * a domain reads them from its next brief (rewritten now, in the
 * background), an open proposal carries them. Returns what went where, and
 * the candidates left to propose.
 */
function fileRecognised(memberId: string, candidates: Candidate[], existing: ReturnType<typeof existingFor>): { rest: Candidate[]; attached: Array<{ name: string; threads: number }> } {
  const byName = new Map(existing.map((e) => [norm(e.name), e]));
  const rest: Candidate[] = [];
  const attached = new Map<string, number>();
  const touched = new Set<string>();
  for (const c of candidates) {
    const hit = c.kind === "mail" && c.named.same_as ? byName.get(norm(c.named.same_as)) : undefined;
    if (!hit) {
      rest.push(c);
      continue;
    }
    if (hit.domainId) {
      const n = attachMail(hit.domainId, memberId, c.ids);
      if (n) touched.add(hit.domainId);
      attached.set(hit.name, (attached.get(hit.name) ?? 0) + n);
    } else if (hit.proposal) {
      const cur = listProposals(memberId, ["proposed"]).find((p) => p.id === hit.proposal!.id);
      if (!cur) { rest.push(c); continue; }
      const before = cur.mail.length;
      const next = updateProposal(cur.id, { mail: [...cur.mail, ...c.ids] });
      attached.set(hit.name, (attached.get(hit.name) ?? 0) + ((next?.mail.length ?? before) - before));
    }
    console.log(`[mapping] mail group "${c.named.name}" (${c.ids.length}) filed under "${hit.name}"`);
  }
  // The domains that received mail rewrite their brief now rather than
  // tomorrow night: the member will look at them this morning.
  for (const id of touched) {
    const d = getMaurice(id);
    if (d) refreshBrief(d, memberId).catch((err) => console.warn(`[mapping] brief of "${d.name}" after mail: ${(err as Error).message}`));
  }
  return { rest, attached: [...attached].filter(([, n]) => n > 0).map(([name, threads]) => ({ name, threads })) };
}

function writeCandidates(memberId: string, candidates: Candidate[], conversationId: string | null = null): Proposal[] {
  const sorted = [...candidates].sort((a, b) => {
    const av = a.stats.verdict === "alive" ? 0 : 1;
    const bv = b.stats.verdict === "alive" ? 0 : 1;
    return av - bv || (b.stats.recent_90 ?? 0) - (a.stats.recent_90 ?? 0) || (b.stats.size ?? 0) - (a.stats.size ?? 0);
  });
  return sorted.map((c) =>
    insertProposal({
      member_id: memberId,
      name: c.named.name,
      summary: c.named.summary,
      conversation_ids: c.kind === "conversation" ? c.ids : [],
      mail: c.kind === "mail" ? c.ids : [],
      presented: c.stats.verdict === "alive",
      conversation_id: conversationId,
      stats: c.stats,
    }),
  );
}

/**
 * Map one member's conversations and mail and, when the criterion is met,
 * open the conversation that proposes what was found. `dryRun` maps and
 * names but writes no proposal and opens nothing (the model calls are still
 * made and charged). Never throws.
 *
 * When a conversation of proposals is already open, the night used to wait.
 * It still does for the conversations — they come back once the member has
 * settled what is there — but not for the mail: new thread digests (a
 * mailbox read the evening before) are mapped, filed under what they belong
 * to, and what is new is proposed in that same conversation, as a message
 * that follows the opening (27 September 2026).
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

  // A proposal still open in a conversation: the mail may add to it; the
  // rest waits, unless it has waited too long. Proposals without a
  // conversation (the opening failed last time) are opened again without
  // mapping anew — through the guard, which the opener applies.
  expireStale(memberId, PROPOSAL_STALE_DAYS, today);
  const open = openProposals(memberId);
  if (open.length && !opts.dryRun) {
    const carrier = open.find((p) => p.conversation_id)?.conversation_id;
    if (carrier) return followWithMail(res, memberId, name, language, carrier, today);
    return finishOpening(res, memberId, name, language, open, new Map(), opts);
  }

  // The guard, before anything is spent: a child or a guest gets nothing,
  // and a member who received a conversation recently waits.
  const guard = openingGuard(memberId, today);
  if (!guard.ok && !opts.force) return { ...res, outcome: "guarded", reason: guard.reason };

  const convos = unattachedConversations(memberId);
  const threads = unattachedThreads(memberId);
  res.conversations = convos.length;
  if (convos.length < MIN_CONVERSATIONS && threads.length < MIN_MAIL_THREADS) {
    return { ...res, outcome: "too_few", reason: `${convos.length} conversations, ${threads.length} mail threads` };
  }
  const byId = new Map(convos.map((c) => [c.id, c]));
  const candidates: Candidate[] = [];

  // Both passes grouped and read before anything is spent: the conversations,
  // and the mail beside them — its groups its own (see domainMail.ts).
  let convRead: GroupRead[] = [];
  const th = thresholdsFor(convos.length);
  if (convos.length >= MIN_CONVERSATIONS) {
    let groups: CorpusGroup[];
    try {
      groups = (await deps.map(memberId, convos.map((c) => c.id))).groups;
    } catch (err) {
      return { ...res, outcome: "failed", reason: `corpus: ${(err as Error).message}` };
    }
    res.groups += groups.length;
    convRead = groups.map((g) => readGroup(g, byId, today, th));
  }
  const mail = await mailReads(memberId, threads, today);
  if ("failed" in mail) console.warn(`[mapping] ${name}: ${mail.failed}`);
  const mailRead = "failed" in mail ? [] : mail.read;
  res.groups += "failed" in mail ? 0 : mail.groups;
  // Maturity, before spending: at least two groups that recur and live.
  if (aliveIn(convRead) + aliveIn(mailRead) < MIN_ALIVE_PROPOSALS) {
    const lived = [...convRead, ...mailRead].filter((g) => g.stats.verdict === "lived").length;
    return { ...res, outcome: "not_mature", reason: `${aliveIn(convRead) + aliveIn(mailRead)} alive group(s) of ${convRead.length + mailRead.length}, ${lived} lived` };
  }

  if (convRead.length) {
    const run = await nameGroups(convRead, byId, th, { name, language, today, kind: "conversation", max: MAX_NAMED });
    res.cost_usd += run.cost;
    res.named += run.named;
    if (run.capped) return { ...res, outcome: "capped", reason: run.capped };
    candidates.push(...run.candidates);
  }
  // What the model recognises in the mail as a domain already there is
  // filed under it rather than proposed.
  const existing = existingFor(memberId);
  if (mailRead.length && !("failed" in mail)) {
    const run = await nameGroups(mailRead, mail.byId, MAIL_THRESHOLDS, { name, language, today, kind: "mail", max: MAX_NAMED_MAIL, existing });
    res.cost_usd += run.cost;
    res.named += run.named;
    if (run.capped) return { ...res, outcome: "capped", reason: run.capped };
    candidates.push(...run.candidates);
  }

  if (opts.dryRun) {
    const aliveDry = candidates.filter((c) => c.stats.verdict === "alive");
    return { ...res, outcome: aliveDry.length >= MIN_ALIVE_PROPOSALS ? "proposed" : "not_mature", proposals: candidates.length, dry: candidates.map((c) => ({ ...c.named, stats: c.stats })) };
  }
  const { rest, attached } = fileRecognised(memberId, candidates, existing);
  if (attached.length) console.log(`[mapping] ${name}: mail filed under ${attached.map((a) => `"${a.name}" (${a.threads})`).join(", ")}`);
  const aliveCands = rest.filter((c) => c.stats.verdict === "alive");
  if (aliveCands.length < MIN_ALIVE_PROPOSALS) {
    return { ...res, outcome: "not_mature", reason: `${aliveCands.length} alive domain(s) after naming, ${rest.length - aliveCands.length} lived` };
  }

  // Write the proposals: every alive one is presented in the opening
  // message (alive first, the most recent first); the lived ones are named
  // apart.
  const proposals = writeCandidates(memberId, rest);
  res.proposals = proposals.length;
  console.log(`[mapping] ${name}: ${proposals.length} proposal(s) from ${res.groups} group(s) of ${convos.length} conversations and ${threads.length} mail threads (${res.named} named, $${res.cost_usd.toFixed(4)})`);
  return finishOpening(res, memberId, name, language, proposals, new Map([...byId, ...threads.map((t) => [t.id, t] as const)]), opts);
}

/**
 * Proposals are open in `conversationId`: map the mail that is new since,
 * file what belongs to a domain or an open proposal under it, propose the
 * rest in the same conversation with a message of Maurice's. The guard does
 * not apply — nothing is opened. Too little new mail, or nothing found:
 * the member waits, as before.
 */
async function followWithMail(res: MemberResult, memberId: string, name: string, language: string, conversationId: string, today: Date): Promise<MemberResult> {
  const waiting = { ...res, outcome: "waiting" as const, proposals: openProposals(memberId).length, reason: "a proposal is still open" };
  const threads = unattachedThreads(memberId);
  if (threads.length < MIN_MAIL_THREADS) return waiting;
  const mail = await mailReads(memberId, threads, today);
  if ("failed" in mail) {
    console.warn(`[mapping] ${name}: ${mail.failed}`);
    return waiting;
  }
  res.groups = mail.groups;
  // Before spending: something in the new mail recurs, alive or lived.
  if (!mail.read.some((g) => g.stats.verdict !== "noise")) return { ...waiting, groups: res.groups, reason: `a proposal is still open; ${threads.length} mail threads, no group recurs` };
  const existing = existingFor(memberId);
  const named = await nameGroups(mail.read, mail.byId, MAIL_THRESHOLDS, { name, language, today, kind: "mail", max: MAX_NAMED_MAIL, existing });
  res.named = named.named;
  res.cost_usd += named.cost;
  if (named.capped) return { ...res, outcome: "capped", reason: named.capped };
  const { rest, attached } = fileRecognised(memberId, named.candidates, existing);
  if (!rest.length && !attached.length) return { ...waiting, cost_usd: res.cost_usd, groups: res.groups, named: res.named, reason: `a proposal is still open; ${threads.length} mail threads, nothing new in them` };
  const proposals = writeCandidates(memberId, rest, conversationId);
  const alive = proposals.filter((p) => p.stats.verdict !== "lived");
  const lived = proposals.filter((p) => p.stats.verdict === "lived");
  const text = renderFollowUp({ locale: memberLocale(memberId), alive, lived, total: memberConversationCount(memberId), attached });
  sayInConversation(conversationId, text);
  console.log(
    `[mapping] ${name}: mail followed up in ${conversationId} — ${proposals.length} proposal(s), ` +
      `${attached.map((a) => `${a.threads} thread(s) under "${a.name}"`).join(", ") || "nothing filed"} ($${res.cost_usd.toFixed(4)})`,
  );
  return { ...res, outcome: "followed_up", proposals: proposals.length, presented: alive.map((p) => p.name), conversation_id: conversationId };
}

/** The order the opening message shows proposals in: alive first, then the
 *  most recent conversations, then the biggest. */
export function openingOrder(a: Proposal, b: Proposal): number {
  const av = a.stats.verdict === "lived" ? 1 : 0;
  const bv = b.stats.verdict === "lived" ? 1 : 0;
  return av - bv || (b.stats.recent_90 ?? 0) - (a.stats.recent_90 ?? 0) || b.conversation_ids.length - a.conversation_ids.length;
}

/**
 * Compose the opening message and open the conversation. The model writes
 * the introduction, the nuances and the invitation (one call, under the
 * cap); the server renders the list of proposals around them. A model reply
 * that cannot be read is not an obstacle: the fixed sentences stand in and
 * the conversation opens all the same.
 */
async function finishOpening(
  res: MemberResult,
  memberId: string,
  name: string,
  language: string,
  proposals: Proposal[],
  byId: Map<string, Convo>,
  opts: { force?: boolean },
): Promise<MemberResult> {
  const sorted = [...proposals].sort(openingOrder);
  const alive = sorted.filter((p) => p.stats.verdict !== "lived");
  const lived = sorted.filter((p) => p.stats.verdict === "lived");
  res.proposals = proposals.length;
  res.presented = alive.map((p) => p.name);
  const titles = byId.size ? sampleTitles(byId) : sampleTitlesFromDb(memberId);
  const locale = memberLocale(memberId);
  const r = await call("domain_mapping", openerSystem(name, language, openerStrings(locale).button, proposals.some((p) => p.mail.length > 0)), openerPrompt(alive, lived, name, titles), 0.6);
  let parts = {};
  if ("capped" in r) {
    // Opening costs nothing: the list is the server's, the fixed sentences
    // frame it, and the member is not made to wait a night for the cap.
    console.warn(`[mapping] opener capped for ${name}: ${r.capped} — opening with the fixed sentences`);
  } else if ("failed" in r) {
    res.cost_usd += r.cost;
    console.warn(`[mapping] opener failed for ${name}: ${r.failed} — opening with the fixed sentences`);
  } else {
    res.cost_usd += r.cost;
    parts = parseOpener(r.text);
    if (!("intro" in parts)) console.warn(`[mapping] opener for ${name} was not JSON — opening with the fixed sentences`);
  }
  const text = renderOpening({ locale, alive, lived, total: memberConversationCount(memberId), parts });
  const opened = await deps.open({ memberId, text, title: openingTitle(locale), force: opts.force });
  if (!opened.ok) return { ...res, outcome: opened.reason === "empty" ? "proposed" : "guarded", reason: opened.reason };
  attachProposals(proposals.map((p) => p.id), opened.conversation.id);
  console.log(`[mapping] ${name}: conversation ${opened.conversation.id} opened with ${alive.length} domain(s) presented, ${lived.length} named apart`);
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
// And after the mail's night (03:00), however long it runs: its reading may
// take hours on a mailbox added the evening before, and the digests it
// writes at the end are what the mail pass maps.

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
    else if (r.outcome === "followed_up") { stats.proposals += r.proposals; stats.waiting++; }
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

/** The mail's night is running, or due and not started yet: the mapping
 *  waits for its digests. A mail night that is off is not waited for. */
export function mailStillToCome(now: Date): boolean {
  if (!mailNightlyOn()) return false;
  const mail = mailNightlyStatus();
  return mail.running || isMailNightlyDue(now, mail.last_run_at);
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
    if (mailStillToCome(new Date())) return;
    runDomainMapping().catch((err) => console.error(`[mapping] nightly: ${(err as Error).message}`));
  };
  setTimeout(() => {
    tick();
    setInterval(tick, TICK_MS).unref();
  }, FIRST_TICK_MS).unref();
}
