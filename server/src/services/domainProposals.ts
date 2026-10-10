import db from "../db";
import { refreshBrief, type RefreshResult } from "./domainBriefs";
import { createMaurice, getMaurice, type Maurice } from "./maurices";
import type { McpTool } from "./mcpClient";
import { describeSeeding, seedDomain, type SeedResult } from "./domainSeeding";
import { attachMail, mailOfDomains, readMailThread } from "./domainMail";

// The domain proposals — what the night's mapping found and offers.
//
// A proposal is a domain Maurice thinks he sees in a member's unattached
// conversations and mail: a name and a paragraph the night model wrote, the
// conversations and thread digests that justify it, the numbers behind the
// verdict. Nothing is a domain until the member says yes (design of
// 19 September 2026, sections 3 and 4b): `adoptProposal` is the only thing
// that creates a row of `maurices` from a proposal, and it runs on the
// member's own act.
//
// Where the member acts changed on 10 October 2026. Until then the night
// opened a conversation to carry its proposals, and everything — the list,
// the tools, the app's drawer, what was done — lived in that conversation; a
// proposal existed nowhere else, and one made three weeks later was a line
// in a thread the member had stopped reading. Now the proposals are a
// section of the app's list of domains (routes/domains.ts): open ones with
// their numbers, and under them what was adopted or put away, which the
// member can come back on. Maurice opens no conversation and posts nothing.
// The four tools remain for a member who would rather say it: they ride in
// any conversation the member holds alone with Maurice while something
// waits, and act on the same functions as the routes.

export type ProposalState = "proposed" | "adopted" | "dismissed" | "expired" | "superseded";

export interface ProposalStats {
  /** Conversations in the group, months with at least one, first and last day. */
  size?: number;
  /** Mail threads in the group (their digests), beside the conversations. */
  mail?: number;
  months_active?: number;
  first?: string;
  last?: string;
  recent_90?: number;
  recent_365?: number;
  imported?: number;
  cohesion?: number;
  /** `alive` (recurring and recent) or `lived` (recurring, but quiet). */
  verdict?: "alive" | "lived";
  /** What the night model said of the group. */
  is_domain?: boolean | null;
  split_hint?: string;
  /** How it came to be: the mapping, a cut the model made, a member's hand. */
  origin?: "mapping" | "split" | "model_split" | "member" | "merge";
  /** The night this proposal was made, as a local day. */
  night?: string;
  /** After adoption (P2-C): whether the garden was seeded for this domain,
   *  or the member declined the notes. Absent = not offered yet. */
  seed?: { state: "written" | "declined"; at: string; notes?: string[] };
}

export interface Proposal {
  id: string;
  member_id: string;
  name: string;
  summary: string;
  conversation_ids: string[];
  /** The mail's thread digests it carries: garden-relative note paths. */
  mail: string[];
  state: ProposalState;
  presented: boolean;
  conversation_id: string | null;
  maurice_id: string | null;
  stats: ProposalStats;
  created_at: string;
  updated_at: string;
}

/** What a proposal weighs: its conversations and its mail threads. */
export function sizeOf(p: Pick<Proposal, "conversation_ids" | "mail">): number {
  return p.conversation_ids.length + (p.mail?.length ?? 0);
}

export const WEIGHT_DOTS = 5;

/** A proposal's weight on a five-dot bar, relative to the biggest one of the
 *  lot: the square root keeps a domain of 40 conversations visible beside
 *  one of 700 (one dot, not none). Always at least one. */
export function weightOf(size: number, maxSize: number): number {
  if (size <= 0 || maxSize <= 0) return 1;
  return Math.max(1, Math.min(WEIGHT_DOTS, Math.round(WEIGHT_DOTS * Math.sqrt(size / maxSize))));
}

/** Share of the member's conversations, as a whole percentage (at least 1
 *  when there is anything at all). */
export function shareOf(size: number, total: number): number {
  if (size <= 0 || total <= 0) return 0;
  return Math.max(1, Math.round((100 * size) / total));
}

/** The first sentence of a summary, cut to `max` characters. */
export function oneLine(summary: string, max = 150): string {
  const flat = summary.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const m = flat.match(/^.*?[.!?](?=\s|$)/);
  let line = (m ? m[0] : flat).trim();
  if (line.length > max) line = line.slice(0, max - 1).replace(/[\s,;:]+\S*$/, "") + "…";
  return line;
}

interface Row {
  id: string;
  member_id: string;
  name: string;
  summary: string;
  conversation_ids_json: string;
  mail_json: string;
  state: ProposalState;
  presented: number;
  conversation_id: string | null;
  maurice_id: string | null;
  stats_json: string;
  created_at: string;
  updated_at: string;
}

function parseJson<T>(s: string, fallback: T): T {
  try {
    const v = JSON.parse(s);
    return (v ?? fallback) as T;
  } catch {
    return fallback;
  }
}

