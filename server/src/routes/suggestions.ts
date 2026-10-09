import { Hono } from "hono";
import { requireAuth } from "../middleware/auth";
import { isParticipant } from "../services/conversations";
import {
  dismissSuggestion,
  keepSuggestion,
  keptCount,
  keptWebPath,
  pendingCount,
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

const view = (memberId: string, s: EntrySuggestion) => ({
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
  /** Several possible identities: one must be picked to keep it. */
  candidates: s.candidates.length > 1 ? s.candidates : [],
  /** Where the entry reads in their garden, once there is one. */
  web_path: s.existing || s.kept_path ? keptWebPath(memberId, s) : null,
});

/** The conversation's list: what waits first, then what was kept. */
suggestions.get("/", (c) => {
  const uid = c.get("userId");
  const conversationId = c.req.query("conversation") ?? "";
  if (!conversationId || !isParticipant(conversationId, uid)) return c.json({ error: "not found" }, 404);
  return c.json({
    suggestions: suggestionsFor(uid, conversationId).map((s) => view(uid, s)),
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
