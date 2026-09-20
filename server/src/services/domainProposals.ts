import db from "../db";
import { addMessage } from "./conversations";
import { memberLocale, refreshBrief, type RefreshResult } from "./domainBriefs";
import { oneLine, shareOf, weightOf } from "./domainOpener";
import { createMaurice, getMaurice, type Maurice } from "./maurices";
import type { McpTool } from "./mcpClient";
import { OPENED_BY_MAURICE } from "./openedConversations";
import { publishToRoom } from "./roomBus";
import { describeSeeding, seedDomain, type SeedResult } from "./domainSeeding";

// The domain proposals — what the night's mapping found and offers, and the
// three tools Maurice holds in the conversation that carries them.
//
// A proposal is a domain Maurice thinks he sees in a member's unattached
// conversations: a name and a paragraph the night model wrote, the
// conversations that justify it, the numbers behind the verdict. Nothing is a
// domain until the member says yes in the conversation the night opened
// (design of 19 September 2026, sections 3 and 4b): `domains__adopt` is the
// only thing that creates a row of `maurices` from a proposal, and it runs
// on a tool call the model makes in that conversation, on the member's turn.
// `domains__propose` shows and adds, `domains__adjust` renames, merges,
// splits and dismisses (a dismissed proposal's conversations never come up
// again). The tools exist in exactly one place: the conversation
// `domain_proposals.conversation_id` points to, which Maurice opened.
//
// Since P2-D (20 September 2026) the same acts have a second door: the
// app's drawer "Define my domains", on the member routes of
// routes/domains.ts — the list with each proposal's weight, a rename, an
// adoption, a dismissal, or the whole lot at once (`applyProposals`), which
// then says in the conversation, in Maurice's voice, what was done. Both
// doors run the functions below; neither adopts without the member's act.

export type ProposalState = "proposed" | "adopted" | "dismissed" | "expired" | "superseded";

export interface ProposalStats {
  /** Conversations in the group, months with at least one, first and last day. */
  size?: number;
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
  state: ProposalState;
  presented: boolean;
  conversation_id: string | null;
  maurice_id: string | null;
  stats: ProposalStats;
  created_at: string;
  updated_at: string;
}

