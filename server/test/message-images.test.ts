/**
 * A message carries several photos: POST /:id/messages takes `images` (an array
 * of data URIs) beside the single `image` older clients send, saves each one,
 * and leads the stored message with one markdown line per photo.
 */
import { beforeAll, expect, test } from "bun:test";

const db = (await import("../src/db")).default;
const routes = (await import("../src/routes/conversations")).default;
const { createSession } = await import("../src/services/auth");
const { createConversation, getMessages } = await import("../src/services/conversations");

const MEMBER = "images-member";
let auth = "";

// A 1×1 PNG.
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

beforeAll(() => {
  db.run(`INSERT OR IGNORE INTO households (id, name) VALUES ('default', 'Home')`);
  db.run(
    `INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES (?, ?, ?, 'admin')`,
    [MEMBER, "imagesmember", "Images member"],
  );
  auth = `Bearer ${createSession(MEMBER).token}`;
});

// summon: false — a human-only turn, so no reply is started.
const post = (convoId: string, body: object) =>
  routes.request(`/${convoId}/messages`, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify({ summon: false, ...body }),
  });

const imageLines = (content: string) => content.match(/!\[photo\]\(\/api\/images\/[^)]+\)/g) ?? [];

test("several images: each saved, one markdown line apiece, before the text", async () => {
  const convo = createConversation(MEMBER);
  const res = await post(convo.id, { content: "Lesquelles garder ?", images: [PNG, PNG, PNG] });
  expect(res.status).toBe(200);
  const stored = getMessages(convo.id).at(-1)!;
  const lines = imageLines(stored.content);
  expect(lines.length).toBe(3);
  expect(new Set(lines).size).toBe(3);
  expect(stored.content.endsWith("\n\nLesquelles garder ?")).toBe(true);
});

test("images alone are a message", async () => {
  const convo = createConversation(MEMBER);
  expect((await post(convo.id, { images: [PNG, PNG] })).status).toBe(200);
  expect(imageLines(getMessages(convo.id).at(-1)!.content).length).toBe(2);
});

test("the single `image` of older clients still works", async () => {
  const convo = createConversation(MEMBER);
  expect((await post(convo.id, { content: "Et celle-ci", image: PNG })).status).toBe(200);
  expect(imageLines(getMessages(convo.id).at(-1)!.content).length).toBe(1);
});

test("more than ten images is refused, and nothing is stored", async () => {
  const convo = createConversation(MEMBER);
  const res = await post(convo.id, { images: Array(11).fill(PNG) });
  expect(res.status).toBe(400);
  expect(getMessages(convo.id).length).toBe(0);
});

test("an empty list with no text is still empty", async () => {
  const convo = createConversation(MEMBER);
  expect((await post(convo.id, { images: [] })).status).toBe(400);
});
