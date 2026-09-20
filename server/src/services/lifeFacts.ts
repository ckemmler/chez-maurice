import db from "../db";
import { ancillaryComplete, type AncillaryRequest, type AncillaryResult } from "./ancillary";
import { recordSpend } from "./budget";
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
export function proposeFact(
  memberId: string,
  text: string,
  conversationId: string | null,
  proposedThisTurn = 0,
  opts: { dryRun?: boolean } = {},
): ProposeResult {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return { fact: null, refused: "empty" };
  if (clean.length > FACT_MAX_CHARS) return { fact: null, refused: "too long" };
  if (proposedThisTurn >= FACTS_PER_TURN) return { fact: null, refused: "too many this turn" };
  const wanted = normal(clean);
  for (const f of allFacts(memberId)) {
    if (normal(f.text) !== wanted) continue;
    return { fact: null, refused: f.state === "kept" ? "already known" : "already proposed" };
  }
  if (opts.dryRun) return { fact: null };
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

// ── The second opinion ───────────────────────────────────────────────────────
//
// The tool is called by whichever model is holding the conversation, and on a
// given turn that may be the cheapest model in the house. Whether a sentence
// is a lasting fact or this week's project is a judgement, and it should not
// depend on which model happens to be speaking. So every proposal is judged
// once more, by the model pinned to the `life_fact` invocation
// (services/ancillary.ts), before the member is shown anything.
//
// It fails open: a judge that errors or answers nothing lets the proposal
// through. The member is the real gate, and a second opinion that goes down
// must not silently stop Maurice from learning.

export interface FactJudgement {
  ok: boolean;
  /** The judge's own wording when it kept the fact but said it better. */
  text: string;
  /** Why not, in one clause, for the model that proposed it. */
  why?: string;
}

/** Swappable for tests, like the briefs' own model call. */
let judgeWith: (req: AncillaryRequest) => Promise<AncillaryResult> = ancillaryComplete;
export function setFactJudge(fn: ((req: AncillaryRequest) => Promise<AncillaryResult>) | null): void {
  judgeWith = fn ?? ancillaryComplete;
}

const JUDGE_SYSTEM =
  "You are deciding whether one sentence is a lasting fact about a person, worth remembering for years.\n\n" +
  "THE TEST: would it still be true in a year if nobody ever mentioned it again? A fact needs no tending. " +
  "A project, a plan, an idea, an opinion, a decision being weighed, something being read or built — all of those change by being lived, " +
  "and belong elsewhere.\n\n" +
  "Facts: a child's age, where someone lives, an allergy, an instrument they play, a recurring date, a diet they hold.\n" +
  "Not facts: wanting to learn a language, considering a trip, reading a book, working on something this week, finding a thing disappointing.\n\n" +
  "Answer with one line and nothing else:\n" +
  "  KEEP <the sentence, in its own language, corrected only if it is clumsy or not a statement about the person>\n" +
  "  DROP <three or four words saying why not>";

export async function judgeFact(text: string, memberId: string | null): Promise<FactJudgement> {
  try {
    const result = await judgeWith({
      invocation: "life_fact",
      system: JUDGE_SYSTEM,
      prompt: text,
      maxTokens: 300,
      temperature: 0,
    });
    recordSpend(result.usage, memberId);
    const line = result.text.replace(/\s+/g, " ").trim();
    const drop = /^\s*DROP\b[:\-\s]*/i.exec(line);
    if (drop) return { ok: false, text, why: line.slice(drop[0].length).trim() || "not a lasting fact" };
    const keep = /^\s*KEEP\b[:\-\s]*/i.exec(line);
    if (keep) {
      const said = keep.input.slice(keep[0].length).trim().replace(/^["'«]|["'»]$/g, "");
      return { ok: true, text: said.slice(0, FACT_MAX_CHARS) || text };
    }
    // Neither word: the judge did not answer the question asked, so it does
    // not get to decide.
    return { ok: true, text };
  } catch (err) {
    console.warn(`[facts] no second opinion (${(err as Error).message})`);
    return { ok: true, text };
  }
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
      "Write down one small, lasting fact you have just learnt about the person you are talking to, so you still know it in a year.\n\n" +
      "THE TEST, and it is the only one: would this still be true in a year if neither of you ever mentioned it again? " +
      "A fact needs no tending. A project, a plan, an idea, an opinion, a decision being weighed, something they are reading or building — " +
      "all of those change by being lived, and they belong to a domain brief, which you already keep. This is not a place to record progress.\n\n" +
      "Facts: \"Emilio a onze ans.\" \"Elle vit à Bruxelles.\" \"Il joue du violon.\" \"Elle est allergique aux arachides.\" " +
      "\"Leur anniversaire de mariage est le 3 mai.\" \"Il est végétarien.\"\n" +
      "Not facts: \"Il pense acheter une voiture électrique.\" \"Elle lit Humus.\" \"Il veut apprendre le portugais.\" " +
      "\"Ils envisagent un voyage aux Galápagos.\" \"Il trouve ce modèle décevant.\" \"Il travaille sur l'app cette semaine.\"\n\n" +
      "Never write down what you inferred rather than were told, anything about someone who is not in this conversation, " +
      "or anything that merely restates what you already know about them. When in doubt, do not write: a fact you missed comes back, " +
      "a wrong one has to be found and removed.\n\n" +
      "One short sentence in their own language, written as a statement about them. " +
      "It is shown to them for confirmation and counts only once they keep it, so propose rather than assert, and do not announce it as already known.",
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
  /** True once the second opinion has been paid for. The per-turn cap counts
   *  these, not the facts that came out of them: otherwise a model on a roll
   *  could be turned down ten times and still have bought ten judgements. */
  counted?: boolean;
}

/**
 * Run it. The card the client draws (`card: "fact"`) is what tells the member;
 * the text tells the model what happened to its proposal.
 */
export async function runRememberFactTool(
  input: any,
  memberId: string | undefined,
  conversationId: string,
  proposedThisTurn: number,
): Promise<FactToolOutcome> {
  if (!memberId) return { text: "Tool error: no member on this turn", isError: true };
  const said = typeof input?.fact === "string" ? input.fact : "";
  // Cheap refusals first: there is no point paying a judge to read an empty
  // string, an essay, or something already known.
  const dry = proposeFact(memberId, said, conversationId, proposedThisTurn, { dryRun: true });
  if (dry.refused) return refusal(dry.refused);
  const judged = await judgeFact(said, memberId);
  if (!judged.ok) {
    return {
      text: `Not written down: ${judged.why}. That belongs to a domain brief, or to nothing at all. Do not propose it again this turn.`,
      isError: false,
      counted: true,
    };
  }
  const { fact, refused } = proposeFact(memberId, judged.text, conversationId, proposedThisTurn);
  if (!fact) return { ...refusal(refused), counted: true };
  return {
    counted: true,
    text:
      `Proposed: "${fact.text}". They are being shown it now and will keep it or throw it away. ` +
      `Do not treat it as known yet, and mention it only in passing if at all — the card says it for you.`,
    isError: false,
    data: { card: "fact", id: fact.id, text: fact.text, state: fact.state },
  };
}

/** What the model is told when nothing was written. */
function refusal(refused: ProposeResult["refused"]): FactToolOutcome {
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