function toProposal(r: Row): Proposal {
  const ids = parseJson<unknown>(r.conversation_ids_json, []);
  const mail = parseJson<unknown>(r.mail_json ?? "[]", []);
  return {
    id: r.id,
    member_id: r.member_id,
    name: r.name,
    summary: r.summary,
    conversation_ids: Array.isArray(ids) ? ids.map(String) : [],
    mail: Array.isArray(mail) ? mail.map(String) : [],
    state: r.state,
    presented: !!r.presented,
    conversation_id: r.conversation_id,
    maurice_id: r.maurice_id,
    stats: parseJson<ProposalStats>(r.stats_json, {}),
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

// ── Rows ─────────────────────────────────────────────────────────────────────

export function getProposal(id: string): Proposal | null {
  const r = db.query(`SELECT * FROM domain_proposals WHERE id = ?`).get(id) as Row | null;
  return r ? toProposal(r) : null;
}

/** A member's proposals, newest first; `states` narrows (default: all). */
export function listProposals(memberId: string, states?: ProposalState[]): Proposal[] {
  const rows = (
    states?.length
      ? db
          .query(`SELECT * FROM domain_proposals WHERE member_id = ? AND state IN (${states.map(() => "?").join(",")}) ORDER BY created_at DESC, rowid DESC`)
          .all(memberId, ...states)
      : db.query(`SELECT * FROM domain_proposals WHERE member_id = ? ORDER BY created_at DESC, rowid DESC`).all(memberId)
  ) as Row[];
  return rows.map(toProposal);
}

/** The proposals still waiting for the member's word. */
export function openProposals(memberId: string): Proposal[] {
  return listProposals(memberId, ["proposed"]);
}

export interface NewProposal {
  member_id: string;
  name: string;
  summary: string;
  conversation_ids: string[];
  mail?: string[];
  presented?: boolean;
  conversation_id?: string | null;
  stats?: ProposalStats;
}

export function insertProposal(p: NewProposal): Proposal {
  const id = crypto.randomUUID();
  db.run(
    `INSERT INTO domain_proposals (id, member_id, name, summary, conversation_ids_json, mail_json, state, presented, conversation_id, stats_json)
     VALUES (?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?)`,
    [
      id,
      p.member_id,
      p.name.trim(),
      p.summary.trim(),
      JSON.stringify([...new Set(p.conversation_ids)]),
      JSON.stringify([...new Set(p.mail ?? [])]),
      p.presented ? 1 : 0,
      p.conversation_id ?? null,
      JSON.stringify({ ...(p.stats ?? {}), size: p.conversation_ids.length, mail: new Set(p.mail ?? []).size }),
    ],
  );
  return getProposal(id)!;
}

export function updateProposal(
  id: string,
  patch: Partial<Pick<Proposal, "name" | "summary" | "conversation_ids" | "mail" | "state" | "presented" | "conversation_id" | "maurice_id" | "stats">>,
): Proposal | null {
  const cur = getProposal(id);
  if (!cur) return null;
  const next = { ...cur, ...patch };
  db.run(
    `UPDATE domain_proposals SET name = ?, summary = ?, conversation_ids_json = ?, mail_json = ?, state = ?, presented = ?,
       conversation_id = ?, maurice_id = ?, stats_json = ?, updated_at = datetime('now') WHERE id = ?`,
    [
      next.name.trim(),
      next.summary.trim(),
      JSON.stringify([...new Set(next.conversation_ids)]),
      JSON.stringify([...new Set(next.mail)]),
      next.state,
      next.presented ? 1 : 0,
      next.conversation_id,
      next.maurice_id,
      JSON.stringify({ ...next.stats, size: next.conversation_ids.length, mail: new Set(next.mail).size }),
      id,
    ],
  );
  return getProposal(id);
}

/** Conversations the mapping must leave alone: those of a proposal the member
 *  refused (they never come up again), of one adopted (bound to the domain
 *  by then, but the list is cheap insurance), or of one still open. */
export function conversationsSpokenFor(memberId: string): Set<string> {
  const out = new Set<string>();
  for (const p of listProposals(memberId, ["proposed", "adopted", "dismissed"])) {
    for (const id of p.conversation_ids) out.add(id);
  }
  return out;
}

/** Mail threads the mapping must leave alone, on the same rule as the
 *  conversations — plus those already attached to a domain. */
export function mailSpokenFor(memberId: string): Set<string> {
  const out = mailOfDomains(memberId);
  for (const p of listProposals(memberId, ["proposed", "adopted", "dismissed"])) {
    for (const path of p.mail) out.add(path);
  }
  return out;
}

// ── What waits for the member ────────────────────────────────────────────────

/** How long after an adoption the notes may still be offered in a conversation. */
const SEED_OFFER_MS = 24 * 60 * 60 * 1000;

function sqliteTime(at: string): number {
  return Date.parse(at.includes("T") ? at : at.replace(" ", "T") + "Z");
}

/** Whether something of the member's waits for their word: a proposal open,
 *  or a domain adopted in the last day whose garden notes were neither
 *  written nor declined (P2-C). This is the grant of the tools. */
export function proposalsWaiting(memberId: string, now = new Date()): boolean {
  const rows = db
    .query(`SELECT state, stats_json, updated_at FROM domain_proposals WHERE member_id = ? AND state IN ('proposed', 'adopted')`)
    .all(memberId) as Array<{ state: ProposalState; stats_json: string; updated_at: string }>;
  return rows.some(
    (r) => r.state === "proposed" || (!parseJson<ProposalStats>(r.stats_json, {}).seed && now.getTime() - sqliteTime(r.updated_at) < SEED_OFFER_MS),
  );
}

/** When the member last opened the list of proposals, or null. */
export function proposalsSeenAt(memberId: string): string | null {
  const row = db.query(`SELECT domain_proposals_seen_at AS at FROM users WHERE id = ?`).get(memberId) as { at: string | null } | null;
  return row?.at ?? null;
}

/** The member has looked at the list: what is there now is no longer new. */
export function markProposalsSeen(memberId: string): void {
  db.run(`UPDATE users SET domain_proposals_seen_at = datetime('now') WHERE id = ?`, [memberId]);
}

/** Open proposals, and how many were made since the member last looked —
 *  the app's badge, and nothing else tells them. */
export function proposalCounts(memberId: string): { open: number; unseen: number } {
  const seen = proposalsSeenAt(memberId);
  const row = db
    .query(`SELECT COUNT(*) AS open, COALESCE(SUM(CASE WHEN ? IS NULL OR created_at > ? THEN 1 ELSE 0 END), 0) AS unseen
              FROM domain_proposals WHERE member_id = ? AND state = 'proposed'`)
    .get(seen, seen, memberId) as { open: number; unseen: number } | null;
  return { open: Number(row?.open ?? 0), unseen: Number(row?.unseen ?? 0) };
}

// ── What the conversations look like ─────────────────────────────────────────

interface ConvoLine {
  id: string;
  title: string;
  first: string;
  last: string;
}

function convoLines(memberId: string, ids: string[], limit: number): ConvoLine[] {
  if (!ids.length) return [];
  const take = ids.slice(0, limit);
  const rows = db
    .query(
      `SELECT c.id, COALESCE(c.title, '') AS title,
              COALESCE(MIN(m.created_at), c.created_at) AS first, COALESCE(MAX(m.created_at), c.updated_at) AS last
       FROM conversations c LEFT JOIN messages m ON m.conversation_id = c.id AND m.role = 'user'
       WHERE c.user_id = ? AND c.id IN (${take.map(() => "?").join(",")}) GROUP BY c.id`,
    )
    .all(memberId, ...take) as ConvoLine[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  return take.map((id) => byId.get(id)).filter((r): r is ConvoLine => !!r);
}

/** The mail threads of a proposal as the tools show them: title and first day. */
function mailLines(memberId: string, paths: string[], limit: number): Array<{ path: string; title: string; first: string; last: string }> {
  const out: Array<{ path: string; title: string; first: string; last: string }> = [];
  for (const p of paths.slice(0, limit)) {
    const t = readMailThread(memberId, p);
    if (t) out.push({ path: p, title: t.title, first: t.dates[0] ?? "", last: t.dates[t.dates.length - 1] ?? "" });
  }
  return out;
}

function day(s: string | undefined | null): string {
  return (s ?? "").slice(0, 10);
}

/** The card of a proposal as the tools and the prompt show it. */
export function proposalCard(p: Proposal, opts: { titles?: number; ids?: boolean } = {}) {
  const lines = convoLines(p.member_id, p.conversation_ids, opts.titles ?? 6);
  return {
    id: p.id,
    name: p.name,
    summary: p.summary,
    state: p.state,
    presented: p.presented,
    conversations: p.conversation_ids.length,
    mail_threads: p.mail.length,
    verdict: p.stats.verdict ?? null,
    from: day(p.stats.first) || null,
    to: day(p.stats.last) || null,
    months_active: p.stats.months_active ?? null,
    recent_90_days: p.stats.recent_90 ?? null,
    split_hint: p.stats.split_hint || null,
    sample: [
      ...lines.map((l) => `${day(l.first)} — ${l.title || "(untitled)"}`),
      ...mailLines(p.member_id, p.mail, opts.titles ?? 6).map((t) => `${t.first} — ${t.title} (mail)`),
    ],
    ...(opts.ids ? { conversation_ids: p.conversation_ids } : {}),
    ...(p.maurice_id ? { domain_id: p.maurice_id } : {}),
  };
}

/** The member's conversations in all — their own, opened by them — for the
 *  share a proposal represents. */
export function memberConversationCount(memberId: string): number {
  const row = db
    .query(`SELECT COUNT(*) AS n FROM conversations c WHERE c.user_id = ? AND c.opened_by = 'member'
              AND (SELECT COUNT(*) FROM conversation_participants p WHERE p.conversation_id = c.id) <= 1`)
    .get(memberId) as { n: number } | null;
  return Number(row?.n ?? 0);
}

/** What the app's list shows of a proposal: the card, plus its weight on
 *  a five-dot bar relative to the biggest of the lot, its share of the
 *  member's conversations, and one line of its summary. */
export function proposalView(p: Proposal, maxSize: number, total: number, seenAt: string | null = null) {
  return {
    ...proposalCard(p, { titles: 3 }),
    one_line: oneLine(p.summary),
    weight: weightOf(sizeOf(p), maxSize),
    share: shareOf(p.conversation_ids.length, total),
    seed: p.stats.seed ?? null,
    origin: p.stats.origin ?? null,
    /** Made since the member last opened the list. */
    is_new: p.state === "proposed" && (!seenAt || p.created_at > seenAt),
    created_at: p.created_at,
    updated_at: p.updated_at,
  };
}

/** A proposal in full, for the page that cuts it or simply looks: every
 *  conversation (up to `limit`) and mail thread it holds. */
export function proposalDetail(p: Proposal, limit = 400) {
  const total = memberConversationCount(p.member_id);
  return {
    ...proposalView(p, Math.max(1, sizeOf(p)), total),
    conversations_list: convoLines(p.member_id, p.conversation_ids, limit).map((l) => ({ id: l.id, date: day(l.first), title: l.title })),
    mail_list: mailLines(p.member_id, p.mail, limit).map((t) => ({ path: t.path, from: t.first, to: t.last, title: t.title })),
  };
}

/** What the list shows once settled: adopted, put away by the member, or
 *  left to lapse under the old six-week rule. A merged or fully cut proposal
 *  lives on in the ones made from it. */
const SETTLED: ProposalState[] = ["adopted", "dismissed", "expired"];

/** The member's proposals as the app lists them: the open ones, alive
 *  first and the most recently active first, with their weights; then the
 *  settled ones, newest first, each still reachable. `unseen` is the badge. */
export function proposalsForMember(memberId: string) {
  const open = openProposals(memberId).sort(orderForDrawer);
  const settled = listProposals(memberId, SETTLED).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const total = memberConversationCount(memberId);
  const maxSize = Math.max(1, ...open.map(sizeOf), ...settled.map(sizeOf));
  const seenAt = proposalsSeenAt(memberId);
  return {
    total_conversations: total,
    seen_at: seenAt,
    unseen: open.filter((p) => !seenAt || p.created_at > seenAt).length,
    proposals: open.map((p) => proposalView(p, maxSize, total, seenAt)),
    settled: settled.map((p) => proposalView(p, maxSize, total, seenAt)),
  };
}

function orderForDrawer(a: Proposal, b: Proposal): number {
  const av = a.stats.verdict === "lived" ? 1 : 0;
  const bv = b.stats.verdict === "lived" ? 1 : 0;
  return av - bv || (b.stats.recent_90 ?? 0) - (a.stats.recent_90 ?? 0) || sizeOf(b) - sizeOf(a);
}

// ── The prompt section ───────────────────────────────────────────────────────

/** What the app calls a brief in each of its languages, so Maurice uses the
 *  member's word rather than the English one. */
export const BRIEF_WORD: Record<string, string> = {
  en: "brief", fr: "cahier", it: "quaderno", de: "Heft", es: "cuaderno", pt: "caderno", nl: "schrift",
};

/** What Maurice is told, in a conversation the member holds alone with him,
 *  while proposals wait: that they exist, where the member settles them,
 *  the rule (nothing adopted without a yes), and the tools. Short on
 *  purpose — it rides in every such conversation, and the list itself is one
 *  tool call away. Empty when nothing waits. */
export function proposalPromptSection(memberId: string | undefined, memberName: string, locale = "en"): string {
  if (!memberId || !proposalsWaiting(memberId)) return "";
  const word = BRIEF_WORD[locale] ?? "brief";
  const open = openProposals(memberId).length;
  return (
    `\n\n## Domain proposals\n` +
    `At night you look for domains in ${memberName}'s conversations and mail: parts of their life you seem to follow. ${open === 1 ? "One proposal waits" : `${open} proposals wait`} in the Maurice app, in the list of domains, where ${memberName} adopts, renames, merges, cuts or puts them away. ` +
    `Do not bring them up yourself. If ${memberName} asks about them, or asks you to act on one, use the tools: \`domains__propose\` (list them, show one in full, or add one they name), \`domains__adjust\` (rename, merge, split, dismiss — a dismissed proposal does not come back), \`domains__adopt\` (create the domain). ` +
    `Nothing becomes a domain without ${memberName}'s explicit yes to that proposal in this conversation — never on a hint, an "ok" to something else, or your own judgement. Their words on what a domain is about are right by definition. ` +
    `Adopting writes the first brief in the background; in ${memberName}'s language the app calls a brief "${word}" — use that word. Do not read ids aloud; use names. ` +
    `\`domains__seed\` writes a few notes on an adopted domain in their garden, each marked as yours and not yet reviewed: a yes to the domain is not a yes to the notes, so offer once after an adoption and call it only on a yes to the notes themselves (\`action: "decline"\` records a no).`
  );
}

// ── The tools ────────────────────────────────────────────────────────────────

export const DOMAIN_TOOL_PREFIX = "domains__";
export const DOMAIN_TOOL_NAMES = ["domains__propose", "domains__adjust", "domains__adopt", "domains__seed"] as const;

export function isDomainTool(name: string): boolean {
  return (DOMAIN_TOOL_NAMES as readonly string[]).includes(name);
}

const TOOLS: McpTool[] = [
  {
    name: "domains__propose",
    description:
      "The member's domain proposals. `list` (default) returns every open proposal with its sample conversations; `show` returns one in full, with all its conversations (up to 200) — use it before splitting; `add` records a domain the member named that the night did not find (a name and a one-paragraph summary; conversation ids optional).",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "show", "add"], description: "list (default), show, or add" },
        id: { type: "string", description: "show: the proposal's id" },
        name: { type: "string", description: "add: the domain's name, as the member would say it" },
        summary: { type: "string", description: "add: a paragraph on what the domain contains" },
        conversation_ids: { type: "array", items: { type: "string" }, description: "add: conversations that belong to it, if known" },
      },
    },
  },
  {
    name: "domains__adjust",
    description:
      "Adjust a proposal as the member asks: `rename` (a new name and/or summary), `merge` (several proposals into one new one: `ids`, plus the merged `name` and `summary`), `split` (one proposal into `parts`, each with a name, a summary and the conversation ids that go to it; what is not assigned stays in the original), `dismiss` (the member says it is not a domain: it is put away and its conversations never come up again).",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["rename", "merge", "split", "dismiss"] },
        id: { type: "string", description: "rename, split, dismiss: the proposal" },
        ids: { type: "array", items: { type: "string" }, description: "merge: the proposals to merge" },
        name: { type: "string" },
        summary: { type: "string" },
        parts: {
          type: "array",
          description: "split: the pieces",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              summary: { type: "string" },
              conversation_ids: { type: "array", items: { type: "string" } },
            },
            required: ["name", "conversation_ids"],
          },
        },
      },
      required: ["action"],
    },
  },
  {
    name: "domains__adopt",
    description:
      "Create the domain from a proposal — only after the member said yes to this one, in this conversation. Optional `name` and `summary` override the proposal's (use the member's words). The domain's statement is the summary; its conversations are bound to it; its first brief is written in the background.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "the proposal to adopt" },
        name: { type: "string" },
        summary: { type: "string" },
      },
      required: ["id"],
    },
  },
  {
    name: "domains__seed",
    description:
      "Write a few notes in the member's garden on a domain adopted from a proposal — only after the member said yes to the notes themselves (adopting the domain is not that yes). One note for the domain (what Maurice understood, the open threads, where it comes from) and up to three on its salient subjects, all marked as written by Maurice and not yet reviewed, with their provenance; the member keeps, corrects or throws each away. Takes up to a minute; returns the notes with their links. `action: \"decline\"` records that the member does not want notes, so they are not asked again.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "the adopted proposal" },
        action: { type: "string", enum: ["write", "decline"], description: "write (default) or decline" },
      },
      required: ["id"],
    },
  },
];

