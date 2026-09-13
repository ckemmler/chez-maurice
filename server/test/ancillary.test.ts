/**
 * Ancillary model resolution: a pin, then the household's ancillary model,
 * then the chat default — skipping anything the household cannot call — and
 * never nothing. The dispatch itself talks to providers and is not run here.
 */

import { beforeAll, expect, test } from "bun:test";

const db = (await import("../src/db")).default;
const { addModel } = await import("../src/services/models");
const {
  ancillaryModel, setPinnedModel, setHouseholdAncillaryModel, householdAncillaryModel,
  ancillaryTable, isAncillaryInvocation, ANCILLARY_INVOCATIONS,
} = await import("../src/services/ancillary");

beforeAll(() => {
  db.run(`INSERT OR IGNORE INTO households (id, name) VALUES ('default', 'Home')`);
  // Anthropic has a key; Z.ai does not.
  db.run(`UPDATE households SET api_key = 'k-anthropic', zai_api_key = NULL, default_model = 'anc-default' WHERE id = 'default'`);
  for (const [id, provider] of [["anc-default", "anthropic"], ["anc-pin", "anthropic"], ["anc-glm", "zai"]] as const) {
    if (!db.query(`SELECT 1 FROM models WHERE id = ?`).get(id)) {
      addModel({ id, name: id, tier: "cloud", vendor: provider, provider });
    }
  }
  // db.ts backfilled ancillary_model from the schema's default_model when it
  // created this throwaway database — before the roster above existed. Set the
  // household model to something in the roster, as an install with a real
  // chat default would have.
  db.run(`UPDATE households SET ancillary_model = 'anc-default' WHERE id = 'default'`);
});

test("every invocation resolves, pinned or not", () => {
  for (const i of ANCILLARY_INVOCATIONS) {
    expect(ancillaryModel(i.id)).toBeTruthy();
  }
  expect(isAncillaryInvocation("flashcards")).toBe(true);
  expect(isAncillaryInvocation("nope")).toBe(false);
});

test("unpinned → the household's ancillary model, backfilled from the chat default", () => {
  expect(householdAncillaryModel()).toBe("anc-default");
  expect(ancillaryModel("flashcards")).toBe("anc-default");
});

test("a pin wins; clearing it goes back to the household model", () => {
  setPinnedModel("flashcards", "anc-pin");
  expect(ancillaryModel("flashcards")).toBe("anc-pin");
  expect(ancillaryTable().find((r) => r.id === "flashcards")?.pinned).toBe("anc-pin");
  setPinnedModel("flashcards", null);
  expect(ancillaryModel("flashcards")).toBe("anc-default");
});

test("a pin to a model without a key is skipped, not fatal", () => {
  setPinnedModel("article_summary", "anc-glm");
  expect(ancillaryModel("article_summary")).toBe("anc-default");
  db.run(`UPDATE households SET zai_api_key = 'k-zai' WHERE id = 'default'`);
  expect(ancillaryModel("article_summary")).toBe("anc-glm");
  db.run(`UPDATE households SET zai_api_key = NULL WHERE id = 'default'`);
  setPinnedModel("article_summary", null);
});

test("a household ancillary model that is not in the roster falls through to the chat default", () => {
  setHouseholdAncillaryModel("gone-from-roster");
  expect(ancillaryModel("signal_parse")).toBe("anc-default");
  setHouseholdAncillaryModel("anc-pin");
  expect(ancillaryModel("signal_parse")).toBe("anc-pin");
  setHouseholdAncillaryModel("anc-default");
});
