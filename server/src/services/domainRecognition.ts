import db from "../db";
import { corpusCall } from "./mcpClient";

// Recognising a domain as the conversation goes (10 October 2026).
//
// Until now the only sign that a conversation touched a domain was Maurice
// reading its brief: the `domain_brief` tool's result is what the app draws
// as a pastille. When the model loaded nothing, nothing showed — a long
// conversation on the design of Maurice wore no mark at all. Whether a turn
// falls into a domain should not hang on what the model chose to do.
//
// So the server asks, before the model answers: the member's last turns are
// embedded as their conversations were, and the corpus says which of their
// domains the nearest conversations belong to (`corpus__match_domains`, the
// neighbours' vote — a centroid per domain was tried first and does not
// work, see tools/corpus/src/domain_map.py). Six neighbours of twelve make
// a domain *recognised*: the app draws it as a pastille of its own, distinct
// from "brief read", and a tap on it offers to bind the conversation. Nine
// make it *strong*: Maurice is then told, at the tail of the turn, to read
// the brief before answering. Measured on single turns of the owner's bound
// conversations, each left out of its own vote: six is wrong on 3.5 % and
// finds half of them, nine is wrong on 1 %.
//
// Only where the index of domains is carried: a conversation the member
// holds alone with Maurice, never a room, never for another member. Nothing
// is bound here — binding changes how a conversation is answered, and is the
// member's gesture or the night's (services/domainMapping.ts).

/** Neighbours of twelve for a domain to be recognised, and to be strong. */
export const RECOGNISED_VOTES = 6;
export const STRONG_VOTES = 9;
export const MATCH_K = 12;
/** What the model waits for at most; past it the turn goes on unmarked. */
export const RECOGNITION_TIMEOUT_MS = 1500;
/** Characters of the member's own turns that are embedded, newest first. */
const TEXT_BUDGET = 1500;
const MIN_TEXT = 24;

export const DOMAIN_RECOGNISED_TOOL = "domain_recognised";

export interface DomainMatch {
  id: string;
  domain: string | null;
  votes: number;
  k: number;
}

export interface Recognition {
  domain: string;
  domain_id: string;
  icon: string | null;
  votes: number;
  k: number;
  /** Enough neighbours for Maurice to be told to read the brief. */
  strong: boolean;
}

export interface RecognitionDeps {
  /** `corpus__match_domains` on a text, the conversation itself kept out. */
  match: (memberId: string, domains: Record<string, string[]>, text: string, exclude: string[]) => Promise<DomainMatch[]>;
}

async function corpusMatch(memberId: string, domains: Record<string, string[]>, text: string, exclude: string[]): Promise<DomainMatch[]> {
  const r = await corpusCall(memberId, "match_domains", { domains, text, exclude });
  if (r?.error || r?.raw) throw new Error(String(r.error ?? r.raw));
  return (r?.matches ?? []) as DomainMatch[];
}

let deps: RecognitionDeps | null = null;
/** Tests hand in the corpus's answer; null puts the real one back. */
export function setRecognitionDeps(d: RecognitionDeps | null): void {
  deps = d;
}

function activeDeps(): RecognitionDeps | null {
  if (deps) return deps;
  // A test that did not ask for it gets no call to a gateway that is not there.
  if (process.env.NODE_ENV === "test") return null;
  return { match: corpusMatch };
}

/** The conversations bound to each of the member's domains by the member or
 *  by an adoption — the ones whose word counts when the neighbours are
 *  asked. Those the night bound itself do not vote: a domain must not grow
 *  on its own guesses. */
export function domainVoters(memberId: string): Record<string, string[]> {
  const rows = db
    .query(
      `SELECT c.maurice_id AS d, c.id FROM conversations c JOIN maurices m ON m.id = c.maurice_id
        WHERE c.user_id = ? AND m.created_by = ? AND COALESCE(m.kind, 'domain') = 'domain' AND COALESCE(c.maurice_bound_by, '') != 'auto'`,
    )
    .all(memberId, memberId) as Array<{ d: string; id: string }>;
  const out: Record<string, string[]> = {};
  for (const r of rows) (out[r.d] ??= []).push(r.id);
  return out;
}