/** The tools for a turn: the four, while something of the member's waits
 *  for their word; nothing otherwise. The caller hands them only to a
 *  conversation the member holds alone with Maurice. */
export function domainToolsFor(memberId: string | undefined): McpTool[] {
  return memberId && proposalsWaiting(memberId) ? TOOLS : [];
}

export interface ToolOutcome {
  text: string;
  isError: boolean;
  data?: unknown;
}

function ok(data: unknown): ToolOutcome {
  return { text: JSON.stringify(data, null, 1), isError: false, data };
}
function fail(message: string): ToolOutcome {
  return { text: `Tool error: ${message}`, isError: true };
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const ids = (v: unknown): string[] => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);

/** Run one of the tools for the member taking the turn. They act on that
 *  member's proposals and no one else's; the grant is checked again here,
 *  in case a roster was cached. */
export async function runDomainTool(name: string, input: any, memberId: string | undefined): Promise<ToolOutcome> {
  if (!memberId || !proposalsWaiting(memberId)) return fail("no domain proposal is waiting for this member");
  const mine = (id: string): Proposal | null => {
    const p = id ? getProposal(id) : null;
    return p && p.member_id === memberId ? p : null;
  };
  const inp = input ?? {};

  if (name === "domains__propose") {
    const action = str(inp.action) || "list";
    if (action === "list") {
      return ok({ proposals: openProposals(memberId).sort(orderForDrawer).map((p) => proposalCard(p)) });
    }
    if (action === "show") {
      const p = mine(str(inp.id));
      if (!p) return fail("no such proposal");
      const lines = convoLines(memberId, p.conversation_ids, 200);
      const threads = mailLines(memberId, p.mail, 200);
      return ok({
        ...proposalCard(p, { titles: 0 }),
        conversations_listed: lines.length,
        conversations: lines.map((l) => ({ id: l.id, date: day(l.first), title: l.title || "(untitled)" })),
        ...(threads.length ? { mail_threads: threads.map((t) => ({ from: t.first, to: t.last, title: t.title })) } : {}),
      });
    }
    if (action === "add") {
      const nm = str(inp.name);
      if (!nm) return fail("a name is needed");
      const chosen = ids(inp.conversation_ids).filter((id) => ownsConversation(memberId, id));
      const p = insertProposal({
        member_id: memberId,
        name: nm,
        summary: str(inp.summary),
        conversation_ids: chosen,
        stats: { origin: "member", verdict: "alive" },
      });
      return ok({ added: proposalCard(p) });
    }
    return fail(`unknown action "${action}"`);
  }

  if (name === "domains__adjust") {
    const action = str(inp.action);
    if (action === "rename") {
      const p = mine(str(inp.id));
      if (!p) return fail("no such proposal");
      return ok({ renamed: proposalCard(renameProposal(p, { name: str(inp.name), summary: str(inp.summary) })) });
    }
    if (action === "dismiss") {
      const p = mine(str(inp.id));
      if (!p) return fail("no such proposal");
      dismissProposal(p);
      return ok({ dismissed: p.name, note: "put away; its conversations will not be proposed again" });
    }
    if (action === "merge") {
      const r = mergeProposals(memberId, ids(inp.ids), { name: str(inp.name), summary: str(inp.summary) });
      if ("error" in r) return fail(r.error);
      return ok({ merged: proposalCard(r.merged), from: r.from });
    }
    if (action === "split") {
      const p = mine(str(inp.id));
      if (!p) return fail("no such proposal");
      const r = splitProposal(p, Array.isArray(inp.parts) ? inp.parts : []);
      if ("error" in r) return fail(r.error);
      return ok({ split: p.name, parts: r.parts.map((m) => proposalCard(m)), left_in_original: r.left });
    }
    return fail(`unknown action "${action}"`);
  }

  if (name === "domains__adopt") {
    const p = mine(str(inp.id));
    if (!p) return fail("no such proposal");
    if (p.state !== "proposed") return fail(`this proposal is ${p.state}`);
    const r = adoptProposal(p, { name: str(inp.name) || undefined, summary: str(inp.summary) || undefined });
    if ("error" in r) return fail(r.error);
    return ok({
      adopted: r.domain.name,
      domain_id: r.domain.id,
      conversations_bound: r.bound,
      brief: "being written now; it will appear on the domain's page in the app",
      garden: "no note written: offer to seed the garden (domains__seed) and wait for a yes to the notes",
    });
  }

  if (name === "domains__seed") {
    const p = mine(str(inp.id));
    if (!p) return fail("no such proposal");
    if (p.state !== "adopted" || !p.maurice_id) return fail(`this proposal is ${p.state}; only an adopted domain can be seeded`);
    if (p.stats.seed) return fail(p.stats.seed.state === "written" ? "the garden was already seeded for this domain" : "the member declined notes on this domain");
    if (str(inp.action) === "decline") {
      updateProposal(p.id, { stats: { ...p.stats, seed: { state: "declined", at: new Date().toISOString() } } });
      return ok({ declined: p.name, note: "no note written; do not offer again" });
    }
    const domain = getMaurice(p.maurice_id);
    if (!domain || domain.created_by !== memberId) return fail("the domain no longer exists");
    const r = await seedProposal(p, domain, memberId);
    if (r.outcome !== "written") return fail(describeSeeding(r));
    return ok({
      seeded: domain.name,
      notes: r.notes.map((n) => ({ title: n.title, role: n.role, link: n.web_path })),
      from_conversations: r.sources,
      note: "each note is marked as written by Maurice and not yet reviewed; the member keeps, corrects or throws it away in the garden",
    });
  }
  return fail(`unknown tool ${name}`);
}

