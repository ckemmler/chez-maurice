import db from "../db";
import type { McpTool } from "./mcpClient";

// ── Facts of a life ──────────────────────────────────────────────────────────
//
// A third kind of memory, beside the domain briefs and the corpus.
//
// A brief describes a live subject and is rewritten every night. A corpus hit
// is a dated passage of something that was said. Neither fits "Emilio is
// eleven" — small, stable, true until it changes. On the Galápagos turn Maurice
// went searching the corpus for the ages of the children, which is a thousand
// tokens spent on something that should simply have been known.
//
// So: Maurice writes one down when he learns it, in the conversation, through
// `remember_fact`. It is **proposed**, not known: the member is told in the
// same reply and decides. Only a kept fact reaches the everyday prompt. The
// order matters — a model that writes into someone's memory unsupervised is a
// model that eventually writes something false into it, and the member is the
// one who has to live with it.
//
// The member's own `users.profile_text` is left alone. That paragraph is
// theirs, written by hand; these are Maurice's additions to it, held apart so
// they can be taken back one by one.

export type FactState = "proposed" | "kept" | "dismissed";

export interface LifeFact {
  id: string;
  member_id: string;
  text: string;
  state: FactState;
  /** Where Maurice learnt it, so the member can go and look. */
  conversation_id: string | null;
  created_at: string;
  decided_at: string | null;
}

/** What a fact may weigh. A fact is a line; anything longer is a brief in
 *  disguise, and belongs in a domain. */
export const FACT_MAX_CHARS = 200;

/** How many a single turn may propose. Two is enough for a conversation that
 *  genuinely taught Maurice something; more is a model filling a form. */
export const FACTS_PER_TURN = 2;

function rows(sql: string, ...args: any[]): LifeFact[] {
  return db.query(sql).all(...args) as LifeFact[];
}

export function getFact(id: string): LifeFact | null {
  return (db.query(`SELECT * FROM life_facts WHERE id = ?`).get(id) as LifeFact) ?? null;
}

/** The facts the member has kept: what Maurice actually knows. */
export function keptFacts(memberId: string): LifeFact[] {
  return rows(`SELECT * FROM life_facts WHERE member_id = ? AND state = 'kept' ORDER BY created_at`, memberId);
}

/** Everything still waiting on the member, oldest first. */
export function proposedFacts(memberId: string): LifeFact[] {
  return rows(`SELECT * FROM life_facts WHERE member_id = ? AND state = 'proposed' ORDER BY created_at`, memberId);
}

export function allFacts(memberId: string): LifeFact[] {
  return rows(
    `SELECT * FROM life_facts WHERE member_id = ? AND state != 'dismissed' ORDER BY state = 'proposed' DESC, created_at DESC`,
    memberId,
  );
}

/** Normalised for comparison: a model proposing the same fact twice in
 *  different words is common; in the same words, constant. */
function normal(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").replace(/[.,;:!?…"'«»]/g, "").trim();
}

export interface ProposeResult {
  fact: LifeFact | null;
  /** Why nothing was written, for the model to read. */
  refused?: "empty" | "too long" | "already known" | "already proposed" | "too many this turn";
}

/**
 * Record a proposed fact. Refusals are ordinary answers, not errors: the model
 * should learn from them within the turn rather than retry.
 */
export function proposeFact(memberId: string, text: string, conversationId: string | null, proposedThisTurn = 0): ProposeResult {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return { fact: null, refused: "empty" };
  if (clean.length > FACT_MAX_CHARS) return { fact: null, refused: "too long" };
  if (proposedThisTurn >= FACTS_PER_TURN) return { fact: null, refused: "too many this turn" };
  const wanted = normal(clean);
  for (const f of allFacts(memberId)) {
    if (normal(f.text) !== wanted) continue;
    return { fact: null, refused: f.state === "kept" ? "already known" : "already proposed" };
  }
  const id = crypto.randomUUID();
  db.run(
    `INSERT INTO life_facts (id, member_id, text, state, conversation_id) VALUES (?, ?, ?, 'proposed', ?)`,
    [id, memberId, clean, conversationId],
  );
  return { fact: getFact(id) };
}

