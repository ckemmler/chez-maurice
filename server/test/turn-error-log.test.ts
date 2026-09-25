// A turn that fails says so in the log (25 September 2026). Until then a
// provider refusal reached the app as an `error` event and left nothing in
// api.log but the 200 of the POST: a household whose Z.ai key had been
// replaced answered 401 to everything, and only calling Z.ai by hand said why.

import { afterAll, beforeAll, expect, test } from "bun:test";

const db = (await import("../src/db")).default;
const { createConversation, addMessage } = await import("../src/services/conversations");
const { streamResponse } = await import("../src/services/claude");

const realFetch = globalThis.fetch;
const realError = console.error;
const logged: string[] = [];

beforeAll(() => {
  db.run(`INSERT OR IGNORE INTO households (id, name) VALUES ('default', 'Home')`);
  db.run(`UPDATE households SET default_model = 'glm-5.3-flash', zai_api_key = 'k-zai' WHERE id = 'default'`);
  db.run(`INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES ('te-anna', 'te-anna', 'Anna', 'standard')`);
  // Z.ai answers the way it did that day; nothing leaves the machine.
  globalThis.fetch = (async (input: any) => {
    const url = String(input?.url ?? input);
    if (url.includes("api.z.ai")) {
      return new Response(JSON.stringify({ error: { code: "401", message: "token expired or incorrect" } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as typeof fetch;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
});

afterAll(() => {
  globalThis.fetch = realFetch;
  console.error = realError;
});

test("a provider's refusal is logged with the conversation, provider and model", async () => {
  const convo = createConversation("te-anna");
  addMessage(convo.id, "user", "Bonjour", { authorId: "te-anna" });
  const events = [];
  for await (const ev of streamResponse(convo.id, "Anna")) events.push(ev);

  const error = events.find((e) => e.type === "error");
  expect(error?.message).toContain("401");
  const line = logged.find((l) => l.startsWith("[turn-error]"));
  expect(line).toBeDefined();
  const entry = JSON.parse(line!.slice("[turn-error] ".length));
  expect(entry).toMatchObject({ convo: convo.id, provider: "zai", model: "glm-5.3-flash" });
  expect(entry.message).toContain("token expired or incorrect");
});
