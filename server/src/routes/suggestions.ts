import { Hono } from "hono";
import { requireAuth } from "../middleware/auth";
import { isParticipant } from "../services/conversations";
import {
  boundRef,
  dismissSuggestion,
  keepSuggestion,
  keptCount,
  keptWebPath,
  pendingCount,
  settled,
  SuggestionError,
  suggestionsFor,
  type EntrySuggestion,
} from "../services/entrySuggestions";

// What a conversation is worth keeping in the member's garden, and their
// decision on each (services/entrySuggestions.ts). Everything here is the
// caller's own: a suggestion of someone else's is not found rather than
// refused, as for the life facts.

const suggestions = new Hono();

suggestions.use("/*", requireAuth);

const view = (memberId: string, s: EntrySuggestion, bound: string | null = boundRef(memberId, s.conversation_id)) => ({
  id: s.id,
  conversation_id: s.conversation_id,
  message_id: s.message_id,
  kind: s.kind,
  title: s.title,
  year: s.year,
  subtitle: s.subtitle,
  image: s.image,
  note: s.note,
  state: s.state,
  /** Already an entry of theirs: keeping it adds the note and nothing else. */
  existing: !!s.existing,
  /** The entry the conversation is held from: the note is its result. */
  bound: !!bound && (s.kept_path ?? s.existing) === bound,
  /** Kept from a conversation held on another entry: keeping links the two. */
  links: !!bound && (s.kept_path ?? s.existing) !== bound,
  /** Several possible identities: one must be picked to keep it. */
  candidates: s.candidates.length > 1 ? s.candidates : [],
  /** The garden entry this is, `<collection>/<locale>/<slug>`, once there is
   *  one — what Carnet opens (`carnet://entry/…`). */
  entry: s.kept_path ?? s.existing,
  /** Where the entry reads in their garden, once there is one. */
  web_path: s.existing || s.kept_path ? keptWebPath(memberId, s) : null,
});

/** The conversation's list: what waits first, then what was kept. */
suggestions.get("/", async (c) => {
  const uid = c.get("userId");
  const conversationId = c.req.query("conversation") ?? "";
  if (!conversationId || !isParticipant(conversationId, uid)) return c.json({ error: "not found" }, 404);
  // `settle=1`: answer once the pass the last reply started is done — for a
  // client with no socket to hear about it (Carnet).
  if (c.req.query("settle")) await settled(conversationId);
  const bound = boundRef(uid, conversationId);
  return c.json({
    entry: bound,
    // The note for the entry the conversation is held from is its result: first.
    suggestions: suggestionsFor(uid, conversationId)
      .map((s) => view(uid, s, bound))
      .sort((a, b) => Number(b.bound && b.state === "proposed") - Number(a.bound && a.state === "proposed")),
    pending: pendingCount(uid, conversationId),
    kept: keptCount(uid, conversationId),
  });
});

/** Keep it: the fiche is opened if the garden has none, the note filed on it. */
suggestions.post("/:id/keep", async (c) => {
  const uid = c.get("userId");
  const body = await c.req.json().catch(() => ({}));
  try {
    const s = await keepSuggestion(uid, c.req.param("id"), body?.candidate ? String(body.candidate) : null);
    return c.json(view(uid, s));
  } catch (e) {
    if (e instanceof SuggestionError) return c.json({ error: e.message }, e.status as any);
    console.error("[suggest] keep failed:", e);
    return c.json({ error: "Failed to keep" }, 500);
  }
});

/** Not this one, here or in any conversation to come. */
suggestions.post("/:id/dismiss", (c) => {
  const uid = c.get("userId");
  const s = dismissSuggestion(uid, c.req.param("id"));
  return s ? c.json(view(uid, s)) : c.json({ error: "not found" }, 404);
});

export default suggestions;
