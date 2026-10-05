// A provider that lives outside the repository (services/providerPlugins.ts).
// What is nailed down here is the boundary: who sees its models, who reaches
// it, and that a turn it cannot take is said rather than sent elsewhere.

import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const db = (await import("../src/db")).default;
const { createConversation, addMessage } = await import("../src/services/conversations");
const { streamResponse } = await import("../src/services/claude");
const { loadProviderPlugins } = await import("../src/services/providerPluginLoader");
const { _resetProviderPlugins, isUnmetered } = await import("../src/services/providerPlugins");
const { availableModelsForUser, setAccess, setEverydayModel } = await import("../src/services/modelAccess");
const { ancillaryProviders, configuredProviders, addModel } = await import("../src/services/models");
const { verdict } = await import("../src/services/budget");
const { createSession } = await import("../src/services/auth");
const webAdmin = (await import("../src/routes/web-admin")).default;

const ADMIN = "pp-admin";
const ANNA = "pp-anna";
const MODEL = "fake-plugin-model";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maurice-plugin-"));
const realFetch = globalThis.fetch;

// The plugin records who it was called for in a global, since it is loaded
// from a file of its own and shares nothing else with this suite.
const calls = ((globalThis as any).__fakePluginCalls = [] as Array<{ memberId: string; system: string; last: string }>);

beforeAll(async () => {
  db.run(`INSERT OR IGNORE INTO households (id, name) VALUES ('default', 'Home')`);
  db.run(`UPDATE households SET default_model = 'glm-5.3-flash', zai_api_key = 'k-zai' WHERE id = 'default'`);
  db.run(`INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES (?, ?, 'Admin', 'admin')`, [ADMIN, ADMIN]);
  db.run(`INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES (?, ?, 'Anna', 'standard')`, [ANNA, ANNA]);
  // Nothing leaves the machine: a turn that slips past the plugin fails loudly.
  globalThis.fetch = (async (input: any) => {
    const url = String(input?.url ?? input);
    if (url.includes("api.z.ai")) return new Response("{}", { status: 401 });
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as typeof fetch;

  const file = path.join(dir, "fake.ts");
  fs.writeFileSync(
    file,
    `export default (host) => {
       host.addModel({ id: "${MODEL}", name: "Fake", tier: "cloud", vendor: "Fake", provider: "fake", ctx: 100 });
       return {
         provider: "fake",
         metered: false,
         configured: () => !globalThis.__fakePluginOff,
         admin: (req, path) => new Response("fake admin:" + req.method + ":" + path),
         async *turn(t) {
           globalThis.__fakePluginCalls.push({ memberId: t.memberId, system: t.system, last: t.messages.at(-2)?.content ?? "" });
           if (t.messages.some((m) => m.content.includes("boom"))) { yield { type: "error", message: "not signed in" }; return; }
           yield { type: "text", text: "bonjour " };
           yield { type: "text", text: "Anna" };
           yield { type: "usage", input: 12, output: 3 };
         },
       };
     };`,
  );
  expect(await loadProviderPlugins(file)).toEqual(["fake"]);
});

afterAll(() => {
  globalThis.fetch = realFetch;
  _resetProviderPlugins();
  delete (globalThis as any).__fakePluginOff;
  fs.rmSync(dir, { recursive: true, force: true });
});

async function turn(memberId: string, text: string) {
  const convo = createConversation(memberId);
  addMessage(convo.id, "user", text, { authorId: memberId });
  const events: any[] = [];
  for await (const ev of streamResponse(convo.id, "X", null, memberId)) events.push(ev);
  return events;
}

test("nothing is loaded unless a plugin is named", async () => {
  expect(await loadProviderPlugins("")).toEqual([]);
});

test("an admin sees the plugin's model; a standard member only once granted", () => {
  expect(availableModelsForUser(ADMIN).map((m) => m.id)).toContain(MODEL);
  expect(availableModelsForUser(ANNA).map((m) => m.id)).not.toContain(MODEL);
  // And cannot choose it for themselves.
  expect(setEverydayModel(ANNA, MODEL)).toBe(false);
});

test("a member without the grant never reaches the plugin, even with the model stored on them", async () => {
  db.run(`UPDATE users SET everyday_model = ? WHERE id = ?`, [MODEL, ANNA]);
  calls.length = 0;
  await turn(ANNA, "Bonjour");
  expect(calls).toEqual([]);
  db.run(`UPDATE users SET everyday_model = NULL WHERE id = ?`, [ANNA]);
});

test("a granted turn streams the plugin's text, for that member, without tools, at no cost", async () => {
  setAccess(ANNA, MODEL, true);
  expect(setEverydayModel(ANNA, MODEL)).toBe(true);
  calls.length = 0;
  const events = await turn(ANNA, "Bonjour");
  expect(events.filter((e) => e.type === "text_delta").map((e) => e.text).join("")).toBe("bonjour Anna");
  expect(events.at(-1)?.type).toBe("done");
  expect(events.find((e) => e.type === "usage")?.usage).toMatchObject({ provider: "fake", input: 12, output: 3, cost: 0 });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ memberId: ANNA, last: "Bonjour" });
  expect(calls[0]!.system).toContain("You have no tools this turn");
});

