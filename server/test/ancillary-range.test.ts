/**
 * The ancillary range: the small work behind the chat should not run on the
 * chat's flagship. Every id named in a range must exist in the seeded roster
 * (a typo here would silently fall back to the household model), and a
 * household on Scaleway must end up on Scaleway's own models.
 */

import { beforeEach, expect, test } from "bun:test";

const db = (await import("../src/db")).default;
const {
  ANCILLARY_INVOCATIONS, ANCILLARY_RANGE, ancillaryModel, applyRecommendedPins,
  rangeProvider, recommendedModel, seedAncillaryPinsOnce, setPinnedModel,
} = await import("../src/services/ancillary");

function household(defaultModel: string, keys: Record<string, string | null>) {
  db.run(`INSERT OR IGNORE INTO households (id, name) VALUES ('default', 'Home')`);
  db.run(`UPDATE households SET default_model = ? WHERE id = 'default'`, [defaultModel]);
  for (const [col, value] of Object.entries(keys)) {
    db.run(`UPDATE households SET ${col} = ? WHERE id = 'default'`, [value]);
  }
}

beforeEach(() => {
  db.run(`DELETE FROM ancillary_models`);
  db.run(`UPDATE households SET ancillary_pins_seeded = 0 WHERE id = 'default'`);
});

test("every model a range names is really in the roster", () => {
  const known = new Set(
    (db.query(`SELECT id FROM models`).all() as Array<{ id: string }>).map((r) => r.id),
  );
  for (const [provider, tiers] of Object.entries(ANCILLARY_RANGE)) {
    for (const [tier, id] of Object.entries(tiers)) {
      expect(`${provider}/${tier}/${id}`).toBe(`${provider}/${tier}/${known.has(id) ? id : "MISSING"}`);
    }
  }
});

test("a range never sends light work to the model the chat uses", () => {
  // Anthropic is the case that motivated this: a dossier title on Opus.
  expect(ANCILLARY_RANGE.anthropic!.light).not.toBe("claude-opus-4-8");
  expect(ANCILLARY_RANGE.scaleway!.light).toBe("mistral-small-3.2-24b-instruct-2506");
  // And the light model is never the heavy one, for every provider.
  for (const tiers of Object.values(ANCILLARY_RANGE)) {
    expect(tiers.light).not.toBe(tiers.heavy);
  }
});

test("a Scaleway household lands on Scaleway's range, tier by tier", () => {
  household("mistral-small-3.2-24b-instruct-2506", {
    scaleway_api_key: "k-scw", api_key: null, openai_api_key: null, mistral_api_key: null, zai_api_key: null,
  });
  expect(rangeProvider()).toBe("scaleway");

  // Only the server's own invocations: the Python tools dispatch through
  // Anthropic themselves, so a Scaleway id would fail over there.
  const serverSide = ANCILLARY_INVOCATIONS.filter((i) => i.side === "server");
  const seeded = seedAncillaryPinsOnce();
  expect(seeded.sort()).toEqual(serverSide.map((i) => i.id).sort());
  expect(recommendedModel("dossier_title")).toBe(null); // a tools invocation

  const byTier = (tier: string) => serverSide.find((i) => i.tier === tier)!.id;
  expect(ancillaryModel(byTier("light"))).toBe("mistral-small-3.2-24b-instruct-2506");
  expect(ancillaryModel(byTier("standard"))).toBe("gpt-oss-120b");
  expect(ancillaryModel(byTier("heavy"))).toBe("qwen3.5-397b-a17b");

  // Seeding is a one-off: a second start does not undo the admin's own pins.
  setPinnedModel(byTier("light"), "glm-5.2");
  expect(seedAncillaryPinsOnce()).toEqual([]);
  expect(ancillaryModel(byTier("light"))).toBe("glm-5.2");

  // The button, though, puts everything back.
  expect(applyRecommendedPins()).toEqual([byTier("light")]);
  expect(ancillaryModel(byTier("light"))).toBe("mistral-small-3.2-24b-instruct-2506");
});

test("no key, no range: nothing is pinned and nothing is marked done", () => {
  household("mistral-small-3.2-24b-instruct-2506", {
    scaleway_api_key: null, api_key: null, openai_api_key: null, mistral_api_key: null, zai_api_key: null,
  });
  expect(rangeProvider()).toBe(null);
  expect(recommendedModel("flashcards")).toBe(null);
  expect(seedAncillaryPinsOnce()).toEqual([]);
  const row = db.query(`SELECT ancillary_pins_seeded FROM households WHERE id = 'default'`).get() as any;
  expect(row.ancillary_pins_seeded).toBe(0); // so it happens the day a key arrives
});

test("an Anthropic household keeps its flagship for the chat only", () => {
  household("claude-opus-4-8", {
    api_key: "k-ant", scaleway_api_key: null, openai_api_key: null, mistral_api_key: null, zai_api_key: null,
  });
  expect(rangeProvider()).toBe("anthropic");
  // Here the tools are covered too: they speak Anthropic, so every invocation
  // is pinned — which is the case that takes dossier titles off Opus.
  expect(seedAncillaryPinsOnce().length).toBe(ANCILLARY_INVOCATIONS.length);
  const light = ANCILLARY_INVOCATIONS.find((i) => i.tier === "light")!.id;
  expect(ancillaryModel(light)).toBe("claude-haiku-4-5-20251001");
  expect(ancillaryModel("dossier_title")).toBe("claude-haiku-4-5-20251001");
  expect(ancillaryModel("flashcards")).toBe("claude-sonnet-4-6");
});
