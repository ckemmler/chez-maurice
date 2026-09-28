// The round after the last tool round (27 September 2026). A turn that spent
// its six tool rounds used to end on "stopped after several tool steps" with
// everything it had found thrown away; it now gets one round more, told the
// tools are done and refused them, to answer from what it holds. The provider
// is played here by a fake Scaleway: nothing leaves the machine.

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";

const db = (await import("../src/db")).default;
const { createConversation, addMessage } = await import("../src/services/conversations");
const { streamResponse, answerOnlyBody, LAST_ROUND_NOTICE, MAX_TOOL_ROUNDS } = await import("../src/services/claude");

const realFetch = globalThis.fetch;
const realWarn = console.warn;
const warned: string[] = [];

/** What the fake provider does once it is asked to answer only. */
let onAnswerRound: "answer" | "ask-again" | "refuse" = "answer";
let requests: any[] = [];

function sse(lines: string[]): Response {
  return new Response(lines.map((l) => `data: ${l}\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

const toolCall = (n: number) => [
  JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `c${n}`, function: { name: "garden__nothing", arguments: "{}" } }] } }] }),
  "[DONE]",
];
const answer = [JSON.stringify({ choices: [{ delta: { content: "Voici où tu en étais." } }] }), "[DONE]"];

beforeAll(() => {
  db.run(`INSERT OR IGNORE INTO households (id, name) VALUES ('default', 'Home')`);
  db.run(`UPDATE households SET default_model = 'deepseek-v4-flash-0731', scaleway_api_key = 'k-scw' WHERE id = 'default'`);
  db.run(`INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES ('ltr-anna', 'ltr-anna', 'Anna', 'standard')`);
  // A model that never stops looking things up, until it is told to.
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input?.url ?? input);
    if (!url.includes("api.scaleway.ai")) throw new Error(`unexpected fetch in test: ${url}`);
    const body = JSON.parse(init.body);
    requests.push(body);
    if (body.tool_choice !== "none") return sse(toolCall(requests.length));
    if (onAnswerRound === "refuse") {
      return new Response(JSON.stringify({ message: "tool_choice not supported" }), { status: 400 });
    }
    return sse(onAnswerRound === "answer" ? answer : toolCall(requests.length));
  }) as typeof fetch;
  console.warn = (...args: unknown[]) => { warned.push(args.map(String).join(" ")); };
});

afterAll(() => {
  globalThis.fetch = realFetch;
  console.warn = realWarn;
});

beforeEach(() => {
  requests = [];
  warned.length = 0;
});

async function turn() {
  const convo = createConversation("ltr-anna");
  addMessage(convo.id, "user", "Je voudrais reprendre la respiration buteyko", { authorId: "ltr-anna" });
  const events: any[] = [];
  for await (const ev of streamResponse(convo.id, "Anna")) events.push(ev);
  const text = events.filter((e) => e.type === "text_delta").map((e) => e.text).join("");
  const ran = events.filter((e) => e.type === "tool_call" && e.status === "start").length;
  return { events, text, ran };
}

test("the turn that spends its tool rounds answers from what it found", async () => {
  onAnswerRound = "answer";
  const { events, text, ran } = await turn();

  expect(ran).toBe(MAX_TOOL_ROUNDS);
  expect(requests.length).toBe(MAX_TOOL_ROUNDS + 1);
  expect(text).toBe("Voici où tu en étais.");
  expect(events.at(-1)?.type).toBe("done");
  expect(events.some((e) => e.type === "error")).toBe(false);

  const last = requests.at(-1);
  // Refused the tools, but still sent them: they head the cached prefix.
  expect(last.tool_choice).toBe("none");
  expect(last.tools.length).toBeGreaterThan(0);
  // Told why, with the results of the last round it ran.
  expect(last.messages.at(-1).role).toBe("tool");
  expect(last.messages.at(-1).content).toContain(LAST_ROUND_NOTICE);
  // Only there: the rounds before it were not warned.
  expect(requests[MAX_TOOL_ROUNDS - 1].messages.some((m: any) => String(m.content ?? "").includes(LAST_ROUND_NOTICE))).toBe(false);

  expect(warned.some((l) => l.startsWith("[tool-cap]"))).toBe(true);
});

test("a model that asks for a tool anyway gets none run, and the old line", async () => {
  onAnswerRound = "ask-again";
  const { text, ran, events } = await turn();

  expect(ran).toBe(MAX_TOOL_ROUNDS);
  expect(requests.length).toBe(MAX_TOOL_ROUNDS + 1);
  expect(text).toContain("Stopped after several tool steps");
  expect(events.at(-1)?.type).toBe("done");
});

test("a provider that refuses the answer round leaves the old line, not an error", async () => {
  onAnswerRound = "refuse";
  const { text, events } = await turn();

  expect(events.some((e) => e.type === "error")).toBe(false);
  expect(text).toContain("Stopped after several tool steps");
  expect(events.at(-1)?.type).toBe("done");
});

test("Z.ai, which documents only tool_choice auto, is not sent none", () => {
  expect(answerOnlyBody("zai")).toEqual({});
  expect(answerOnlyBody("scaleway")).toEqual({ tool_choice: "none" });
  expect(answerOnlyBody("mistral")).toEqual({ tool_choice: "none" });
});
