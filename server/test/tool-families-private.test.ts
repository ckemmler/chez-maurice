// The corpus is an always-on family, and a member-private one (20 September
// 2026). Four things are nailed down here: it rides in every private turn
// without anyone selecting it or being granted experimental access; it is
// withheld the moment a conversation has a second participant — the same rule
// the domain briefs follow, so one member's indexed life is not read out to
// the others in a room; its writing tools are never handed to a model at all;
// and a turn that did not ask for the family by name gets the two everyday
// reading tools rather than the whole roster.

import { expect, test } from "bun:test";

const {
  ALWAYS_ON,
  PRIVATE_ONLY,
  isPrivateOnlyTool,
  isExperimentalTool,
  resolveFamilies,
  selectedFamilies,
  corpusToolAllowed,
} = await import("../src/services/toolFamilies");

test("the corpus is always on and no longer experimental", () => {
  expect(ALWAYS_ON).toContain("corpus");
  expect(isExperimentalTool("corpus__search")).toBe(false);
  // The two it joined are untouched.
  expect(ALWAYS_ON).toContain("web");
  expect(ALWAYS_ON).toContain("signals");
});

test("the corpus and the mailboxes are member-private, recognised by prefix", () => {
  expect(PRIVATE_ONLY).toEqual(["corpus", "email", "mail"]);
  expect(isPrivateOnlyTool("corpus__search")).toBe(true);
  expect(isPrivateOnlyTool("corpus__map_conversations")).toBe(true);
  // A room would otherwise hear whoever spoke have their mail read out.
  expect(isPrivateOnlyTool("email__search")).toBe(true);
  expect(isPrivateOnlyTool("email__get_message")).toBe(true);
  expect(isPrivateOnlyTool("mail__latest_proposal")).toBe(true);
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

test("holding the family is not the same as having asked for it", () => {
  // What the turn chose, before the always-on union: nothing.
  expect(selectedFamilies("no-such-conversation")).toEqual([]);
});

test("the corpus tools that write are never offered, selection or not", () => {
  for (const explicit of [false, true]) {
    expect(corpusToolAllowed("corpus__prune", explicit)).toBe(false);
    expect(corpusToolAllowed("corpus__reindex", explicit)).toBe(false);
    expect(corpusToolAllowed("corpus__index_path", explicit)).toBe(false);
    expect(corpusToolAllowed("corpus__index_conversation", explicit)).toBe(false);
    expect(corpusToolAllowed("corpus__import_chat_export", explicit)).toBe(false);
    expect(corpusToolAllowed("corpus__map_conversations", explicit)).toBe(false);
  }
});

test("an unselected turn gets search and widening, a selected one gets the reading roster", () => {
  // Always on: the two that remembering needs.
  expect(corpusToolAllowed("corpus__search", false)).toBe(true);
  expect(corpusToolAllowed("corpus__get_chunk_context", false)).toBe(true);
  // The rest waits for a turn that asked for the family.
  expect(corpusToolAllowed("corpus__search_in_book", false)).toBe(false);
  expect(corpusToolAllowed("corpus__list_dossiers", false)).toBe(false);
  expect(corpusToolAllowed("corpus__search_in_book", true)).toBe(true);
  expect(corpusToolAllowed("corpus__list_dossiers", true)).toBe(true);
  // Other families are none of this function's business.
  expect(corpusToolAllowed("garden__list_notes", false)).toBe(true);
});

test("a member who added a mailbox holds the Email family, without the experimental tick", async () => {
  const { default: db } = await import("../src/db");
  const { createMailAccount } = await import("../src/services/mailAccounts");
  const { hasMailAccount } = await import("../src/services/toolFamilies");
  db.run(`INSERT OR IGNORE INTO households (id, name) VALUES ('default', 'Home')`);
  db.run(`INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES ('tf-mail', 'tf-mail', 'Mail', 'standard')`);
  expect(hasMailAccount("tf-mail")).toBe(false);
  expect(resolveFamilies("no-such-conversation", false, "tf-mail") as string[]).not.toContain("email");
  createMailAccount("tf-mail", { address: "tf@gmail.com", password: "x" });
  expect(resolveFamilies("no-such-conversation", false, "tf-mail") as string[]).toContain("email");
  // Granted by the mailbox, not by the admin: never withheld as experimental…
  expect(isExperimentalTool("email__search")).toBe(false);
  // …and still never in a room.
  expect(isPrivateOnlyTool("email__search")).toBe(true);
  // A member without a mailbox does not get it.
  expect(resolveFamilies("no-such-conversation", false, "someone-else") as string[]).not.toContain("email");
});

test("the picker shows Email where it is true for this member", async () => {
  const { default: db } = await import("../src/db");
  const { familiesForMember } = await import("../src/services/toolFamilies");
  db.run(`INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES ('tf-admin', 'tf-admin', 'Admin', 'admin')`);
  db.run(`INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES ('tf-plain', 'tf-plain', 'Plain', 'standard')`);
  const all = [
    { id: "web", title: "Web search", icon: "globe", blurb: "", count: 1, group: "core" as const, alwaysOn: true },
    { id: "email", title: "Email", icon: "envelope", blurb: "", count: 6, group: "core" as const, alwaysOn: false },
  ];
  const email = (member: string) => familiesForMember(all, member).find((f) => f.id === "email");
  // tf-mail added a mailbox above: always on, listed with web.
  expect(email("tf-mail")).toMatchObject({ group: "core", alwaysOn: true });
  // An admin without one (their mailbox is in email.toml): offered, to tick by hand.
  expect(email("tf-admin")).toMatchObject({ group: "experimental", alwaysOn: false });
  // A member with neither a mailbox nor experimental access: not offered.
  expect(email("tf-plain")).toBeUndefined();
});