function ownsConversation(memberId: string, id: string): boolean {
  return !!db.query(`SELECT 1 FROM conversations WHERE id = ? AND user_id = ?`).get(id, memberId);
}

function mergedStats(parts: Proposal[]): ProposalStats {
  const first = parts.map((p) => p.stats.first).filter(Boolean).sort()[0];
  const last = parts.map((p) => p.stats.last).filter(Boolean).sort().at(-1);
  return {
    first,
    last,
    months_active: Math.max(...parts.map((p) => p.stats.months_active ?? 0)),
    recent_90: parts.reduce((s, p) => s + (p.stats.recent_90 ?? 0), 0),
    recent_365: parts.reduce((s, p) => s + (p.stats.recent_365 ?? 0), 0),
  };
}

// ── Rename, dismiss, restore, merge, split ───────────────────────────────────

/** A new name and/or summary in the member's words; an empty one keeps the old. */
export function renameProposal(p: Proposal, patch: { name?: string; summary?: string }): Proposal {
  const name = (patch.name ?? "").trim() || p.name;
  const summary = (patch.summary ?? "").trim() || p.summary;
  if (name === p.name && summary === p.summary) return p;
  return updateProposal(p.id, { name, summary })!;
}

/** The member says it is not a domain: put away, its conversations never
 *  come up in a mapping again. It does not come back by itself. */
