/**
 * The turn endpoint the Python tools use instead of an Anthropic client of
 * their own. It is loopback-only — the same test the admin dashboard uses —
 * and it refuses anything it cannot answer honestly rather than guessing.
 */

import { beforeAll, expect, test } from "bun:test";

const db = (await import("../src/db")).default;
const route = (await import("../src/routes/ancillary")).default;
const { ancillaryModel } = await import("../src/services/ancillary");

const LOCAL = { Host: "localhost", "Content-Type": "application/json" };

beforeAll(() => {
  db.run(`INSERT OR IGNORE INTO households (id, name) VALUES ('default', 'Home')`);
});

const post = (body: unknown, headers: Record<string, string> = LOCAL) =>
  route.request("/", { method: "POST", headers, body: JSON.stringify(body) });

test("a request that did not come from this machine is refused", async () => {
  const far = await post({ invocation: "moc_evocations", prompt: "hi" }, {
    ...LOCAL, Host: "aline.chezmaurice.eu",
  });
  expect(far.status).toBe(403);

  // And a tunnelled request is refused however local its Host claims to be.
  const tunnelled = await post({ invocation: "moc_evocations", prompt: "hi" }, {
    ...LOCAL, "cf-ray": "8a2f-CDG",
  });
  expect(tunnelled.status).toBe(403);
});

test("an invocation nobody has heard of is a bad request, not a turn", async () => {
  const res = await post({ invocation: "no_such_thing", prompt: "hi" });
  expect(res.status).toBe(400);
});

test("a turn needs something to write about", async () => {
  const res = await post({ invocation: "moc_evocations", prompt: "   " });
  expect(res.status).toBe(400);
});

test("a tool can ask what an invocation would run on", async () => {
  const res = await route.request("/moc_evocations", { headers: { Host: "localhost" } });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    invocation: "moc_evocations",
    model: ancillaryModel("moc_evocations"),
  });

  const unknown = await route.request("/no_such_thing", { headers: { Host: "localhost" } });
  expect(unknown.status).toBe(404);
});

test("a household with no key for the chosen model says so, and does not fall back", async () => {
  // No provider key at all: every backend refuses, and the route reports it
  // rather than quietly reaching for a vendor of its own.
  db.run(`UPDATE households SET api_key = NULL, openai_api_key = NULL, mistral_api_key = NULL,
          zai_api_key = NULL, scaleway_api_key = NULL WHERE id = 'default'`);
  const res = await post({ invocation: "moc_evocations", prompt: "a note about rivers" });
  expect(res.status).toBeGreaterThanOrEqual(400);
  const body = (await res.json()) as { error?: string };
  expect(body.error).toBeTruthy();
});

test("the socket has the last word: a forged local Host from another machine is refused", async () => {
  // What index.ts hands Hono as env: the Bun server, whose requestIP() names
  // the peer. A test harness has none, which is why the tests above pass on
  // the headers alone.
  const from = (address: string | null) => ({
    requestIP: () => (address ? { address, family: "IPv4", port: 51000 } : null),
  });
  const body = JSON.stringify({ invocation: "no_such_thing", prompt: "hi" });
  const ask = (env: unknown) => route.request("/", { method: "POST", headers: LOCAL, body }, env);

  // A LAN or tailnet client that sets Host: localhost — the server listens on
  // 0.0.0.0, so it reaches the port directly. Refused at the door.
  expect((await ask(from("192.168.1.20"))).status).toBe(403);
  // Caddy, from its own compose address, forwarding whatever Host it was sent.
  expect((await ask(from("172.18.0.3"))).status).toBe(403);
  // A server that cannot say where the socket came from cannot vouch either.
  expect((await ask(from(null))).status).toBe(403);
  // A genuine loopback socket passes the door, then fails on the body as it should.
  for (const address of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
    expect((await ask(from(address))).status).toBe(400);
  }
});
