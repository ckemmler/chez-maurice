/**
 * What the system prompt says of a member's mail (services/claude.ts,
 * mailNotice): nothing to a member with no mailbox or without the email
 * tool; to one who linked mailboxes, that the store is there and to look at
 * it before the live mailbox; the fiches only once the reading was approved
 * and the garden tool is there; the address book only once one is linked.
 */
import { afterAll, beforeEach, expect, test } from "bun:test";

const db = (await import("../src/db")).default;
const { mailNotice } = await import("../src/services/claude");

const ANNA = "mn-anna";
const TOOLS = ["email__search", "email__exchanges", "email__get_message", "garden__get_fiche", "corpus__search"];

function reset() {
  db.run(`DELETE FROM mail_accounts WHERE member_id = ?`, [ANNA]);
  db.run(`DELETE FROM contact_accounts WHERE member_id = ?`, [ANNA]);
  db.run(`DELETE FROM mail_conversations WHERE member_id = ?`, [ANNA]);
}

beforeEach(() => {
  reset();
  db.run(`INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES (?, ?, ?, 'standard')`, [ANNA, ANNA, "Anna"]);
});
afterAll(reset);

const linkMail = () => {
  db.run(`INSERT INTO mail_accounts (id, member_id, address, provider, secret) VALUES ('mn-1', ?, 'anna@proton.me', 'proton', 'v1:x')`, [ANNA]);
  db.run(`INSERT INTO mail_accounts (id, member_id, address, secret) VALUES ('mn-2', ?, 'anna@gmail.com', 'v1:x')`, [ANNA]);
};

test("nothing without a mailbox, or without the tool", () => {
  expect(mailNotice(TOOLS, ANNA, "Anna")).toBe("");
  linkMail();
  expect(mailNotice(TOOLS.filter((t) => t !== "email__exchanges"), ANNA, "Anna")).toBe("");
  expect(mailNotice(TOOLS, null, "Anna")).toBe("");
});

test("mailboxes linked, no reading yet: the store first, then the live mailbox; no fiches promised", () => {
  linkMail();
  const n = mailNotice(TOOLS, ANNA, "Anna");
  expect(n).toContain("## Anna's mail");
  expect(n).toContain("(Gmail, Proton)");
  expect(n).toContain("1. email__exchanges");
  expect(n).toContain("2. The live mailbox");
  expect(n).not.toContain("fiche");
  expect(n).not.toContain("address book");
});

test("the reading approved and an address book linked: the fiche comes first, with its fragments", () => {
  linkMail();
  db.run(`INSERT INTO mail_conversations (member_id, conversation_id, reading) VALUES (?, 'c-mn', 'approved')`, [ANNA]);
  db.run(`INSERT INTO contact_accounts (id, member_id, username, secret, state, cards) VALUES ('mn-c', ?, 'anna@icloud.com', 'v1:x', 'ok', 40)`, [ANNA]);
  const n = mailNotice(TOOLS, ANNA, "Anna");
  expect(n).toContain("and their address book");
  expect(n).toContain("each person who matters has a private fiche");
  expect(n).toMatch(/1\. Their fiche: garden__get_fiche[^\n]*fragments/);
  expect(n).toContain("2. email__exchanges");
  expect(n).toContain("3. The live mailbox");
  // Without the garden tool, the fiche is not a step it could take.
  expect(mailNotice(TOOLS.filter((t) => t !== "garden__get_fiche"), ANNA, "Anna")).toContain("1. email__exchanges");
});

test("the corpus notice asks for the people as a layer of their own, and to open a person's fiche", async () => {
  const { corpusNotice } = await import("../src/services/claude");
  const n = corpusNotice(["corpus__search", "garden__get_fiche"]);
  expect(n).toContain(`filters {"collection": "people"}`);
  expect(n).toContain(`"my accountant"`);
  expect(n).toContain("open it (garden__get_fiche");
  expect(n.indexOf(`{"collection": "people"}`)).toBeLessThan(n.indexOf(`"source_type": ["note"`));
  expect(corpusNotice(["corpus__search"])).not.toContain("garden__get_fiche");
});