export function dismissProposal(p: Proposal): Proposal {
  return updateProposal(p.id, { state: "dismissed" })!;
}

/** The member comes back on a proposal they put away, or one the old
 *  six-week rule put away for them: it is open again, as it was. */
export function restoreProposal(p: Proposal): Proposal | { error: string } {
  if (p.state !== "dismissed" && p.state !== "expired") return { error: `this proposal is ${p.state}` };
  return updateProposal(p.id, { state: "proposed" })!;
}

/** Several open proposals of the member's into one new one; the parts are
 *  kept as `superseded`. A name or summary not given is made of theirs. */
export function mergeProposals(
  memberId: string,
  proposalIds: string[],
  opts: { name?: string; summary?: string } = {},
): { merged: Proposal; from: string[] } | { error: string } {
  const parts = [...new Set(proposalIds)].map((id) => getProposal(id));
  if (parts.length < 2 || parts.some((p) => !p || p.member_id !== memberId || p.state !== "proposed")) {
    return { error: "merge needs two or more open proposals" };
  }
  const all = parts as Proposal[];
  const merged = insertProposal({
    member_id: memberId,
    name: (opts.name ?? "").trim() || all.map((p) => p.name).join(" & "),
    summary: (opts.summary ?? "").trim() || all.map((p) => p.summary).filter(Boolean).join("\n\n"),
    conversation_ids: all.flatMap((p) => p.conversation_ids),
    mail: all.flatMap((p) => p.mail),
    presented: all.some((p) => p.presented),
    stats: { origin: "merge", verdict: all.some((p) => p.stats.verdict === "alive") ? "alive" : "lived", ...mergedStats(all) },
  });
  for (const p of all) updateProposal(p.id, { state: "superseded" });
  return { merged, from: all.map((p) => p.name) };
}

