/**
 * A conversation Maurice opens on his own (services/openedConversations.ts,
 * the admin route, and what the list and the unread count say of it). What is
 * nailed down: the row is his (opened_by, a first assistant message, a
 * title), it is unread until the member opens it and counts as such on the
 * foyer badge, the member's socket is told and a member without a socket is
 * pushed; the guard refuses a child, a guest, a stranger, and a second
 * opening within the household's days (fifteen unless the console says
 * otherwise) — and only the admin's `force` walks past it; the history sent
 * to a provider never starts with an assistant turn; and after the member
 * replies, the thread is an ordinary conversation.
 */
import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";

const db = (await import("../src/db")).default;
const opened = await import("../src/services/openedConversations");
const { listConversations, unreadRoomCount, markConversationRead, getMessages } = await import("../src/services/conversations");
const { setRoomPublisher, setSubscriberCount } = await import("../src/services/roomBus");
const { createSession } = await import("../src/services/auth");
const { setUserChild } = await import("../src/services/users");
const admin = (await import("../src/routes/admin")).default;
const conversations = (await import("../src/routes/conversations")).default;
const { _resetTurns } = await import("../src/services/turns");

const ANNA = "opened-anna";
const KID = "opened-kid";
const GUEST = "opened-guest";
const BOSS = "opened-admin";

let events: Array<{ topic: string; event: any }> = [];
let sockets = new Set<string>();

beforeAll(() => {
  db.run(`INSERT OR IGNORE INTO households (id, name) VALUES ('default', 'Home')`);
  // Echo mode for the reply test: no key anywhere.
  db.run(`UPDATE households SET api_key = NULL, openai_api_key = NULL, mistral_api_key = NULL,
          zai_api_key = NULL, scaleway_api_key = NULL, default_model = 'claude-sonnet-4-6' WHERE id = 'default'`);
  for (const [id, name, role] of [[ANNA, "Anna", "standard"], [KID, "Kid", "standard"], [GUEST, "Gus", "guest"], [BOSS, "Boss", "admin"]] as const) {
    db.run(`INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES (?, ?, ?, ?)`, [id, id, name, role]);
  }
  setUserChild(KID, true);
  setRoomPublisher((topic, data) => events.push({ topic, event: JSON.parse(data) }));
  setSubscriberCount((topic) => (sockets.has(topic) ? 1 : 0));
});

afterAll(() => _resetTurns());

beforeEach(() => {
  events = [];
  sockets = new Set();
  db.run(`DELETE FROM conversations WHERE user_id IN (?, ?, ?, ?)`, [ANNA, KID, GUEST, BOSS]);
  db.run(`DELETE FROM device_tokens WHERE user_id IN (?, ?, ?, ?)`, [ANNA, KID, GUEST, BOSS]);
  opened.setOpensMinDays(null);
});

const userEvents = (id: string) => events.filter((e) => e.topic === `user:${id}`).map((e) => e.event);

test("opens a conversation in Maurice's voice: his row, his first message, unread until opened", async () => {
  sockets.add(`user:${ANNA}`);
  const r = await opened.openConversation({ memberId: ANNA, text: "# Trois domaines\n\nJ'ai relu nos conversations…" });
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.conversation.opened_by).toBe("maurice");
  expect(r.conversation.title).toBe("Trois domaines");
  expect(r.message.role).toBe("assistant");
  expect(r.message.author_id).toBeNull();
  expect(r.message.usage).toBeNull();

  const list = listConversations(ANNA);
  expect(list.map((c) => c.id)).toEqual([r.conversation.id]);
  expect(list[0]!.unread).toBe(true);
  expect(list[0]!.has_everyday_maurice).toBe(true);
  expect(unreadRoomCount(ANNA)).toBe(1);

  // The socket was told, the way a room tells its members; no push while a socket is live.
  const ev = userEvents(ANNA);
  expect(ev).toHaveLength(1);
  expect(ev[0]).toMatchObject({ type: "conversation_opened", conversationId: r.conversation.id, title: "Trois domaines", author: "Maurice" });
  expect(ev[0].preview).toContain("Trois domaines");

  // Opening it reads it.
  markConversationRead(ANNA, r.conversation.id);
  expect(listConversations(ANNA)[0]!.unread).toBe(false);
  expect(unreadRoomCount(ANNA)).toBe(0);
});

