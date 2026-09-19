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
    expect(at("claude-sonnet-4-6")).toBe("optional");
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
  test("Z.ai gets its `thinking` field; nobody else gets anything", () => {
    expect(thinkingBody("zai", false)).toEqual({ thinking: { type: "disabled" } });
    expect(thinkingBody("zai", true)).toEqual({ thinking: { type: "enabled" } });
    expect(thinkingBody("zai", undefined)).toBeUndefined();
    expect(thinkingBody("scaleway", false)).toBeUndefined();
    expect(thinkingBody("mistral", true)).toBeUndefined();
    expect(thinkingBody("openai", false)).toBeUndefined();
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
        { extraBody: { thinking: { type: "disabled" } } })) events.push(ev);
      expect(sent.thinking).toEqual({ type: "disabled" });
      expect(events.at(-1).type).toBe("turn_end");
      // And nothing when there is nothing to say.
      for await (const _ of openaiTurn("https://example.invalid/v1", "k", "glm-5.3-flash", [], [], undefined)) {}
      expect(sent.thinking).toBeUndefined();
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
