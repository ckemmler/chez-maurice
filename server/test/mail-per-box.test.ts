/**
 * A yes per mailbox (28 September 2026): the yes to reading covers the
 * mailboxes there are; one added after it is not read without its own —
 * the reading asks the tool for the approved mailboxes only, Maurice says
 * so in the mail conversation, and a yes to one mailbox (the app's
 * "Read this mailbox", or the conversation's tool with `mailbox`) marks
 * that one alone.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";

const { default: db } = await import("../src/db");
const accounts = await import("../src/services/mailAccounts");
const approval = await import("../src/services/mailApproval");
const reading = await import("../src/services/mailReading");
const est = await import("../src/services/mailboxEstimate");

const M = "perbox-m";
const calls: Array<{ tool: string; args: any }> = [];

beforeAll(() => {
  db.run(`INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES (?, ?, 'M', 'standard')`, [M, M]);
  db.run(`INSERT OR IGNORE INTO mail_accounts (id, member_id, address, secret, state) VALUES ('pb-1', ?, 'first@example.org', 'v1:x', 'ok')`, [M]);
  const c = crypto.randomUUID();
  db.run(`INSERT INTO conversations (id, user_id, title, opened_by) VALUES (?, ?, 'Ta boîte', 'maurice')`, [c, M]);
  approval.linkMailConversation(M, c);
  reading.setMailReadingDeps({
    call: async (_m: string, tool: string, args: any) => {
      calls.push({ tool, args });
      if (tool === "reading_progress") return { job: { id: "job-pb", state: "approved" }, progress: { to_light: 0, to_read: 0 } };
      return {};
    },
  });
});

afterAll(() => reading.setMailReadingDeps(null));

test("the yes covers the mailboxes there are; one added later is not read, and the reading asks for the approved ones only", async () => {
  expect(accounts.approvedMailboxAddresses(M)).toEqual([]);
  expect(accounts.approveMailboxes(M)).toBe(1);
  db.run(`UPDATE mail_conversations SET reading = 'approved' WHERE member_id = ?`, [M]);
  db.run(`INSERT OR IGNORE INTO mail_accounts (id, member_id, address, secret, state) VALUES ('pb-2', ?, 'Later@Example.org', 'v1:x', 'ok')`, [M]);
  expect(accounts.approvedMailboxAddresses(M)).toEqual(["first@example.org"]);
  calls.length = 0;
  await reading.runMailReading(M);
  expect(calls.find((c) => c.tool === "reading_progress")!.args.addresses).toEqual(["first@example.org"]);
});

test("Maurice says what an added mailbox would take, never the money, and waits for its yes", () => {
  const box: est.MailboxView = {
    address: "later@example.org", messages: 12345, untriaged: 0,
    reading: { window: 900, to_light: 600, kept: 100, skipped: 200, to_read: 100, read: 0 },
    top_senders: [],
    estimate: { to_sort: 600, to_read: 300, hours: 0.4, euros: 4.2, basis: "formula", pending: false },
  };
  const fr = est.newMailboxNotice("fr", "later@example.org", box);
  expect(fr).toContain("**later@example.org**");
  expect(fr).toContain("moins d'une heure");
  expect(fr).toContain("Lire cette boîte");
  expect(fr).not.toContain("€");
});

test("in the conversation, a yes to one mailbox marks that one alone", async () => {
  const mc = approval.mailConversationOf(M)!;
  expect(approval.mailPromptSection(mc.conversation_id, M, "M")).toContain("Later@Example.org");
  const out = await approval.runMailTool({ action: "approve", mailbox: "later@example.org" }, mc.conversation_id);
  expect(out.isError).toBe(false);
  expect(accounts.approvedMailboxAddresses(M).sort()).toEqual(["first@example.org", "later@example.org"]);
  expect((await approval.runMailTool({ action: "approve", mailbox: "nobody@example.org" }, mc.conversation_id)).isError).toBe(true);
});

test("with more than one mailbox, the mail conversation speaks of all the mail, and says which mailboxes a message is about", async () => {
  const docs = await import("../src/services/mailDocuments");
  const mc = approval.mailConversationOf(M)!;
  db.run(`UPDATE conversations SET title = 'Ta boîte Proton, en chiffres' WHERE id = ?`, [mc.conversation_id]);
  expect(approval.ensureMailConversationTitle(M)).toBe(true); // two mailboxes by now
  const title = (db.query(`SELECT title FROM conversations WHERE id = ?`).get(mc.conversation_id) as { title: string }).title;
  expect(title).not.toContain("Proton");
  expect(approval.ensureMailConversationTitle(M)).toBe(false); // once
  const run = { outcome: "written", member_id: M, written: [{ kind: "person", key: "k", slug: "s", title: "Salman", web_path: "/x", sources: 1 }],
    skipped: { unchanged: 0, deleted: 0, too_few: 0, declined: 0 }, cost: 0, model: "m", error: null, said: null, mailboxes: ["later@example.org"] } as any;
  const id = docs.sayDocumentsWritten(M, run, { root: "/tmp/none", username: M })!;
  const said = (db.query(`SELECT content FROM messages WHERE id = ?`).get(id) as { content: string }).content;
  expect(said).toContain("later@example.org");
});