test("a given title wins; a member's own conversations are not unread", async () => {
  const r = await opened.openConversation({ memberId: ANNA, text: "Bonjour.", title: "Un mot de Maurice" });
  expect(r.ok && r.conversation.title).toBe("Un mot de Maurice");
  const { createConversation, addMessage } = await import("../src/services/conversations");
  const mine = createConversation(ANNA);
  addMessage(mine.id, "user", "hello", { authorId: ANNA });
  addMessage(mine.id, "assistant", "hi");
  const rows = listConversations(ANNA);
  expect(rows.find((c) => c.id === mine.id)!.opened_by).toBe("member");
  expect(rows.find((c) => c.id === mine.id)!.unread).toBe(false);
  expect(unreadRoomCount(ANNA)).toBe(1);
});

test("the guard: never a child, never a guest, never a stranger, never twice within the household's days", async () => {
  expect(opened.openingGuard(KID)).toMatchObject({ ok: false, reason: "child" });
  expect(opened.openingGuard(GUEST)).toMatchObject({ ok: false, reason: "guest" });
  expect(opened.openingGuard("nobody")).toMatchObject({ ok: false, reason: "unknown" });
  expect((await opened.openConversation({ memberId: KID, text: "x" })).ok).toBe(false);
  expect((await opened.openConversation({ memberId: KID, text: "x", force: true })).ok).toBe(true);
  expect((await opened.openConversation({ memberId: "nobody", text: "x", force: true })).ok).toBe(false);
  expect((await opened.openConversation({ memberId: ANNA, text: "   " })).ok).toBe(false);

  const first = await opened.openConversation({ memberId: ANNA, text: "first" });
  expect(first.ok).toBe(true);
  const second = await opened.openConversation({ memberId: ANNA, text: "second" });
  expect(second.ok).toBe(false);
  if (second.ok) return;
  expect(second.reason).toBe("too_soon");
  expect(second.next_at).toBeTruthy();
  const days = (Date.parse(second.next_at!) - Date.now()) / 86_400_000;
  expect(days).toBeGreaterThan(14.9);
  expect(days).toBeLessThan(15.1);
  // Force walks past it — the admin's hand, not the night's.
  expect((await opened.openConversation({ memberId: ANNA, text: "second", force: true })).ok).toBe(true);
});

test("the guard is the household's: fewer days, or an old opening, lets the next one through", async () => {
  const first = await opened.openConversation({ memberId: ANNA, text: "first" });
  expect(first.ok).toBe(true);
  opened.setOpensMinDays(1);
  expect(opened.opensMinDays()).toBe(1);
  expect((await opened.openConversation({ memberId: ANNA, text: "second" })).ok).toBe(false);
  db.run(`UPDATE conversations SET created_at = datetime('now', '-2 days') WHERE user_id = ?`, [ANNA]);
  expect(opened.openingGuard(ANNA).ok).toBe(true);
  opened.setOpensMinDays(null);
  expect(opened.opensMinDays()).toBe(15);
  expect(opened.openingGuard(ANNA)).toMatchObject({ ok: false, reason: "too_soon" });
  db.run(`UPDATE conversations SET created_at = datetime('now', '-16 days') WHERE user_id = ?`, [ANNA]);
  expect(opened.openingGuard(ANNA).ok).toBe(true);
});

test("a member with no socket is pushed", async () => {
  db.run(`INSERT INTO device_tokens (token, user_id, platform, household_tag) VALUES (?, ?, 'ios', 'home')`, ["tok-" + ANNA, ANNA]);
  const apns = await import("../src/services/apns");
  const sent: any[] = [];
  const spy = spyOn(apns, "sendApns").mockImplementation(async (token: string, payload: any) => { sent.push({ token, payload }); return { status: 200 } as any; });
  try {
    const r = await opened.openConversation({ memberId: ANNA, text: "Un mot pour toi.", title: "Maurice" });
    expect(r.ok).toBe(true);
    // pushToUser is fire-and-forget; let it run.
    await new Promise((res) => setTimeout(res, 20));
    expect(sent).toHaveLength(1);
    expect(sent[0].payload).toMatchObject({ title: "Maurice", body: "Maurice: Un mot pour toi.", conversationId: r.ok ? r.conversation.id : "" });
  } finally {
    spy.mockRestore();
  }
});

