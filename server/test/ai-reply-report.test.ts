/**
 * Reporting a reply of Maurice's (App Review 1.2): possible in a private
 * conversation, and what reaches the operator is the copy of the reply and of
 * the question before it — not the conversation.
 */
import { afterAll, expect, test } from "bun:test";
import { MEMBER } from "./_member";

const db = (await import("../src/db")).default;
const conversations = (await import("../src/routes/conversations")).default;
const { createSession } = await import("../src/services/auth");
const { listReports, actionReport, dismissReport } = await import("../src/services/safety");

const auth = { Authorization: `Bearer ${createSession(MEMBER.id).token}`, "Content-Type": "application/json" };
const CONVO = "ai-report-convo";

db.run(`INSERT OR IGNORE INTO conversations (id, user_id, title) VALUES (?, ?, 'Private')`, [CONVO, MEMBER.id]);
db.run(`INSERT OR IGNORE INTO conversation_participants (conversation_id, member_id) VALUES (?, ?)`, [CONVO, MEMBER.id]);
db.run(`INSERT OR IGNORE INTO messages (id, conversation_id, role, content, created_at) VALUES ('q1', ?, 'user', 'Is this mushroom safe?', '2026-10-29 10:00:00')`, [CONVO]);
db.run(`INSERT OR IGNORE INTO messages (id, conversation_id, role, content, created_at) VALUES ('a1', ?, 'assistant', 'Yes, eat it raw.', '2026-10-29 10:00:05')`, [CONVO]);

afterAll(() => {
  db.run(`DELETE FROM ai_reply_reports WHERE conversation_id = ?`, [CONVO]);
  db.run(`DELETE FROM conversations WHERE id = ?`, [CONVO]);
});

const report = (body: unknown) =>
  conversations.request(`/${CONVO}/reports`, { method: "POST", headers: auth, body: JSON.stringify(body) });

test("a reply of Maurice's can be reported in a private conversation, with the copy the operator reads", async () => {
  const res = await report({ target_type: "ai_reply", target_id: "a1", reason: "harmful_or_misleading", note: "dangerous" });
  expect(res.status).toBe(201);
  const { report_id } = (await res.json()) as { report_id: string };

  const open = listReports("open").find((r) => r.id === report_id)!;
  expect(open.target_type).toBe("ai_reply");
  expect(open.reported_message?.content).toBe("Yes, eat it raw.");
  expect(open.reported_question).toBe("Is this mushroom safe?");
  // The conversation's own title is not shown to the operator.
  expect(open.room_title).toBe(null);

  expect(actionReport(report_id, {})?.status).toBe("actioned");
  // Handling it removes nothing from the member's conversation.
  expect(db.query(`SELECT 1 FROM messages WHERE id = 'a1'`).get()).not.toBe(null);
});

test("only a reply of Maurice's can be reported that way, for a known reason", async () => {
  expect((await report({ target_type: "ai_reply", target_id: "q1", reason: "other" })).status).toBe(400);
  expect((await report({ target_type: "ai_reply", target_id: "a1", reason: "nonsense" })).status).toBe(400);
  // A member's own message in a private conversation is still not reportable.
  expect((await report({ target_type: "message", target_id: "q1", reason: "spam" })).status).toBe(400);
});

test("a dismissed report leaves the open queue", async () => {
  const res = await report({ target_type: "ai_reply", target_id: "a1", reason: "other" });
  const { report_id } = (await res.json()) as { report_id: string };
  expect(dismissReport(report_id)?.status).toBe("dismissed");
  expect(listReports("open").some((r) => r.id === report_id)).toBe(false);
});
