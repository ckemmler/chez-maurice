// Working notes held back (6 October 2026). DeepSeek V4 Flash on Scaleway,
// told to answer without reasoning, thinks aloud instead: a line before each
// tool call ("Let me look at…"), as content, which the member read at the top
// of the answer. A round's text is now held until the round says what it was.
// The provider is played here by a fake Scaleway: nothing leaves the machine.

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";

const db = (await import("../src/db")).default;
const { createConversation, addMessage } = await import("../src/services/conversations");
const { streamResponse } = await import("../src/services/claude");

const realFetch = globalThis.fetch;
let requests: any[] = [];

function sse(lines: string[]): Response {
  return new Response(lines.map((l) => `data: ${l}\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}
const delta = (d: unknown) => JSON.stringify({ choices: [{ delta: d }] });
const notesThenTool = [
  delta({ content: "Let me look at the context " }),
  delta({ content: "around this." }),
  delta({ tool_calls: [{ index: 0, id: "c1", function: { name: "garden__nothing", arguments: "{}" } }] }),
  "[DONE]",
];
const answer = [delta({ content: "Voici où " }), delta({ content: "tu en étais." }), "[DONE]"];

beforeAll(() => {
  db.run(`INSERT OR IGNORE INTO households (id, name) VALUES ('default', 'Home')`);
  db.run(`UPDATE households SET default_model = 'deepseek-v4-flash-0731', scaleway_api_key = 'k-scw' WHERE id = 'default'`);
  db.run(`INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES ('hwn-anna', 'hwn-anna', 'Anna', 'standard')`);
  // One round of notes and a tool call, then the answer.
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input?.url ?? input);
    if (!url.includes("api.scaleway.ai")) throw new Error(`unexpected fetch in test: ${url}`);
    requests.push(JSON.parse(init.body));
    return sse(requests.length === 1 ? notesThenTool : answer);
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  db.run(`UPDATE households SET everyday_thinking = 0 WHERE id = 'default'`);
});

beforeEach(() => { requests = []; });

async function turn() {
  const convo = createConversation("hwn-anna");
  addMessage(convo.id, "user", "Où en étais-je ?", { authorId: "hwn-anna" });
  const events: any[] = [];
  for await (const ev of streamResponse(convo.id, "Anna")) events.push(ev);
  return { events, deltas: events.filter((e) => e.type === "text_delta").map((e) => e.text as string) };
}

test("answering directly: the notes before a tool call are not shown, the answer comes in one piece", async () => {
  db.run(`UPDATE households SET everyday_thinking = 0 WHERE id = 'default'`);
  const { events, deltas } = await turn();

  expect(requests[0].reasoning_effort).toBe("none");
  expect(deltas).toEqual(["Voici où tu en étais."]);
  // The member is shown that something is happening while the text is held.
  expect(events.some((e) => e.type === "thinking")).toBe(true);
  // The model keeps its own notes: they are part of what it said.
  expect(requests[1].messages.find((m: any) => m.role === "assistant" && m.tool_calls)?.content).toBe("Let me look at the context around this.");
  expect(events.at(-1)?.type).toBe("done");
});

test("no recorded choice: nothing is asked of the provider and the text streams as it comes", async () => {
  db.run(`UPDATE households SET everyday_thinking = NULL WHERE id = 'default'`);
  const { deltas } = await turn();

  expect(requests[0].reasoning_effort).toBeUndefined();
  expect(deltas).toEqual(["Let me look at the context ", "around this.", "Voici où ", "tu en étais."]);
});
