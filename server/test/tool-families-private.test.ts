// The corpus is an always-on family, and a member-private one (20 September
// 2026). Two things are nailed down here: it rides in every private turn
// without anyone selecting it or being granted experimental access, and it is
// withheld the moment a conversation has a second participant — the same rule
// the domain briefs follow, for the same reason: one member's indexed life
// must not be read out to the others in a room.

import { expect, test } from "bun:test";

const { ALWAYS_ON, PRIVATE_ONLY, isPrivateOnlyTool, isExperimentalTool, resolveFamilies } =
  await import("../src/services/toolFamilies");

test("the corpus is always on and no longer experimental", () => {
  expect(ALWAYS_ON).toContain("corpus");
  expect(isExperimentalTool("corpus__search")).toBe(false);
  // The two it joined are untouched.
  expect(ALWAYS_ON).toContain("web");
  expect(ALWAYS_ON).toContain("signals");
});

test("only the corpus is member-private, and its tools are recognised by prefix", () => {
  expect(PRIVATE_ONLY).toEqual(["corpus"]);
  expect(isPrivateOnlyTool("corpus__search")).toBe(true);
  expect(isPrivateOnlyTool("corpus__map_conversations")).toBe(true);
  expect(isPrivateOnlyTool("garden__list_notes")).toBe(false);
  expect(isPrivateOnlyTool("web_search")).toBe(false);
});

test("a turn with no selection at all still holds the corpus", () => {
  // No such conversation, no persona, no household default: the floor is the
  // always-on set, and the corpus is now part of it.
  const families = resolveFamilies("no-such-conversation", false, undefined);
  expect(families).not.toBe("all");
  expect(families as string[]).toContain("corpus");
});