export interface SplitPart {
  name?: string;
  summary?: string;
  conversation_ids?: string[];
  /** Mail threads that go to the part: garden paths of the proposal's own. */
  mail?: string[];
}

/** One open proposal into parts, each with a name and what goes to it;
 *  what is not assigned stays in the original, which is `superseded` when
 *  nothing is left. */
export function splitProposal(p: Proposal, parts: SplitPart[]): { parts: Proposal[]; left: number } | { error: string } {
  if (p.state !== "proposed") return { error: `this proposal is ${p.state}` };
  const pool = new Set(p.conversation_ids);
  const mailPool = new Set(p.mail);
  const made: Proposal[] = [];
  for (const part of parts) {
    const nm = str(part?.name);
    const chosen = ids(part?.conversation_ids).filter((id) => pool.has(id));
    const threads = ids(part?.mail).filter((path) => mailPool.has(path));
    if (!nm || !(chosen.length + threads.length)) continue;
    for (const id of chosen) pool.delete(id);
    for (const path of threads) mailPool.delete(path);
    made.push(
      insertProposal({
        member_id: p.member_id,
        name: nm,
        summary: str(part?.summary),
        conversation_ids: chosen,
        mail: threads,
        presented: p.presented,
        stats: { origin: "split", verdict: p.stats.verdict ?? "alive" },
      }),
    );
  }
  if (!made.length) return { error: "no part had a name and something of this proposal" };
  const left = pool.size + mailPool.size;
  if (left) updateProposal(p.id, { conversation_ids: [...pool], mail: [...mailPool] });
  else updateProposal(p.id, { state: "superseded" });
  return { parts: made, left };
}

