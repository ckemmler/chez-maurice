import { Hono } from "hono";
import { requireAuth } from "../middleware/auth";
import {
  allFacts,
  decideFact,
  editFact,
  forgetFact,
  keptFacts,
  proposedFacts,
  type LifeFact,
} from "../services/lifeFacts";

// The facts Maurice has written down about a member, and their decision on
// each (services/lifeFacts.ts). Everything here is the caller's own: a fact
// of someone else's is not found rather than refused, which is the same answer
// the rest of the app gives about another member's memory.

const facts = new Hono();

facts.use("/*", requireAuth);

const view = (f: LifeFact) => ({
  id: f.id,
  text: f.text,
  state: f.state,
  conversation_id: f.conversation_id,
  created_at: f.created_at,
  decided_at: f.decided_at,
});

/** Everything but what they threw away: what is waiting first, then what is
 *  known. `?state=proposed` for the waiting ones alone — what a badge counts. */
facts.get("/", (c) => {
  const uid = c.get("userId");
  const state = c.req.query("state");
  if (state === "proposed") return c.json({ facts: proposedFacts(uid).map(view) });
  if (state === "kept") return c.json({ facts: keptFacts(uid).map(view) });
  return c.json({ facts: allFacts(uid).map(view) });
});

/** Keep it: from now on it is in every private conversation's prompt. */
facts.post("/:id/keep", (c) => {
  const f = decideFact(c.get("userId"), c.req.param("id"), true);
  return f ? c.json(view(f)) : c.json({ error: "not found" }, 404);
});

/** Throw it away: it stays in the table, marked, so the same sentence is not
 *  proposed again next week. */
facts.post("/:id/dismiss", (c) => {
  const f = decideFact(c.get("userId"), c.req.param("id"), false);
  return f ? c.json(view(f)) : c.json({ error: "not found" }, 404);
});

/** Correct it. Maurice wrote it from what he understood; the member knows. */
facts.patch("/:id", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const f = editFact(c.get("userId"), c.req.param("id"), String(body?.text ?? ""));
  return f ? c.json(view(f)) : c.json({ error: "not found" }, 404);
});

/** Forget it entirely — including one that was kept for months. */
facts.delete("/:id", (c) => {
  return forgetFact(c.get("userId"), c.req.param("id")) ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
});

export default facts;