interface Row {
  id: string;
  member_id: string;
  name: string;
  summary: string;
  conversation_ids_json: string;
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
  return {
    id: r.id,
    member_id: r.member_id,
    name: r.name,
    summary: r.summary,
    conversation_ids: Array.isArray(ids) ? ids.map(String) : [],
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
  presented?: boolean;
  conversation_id?: string | null;
  stats?: ProposalStats;
}

export function insertProposal(p: NewProposal): Proposal {
  const id = crypto.randomUUID();
  db.run(
    `INSERT INTO domain_proposals (id, member_id, name, summary, conversation_ids_json, state, presented, conversation_id, stats_json)
     VALUES (?, ?, ?, ?, ?, 'proposed', ?, ?, ?)`,
    [
      id,
      p.member_id,
      p.name.trim(),
      p.summary.trim(),
      JSON.stringify([...new Set(p.conversation_ids)]),
      p.presented ? 1 : 0,
      p.conversation_id ?? null,
      JSON.stringify({ size: p.conversation_ids.length, ...(p.stats ?? {}) }),
    ],
  );
  return getProposal(id)!;
}

export function updateProposal(
  id: string,
  patch: Partial<Pick<Proposal, "name" | "summary" | "conversation_ids" | "state" | "presented" | "conversation_id" | "maurice_id" | "stats">>,
): Proposal | null {
  const cur = getProposal(id);
  if (!cur) return null;
  const next = { ...cur, ...patch };
  db.run(
    `UPDATE domain_proposals SET name = ?, summary = ?, conversation_ids_json = ?, state = ?, presented = ?,
       conversation_id = ?, maurice_id = ?, stats_json = ?, updated_at = datetime('now') WHERE id = ?`,
    [
      next.name.trim(),
      next.summary.trim(),
      JSON.stringify([...new Set(next.conversation_ids)]),
      next.state,
      next.presented ? 1 : 0,
      next.conversation_id,
      next.maurice_id,
      JSON.stringify({ ...next.stats, size: next.conversation_ids.length }),
      id,
    ],
  );
  return getProposal(id);
}

/** Tie a night's proposals to the conversation that carries them. */
export function attachProposals(ids: string[], conversationId: string): void {
  for (const id of ids) db.run(`UPDATE domain_proposals SET conversation_id = ?, updated_at = datetime('now') WHERE id = ?`, [conversationId, id]);
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

/** Proposals left unanswered past `days` are put away as expired, so the
 *  next night maps again. Returns how many. */
export function expireStale(memberId: string, days: number, now = new Date()): number {
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString().replace("T", " ").slice(0, 19);
  const r = db.run(
    `UPDATE domain_proposals SET state = 'expired', updated_at = datetime('now')
     WHERE member_id = ? AND state = 'proposed' AND created_at < ?`,
    [memberId, cutoff],
  );
  return Number(r.changes ?? 0);
}

// ── Whose conversation is this? ──────────────────────────────────────────────

/** The member whose proposals a conversation carries, if it is one Maurice
 *  opened for that purpose and something in it still waits for their word:
 *  a proposal open, or a domain adopted whose garden notes were neither
 *  written nor declined (P2-C); else null. This is the whole grant: the
 *  tools exist here and nowhere else. */
export function proposalMemberOf(conversationId: string): string | null {
  const conv = db.query(`SELECT user_id, opened_by FROM conversations WHERE id = ?`).get(conversationId) as
    | { user_id: string; opened_by: string }
    | null;
  if (!conv || conv.opened_by !== OPENED_BY_MAURICE) return null;
  const rows = db
    .query(`SELECT state, stats_json FROM domain_proposals WHERE conversation_id = ? AND member_id = ? AND state IN ('proposed', 'adopted')`)
    .all(conversationId, conv.user_id) as Array<{ state: ProposalState; stats_json: string }>;
  const waiting = rows.some((r) => r.state === "proposed" || !parseJson<ProposalStats>(r.stats_json, {}).seed);
  return waiting ? conv.user_id : null;
}

/** The proposals carried by a conversation (any state), presented first. */
export function proposalsInConversation(conversationId: string): Proposal[] {
  const rows = db
    .query(`SELECT * FROM domain_proposals WHERE conversation_id = ? ORDER BY presented DESC, created_at DESC, rowid DESC`)
    .all(conversationId) as Row[];
  return rows.map(toProposal);
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
    verdict: p.stats.verdict ?? null,
    from: day(p.stats.first) || null,
    to: day(p.stats.last) || null,
    months_active: p.stats.months_active ?? null,
    recent_90_days: p.stats.recent_90 ?? null,
    split_hint: p.stats.split_hint || null,
    sample: lines.map((l) => `${day(l.first)} — ${l.title || "(untitled)"}`),
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

/** What the app's drawer shows of a proposal: the card, plus its weight on
 *  a five-dot bar relative to the biggest of the lot, its share of the
 *  member's conversations, and one line of its summary. */
export function proposalView(p: Proposal, maxSize: number, total: number) {
  const n = p.conversation_ids.length;
  return {
    ...proposalCard(p, { titles: 3 }),
    one_line: oneLine(p.summary),
    weight: weightOf(n, maxSize),
    share: shareOf(n, total),
    conversation_id: p.conversation_id,
    seed: p.stats.seed ?? null,
    created_at: p.created_at,
    updated_at: p.updated_at,
  };
}

/** The member's open proposals as the drawer lists them: alive first, the
 *  most recent conversations first, with their weights; and the settled
 *  ones of the same conversation for the record. */
export function proposalsForMember(memberId: string) {
  const open = openProposals(memberId).sort(orderForDrawer);
  const conversationId = open.find((p) => p.conversation_id)?.conversation_id ?? null;
  const settled = conversationId ? proposalsInConversation(conversationId).filter((p) => p.state !== "proposed") : [];
  const total = memberConversationCount(memberId);
  const maxSize = Math.max(1, ...open.map((p) => p.conversation_ids.length), ...settled.map((p) => p.conversation_ids.length));
  return {
    conversation_id: conversationId,
    total_conversations: total,
    proposals: open.map((p) => proposalView(p, maxSize, total)),
    settled: settled.map((p) => proposalView(p, maxSize, total)),
  };
}

function orderForDrawer(a: Proposal, b: Proposal): number {
  const av = a.stats.verdict === "lived" ? 1 : 0;
  const bv = b.stats.verdict === "lived" ? 1 : 0;
  return av - bv || (b.stats.recent_90 ?? 0) - (a.stats.recent_90 ?? 0) || b.conversation_ids.length - a.conversation_ids.length;
}

// ── The prompt section ───────────────────────────────────────────────────────

/** What the app calls a brief in each of its languages, so Maurice uses the
 *  member's word rather than the English one. */
export const BRIEF_WORD: Record<string, string> = {
  en: "brief", fr: "cahier", it: "quaderno", de: "Heft", es: "cuaderno", pt: "caderno", nl: "schrift",
};

/** What Maurice is told in the proposal conversation: the proposals by name
 *  and id, the rules (nothing adopted without a yes), and the three tools. */
export function proposalPromptSection(conversationId: string, memberName: string, locale = "en"): string {
  const all = proposalsInConversation(conversationId);
  if (!all.length) return "";
  const word = BRIEF_WORD[locale] ?? "brief";
  const open = all.filter((p) => p.state === "proposed");
  const settled = all.filter((p) => p.state !== "proposed");
  const line = (p: Proposal) =>
    `- ${p.name} (id ${p.id}; ${p.conversation_ids.length} conversations, ${p.stats.verdict === "lived" ? "lived, quiet now" : "alive"}${p.presented ? ", presented in your opening message" : ""}${p.stats.split_hint ? `; might be several things: ${p.stats.split_hint}` : ""})`;
  const settledLine = (p: Proposal) =>
    p.state !== "adopted"
      ? `${p.name} (${p.state})`
      : `${p.name} (id ${p.id}; adopted, ${p.stats.seed?.state === "written" ? `${p.stats.seed.notes?.length ?? 0} note(s) seeded in the garden` : p.stats.seed?.state === "declined" ? "garden notes declined" : "garden notes not offered yet"})`;
  return (
    `\n\n## Proposing domains\n` +
    `You opened this conversation yourself, at night, to propose domains: parts of ${memberName}'s life you seem to follow across their conversations (imported ones and the ones lived with you). A domain, once adopted, is a row with a name and a statement that you keep a brief on. ` +
    `Nothing becomes a domain without ${memberName}'s yes in this conversation — never adopt on a hint, an "ok" to something else, or your own judgement. Discuss: they may rename, merge two, cut one, say one is not a domain (then dismiss it, and its conversations will not come up again), or point at something you missed (then propose it). Their words on what a domain is about are right by definition.\n` +
    `Three tools, here only: \`domains__propose\` (list the proposals with their sample conversations, show one in full, or add one ${memberName} names), \`domains__adjust\` (rename, merge, split, dismiss), \`domains__adopt\` (create the domain — after an explicit yes). ` +
    `Adopting writes the first brief in the background; say it will appear on the domain's page in the app shortly. In ${memberName}'s language the app calls a brief "${word}" — use that word. Do not read ids aloud; use names. ` +
    `${memberName} can also settle the proposals without you, in the app's drawer "Define my domains" under your opening message (adopt, rename, put away, ask for garden notes); what they did there appears in this conversation as a message of yours, and the list below is always current.\n` +
    `Seeding the garden (\`domains__seed\`): once a domain is adopted, offer once to write a few notes on it in ${memberName}'s garden — what you understood, the open threads, where it comes from, perhaps one note per salient subject — each marked as written by you and not yet reviewed, for them to keep, correct or throw away. ` +
    `A yes to the domain is not a yes to the notes: call \`domains__seed\` only after ${memberName} agrees to the notes themselves. It takes up to a minute and returns the notes with their links — give them. If they decline, call it with \`action: "decline"\` so you do not ask again.\n` +
    (open.length ? `\nOpen proposals:\n${open.map(line).join("\n")}` : `\nNo proposal is open any more in this conversation.`) +
    (settled.length ? `\n\nSettled: ${settled.map(settledLine).join("; ")}.` : "")
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
      "The domain proposals of this conversation. `list` (default) returns every open proposal with its sample conversations; `show` returns one in full, with all its conversations (up to 200) — use it before splitting; `add` records a domain the member named that the night did not find (a name and a one-paragraph summary; conversation ids optional).",
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
      "Write a few notes in the member's garden on a domain adopted in this conversation — only after the member said yes to the notes themselves (adopting the domain is not that yes). One note for the domain (what Maurice understood, the open threads, where it comes from) and up to three on its salient subjects, all marked as written by Maurice and not yet reviewed, with their provenance; the member keeps, corrects or throws each away. Takes up to a minute; returns the notes with their links. `action: \"decline\"` records that the member does not want notes, so they are not asked again.",
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

/** The tools for a turn: the four, when the conversation carries an open
 *  proposal of the member taking the turn, or an adopted one whose notes
 *  still wait for their word; nothing otherwise. */
export function domainToolsFor(conversationId: string, memberId: string | undefined): McpTool[] {
  if (!memberId) return [];
  const owner = proposalMemberOf(conversationId);
  return owner && owner === memberId ? TOOLS : [];
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

/** Run one of the three tools inside a conversation. The member is the
 *  conversation's owner; the tools refuse a conversation that carries no
 *  open proposal of theirs — that check is the grant, made again here in
 *  case a roster was cached. */
export async function runDomainTool(name: string, input: any, conversationId: string): Promise<ToolOutcome> {
  const memberId = proposalMemberOf(conversationId);
  if (!memberId) return fail("these tools exist only in the conversation that proposes domains, while a proposal is open");
  const mine = (id: string): Proposal | null => {
    const p = id ? getProposal(id) : null;
    return p && p.member_id === memberId && p.conversation_id === conversationId ? p : null;
  };
  const inp = input ?? {};

  if (name === "domains__propose") {
    const action = str(inp.action) || "list";
    if (action === "list") {
      const open = proposalsInConversation(conversationId).filter((p) => p.state === "proposed");
      return ok({ proposals: open.map((p) => proposalCard(p)) });
    }
    if (action === "show") {
      const p = mine(str(inp.id));
      if (!p) return fail("no such proposal in this conversation");
      const lines = convoLines(memberId, p.conversation_ids, 200);
      return ok({
        ...proposalCard(p, { titles: 0 }),
        conversations_listed: lines.length,
        conversations: lines.map((l) => ({ id: l.id, date: day(l.first), title: l.title || "(untitled)" })),
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
        conversation_id: conversationId,
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
      if (!p) return fail("no such proposal in this conversation");
      return ok({ renamed: proposalCard(renameProposal(p, { name: str(inp.name), summary: str(inp.summary) })) });
    }
    if (action === "dismiss") {
      const p = mine(str(inp.id));
      if (!p) return fail("no such proposal in this conversation");
      dismissProposal(p);
      return ok({ dismissed: p.name, note: "put away; its conversations will not be proposed again" });
    }
    if (action === "merge") {
      const parts = ids(inp.ids).map(mine);
      if (parts.length < 2 || parts.some((p) => !p || p.state !== "proposed")) return fail("merge needs two or more open proposals of this conversation");
      const nm = str(inp.name) || parts.map((p) => p!.name).join(" & ");
      const sm = str(inp.summary) || parts.map((p) => p!.summary).filter(Boolean).join("\n\n");
      const merged = insertProposal({
        member_id: memberId,
        name: nm,
        summary: sm,
        conversation_ids: parts.flatMap((p) => p!.conversation_ids),
        conversation_id: conversationId,
        presented: parts.some((p) => p!.presented),
        stats: { origin: "merge", verdict: parts.some((p) => p!.stats.verdict === "alive") ? "alive" : "lived", ...mergedStats(parts as Proposal[]) },
      });
      for (const p of parts) updateProposal(p!.id, { state: "superseded" });
      return ok({ merged: proposalCard(merged), from: parts.map((p) => p!.name) });
    }
    if (action === "split") {
      const p = mine(str(inp.id));
      if (!p || p.state !== "proposed") return fail("no such open proposal in this conversation");
      const parts = Array.isArray(inp.parts) ? inp.parts : [];
      if (parts.length < 1) return fail("split needs at least one part with a name and conversation ids");
      const pool = new Set(p.conversation_ids);
      const made: Proposal[] = [];
      for (const part of parts) {
        const nm = str(part?.name);
        const chosen = ids(part?.conversation_ids).filter((id) => pool.has(id));
        if (!nm || !chosen.length) continue;
        for (const id of chosen) pool.delete(id);
        made.push(
          insertProposal({
            member_id: memberId,
            name: nm,
            summary: str(part?.summary),
            conversation_ids: chosen,
            conversation_id: conversationId,
            presented: p.presented,
            stats: { origin: "split", verdict: p.stats.verdict ?? "alive" },
          }),
        );
      }
      if (!made.length) return fail("no part had a name and conversations of this proposal");
      const rest = [...pool];
      if (rest.length) updateProposal(p.id, { conversation_ids: rest });
      else updateProposal(p.id, { state: "superseded" });
      return ok({ split: p.name, parts: made.map((m) => proposalCard(m)), left_in_original: rest.length });
    }
    return fail(`unknown action "${action}"`);
  }

  if (name === "domains__adopt") {
    const p = mine(str(inp.id));
    if (!p) return fail("no such proposal in this conversation");
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
    if (!p) return fail("no such proposal in this conversation");
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

// ── Rename, dismiss ──────────────────────────────────────────────────────────

/** A new name and/or summary in the member's words; an empty one keeps the old. */
export function renameProposal(p: Proposal, patch: { name?: string; summary?: string }): Proposal {
  const name = (patch.name ?? "").trim() || p.name;
  const summary = (patch.summary ?? "").trim() || p.summary;
  if (name === p.name && summary === p.summary) return p;
  return updateProposal(p.id, { name, summary })!;
}

/** The member says it is not a domain: put away, its conversations never
 *  come up in a mapping again. */
export function dismissProposal(p: Proposal): Proposal {
  return updateProposal(p.id, { state: "dismissed" })!;
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
  updateProposal(p.id, { state: "adopted", maurice_id: domain.id, name, summary });
  console.log(`[proposals] "${name}" adopted by ${p.member_id}: domain ${domain.id}, ${bound} conversation(s) bound`);
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

// ── The drawer's validation (P2-D) ───────────────────────────────────────────

export type ApplyAction = "adopt" | "dismiss" | "keep";

export interface ApplyItem {
  id: string;
  action: ApplyAction;
  name?: string;
  summary?: string;
  /** Adopt only: write the garden notes too. A yes to the domain is not a
   *  yes to the notes; the drawer's box is off by default. */
  seed?: boolean;
}

export interface ApplyResult {
  adopted: Array<{ id: string; name: string; domain_id: string; conversations_bound: number; seeding: boolean }>;
  dismissed: Array<{ id: string; name: string }>;
  renamed: Array<{ id: string; name: string }>;
  errors: Array<{ id: string; error: string }>;
  /** The message Maurice left in the conversation, or null when nothing changed. */
  message_id: string | null;
  conversation_id: string | null;
}

/** What Maurice says in the conversation once the drawer is validated, in
 *  the member's language. */
const DONE: Record<string, { adopted: string; brief: string; dismissed: string; renamed: string; no_notes: string; seeding: string; seeded: string; seed_failed: string; notes_one: string; notes_other: string }> = {
  en: {
    adopted: "Done, from the app. Adopted: %s.",
    brief: "The first brief is being written now and will appear on the domain's page in a minute or two.",
    dismissed: "Put away: %s — their conversations will not come up again.",
    renamed: "Corrected: %s.",
    no_notes: "No note was written in your garden.",
    seeding: "You asked for garden notes on %s: I am writing them and will tell you here when they are there.",
    seeded: "Notes on %s are in your garden (%s), each marked as written by me and not reviewed yet — keep, correct or throw away:",
    seed_failed: "The notes on %s could not be written: %s.",
    notes_one: "%d note",
    notes_other: "%d notes",
  },
  fr: {
    adopted: "C'est fait, depuis l'app. Adopté : %s.",
    brief: "Le premier cahier s'écrit maintenant et apparaîtra sur la fiche du domaine d'ici une minute ou deux.",
    dismissed: "Rangé : %s — leurs conversations ne remonteront plus.",
    renamed: "Corrigé : %s.",
    no_notes: "Aucune note n'a été écrite dans ton jardin.",
    seeding: "Tu as demandé des notes de jardin sur %s : je les écris et je te le dis ici quand elles y sont.",
    seeded: "Les notes sur %s sont dans ton jardin (%s), chacune marquée comme écrite par moi et pas encore relue — garde, corrige ou jette :",
    seed_failed: "Les notes sur %s n'ont pas pu être écrites : %s.",
    notes_one: "%d note",
    notes_other: "%d notes",
  },
  it: {
    adopted: "Fatto, dall'app. Adottati: %s.",
    brief: "Il primo quaderno si sta scrivendo ora e comparirà nella pagina del dominio tra un minuto o due.",
    dismissed: "Messi via: %s — le loro conversazioni non torneranno più.",
    renamed: "Corretti: %s.",
    no_notes: "Nessuna nota è stata scritta nel tuo giardino.",
    seeding: "Hai chiesto note di giardino su %s: le sto scrivendo e te lo dirò qui quando ci saranno.",
    seeded: "Le note su %s sono nel tuo giardino (%s), ciascuna segnata come scritta da me e non ancora riletta — tieni, correggi o butta:",
    seed_failed: "Le note su %s non hanno potuto essere scritte: %s.",
    notes_one: "%d nota",
    notes_other: "%d note",
  },
  de: {
    adopted: "Erledigt, aus der App. Übernommen: %s.",
    brief: "Das erste Heft wird jetzt geschrieben und erscheint in ein, zwei Minuten auf der Seite des Bereichs.",
    dismissed: "Weggelegt: %s — ihre Gespräche kommen nicht wieder hoch.",
    renamed: "Korrigiert: %s.",
    no_notes: "In deinem Garten wurde keine Notiz geschrieben.",
    seeding: "Du hast Gartennotizen zu %s gewünscht: Ich schreibe sie und sage dir hier Bescheid, wenn sie da sind.",
    seeded: "Die Notizen zu %s sind in deinem Garten (%s), jede als von mir geschrieben und noch nicht durchgesehen markiert — behalten, korrigieren oder wegwerfen:",
    seed_failed: "Die Notizen zu %s konnten nicht geschrieben werden: %s.",
    notes_one: "%d Notiz",
    notes_other: "%d Notizen",
  },
  es: {
    adopted: "Hecho, desde la app. Adoptados: %s.",
    brief: "El primer cuaderno se está escribiendo ahora y aparecerá en la página del dominio en uno o dos minutos.",
    dismissed: "Guardados: %s — sus conversaciones no volverán a salir.",
    renamed: "Corregidos: %s.",
    no_notes: "No se ha escrito ninguna nota en tu jardín.",
    seeding: "Has pedido notas de jardín sobre %s: las estoy escribiendo y te lo diré aquí cuando estén.",
    seeded: "Las notas sobre %s están en tu jardín (%s), cada una marcada como escrita por mí y aún sin revisar — guarda, corrige o tira:",
    seed_failed: "Las notas sobre %s no se han podido escribir: %s.",
    notes_one: "%d nota",
    notes_other: "%d notas",
  },
  pt: {
    adopted: "Feito, a partir da app. Adotados: %s.",
    brief: "O primeiro caderno está a ser escrito agora e aparecerá na página do domínio dentro de um ou dois minutos.",
    dismissed: "Arrumados: %s — as suas conversas não voltarão a aparecer.",
    renamed: "Corrigidos: %s.",
    no_notes: "Nenhuma nota foi escrita no teu jardim.",
    seeding: "Pediste notas de jardim sobre %s: estou a escrevê-las e digo-te aqui quando lá estiverem.",
    seeded: "As notas sobre %s estão no teu jardim (%s), cada uma marcada como escrita por mim e ainda não revista — guarda, corrige ou deita fora:",
    seed_failed: "As notas sobre %s não puderam ser escritas: %s.",
    notes_one: "%d nota",
    notes_other: "%d notas",
  },
  nl: {
    adopted: "Gedaan, vanuit de app. Overgenomen: %s.",
    brief: "Het eerste schrift wordt nu geschreven en verschijnt binnen een minuut of twee op de pagina van het domein.",
    dismissed: "Opgeborgen: %s — hun gesprekken komen niet meer terug.",
    renamed: "Verbeterd: %s.",
    no_notes: "Er is geen notitie in je tuin geschreven.",
    seeding: "Je vroeg om tuinnotities over %s: ik schrijf ze en laat het je hier weten zodra ze er zijn.",
    seeded: "De notities over %s staan in je tuin (%s), elk gemarkeerd als door mij geschreven en nog niet nagekeken — bewaar, verbeter of gooi weg:",
    seed_failed: "De notities over %s konden niet worden geschreven: %s.",
    notes_one: "%d notitie",
    notes_other: "%d notities",
  },
};

function fill(s: string, ...args: Array<string | number>): string {
  let i = 0;
  return s.replace(/%[ds]/g, () => String(args[i++] ?? ""));
}

const bold = (names: string[]) => names.map((n) => `**${n}**`).join(", ");

/** Leave a message of Maurice's in the proposal conversation and fan it out
 *  to the member's open thread. Returns its id. */
export function sayInConversation(conversationId: string, text: string): string {
  const msg = addMessage(conversationId, "assistant", text, { mauriceId: null });
  publishToRoom(conversationId, { type: "message", message: msg });
  return msg.id;
}

/** Tests wait on the seeding kicked off by `applyProposals`. */
let lastSeeding: Promise<void> = Promise.resolve();
export function seedingSettled(): Promise<void> {
  return lastSeeding;
}

/**
 * The drawer's validation: every item is a proposal of the member's, still
 * open; a name or summary given is theirs and prevails; `adopt` creates the
 * domain (adoptProposal, the same as the tool), `dismiss` puts it away,
 * `keep` only renames. Then Maurice says in the conversation what was
 * done, and the garden notes asked for are written in the background, each
 * announced in turn (charged to the member, like the tool).
 */
export async function applyProposals(memberId: string, items: ApplyItem[]): Promise<ApplyResult> {
  const out: ApplyResult = { adopted: [], dismissed: [], renamed: [], errors: [], message_id: null, conversation_id: null };
  const seeds: Array<{ p: Proposal; domain: Maurice }> = [];
  for (const it of items) {
    const p = it.id ? getProposal(it.id) : null;
    if (!p || p.member_id !== memberId) { out.errors.push({ id: it.id, error: "no such proposal" }); continue; }
    if (p.state !== "proposed") { out.errors.push({ id: it.id, error: `this proposal is ${p.state}` }); continue; }
    out.conversation_id ??= p.conversation_id;
    const renamed = renameProposal(p, { name: it.name, summary: it.summary });
    if (renamed.name !== p.name || renamed.summary !== p.summary) out.renamed.push({ id: p.id, name: renamed.name });
    if (it.action === "adopt") {
      const r = adoptProposal(renamed);
      if ("error" in r) { out.errors.push({ id: p.id, error: r.error }); continue; }
      out.adopted.push({ id: p.id, name: r.domain.name, domain_id: r.domain.id, conversations_bound: r.bound, seeding: !!it.seed });
      // The box left unticked is not a refusal: the notes stay offerable
      // in the conversation (domains__seed), where Maurice may propose them.
      if (it.seed) seeds.push({ p: getProposal(p.id)!, domain: r.domain });
    } else if (it.action === "dismiss") {
      dismissProposal(renamed);
      out.dismissed.push({ id: p.id, name: renamed.name });
    }
  }

  const changed = out.adopted.length || out.dismissed.length || out.renamed.length;
  if (changed && out.conversation_id) {
    const t = DONE[memberLocale(memberId)] ?? DONE.en!;
    const lines: string[] = [];
    if (out.adopted.length) {
      lines.push(fill(t.adopted, bold(out.adopted.map((a) => a.name))) + " " + t.brief);
    }
    if (out.dismissed.length) lines.push(fill(t.dismissed, bold(out.dismissed.map((d) => d.name))));
    const renamedOnly = out.renamed.filter((r) => !out.adopted.some((a) => a.id === r.id) && !out.dismissed.some((d) => d.id === r.id));
    if (renamedOnly.length) lines.push(fill(t.renamed, bold(renamedOnly.map((r) => r.name))));
    if (out.adopted.length) {
      lines.push(seeds.length ? fill(t.seeding, bold(seeds.map((s) => s.domain.name))) : t.no_notes);
    }
    out.message_id = sayInConversation(out.conversation_id, lines.join("\n\n"));
    console.log(`[proposals] ${memberId} applied from the app: ${out.adopted.length} adopted, ${out.dismissed.length} dismissed, ${renamedOnly.length} renamed, ${seeds.length} to seed`);
  }

  if (seeds.length && out.conversation_id) {
    const conversationId = out.conversation_id;
    const t = DONE[memberLocale(memberId)] ?? DONE.en!;
    lastSeeding = lastSeeding.then(async () => {
      for (const { p, domain } of seeds) {
        try {
          const r = await seedProposal(p, domain, memberId);
          if (r.outcome === "written") {
            const n = r.notes.length;
            const links = r.notes.map((note) => `- [${note.title}](${note.web_path})`).join("\n");
            sayInConversation(conversationId, `${fill(t.seeded, `**${domain.name}**`, fill(n === 1 ? t.notes_one : t.notes_other, n))}\n${links}`);
          } else {
            sayInConversation(conversationId, fill(t.seed_failed, `**${domain.name}**`, describeSeeding(r)));
          }
        } catch (err) {
          sayInConversation(conversationId, fill(t.seed_failed, `**${domain.name}**`, (err as Error).message));
        }
      }
    });
  }
  return out;
}
