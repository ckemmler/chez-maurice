// Pictures in an ancillary turn, and a turn made for a member (7 October
// 2026). The mail tool reads a scanned attachment by asking the server for a
// turn on a model that reads images; the member who asked is the one charged,
// under their own caps. The provider is played by a fake Scaleway.

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";

const db = (await import("../src/db")).default;
const route = (await import("../src/routes/ancillary")).default;
const { ancillaryModel, isAncillaryInvocation, setPinnedModel, recommendedModel } = await import("../src/services/ancillary");

const LOCAL = { Host: "localhost", "Content-Type": "application/json" };
const PIXEL = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAEBAQ==";
const realFetch = globalThis.fetch;
let requests: any[] = [];

beforeAll(() => {
  db.run(`INSERT OR IGNORE INTO households (id, name) VALUES ('default', 'Home')`);
  db.run(`UPDATE households SET scaleway_api_key = 'k-scw' WHERE id = 'default'`);
  db.run(`INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES ('av-lea', 'av-lea', 'Léa', 'standard')`);
  // What the server does at start for an invocation it has not met: pin it
  // to its advice.
  setPinnedModel("attachment_vision", recommendedModel("attachment_vision"), "auto");
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input?.url ?? input);
    if (!url.includes("api.scaleway.ai")) throw new Error(`unexpected fetch in test: ${url}`);
    requests.push(JSON.parse(init.body));
    const lines = [
      JSON.stringify({ choices: [{ delta: { content: "Compte rendu de l’atelier" } }] }),
      JSON.stringify({ choices: [], usage: { prompt_tokens: 353, completion_tokens: 900 } }),
      "[DONE]",
    ];
    return new Response(lines.map((l) => `data: ${l}\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  db.run(`DELETE FROM spend_ledger WHERE user_id = 'av-lea'`);
  db.run(`UPDATE users SET spend_cap_daily_usd = NULL WHERE id = 'av-lea'`);
});

beforeEach(() => { requests = []; });

const post = (body: unknown) => route.request("/", { method: "POST", headers: LOCAL, body: JSON.stringify(body) });
const page = { media_type: "image/jpeg", data: PIXEL };
const spent = () => (db.query(`SELECT COUNT(*) n, COALESCE(SUM(cost_usd), 0) eur FROM spend_ledger WHERE user_id = 'av-lea'`).get() as { n: number; eur: number });

test("the invocation exists and resolves to a model that reads images", () => {
  expect(isAncillaryInvocation("attachment_vision")).toBe(true);
  expect(recommendedModel("attachment_vision")).toBe("gemma-4-26b-a4b-it");
  const model = ancillaryModel("attachment_vision");
  expect((db.query(`SELECT vision FROM models WHERE id = ?`).get(model) as any)?.vision).toBe(1);
});

test("a picture reaches the provider beside the prompt, and the member is charged", async () => {
  const before = spent();
  const res = await post({ invocation: "attachment_vision", prompt: "Transcribe this page.", images: [page], member_id: "av-lea" });
  expect(res.status).toBe(200);
  expect((await res.json()).text).toBe("Compte rendu de l’atelier");

  const content = requests[0].messages.at(-1).content;
  expect(content[0]).toEqual({ type: "text", text: "Transcribe this page." });
  expect(content[1]).toEqual({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${PIXEL}` } });

  const after = spent();
  expect(after.n).toBe(before.n + 1);
  expect(after.eur).toBeGreaterThan(before.eur);
});

test("a turn made for nobody is the household's, as before: nothing under a member's name", async () => {
  const before = spent();
  expect((await post({ invocation: "attachment_vision", prompt: "Transcribe.", images: [page] })).status).toBe(200);
  expect(spent().n).toBe(before.n);
});

test("a model that does not read images is refused, not shown nothing", async () => {
  const res = await post({ invocation: "attachment_vision", prompt: "Transcribe.", images: [page], model: "deepseek-v4-flash-0731" });
  expect(res.status).toBe(422);
  expect((await res.json()).error).toContain("does not read images");
  expect(requests.length).toBe(0);
});

test("what is not a picture, or too many, is a bad request", async () => {
  expect((await post({ invocation: "attachment_vision", prompt: "x", images: [{ media_type: "application/pdf", data: PIXEL }] })).status).toBe(400);
  expect((await post({ invocation: "attachment_vision", prompt: "x", images: [{ media_type: "image/jpeg" }] })).status).toBe(400);
  expect((await post({ invocation: "attachment_vision", prompt: "x", images: Array(5).fill(page) })).status).toBe(400);
  expect((await post({ invocation: "attachment_vision", prompt: "x", images: [page], member_id: "nobody" })).status).toBe(400);
  expect(requests.length).toBe(0);
});

test("a member at their cap is refused before anything is spent", async () => {
  db.run(`UPDATE users SET spend_cap_daily_usd = 0.000001 WHERE id = 'av-lea'`);
  const res = await post({ invocation: "attachment_vision", prompt: "Transcribe.", images: [page], member_id: "av-lea" });
  expect(res.status).toBe(402);
  expect(requests.length).toBe(0);
  db.run(`UPDATE users SET spend_cap_daily_usd = NULL WHERE id = 'av-lea'`);
});