/** The member's own last turns in a conversation, newest first, as one text:
 *  a "yes, go on" says nothing by itself, the turn before it does. */
export function recentMemberText(conversationId: string, memberId: string): string {
  const rows = db
    .query(
      `SELECT content FROM messages WHERE conversation_id = ? AND role = 'user' AND (author_id = ? OR author_id IS NULL)
        ORDER BY created_at DESC, rowid DESC LIMIT 4`,
    )
    .all(conversationId, memberId) as Array<{ content: string }>;
  const parts: string[] = [];
  let used = 0;
  for (const r of rows) {
    const text = r.content.replace(/```[\s\S]*?```/g, " ").replace(/!\[[^\]]*\]\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
    if (!text) continue;
    parts.push(text.slice(0, TEXT_BUDGET - used));
    used += text.length;
    if (used >= TEXT_BUDGET) break;
  }
  return parts.join("\n");
}

/**
 * Which of the member's domains this conversation is in just now, or null:
 * none recognised, no domain with conversations of its own, too little
 * said, a corpus that did not answer in time, or the domain the conversation
 * is already bound to (it wears that one's mark already). Never throws.
 */
export async function recogniseDomain(memberId: string, conversationId: string, timeoutMs = RECOGNITION_TIMEOUT_MS): Promise<Recognition | null> {
  const d = activeDeps();
  if (!d) return null;
  try {
    const voters = domainVoters(memberId);
    if (!Object.keys(voters).length) return null;
    const text = recentMemberText(conversationId, memberId);
    if (text.length < MIN_TEXT) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); });
    const matches = await Promise.race([d.match(memberId, voters, text, [conversationId]), late]).finally(() => clearTimeout(timer));
    const m = matches?.[0];
    if (!m?.domain || m.votes * MATCH_K < RECOGNISED_VOTES * m.k) return null;
    const row = db
      .query(`SELECT m.id, m.name, m.icon, (SELECT maurice_id FROM conversations WHERE id = ?) AS bound FROM maurices m WHERE m.id = ? AND m.created_by = ?`)
      .get(conversationId, m.domain, memberId) as { id: string; name: string; icon: string | null; bound: string | null } | null;
    if (!row || row.bound === row.id) return null;
    return { domain: row.name, domain_id: row.id, icon: row.icon, votes: m.votes, k: m.k, strong: m.votes * MATCH_K >= STRONG_VOTES * m.k };
  } catch (err) {
    console.warn(`[domains] recognition for ${conversationId}: ${(err as Error).message}`);
    return null;
  }
}

/** Whether a brief of that domain was already read in this conversation.
 *  Read off the `domain_brief` blocks themselves: the recognition's own mark
 *  sits in the same `data` and names a domain too. */
export function briefAlreadyRead(conversationId: string, domainId: string): boolean {
  const rows = db
    .query(`SELECT data FROM messages WHERE conversation_id = ? AND role = 'assistant' AND data LIKE '%domain_brief%'`)
    .all(conversationId) as Array<{ data: string }>;
  return rows.some((r) => {
    try {
      const blocks = JSON.parse(r.data);
      return Array.isArray(blocks) && blocks.some((b) => b?.tool === "domain_brief" && b?.data?.domain_id === domainId);
    } catch {
      return false;
    }
  });
}

/** What Maurice is told at the tail of a turn that falls strongly into a
 *  domain whose brief he has not read here. */
export function recognitionNote(r: Recognition, memberName: string): string {
  return `This turn seems to fall into "${r.domain}", one of ${memberName}'s domains: their past conversations nearest to it belong there. You keep a brief on it — read it with \`domain_brief\` before answering, unless the question plainly has nothing to do with it.`;
}