// ── Adoption ─────────────────────────────────────────────────────────────────

/** How many of the proposal's conversations are baked into the domain's
 *  context (the closest to the centre; the rest are bound by `maurice_id`). */
export const BAKED_CONVERSATIONS = 3;

export interface Adoption {
  domain: Maurice;
  bound: number;
  /** The first brief, written in the background; awaited by tests. */
  brief: Promise<RefreshResult>;
}

/**
 * Create the domain from a proposal: a row of `maurices` of kind `domain`,
 * created by the member, its statement the proposal's summary, the closest
 * conversations baked into its context, every conversation of the proposal
 * bound to it (`conversations.maurice_id`, when not bound elsewhere), and
 * the first brief written from them by the briefs service (P1-A) — on the
 * night model, charged to the ledger's system spender.
 */
export function adoptProposal(p: Proposal, opts: { name?: string; summary?: string } = {}): Adoption | { error: string } {
  const name = (opts.name ?? p.name).trim();
  const summary = (opts.summary ?? p.summary).trim();
  if (!name) return { error: "a domain needs a name" };
  const owned = p.conversation_ids.filter((id) => ownsConversation(p.member_id, id));
  const baked = owned.slice(0, BAKED_CONVERSATIONS).map((id) => ({ type: "conversation", id }));
  let created = createMaurice(p.member_id, { name, kind: "domain", tagline: "", prompt: summary, context: baked, users: [p.member_id] });
  if ("errors" in created) {
    // A conversation the composer refuses (deleted meanwhile, say) should
    // not stop the adoption: bind without baking.
    created = createMaurice(p.member_id, { name, kind: "domain", tagline: "", prompt: summary, context: [], users: [p.member_id] });
    if ("errors" in created) return { error: created.errors.map((e) => e.message ?? String(e)).join("; ") };
  }
  const domain = created;
  let bound = 0;
  for (const id of owned) {
    const r = db.run(`UPDATE conversations SET maurice_id = ? WHERE id = ? AND user_id = ? AND maurice_id IS NULL`, [domain.id, id, p.member_id]);
    bound += Number(r.changes ?? 0);
  }
  // Its mail threads become the domain's, for the brief to read.
  const mail = attachMail(domain.id, p.member_id, p.mail);
  updateProposal(p.id, { state: "adopted", maurice_id: domain.id, name, summary });
  console.log(`[proposals] "${name}" adopted by ${p.member_id}: domain ${domain.id}, ${bound} conversation(s) bound${mail ? `, ${mail} mail thread(s)` : ""}`);
  const brief = refreshBrief(getMaurice(domain.id) ?? domain, p.member_id).catch((err) => {
    console.warn(`[proposals] first brief of "${name}" failed: ${(err as Error).message}`);
    return { outcome: "failed", brief: null, sources: 0, cost_usd: null, error: String(err) } as RefreshResult;
  });
  return { domain, bound, brief };
}

