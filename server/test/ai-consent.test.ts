/**
 * Consent to send a member's data to AI providers (services/aiConsent.ts):
 * what the apps are told to ask, what a yes covers, and that a no is held by
 * the server — not only by the app that asked.
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { MEMBER } from "./_member";

const db = (await import("../src/db")).default;
const me = (await import("../src/routes/me")).default;
const dictation = (await import("../src/routes/dictation")).default;
const { createSession } = await import("../src/services/auth");
const { aiAllowed, embeddingProvider, setConsent, uncovered } = await import("../src/services/aiConsent");
const { ancillaryComplete, AncillaryError } = await import("../src/services/ancillary");

const auth = { Authorization: `Bearer ${createSession(MEMBER.id).token}`, "Content-Type": "application/json" };

beforeAll(() => {
  db.run(`INSERT OR IGNORE INTO models (id, name, tier, provider) VALUES ('consent-test-model', 'Consent test', 'cloud', 'scaleway')`);
});

afterEach(() => {
  db.run(`DELETE FROM ai_consent WHERE user_id = ?`, [MEMBER.id]);
  db.run(`UPDATE households SET scaleway_api_key = NULL WHERE id = 'default'`);
  delete process.env.MAURICE_DICTATION_ENGINE;
  delete process.env.CORPUS_EMBEDDING_BASE_URL;
});

afterAll(() => {
  db.run(`DELETE FROM models WHERE id = 'consent-test-model'`);
});

test("a member with no answer on file is let through, so apps that do not ask yet keep working", () => {
  expect(aiAllowed(MEMBER.id, "scaleway")).toBe(true);
});

test("a no stops every provider outside the house, and never a local model", () => {
  setConsent(MEMBER.id, "declined", ["scaleway"]);
  expect(aiAllowed(MEMBER.id, "scaleway")).toBe(false);
  expect(aiAllowed(MEMBER.id, "anthropic")).toBe(false);
  expect(aiAllowed(MEMBER.id, "ollama")).toBe(true);
});

test("a yes covers the providers it named, and only those", () => {
  setConsent(MEMBER.id, "accepted", ["scaleway", "ollama"]);
  expect(aiAllowed(MEMBER.id, "scaleway")).toBe(true);
  expect(aiAllowed(MEMBER.id, "anthropic")).toBe(false);
  expect(uncovered(MEMBER.id, ["scaleway", "anthropic", "ollama"])).toEqual(["anthropic"]);
});

test("the household's own work, done for no member, is not asked about", () => {
  setConsent(MEMBER.id, "declined", []);
  expect(aiAllowed(null, "scaleway")).toBe(true);
});

test("the embedding provider is read from the container's settings", () => {
  expect(embeddingProvider()).toBe(null);
  process.env.CORPUS_EMBEDDING_BASE_URL = "https://api.scaleway.ai/v1";
  expect(embeddingProvider()).toBe("scaleway");
  process.env.CORPUS_EMBEDDING_BASE_URL = "http://localhost:11434/v1";
  expect(embeddingProvider()).toBe(null);
});

test("the route asks for an answer until there is one, and records it", async () => {
  db.run(`UPDATE households SET scaleway_api_key = 'sk-test' WHERE id = 'default'`);
  process.env.MAURICE_DICTATION_ENGINE = "scaleway";

  const first = await (await me.request("/ai-consent", { headers: auth })).json() as any;
  expect(first.record).toBe(null);
  expect(first.needs_answer).toBe(true);
  expect(first.providers.map((p: any) => p.id)).toContain("scaleway");
  expect(first.providers.find((p: any) => p.id === "scaleway").name).toBe("Scaleway Generative APIs");

  const shown: string[] = first.providers.map((p: any) => p.id);
  const partial = await (await me.request("/ai-consent", {
    method: "PUT", headers: auth, body: JSON.stringify({ status: "accepted", providers: ["scaleway", "nowhere"] }),
  })).json() as any;
  // Only providers the household uses are kept, and what was left out is asked again.
  expect(partial.record.providers).toEqual(["scaleway"]);
  expect(partial.needs_answer).toBe(shown.length > 1);

  const after = await (await me.request("/ai-consent", {
    method: "PUT", headers: auth, body: JSON.stringify({ status: "accepted", providers: shown }),
  })).json() as any;
  expect(after.record.status).toBe("accepted");
  expect(after.needs_answer).toBe(false);

  const bad = await me.request("/ai-consent", { method: "PUT", headers: auth, body: JSON.stringify({ status: "maybe" }) });
  expect(bad.status).toBe(400);
});

test("a no is held by the server: no dictation clip goes to Scaleway", async () => {
  db.run(`UPDATE households SET scaleway_api_key = 'sk-test' WHERE id = 'default'`);
  process.env.MAURICE_DICTATION_ENGINE = "scaleway";
  setConsent(MEMBER.id, "declined", []);

  const info = await (await dictation.request("/", { headers: auth })).json() as any;
  expect(info.allowed).toBe(false);
  expect(info.available).toBe(false);

  const res = await dictation.request("/?duration=2", {
    method: "POST", headers: { ...auth, "Content-Type": "audio/mp4" }, body: new Uint8Array(16),
  });
  expect(res.status).toBe(403);
});

test("a no is held by the server: background work for the member is refused before any call", async () => {
  db.run(`UPDATE households SET scaleway_api_key = 'sk-test' WHERE id = 'default'`);
  setConsent(MEMBER.id, "declined", []);
  let err: unknown = null;
  try {
    await ancillaryComplete({
      invocation: "conversation_summary", memberId: MEMBER.id, model: "consent-test-model", prompt: "hi", maxTokens: 16,
    });
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(AncillaryError);
  expect((err as InstanceType<typeof AncillaryError>).status).toBe(403);
});
