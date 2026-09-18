/**
 * Preferred models for the small work behind the chat. Each tier has a list,
 * best first, and a household takes the first entry it can actually call — so
 * the question is what should do the job, not which provider the household
 * belongs to. Aline is the case that shaped it: her chat runs on GLM, her
 * household holds a Scaleway key, and her summaries should be on Scaleway.
 */

import { beforeEach, expect, test } from "bun:test";

const db = (await import("../src/db")).default;
const {
  ANCILLARY_INVOCATIONS, PREFERRED, ancillaryModel, applyRecommendedPins, hasRecommendations,
  pinSource, recommendedModel, refreshAutoPins, seedAncillaryPinsOnce, setPinnedModel,
} = await import("../src/services/ancillary");

const NO_KEYS = {
  api_key: null, openai_api_key: null, mistral_api_key: null, zai_api_key: null, scaleway_api_key: null,
};

function household(defaultModel: string, keys: Record<string, string | null>) {
  db.run(`INSERT OR IGNORE INTO households (id, name) VALUES ('default', 'Home')`);
  db.run(`UPDATE households SET default_model = ? WHERE id = 'default'`, [defaultModel]);
  for (const [col, value] of Object.entries({ ...NO_KEYS, ...keys })) {
    db.run(`UPDATE households SET ${col} = ? WHERE id = 'default'`, [value]);
  }
}

const firstOfTier = (tier: string, side: "server" | "tools" = "server") =>
  ANCILLARY_INVOCATIONS.find((i) => i.tier === tier && i.side === side)!.id;

beforeEach(() => {
  db.run(`DELETE FROM ancillary_models`);
  db.run(`UPDATE households SET ancillary_pins_seeded = 0 WHERE id = 'default'`);
});

test("every preferred model is really in the roster", () => {
  const known = new Set(
    (db.query(`SELECT id FROM models`).all() as Array<{ id: string }>).map((r) => r.id),
  );
  for (const [tier, ids] of Object.entries(PREFERRED)) {
    for (const id of ids) {
      expect(`${tier}/${known.has(id) ? id : "MISSING"}`).toBe(`${tier}/${id}`);
    }
  }
});

test("no flagship is preferred, and no Z.ai model is preferred at all", () => {
  const all = Object.values(PREFERRED).flat();
  // Z.ai ships only large models: GLM 5.3 and its Flash are both the size this
  // is meant to avoid, so neither belongs in any tier.
  expect(all.filter((id) => id.startsWith("glm-"))).toEqual([]);
  expect(all).not.toContain("claude-opus-4-8");
  expect(PREFERRED.light[0]).toBe("mistral-small-3.2-24b-instruct-2506");
});

test("Aline's shape: a GLM chat with a Scaleway key advises Scaleway", () => {
  household("glm-5.3-flash", { zai_api_key: "k-zai", scaleway_api_key: "k-scw" });
  expect(hasRecommendations()).toBe(true);
  expect(recommendedModel(firstOfTier("light"))).toBe("mistral-small-3.2-24b-instruct-2506");
  expect(recommendedModel("conversation_summary")).toBe("gpt-oss-120b");
  expect(recommendedModel("flashcards")).toBe("qwen3.5-397b-a17b");
  // The tools dispatch through Anthropic themselves and she has no key there.
  expect(recommendedModel(firstOfTier("light", "tools"))).toBe(null);

  const seeded = seedAncillaryPinsOnce();
  expect(seeded.sort()).toEqual(ANCILLARY_INVOCATIONS.filter((i) => i.side === "server").map((i) => i.id).sort());
  expect(ancillaryModel("conversation_summary")).toBe("gpt-oss-120b");
});

test("a household with only Z.ai is advised nothing and keeps its own model", () => {
  household("glm-5.3-flash", { zai_api_key: "k-zai" });
  expect(hasRecommendations()).toBe(false);
  expect(recommendedModel("conversation_summary")).toBe(null);
  expect(seedAncillaryPinsOnce()).toEqual([]);
  const row = db.query(`SELECT ancillary_pins_seeded FROM households WHERE id = 'default'`).get() as any;
  expect(row.ancillary_pins_seeded).toBe(0); // so it happens the day a key arrives
  expect(ancillaryModel("conversation_summary")).toBe("glm-5.3-flash");
});

test("Anthropic alone covers the tools too, and leaves Opus to the chat", () => {
  household("claude-opus-4-8", { api_key: "k-ant" });
  expect(seedAncillaryPinsOnce().length).toBe(ANCILLARY_INVOCATIONS.length);
  expect(ancillaryModel(firstOfTier("light"))).toBe("claude-haiku-4-5-20251001");
  expect(ancillaryModel("dossier_title")).toBe("claude-haiku-4-5-20251001"); // a tools one
  expect(ancillaryModel("flashcards")).toBe("claude-sonnet-4-6");
});

test("Scaleway wins over Anthropic for the server's own work", () => {
  household("claude-opus-4-8", { api_key: "k-ant", scaleway_api_key: "k-scw" });
  expect(recommendedModel("conversation_summary")).toBe("gpt-oss-120b");
  // …while a tools invocation still takes the Anthropic entry, since that is
  // the only one its dispatcher can reach.
  expect(recommendedModel("dossier_title")).toBe("claude-haiku-4-5-20251001");
});

test("a pin this file chose follows the advice; a pin a person chose does not", () => {
  household("glm-5.3-flash", { zai_api_key: "k-zai", scaleway_api_key: "k-scw" });
  // Aline's shape before this change: pins written by the older version, which
  // read her GLM chat and advised GLM for everything.
  setPinnedModel("conversation_summary", "glm-5.3-flash", "auto");
  setPinnedModel("flashcards", "glm-5.3", "admin");
  db.run(`UPDATE households SET ancillary_pins_seeded = 1 WHERE id = 'default'`);

  // A start on this code moves the one nobody chose, and only that one.
  expect(seedAncillaryPinsOnce()).toEqual([]);
  expect(refreshAutoPins()).toEqual(["conversation_summary"]);
  expect(ancillaryModel("conversation_summary")).toBe("gpt-oss-120b");
  expect(ancillaryModel("flashcards")).toBe("glm-5.3");
  expect(pinSource("flashcards")).toBe("admin");

  // And it does not re-create a pin the admin deleted.
  setPinnedModel("article_summary", null);
  expect(refreshAutoPins()).toEqual([]);
  expect(pinSource("article_summary")).toBe(null);
});

test("seeding is a one-off; the button is not", () => {
  household("glm-5.3-flash", { zai_api_key: "k-zai", scaleway_api_key: "k-scw" });
  seedAncillaryPinsOnce();
  setPinnedModel("conversation_summary", "glm-5.3");
  expect(seedAncillaryPinsOnce()).toEqual([]);
  expect(ancillaryModel("conversation_summary")).toBe("glm-5.3");
  expect(applyRecommendedPins()).toEqual(["conversation_summary"]);
  expect(ancillaryModel("conversation_summary")).toBe("gpt-oss-120b");
});