// ── Seeding (P2-C) ───────────────────────────────────────────────────────────

/**
 * Write the garden notes of an adopted proposal's domain, on the member's
 * turn and account (services/domainSeeding.ts), and record the outcome on
 * the proposal so it is offered once. The yes is the caller's business.
 */
export async function seedProposal(p: Proposal, domain: Maurice, memberId: string): Promise<SeedResult> {
  const r = await seedDomain(domain, memberId);
  if (r.outcome === "written") {
    updateProposal(p.id, { stats: { ...p.stats, seed: { state: "written", at: new Date().toISOString(), notes: r.notes.map((n) => n.slug) } } });
    console.log(`[proposals] "${domain.name}": garden seeded for ${memberId} — ${r.notes.map((n) => n.slug).join(", ")}`);
  }
  return r;
}

// ── The list's validation (P2-D) ─────────────────────────────────────────────

export type ApplyAction = "adopt" | "dismiss" | "keep";

export interface ApplyItem {
  id: string;
  action: ApplyAction;
  name?: string;
  summary?: string;
  /** Adopt only: write the garden notes too. A yes to the domain is not a
   *  yes to the notes; the app's box is off by default. */
  seed?: boolean;
}

export interface ApplyResult {
  adopted: Array<{ id: string; name: string; domain_id: string; conversations_bound: number; seeding: boolean }>;
  dismissed: Array<{ id: string; name: string }>;
  renamed: Array<{ id: string; name: string }>;
  errors: Array<{ id: string; error: string }>;
}

/** Tests wait on the seeding kicked off by `applyProposals`. */
let lastSeeding: Promise<void> = Promise.resolve();
export function seedingSettled(): Promise<void> {
  return lastSeeding;
}

/**
 * The member's word on several proposals at once: every item is a proposal
 * of theirs, still open; a name or summary given is theirs and prevails;
 * `adopt` creates the domain (adoptProposal, the same as the tool), `dismiss`
 * puts it away, `keep` only renames. The garden notes asked for are written
 * in the background (charged to the member, like the tool). Nothing is said
 * anywhere: the list shows what was done, the domain's page counts its notes.
 */
export async function applyProposals(memberId: string, items: ApplyItem[]): Promise<ApplyResult> {
  const out: ApplyResult = { adopted: [], dismissed: [], renamed: [], errors: [] };
  const seeds: Array<{ p: Proposal; domain: Maurice }> = [];
  for (const it of items) {
    const p = it.id ? getProposal(it.id) : null;
    if (!p || p.member_id !== memberId) { out.errors.push({ id: it.id, error: "no such proposal" }); continue; }
    if (p.state !== "proposed") { out.errors.push({ id: it.id, error: `this proposal is ${p.state}` }); continue; }
    const renamed = renameProposal(p, { name: it.name, summary: it.summary });
    if (renamed.name !== p.name || renamed.summary !== p.summary) out.renamed.push({ id: p.id, name: renamed.name });
    if (it.action === "adopt") {
      const r = adoptProposal(renamed);
      if ("error" in r) { out.errors.push({ id: p.id, error: r.error }); continue; }
      out.adopted.push({ id: p.id, name: r.domain.name, domain_id: r.domain.id, conversations_bound: r.bound, seeding: !!it.seed });
      // The box left unticked is not a refusal: the notes stay offerable
      // for a day in a conversation (domains__seed).
      if (it.seed) seeds.push({ p: getProposal(p.id)!, domain: r.domain });
    } else if (it.action === "dismiss") {
      dismissProposal(renamed);
      out.dismissed.push({ id: p.id, name: renamed.name });
    }
  }

  if (out.adopted.length || out.dismissed.length || out.renamed.length) {
    console.log(`[proposals] ${memberId} applied from the app: ${out.adopted.length} adopted, ${out.dismissed.length} dismissed, ${out.renamed.length} renamed or corrected, ${seeds.length} to seed`);
  }
  if (seeds.length) {
    lastSeeding = lastSeeding.then(async () => {
      for (const { p, domain } of seeds) {
        try {
          const r = await seedProposal(p, domain, memberId);
          if (r.outcome !== "written") console.warn(`[proposals] notes on "${domain.name}" for ${memberId}: ${describeSeeding(r)}`);
        } catch (err) {
          console.warn(`[proposals] notes on "${domain.name}" for ${memberId}: ${(err as Error).message}`);
        }
      }
    });
  }
  return out;
}
