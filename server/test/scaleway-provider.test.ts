/**
 * Scaleway as a provider: the roster seeds itself, the key column gates the
 * provider, every seeded model has a price, and the two stream quirks that
 * would otherwise mislead are handled — a per-minute quota whose wording reads
 * like an empty account, and reasoning that arrives as `reasoning` rather
 * than `reasoning_content`. The dispatch itself talks to Scaleway and is not
 * run here.
 */

import { beforeAll, expect, test } from "bun:test";

const db = (await import("../src/db")).default;
const { configuredProviders } = await import("../src/services/models");
const { priceFor } = await import("../src/services/pricing");
const { billingErrorKind, openaiTurn } = await import("../src/services/openaiChat");
const { OPENAI_STYLE_BASE_URL, isOpenAIStyle, openaiStyleKey, openaiStyleBaseUrl } = await import("../src/services/claude");

beforeAll(() => {
  db.run(`INSERT OR IGNORE INTO households (id, name) VALUES ('default', 'Home')`);
});

test("the roster is seeded once, vision set where the model reads images", () => {
  const rows = db.query(`SELECT id, vision, vendor FROM models WHERE provider = 'scaleway' ORDER BY sort`).all() as any[];
  expect(rows.length).toBe(10);
  expect(rows[0].id).toBe("mistral-small-3.2-24b-instruct-2506");
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  expect(byId["mistral-small-3.2-24b-instruct-2506"].vision).toBe(1);
  expect(byId["gpt-oss-120b"].vision).toBe(0);
  expect(byId["glm-5.2"].vendor).toBe("Z.ai"); // the maker, not the host
  // Nothing Scaleway has deprecated is offered.
  expect(byId["pixtral-12b-2409"]).toBeUndefined();
});

test("the provider appears only once its key is set", () => {
  db.run(`UPDATE households SET scaleway_api_key = NULL WHERE id = 'default'`);
  expect(configuredProviders().has("scaleway")).toBe(false);
  db.run(`UPDATE households SET scaleway_api_key = 'k-scw' WHERE id = 'default'`);
  expect(configuredProviders().has("scaleway")).toBe(true);
  db.run(`UPDATE households SET scaleway_api_key = NULL WHERE id = 'default'`);
});

test("it is an OpenAI-style provider with a key column of its own", () => {
  expect(isOpenAIStyle("scaleway")).toBe(true);
  expect(isOpenAIStyle("anthropic")).toBe(false);
  expect(isOpenAIStyle("toString")).toBe(false); // an own-property check, not a prototype walk
  expect(OPENAI_STYLE_BASE_URL.scaleway).toBe("https://api.scaleway.ai/v1");
  const config = {
    apiKey: null, openaiApiKey: null, mistralApiKey: null, zaiApiKey: "z", scalewayApiKey: "s",
    scalewayProjectId: null, falApiKey: null, defaultModel: "", maxTokens: 1,
  };
  expect(openaiStyleKey("scaleway", config)).toBe("s");
  expect(openaiStyleKey("zai", config)).toBe("z");
  expect(openaiStyleKey("openai", config)).toBeNull();
});

test("a project-scoped key names its project in the URL; an organization-wide one does not", () => {
  const base = {
    apiKey: null, openaiApiKey: null, mistralApiKey: null, zaiApiKey: null, scalewayApiKey: "s",
    falApiKey: null, defaultModel: "", maxTokens: 1,
  };
  expect(openaiStyleBaseUrl("scaleway", { ...base, scalewayProjectId: null })).toBe("https://api.scaleway.ai/v1");
  expect(openaiStyleBaseUrl("scaleway", { ...base, scalewayProjectId: "3dfc66c4-bb95-49f9-8b8b-ecab3b2ac9ee" }))
    .toBe("https://api.scaleway.ai/3dfc66c4-bb95-49f9-8b8b-ecab3b2ac9ee/v1");
  // Nobody else has a project; the field is ignored for them.
  expect(openaiStyleBaseUrl("zai", { ...base, scalewayProjectId: "x" })).toBe("https://api.z.ai/api/paas/v4");
});

test("every seeded model has a price, in dollars", () => {
  const ids = (db.query(`SELECT id FROM models WHERE provider = 'scaleway'`).all() as any[]).map((r) => r.id);
  for (const id of ids) expect(priceFor(id)).not.toBeNull();
  const p = priceFor("mistral-small-3.2-24b-instruct-2506")!;
  expect(p.input).toBeCloseTo(0.15 * 1.1537, 6);
  expect(p.output).toBeGreaterThan(p.input);
  // The one cached-input price on the sheet.
  expect(priceFor("deepseek-v4-flash-0731")!.cacheRead).toBeCloseTo(0.2, 6);
});

test("a per-minute quota is not an empty account", () => {
  expect(billingErrorKind(
    '{"status":429,"error":"INSUFFICIENT QUOTA","message":"You exceeded your current quota of tokens per minute. Slow down your usage or increase your quotas."}',
  )).toBeUndefined();
  expect(billingErrorKind("You exceeded your current quota, please check your plan and billing details.")).toBe("out_of_credits");
  expect(billingErrorKind("Insufficient balance or no resource package")).toBe("plan_or_credits");
});

test("reasoning streamed as `reasoning` counts as thinking", async () => {
  const sse = [
    `data: {"choices":[{"delta":{"role":"assistant","reasoning":"let me see"}}]}`,
    `data: {"choices":[{"delta":{"content":"42"}}]}`,
    `data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1}}`,
    `data: [DONE]`,
  ].join("\n\n") + "\n\n";
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })) as any;
  try {
    const events: any[] = [];
    for await (const ev of openaiTurn("https://example.invalid/v1", "k", "m", [], [], undefined)) events.push(ev);
    expect(events.map((e) => e.type)).toEqual(["thinking", "text", "turn_end"]);
    expect(events[1].text).toBe("42");
    expect(events[2].usage).toEqual({ prompt: 3, completion: 1, cached: 0 });
  } finally {
    globalThis.fetch = realFetch;
  }
});