test("a plugin's error ends the turn as an error — no other provider answers", async () => {
  const events = await turn(ANNA, "boom");
  expect(events.map((e) => e.type)).toEqual(["error"]);
  expect(events[0].message).toBe("not signed in");
});

test("a model whose provider nothing answers for is refused, not sent to Anthropic", async () => {
  addModel({ id: "orphan-model", name: "Orphan", tier: "cloud", provider: "gone" });
  setEverydayModel(ADMIN, "orphan-model");
  const events = await turn(ADMIN, "Bonjour");
  expect(events.map((e) => e.type)).toEqual(["error"]);
  expect(events[0].message).toContain("gone");
  setEverydayModel(ADMIN, null);
});

test("an unmetered plugin is free of the spending caps, and out of the ancillary range", () => {
  expect(isUnmetered("fake")).toBe(true);
  process.env.MAURICE_SPEND_CAP_USD = "0.01";
  try {
    expect(verdict("fake", MODEL, 0, ANNA).ok).toBe(true);
  } finally {
    delete process.env.MAURICE_SPEND_CAP_USD;
  }
  expect(configuredProviders().has("fake")).toBe(true);
  expect(ancillaryProviders().has("fake")).toBe(false);
});

test("switched off, the plugin's models leave the rosters", () => {
  (globalThis as any).__fakePluginOff = true;
  expect(availableModelsForUser(ADMIN).map((m) => m.id)).not.toContain(MODEL);
  delete (globalThis as any).__fakePluginOff;
});

test("the plugin's admin page sits behind the admin session, for admins only", async () => {
  const local = { host: "localhost" };
  const anonymous = await webAdmin.request("/x/fake/", { headers: local });
  expect(anonymous.status).toBe(302);
  expect(anonymous.headers.get("location")).toBe("/admin/login");

  const member = await webAdmin.request("/x/fake/", { headers: { ...local, cookie: `maurice_admin=${createSession(ANNA).token}` } });
  expect(member.status).toBe(302);

  const cookie = `maurice_admin=${createSession(ADMIN).token}`;
  const page = await webAdmin.request("/x/fake/", { headers: { ...local, cookie } });
  expect(await page.text()).toBe("fake admin:GET:");
  const post = await webAdmin.request("/x/fake/stop", { method: "POST", headers: { ...local, cookie } });
  expect(await post.text()).toBe("fake admin:POST:stop");

  // Not from this machine: refused before any session is looked at.
  const remote = await webAdmin.request("/x/fake/", { headers: { host: "maurice.example", cookie } });
  expect(remote.status).toBe(403);
  // And a provider with no plugin behind it is simply not there.
  expect((await webAdmin.request("/x/nobody/", { headers: { ...local, cookie } })).status).toBe(404);
});
