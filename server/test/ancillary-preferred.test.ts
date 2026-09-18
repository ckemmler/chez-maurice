/**
 * Preferred models for the small work behind the chat. Each tier has a list,
 * best first, and a household takes the first entry it can actually call — so
 * the question is what should do the job, not which provider the household
 * belongs to. Aline is the case that shaped it: her chat runs on GLM, her
 * household holds a Scaleway key, and her summaries should be on Scaleway.
 */

import { beforeEach, expect, test } from "bun:test";
import { existsSync } from "fs";
import { join } from "path";

const db = (await import("../src/db")).default;
const {
  ANCILLARY_INVOCATIONS, PREFERRED, ancillaryModel, applyRecommendedPins, hasRecommendations,
  pinSource, presentInvocations, recommendedModel, refreshAutoPins, seedAncillaryPinsOnce,
  setPinnedModel,
} = await import("../src/services/ancillary");

const NO_KEYS = {
  api_key: null, openai_api_key: null, mistral_api_key: null, zai_api_key: null, scaleway_api_key: null,
};

function household(defaultModel: string, keys: Record<string, string | null>) {
  db.run(`INSERT OR IGNORE INTO households (id, name) VALUES ('default', 'Home')`);
  // The ancillary default too: another suite in this run may have moved it,
  // and what an unpinned invocation falls back to is part of what is tested.
  db.run(
    `UPDATE households SET default_model = ?, ancillary_model = ? WHERE id = 'default'`,
    [defaultModel, defaultModel],
  );
  for (const [col, value] of Object.entries({ ...NO_KEYS, ...keys })) {
    db.run(`UPDATE households SET ${col} = ? WHERE id = 'default'`, [value]);
  }
}

const firstOfTier = (tier: string, side: "server" | "tools" = "server") =>
  ANCILLARY_INVOCATIONS.find((i) => i.tier === tier && i.side === side)!.id;

/** A tools invocation this checkout actually has — the private ones are
 *  symlinks that do not resolve in a worktree, exactly as in a hosted image. */
const toolsHere = (tier: string) =>
  presentInvocations().find((i) => i.side === "tools" && i.tier === tier)?.id ?? null;

beforeEach(() => {
  db.run(`DELETE FROM ancillary_models`);
  db.run(`UPDATE households SET ancillary_pins_seeded = 0 WHERE id = 'default'`);
});

test("only the functions whose code is installed are offered", () => {
  const present = presentInvocations();
  // Everything the server runs itself is always there.
  for (const inv of ANCILLARY_INVOCATIONS.filter((i) => i.side === "server")) {
    expect(present.map((p) => p.id)).toContain(inv.id);
  }
  // A tools invocation is offered only when its directory is on disk. Thirteen
  // of the tools/* entries are symlinks into the private repo that the image's
  // dockerignore drops, so a hosted household has far fewer than the catalogue.
  for (const inv of present) {
    if (inv.needs) expect(existsSync(join(import.meta.dir, "..", "..", inv.needs))).toBe(true);
  }
  // Every tools invocation declares what serves it, or the filter cannot work.
  for (const inv of ANCILLARY_INVOCATIONS.filter((i) => i.side === "tools")) {
    expect(`${inv.id}: ${inv.needs ?? "UNDECLARED"}`).toBe(`${inv.id}: ${inv.needs}`);
  }
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

test("neither Z.ai nor Anthropic is ever preferred", () => {
  const all = Object.values(PREFERRED).flat();
  // Z.ai ships only large models: GLM 5.3 and its Flash are both the size this
  // is meant to avoid.
  expect(all.filter((id) => id.startsWith("glm-"))).toEqual([]);
  // Anthropic is out by decision, not by size: American and dear, for work
  // that a small European model does as well.
  expect(all.filter((id) => id.startsWith("claude-"))).toEqual([]);
  expect(PREFERRED.light[0]).toBe("mistral-small-3.2-24b-instruct-2506");
});

test("nothing is advised for a function that dispatches its own turn", () => {
  household("glm-5.3-flash", { scaleway_api_key: "k-scw" });
  const own = ANCILLARY_INVOCATIONS.filter((i) => i.ownDispatch);
  expect(own.length).toBeGreaterThan(0);
  for (const inv of own) expect(recommendedModel(inv.id)).toBe(null);
  // …while the ones that ask the server for their turn are advised normally.
  expect(recommendedModel("moc_evocations")).toBe("mistral-small-3.2-24b-instruct-2506");
});

test("Aline's shape: a GLM chat with a Scaleway key advises Scaleway", () => {
  household("glm-5.3-flash", { zai_api_key: "k-zai", scaleway_api_key: "k-scw" });
  expect(hasRecommendations()).toBe(true);
  expect(recommendedModel(firstOfTier("light"))).toBe("mistral-small-3.2-24b-instruct-2506");
  expect(recommendedModel("conversation_summary")).toBe("gpt-oss-120b");
  expect(recommendedModel("flashcards")).toBe("qwen3.5-397b-a17b");
  // The garden tool asks the server for its turn, so it is advised too.
  expect(recommendedModel("moc_evocations")).toBe("mistral-small-3.2-24b-instruct-2506");

  const seeded = seedAncillaryPinsOnce();
  const advisable = presentInvocations().filter((i) => !i.ownDispatch).map((i) => i.id);
  expect(seeded.sort()).toEqual(advisable.sort());
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

test("an Anthropic-only household is advised nothing, and is told why", () => {
  // Home's shape after 18 September: an Anthropic key and no small model
  // anywhere. Nothing is advised rather than reaching for Claude, and the
  // functions stay on the household model until a Scaleway key arrives.
  household("claude-opus-4-8", { api_key: "k-ant" });
  expect(hasRecommendations()).toBe(false);
  expect(recommendedModel("conversation_summary")).toBe(null);
  expect(ancillaryModel("conversation_summary")).toBe("claude-opus-4-8");
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