/** The member's decision. Returns null when the fact is not theirs. */
export function decideFact(memberId: string, id: string, keep: boolean): LifeFact | null {
  const fact = getFact(id);
  if (!fact || fact.member_id !== memberId) return null;
  db.run(`UPDATE life_facts SET state = ?, decided_at = datetime('now') WHERE id = ?`, [keep ? "kept" : "dismissed", id]);
  return getFact(id);
}

/** A kept fact the member no longer wants known. Same route as dismissing a
 *  proposal: forgetting is one gesture, whenever it happens. */
export function forgetFact(memberId: string, id: string): boolean {
  const fact = getFact(id);
  if (!fact || fact.member_id !== memberId) return false;
  db.run(`DELETE FROM life_facts WHERE id = ?`, [id]);
  return true;
}

/** The member's own correction of a fact Maurice wrote clumsily. */
export function editFact(memberId: string, id: string, text: string): LifeFact | null {
  const clean = text.replace(/\s+/g, " ").trim().slice(0, FACT_MAX_CHARS);
  const fact = getFact(id);
  if (!fact || fact.member_id !== memberId || !clean) return null;
  db.run(`UPDATE life_facts SET text = ? WHERE id = ?`, [clean, id]);
  return getFact(id);
}

/** The section of the everyday prompt: only what the member kept. "" when
 *  there is nothing, so a member who never validated anything sees no trace of
 *  the machinery. */
export function factsForPrompt(memberId: string): string {
  const facts = keptFacts(memberId);
  if (!facts.length) return "";
  return `\n\nAlso true of them, and confirmed by them:\n${facts.map((f) => `- ${f.text}`).join("\n")}`;
}

// ── The tool ─────────────────────────────────────────────────────────────────

export const REMEMBER_FACT_TOOL = "remember_fact";

export function isRememberFactTool(name: string): boolean {
  return name === REMEMBER_FACT_TOOL;
}

export function rememberFactTool(): McpTool {
  return {
    name: REMEMBER_FACT_TOOL,
    description:
      "Write down one small, lasting fact you have just learnt about the person you are talking to, so you still know it in a year. " +
      "For facts only: their children's names and ages, where they live, what they do, an allergy, an instrument they play, a date that recurs. " +
      "Not for what belongs to a domain (what they are working on, reading, deciding — that is a brief), not for anything passing " +
      "(a mood, today's plan), not for anything you inferred rather than were told, and never for someone who is not in this conversation. " +
      "One short sentence in their own language, written as a statement about them. " +
      "The fact is shown to them for confirmation and only counts once they keep it, so propose rather than assert, and do not announce it as already known.",
    inputSchema: {
      type: "object",
      properties: {
        fact: {
          type: "string",
          description: "The fact, one sentence, at most 200 characters. E.g. \"Emilio a onze ans.\"",
        },
      },
      required: ["fact"],
    },
  };
}

export interface FactToolOutcome {
  text: string;
  isError: boolean;
  data?: unknown;
}

/**
 * Run it. The card the client draws (`card: "fact"`) is what tells the member;
 * the text tells the model what happened to its proposal.
 */
export function runRememberFactTool(
  input: any,
  memberId: string | undefined,
  conversationId: string,
  proposedThisTurn: number,
): FactToolOutcome {
  if (!memberId) return { text: "Tool error: no member on this turn", isError: true };
  const { fact, refused } = proposeFact(memberId, typeof input?.fact === "string" ? input.fact : "", conversationId, proposedThisTurn);
  if (!fact) {
    const why =
      refused === "already known"
        ? "You already know that, and they confirmed it. Nothing was written."
        : refused === "already proposed"
          ? "You have already proposed that and they have not decided yet. Nothing was written."
          : refused === "too long"
            ? `That is longer than a fact (${FACT_MAX_CHARS} characters at most). If it needs a paragraph it belongs to a domain, not here.`
            : refused === "too many this turn"
              ? `Two facts in one turn is the limit. Keep the rest for when they come up.`
              : "Nothing to write.";
    return { text: why, isError: false };
  }
  return {
    text:
      `Proposed: "${fact.text}". They are being shown it now and will keep it or throw it away. ` +
      `Do not treat it as known yet, and mention it only in passing if at all — the card says it for you.`,
    isError: false,
    data: { card: "fact", id: fact.id, text: fact.text, state: fact.state },
  };
}