test("the history a provider sees starts with a user turn", () => {
  const lead = { role: "user", content: [{ type: "text", text: opened.OPENER_LEAD }] };
  const opener = { role: "assistant", content: [{ type: "text", text: "Bonjour." }] };
  const reply = { role: "user", content: [{ type: "text", text: "Salut." }] };
  expect(opened.ensureUserFirst([opener, reply])).toEqual([lead, opener, reply]);
  expect(opened.ensureUserFirst([reply, opener])).toEqual([reply, opener]);
  expect(opened.ensureUserFirst([])).toEqual([]);
});

test("titleFrom and preview", () => {
  expect(opened.titleFrom("\n\n## **Trois** domaines\nsuite")).toBe("Trois domaines");
  expect(opened.titleFrom("   ")).toBe("Maurice");
  expect(opened.titleFrom("x".repeat(100))).toHaveLength(80);
  expect(opened.preview("![photo](/api/images/a.png)\n\nBonjour   toi")).toBe("Bonjour toi");
});

// ── The admin route ──────────────────────────────────────────────────────────

const call = (who: string, body: unknown) =>
  admin.request("/conversations/open", {
    method: "POST",
    headers: { Authorization: `Bearer ${createSession(who).token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

test("POST /api/admin/conversations/open: admin only, by username or id, guard → 409, dry run", async () => {
  expect((await call(ANNA, { username: ANNA, text: "x" })).status).toBe(403);
  expect((await call(BOSS, { username: "nobody", text: "x" })).status).toBe(404);
  expect((await call(BOSS, { username: ANNA })).status).toBe(400);
  expect((await call(BOSS, { username: ANNA, text: "x", maurice_id: "no-such-domain" })).status).toBe(404);

  const dry = await call(BOSS, { username: ANNA, dry_run: true });
  expect(dry.status).toBe(200);
  expect(await dry.json()).toMatchObject({ member_id: ANNA, guard: { ok: true } });

  const res = await call(BOSS, { username: ANNA, text: "Bonjour Anna.", title: "Un mot" });
  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body.conversation).toMatchObject({ user_id: ANNA, opened_by: "maurice", title: "Un mot" });
  expect(body.message).toMatchObject({ role: "assistant", content: "Bonjour Anna." });

  const again = await call(BOSS, { member_id: ANNA, text: "Encore." });
  expect(again.status).toBe(409);
  expect(await again.json()).toMatchObject({ reason: "too_soon" });
  expect((await call(BOSS, { member_id: KID, text: "x" })).status).toBe(409);
  expect((await call(BOSS, { member_id: ANNA, text: "Encore.", force: true })).status).toBe(201);
});

// ── The next turn is an ordinary one ────────────────────────────────────────

test("the member replies and Maurice answers as in any conversation (echo mode)", async () => {
  const r = await opened.openConversation({ memberId: ANNA, text: "Bonjour Anna, trois domaines…", title: "Trois domaines" });
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  const auth = `Bearer ${createSession(ANNA).token}`;
  const res = await conversations.request(`/${r.conversation.id}/messages`, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify({ content: "Oui, raconte." }),
  });
  expect(res.status).toBe(200);
  const text = await res.text();
  const events = text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  expect(events.some((e) => e.type === "done")).toBe(true);
  const msgs = getMessages(r.conversation.id);
  expect(msgs.map((m) => m.role)).toEqual(["assistant", "user", "assistant"]);
  expect(msgs[1]!.author_id).toBe(ANNA);
  // The title Maurice gave stays: autoTitle only fills an empty one.
  expect(listConversations(ANNA)[0]!.title).toBe("Trois domaines");
});
