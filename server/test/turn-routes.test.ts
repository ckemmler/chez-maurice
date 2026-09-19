/**
 * A reply outlives the request that started it. The registry's routes: a
 * client re-attaches with GET /:id/turn and gets the same text the original
 * stream got; a second summons while a reply runs is refused; stopping is
 * POST /:id/turn/stop. Runs the real pump in echo mode (no provider key).
 */
import { afterAll, beforeAll, expect, test } from "bun:test";

const db = (await import("../src/db")).default;
const routes = (await import("../src/routes/conversations")).default;
const { createSession } = await import("../src/services/auth");
const { createConversation, getMessages } = await import("../src/services/conversations");
const { currentTurn, _resetTurns } = await import("../src/services/turns");

const MEMBER = "turn-member";
let auth = "";

beforeAll(() => {
  db.run(`INSERT OR IGNORE INTO households (id, name) VALUES ('default', 'Home')`);
  // No key anywhere: the Anthropic path echoes the message back, a word at a time.
  db.run(`UPDATE households SET api_key = NULL, openai_api_key = NULL, mistral_api_key = NULL,
          zai_api_key = NULL, scaleway_api_key = NULL, default_model = 'claude-sonnet-4-6' WHERE id = 'default'`);
  // An admin: every model is theirs, so the household default is picked.
  db.run(
    `INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES (?, ?, ?, 'admin')`,
    [MEMBER, "turnmember", "Turn member"],
  );
  auth = `Bearer ${createSession(MEMBER).token}`;
});

afterAll(() => _resetTurns());

const req = (path: string, init: RequestInit = {}) =>
  routes.request(path, {
    ...init,
    headers: { Authorization: auth, "Content-Type": "application/json", ...(init.headers as any) },
  });

/** Read an NDJSON body to the end. */
async function lines(res: Response): Promise<any[]> {
  const text = await res.text();
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

const textOf = (events: any[]) =>
  events.filter((e) => e.type === "text_delta").map((e) => e.text).join("");

test("idle: nothing to re-attach to, nothing to stop", async () => {
  const convo = createConversation(MEMBER);
  expect((await req(`/${convo.id}/turn`)).status).toBe(204);
  const stop = await req(`/${convo.id}/turn/stop`, { method: "POST" });
  expect(stop.status).toBe(404);
  expect(await stop.json()).toEqual({ error: "No reply in progress" });
  // Membership first: a stranger's conversation is not found, not idle.
  db.run(`INSERT OR IGNORE INTO users (id, username, display_name) VALUES ('turn-other', 'turnother', 'Other')`);
  const theirs = createConversation("turn-other");
  expect((await req(`/${theirs.id}/turn`)).status).toBe(404);
  expect((await req(`/${theirs.id}/turn/stop`, { method: "POST" })).status).toBe(404);
});

test("a client that re-attaches mid-reply gets what it missed, then the rest, then done", async () => {
  const convo = createConversation(MEMBER);
  const res = await req(`/${convo.id}/messages`, {
    method: "POST",
    body: JSON.stringify({ content: "un deux trois quatre cinq six sept huit neuf dix" }),
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/x-ndjson");
  const original = lines(res); // consumed in the background, like an app would

  // Let a few words through, then come back for the reply.
  await new Promise((r) => setTimeout(r, 120));
  expect(currentTurn(convo.id)?.snapshot.finished).toBe(false);

  // A second summons meanwhile is refused — but the message itself is kept.
  const before = getMessages(convo.id).length;
  const busy = await req(`/${convo.id}/messages`, {
    method: "POST",
    body: JSON.stringify({ content: "encore" }),
  });
  expect(busy.status).toBe(409);
  expect(await busy.json()).toEqual({ error: "A reply is already in progress" });
  expect(getMessages(convo.id).length).toBe(before + 1);

  const again = await req(`/${convo.id}/turn`);
  expect(again.status).toBe(200);
  expect(again.headers.get("content-type")).toBe("application/x-ndjson");
  const resumed = await lines(again);
  const first = resumed[0];
  expect(first.type).toBe("resume");
  expect(first.finished).toBe(false);
  expect(first.tool).toBeNull();
  expect(first.data).toEqual([]);
  expect(typeof first.started_at).toBe("string");
  const last = resumed[resumed.length - 1];
  expect(last.type).toBe("done");

  const full = await original;
  const done = full[full.length - 1];
  expect(done.type).toBe("done");
  expect(last.message_id).toBe(done.message_id);
  // The snapshot plus the live tail is exactly the original stream's text.
  expect(first.text + textOf(resumed)).toBe(textOf(full));
  expect(first.text.length).toBeGreaterThan(0);
  expect(textOf(resumed).length).toBeGreaterThan(0);
  const stored = getMessages(convo.id).find((m) => m.id === done.message_id);
  expect(stored?.content).toBe(textOf(full));

  // Finished, within the window: the whole reply, then done, then close.
  const late = await lines(await req(`/${convo.id}/turn`));
  expect(late).toEqual([
    expect.objectContaining({ type: "resume", finished: true, text: textOf(full) }),
    { type: "done", message_id: done.message_id },
  ]);
});

test("stop ends the reply and keeps what streamed", async () => {
  const convo = createConversation(MEMBER);
  const res = await req(`/${convo.id}/messages`, {
    method: "POST",
    body: JSON.stringify({ content: "un deux trois quatre cinq six sept huit neuf dix onze douze" }),
  });
  const original = lines(res);
  await new Promise((r) => setTimeout(r, 100));
  const stop = await req(`/${convo.id}/turn/stop`, { method: "POST" });
  expect(stop.status).toBe(200);
  expect(await stop.json()).toEqual({ ok: true });

  const full = await original;
  const done = full[full.length - 1];
  expect(done.type).toBe("done");
  const stored = getMessages(convo.id).find((m) => m.id === done.message_id);
  expect(stored?.role).toBe("assistant");
  expect(stored?.content).toBe(textOf(full));
  // Stopped a third of the way through the echo: the tail never came.
  expect(textOf(full)).not.toContain("douze");
  expect(currentTurn(convo.id)?.snapshot.finished).toBe(true);
  expect((await req(`/${convo.id}/turn/stop`, { method: "POST" })).status).toBe(404);
});

test("regenerate is refused while a reply runs", async () => {
  const convo = createConversation(MEMBER);
  const res = await req(`/${convo.id}/messages`, {
    method: "POST",
    body: JSON.stringify({ content: "un deux trois quatre cinq six" }),
  });
  const original = lines(res);
  const regen = await req(`/${convo.id}/messages`, {
    method: "POST",
    body: JSON.stringify({ regenerate: true }),
  });
  expect(regen.status).toBe(409);
  await original;
});
