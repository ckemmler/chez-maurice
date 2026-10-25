/**
 * The reasoning switch. The roster says which models reason and whether a
 * request can turn the phase on or off; a persona records its choice; the
 * provider paths translate it into the one field each provider reads — and
 * send nothing at all where the roster says there is no switch.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { MEMBER } from "./_member";

const db = (await import("../src/db")).default;
const { addModel, getModel, setModelThinking, toModelInfo } = await import("../src/services/models");
const { createMaurice, updateMaurice } = await import("../src/services/maurices");
const { thinkingBody, getHouseholdConfig } = await import("../src/services/claude");
const { anthropicThinking, anthropicTakesTemperature } = await import("../src/services/anthropicParams");
const { ancillaryComplete } = await import("../src/services/ancillary");
const { openaiTurn } = await import("../src/services/openaiChat");
const { _resetErrors, fullHealth, DB_CHECK_TTL_MS } = await import("../src/services/health");
const health = await import("../src/services/health");

beforeAll(() => {
  db.run(`INSERT OR IGNORE INTO households (id, name) VALUES ('default', 'Home')`);
});

describe("the roster knows which models reason", () => {
  test("the seed marks the switchable ones, the fixed ones, and leaves the rest alone", () => {
    const at = (id: string) => getModel(id)?.thinking;
    expect(at("glm-5.3-flash")).toBe("optional");
    expect(at("glm-5.3")).toBe("optional");
    expect(at("claude-sonnet-5-5")).toBe("optional");
    expect(at("claude-opus-5-5")).toBe("optional");
    expect(at("claude-haiku-4-5-20251001")).toBe("none"); // still the budget form, which Maurice does not send
    expect(at("gpt-oss-120b")).toBe("always");
    expect(at("mistral-small-3.2-24b-instruct-2506")).toBe("none");
    expect(at("gpt-4o")).toBe("none");
  });

  test("the apps see the capability on every model", () => {
    expect(toModelInfo(getModel("glm-5.3-flash")!).thinking).toBe("optional");
    expect(toModelInfo(getModel("gpt-4o")!).thinking).toBe("none");
  });

  test("the admin can correct it, and only to a known value", () => {
    addModel({ id: "test-thinker", name: "Thinker", tier: "cloud", provider: "zai" });
    expect(getModel("test-thinker")!.thinking).toBe("none");
    expect(setModelThinking("test-thinker", "optional")).toBe(true);
    expect(getModel("test-thinker")!.thinking).toBe("optional");
    expect(setModelThinking("test-thinker", "sometimes")).toBe(false);
    expect(getModel("test-thinker")!.thinking).toBe("optional");
    expect(setModelThinking("no-such-model", "none")).toBe(false);
  });

  test("a re-upsert that says nothing about reasoning keeps what the row has", () => {
    // What a rescan does: the same model again, capability not mentioned.
    addModel({ id: "test-thinker", name: "Thinker again", tier: "cloud", provider: "zai" });
    expect(getModel("test-thinker")!.name).toBe("Thinker again");
    expect(getModel("test-thinker")!.thinking).toBe("optional");
    // Said explicitly, it moves.
    addModel({ id: "test-thinker", name: "Thinker", tier: "cloud", provider: "zai", thinking: "always" });
    expect(getModel("test-thinker")!.thinking).toBe("always");
    db.run(`DELETE FROM models WHERE id = 'test-thinker'`);
  });
});

describe("a persona records its choice", () => {
  test("null by default; true and false stick; an omitted field leaves it alone; null resets", () => {
    const made = createMaurice(MEMBER.id, { name: "Reader", model: "glm-5.3-flash" });
    if ("errors" in made) throw new Error("persona not created");
    expect(made.thinking).toBeNull();

    const off = updateMaurice(made.id, MEMBER.id, { thinking: false });
    expect(off && !("errors" in off) && off.thinking).toBe(false);
    const untouched = updateMaurice(made.id, MEMBER.id, { tagline: "Reads with you" });
    expect(untouched && !("errors" in untouched) && untouched.thinking).toBe(false);
    const on = updateMaurice(made.id, MEMBER.id, { thinking: true });
    expect(on && !("errors" in on) && on.thinking).toBe(true);
    const reset = updateMaurice(made.id, MEMBER.id, { thinking: null });
    expect(reset && !("errors" in reset) && reset.thinking).toBeNull();
    db.run(`DELETE FROM maurices WHERE id = ?`, [made.id]);
  });

  test("a value that is not a boolean is no choice, not a request", () => {
    const made = createMaurice(MEMBER.id, { name: "Loose", thinking: "yes" as any });
    if ("errors" in made) throw new Error("persona not created");
    expect(made.thinking).toBeNull();
    db.run(`DELETE FROM maurices WHERE id = ?`, [made.id]);
  });

  test("the everyday Maurice has a factory setting: answer directly", () => {
    expect(getHouseholdConfig().everydayThinking).toBe(false);
    db.run(`UPDATE households SET everyday_thinking = NULL WHERE id = 'default'`);
    expect(getHouseholdConfig().everydayThinking).toBeNull();
    db.run(`UPDATE households SET everyday_thinking = 1 WHERE id = 'default'`);
    expect(getHouseholdConfig().everydayThinking).toBe(true);
    db.run(`UPDATE households SET everyday_thinking = 0 WHERE id = 'default'`);
  });
});

describe("what reaches the provider", () => {
  test("Z.ai gets `reasoning_effort`; nobody else gets anything", () => {
    // GLM cannot be told not to think at all: the dial takes low | high | max.
    expect(thinkingBody("zai", false)).toEqual({ reasoning_effort: "low" });
    expect(thinkingBody("zai", true)).toEqual({ reasoning_effort: "high" });
    expect(thinkingBody("scaleway", false)).toBeUndefined();
    expect(thinkingBody("mistral", true)).toBeUndefined();
    expect(thinkingBody("openai", false)).toBeUndefined();
  });

  test("no choice on Z.ai is `low`, not the provider's own default", () => {
    // Where the phase can be turned off, saying nothing is fine. On GLM it is
    // not: the default effort is a minute of reasoning a turn, which is what a
    // persona with no recorded choice used to get.
    expect(thinkingBody("zai", undefined)).toEqual({ reasoning_effort: "low" });
    expect(thinkingBody("anthropic", undefined)).toBeUndefined();
    expect(thinkingBody("scaleway", undefined)).toBeUndefined();
  });

  test("Scaleway's DeepSeek V4 Flash answers directly when that is the recorded choice, and only then", () => {
    // The one Scaleway model found to take a switch (`reasoning_effort: "none"`).
    expect(thinkingBody("scaleway", false, "deepseek-v4-flash-0731")).toEqual({ reasoning_effort: "none" });
    // No choice, or reasoning asked for: nothing is sent, the model decides.
    expect(thinkingBody("scaleway", undefined, "deepseek-v4-flash-0731")).toBeUndefined();
    expect(thinkingBody("scaleway", true, "deepseek-v4-flash-0731")).toBeUndefined();
    // The other Scaleway models have no switch: an unknown field is a 422.
    expect(thinkingBody("scaleway", false, "qwen3.5-397b-a17b")).toBeUndefined();
    // And the roster says the model takes a choice.
    expect((db.query(`SELECT thinking FROM models WHERE id = 'deepseek-v4-flash-0731'`).get() as any)?.thinking).toBe("optional");
  });

  test("the models Scaleway added in October take the same switch, and are on the roster", () => {
    for (const id of ["deepseek-v4.1-flash", "qwen3.8-27b"]) {
      expect(thinkingBody("scaleway", false, id)).toEqual({ reasoning_effort: "none" });
      expect(thinkingBody("scaleway", undefined, id)).toBeUndefined();
      const row = db.query(`SELECT provider, thinking, vision FROM models WHERE id = ?`).get(id) as any;
      expect(row).toEqual({ provider: "scaleway", thinking: "optional", vision: 1 });
    }
    // GLM 5.3 moved over from Z.ai rather than being added twice.
    expect(thinkingBody("scaleway", false, "glm-5.3")).toEqual({ reasoning_effort: "none" });
    const glm = db.query(`SELECT provider, vendor, thinking FROM models WHERE id = 'glm-5.3'`).get() as any;
    expect(glm).toEqual({ provider: "scaleway", vendor: "Z.ai", thinking: "optional" });
    expect((db.query(`SELECT provider FROM models WHERE id = 'glm-5.3-flash'`).get() as any)?.provider).toBe("zai");
  });

  test("each Anthropic generation is told to answer directly in the form it accepts", () => {
    // As the API answered on 16 October 2026 — every other form is a 400.
    expect(anthropicThinking("claude-opus-5-5", false)).toEqual({ output_config: { effort: "low" } });
    expect(anthropicThinking("claude-sonnet-5-5", false)).toEqual({ thinking: { type: "between_tools" } });
    expect(anthropicThinking("claude-opus-5", false)).toEqual({ thinking: { type: "disabled" } });
    expect(anthropicThinking("claude-sonnet-4-6", false)).toEqual({ thinking: { type: "disabled" } });
    // Reasoning asked for is adaptive everywhere.
    expect(anthropicThinking("claude-opus-5-5", true)).toEqual({ thinking: { type: "adaptive" } });
    // The chat path reaches it through the one per-provider switch.
    expect(thinkingBody("anthropic", false, "claude-sonnet-5-5")).toEqual({ thinking: { type: "between_tools" } });
  });

  test("no choice answers directly on the Claude models that would otherwise reason, and sends nothing on the others", () => {
    // From Opus 5 / Sonnet 5 on, a request that says nothing reasons; a model
    // upgrade must not turn reasoning on for a persona that never asked.
    expect(anthropicThinking("claude-sonnet-5-5", undefined)).toEqual({ thinking: { type: "between_tools" } });
    expect(anthropicThinking("claude-opus-5-5", undefined)).toEqual({ output_config: { effort: "low" } });
    expect(anthropicThinking("claude-opus-5", undefined)).toEqual({ thinking: { type: "disabled" } });
    // Up to Opus 4.8 nothing sent already means no reasoning.
    expect(anthropicThinking("claude-sonnet-4-6", undefined)).toBeUndefined();
    expect(anthropicThinking("claude-haiku-4-5-20251001", undefined)).toBeUndefined();
  });

  test("a side task on a Claude 5.x model is told not to reason, unless it asks for an effort", async () => {
    db.run(`UPDATE households SET api_key = 'k-ant' WHERE id = 'default'`);
    const realFetch = globalThis.fetch;
    const sent: any[] = [];
    globalThis.fetch = (async (_url: string, init: any) => {
      sent.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 5, output_tokens: 1 } }), { status: 200 });
    }) as any;
    try {
      await ancillaryComplete({ invocation: "topic_tags", model: "claude-sonnet-5-5", prompt: "x", maxTokens: 100, temperature: 0, reasoning: "none" });
      await ancillaryComplete({ invocation: "topic_tags", model: "claude-opus-5-5", prompt: "x", maxTokens: 100, effort: "high" });
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(sent[0].thinking).toEqual({ type: "between_tools" });
    expect(sent[0].temperature).toBeUndefined();
    expect(sent[1].thinking).toBeUndefined();
    expect(sent[1].output_config).toEqual({ effort: "high" });
  });

  test("a persona's temperature reaches only the Anthropic models that still take one", () => {
    for (const m of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-opus-5", "claude-opus-4-8", "claude-fable-5-1"]) {
      expect(anthropicTakesTemperature(m)).toBe(false);
    }
    for (const m of ["claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5-20251001"]) {
      expect(anthropicTakesTemperature(m)).toBe(true);
    }
  });

  test("the Chat Completions client sends the extra field as it is", async () => {
    const sse = `data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n`;
    const realFetch = globalThis.fetch;
    let sent: any = null;
    globalThis.fetch = (async (_url: string, init: any) => {
      sent = JSON.parse(init.body);
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as any;
    try {
      const events: any[] = [];
      for await (const ev of openaiTurn("https://example.invalid/v1", "k", "glm-5.3-flash", [], [], undefined,
        { extraBody: { reasoning_effort: "low" } })) events.push(ev);
      expect(sent.reasoning_effort).toBe("low");
      expect(events.at(-1).type).toBe("turn_end");
      // And nothing when there is nothing to say.
      for await (const _ of openaiTurn("https://example.invalid/v1", "k", "glm-5.3-flash", [], [], undefined)) {}
      expect(sent.reasoning_effort).toBeUndefined();
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("/healthz keeps its database verdict for a while", () => {
  test("the integrity check runs once per TTL, the liveness check every time", () => {
    _resetErrors();
    const t0 = 1_700_000_000_000;
    expect(fullHealth(t0).db).toBe("ok");
    expect(fullHealth(t0 + 1000).db).toBe("ok");
    expect(fullHealth(t0 + DB_CHECK_TTL_MS - 1).db).toBe("ok");
    expect(health._dbChecks).toBe(1);
    expect(fullHealth(t0 + DB_CHECK_TTL_MS).db).toBe("ok");
    expect(health._dbChecks).toBe(2);
  });
});
