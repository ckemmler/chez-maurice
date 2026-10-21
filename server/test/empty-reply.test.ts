/**
 * A turn always ends on a terminal event (21 October 2026). A model that came
 * back without a word left nothing to persist, and the stream used to close
 * with neither `done` nor `error`: the app took it for a lost connection and
 * re-attached until it showed "connection lost". It now ends on `error`, in
 * the member's language, and only once.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";

const db = (await import("../src/db")).default;
const routes = (await import("../src/routes/conversations")).default;
const { createSession } = await import("../src/services/auth");
const { createConversation, getMessages } = await import("../src/services/conversations");
const { _resetTurns } = await import("../src/services/turns");

const MEMBER = "empty-reply-member";
let auth = "";
const realFetch = globalThis.fetch;
let saved: Record<string, unknown> | null = null;
/** What the fake Anthropic answers: an SSE body, or an HTTP error. */
let answer: () => Response = () => new Response("", { status: 500 });

function sse(events: object[]): Response {
  const body = events.map((e) => `event: ${(e as any).type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

beforeAll(() => {
  db.run(`INSERT OR IGNORE INTO households (id, name) VALUES ('default', 'Home')`);
  saved = db.query(`SELECT api_key, openai_api_key, mistral_api_key, zai_api_key, scaleway_api_key, default_model FROM households WHERE id = 'default'`).get() as any;
  db.run(`UPDATE households SET api_key = 'k-anthropic', openai_api_key = NULL, mistral_api_key = NULL,
          zai_api_key = NULL, scaleway_api_key = NULL, default_model = 'claude-sonnet-4-6' WHERE id = 'default'`);
  db.run(
    `INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES (?, ?, ?, 'admin')`,
    [MEMBER, "emptyreply", "Empty reply"],
  );
  db.run(`INSERT OR REPLACE INTO user_preferences (user_id, locale) VALUES (?, 'fr')`, [MEMBER]);
  auth = `Bearer ${createSession(MEMBER).token}`;
  // Nothing leaves the machine: the MCP gateway is simply unreachable.
  globalThis.fetch = (async (input: any) => {
    const url = String(input?.url ?? input);
    if (url.includes("api.anthropic.com")) return answer();
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  if (saved) {
    db.run(
      `UPDATE households SET api_key = ?, openai_api_key = ?, mistral_api_key = ?, zai_api_key = ?, scaleway_api_key = ?, default_model = ? WHERE id = 'default'`,
      [saved.api_key, saved.openai_api_key, saved.mistral_api_key, saved.zai_api_key, saved.scaleway_api_key, saved.default_model] as any,
    );
  }
  _resetTurns();
});

const post = (convoId: string, content: string) =>
  routes.request(`/${convoId}/messages`, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify({ content, summon: true }),
  });

async function lines(res: Response): Promise<any[]> {
  return (await res.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

const terminal = (events: any[]) => events.filter((e) => e.type === "done" || e.type === "error");

test("a model that says nothing ends the turn on one error, and nothing is stored", async () => {
  answer = () =>
    sse([
      { type: "message_start", message: { usage: { input_tokens: 12, output_tokens: 0 } } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 0 } },
      { type: "message_stop" },
    ]);
  const convo = createConversation(MEMBER);
  const res = await post(convo.id, "Bonjour");
  expect(res.status).toBe(200);
  const events = await lines(res);
  const ends = terminal(events);
  expect(ends).toHaveLength(1);
  expect(events[events.length - 1]).toEqual({
    type: "error",
    message: "Maurice est revenu sans réponse. Réessayez, ou choisissez un autre modèle.",
  });
  expect(getMessages(convo.id).filter((m) => m.role === "assistant")).toHaveLength(0);

  // A client that re-attaches finds the same end, not an endless wait.
  const again = await lines(
    await routes.request(`/${convo.id}/turn`, { headers: { Authorization: auth } }),
  );
  expect(again[0]).toMatchObject({ type: "resume", finished: true, text: "" });
  expect(again[1]).toEqual(events[events.length - 1]);
});

test("a provider error with no text is the only terminal event", async () => {
  answer = () => new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 529 });
  const convo = createConversation(MEMBER);
  const events = await lines(await post(convo.id, "Bonjour"));
  const ends = terminal(events);
  expect(ends).toHaveLength(1);
  expect(ends[0].type).toBe("error");
  expect(ends[0].message).toContain("529");
});
