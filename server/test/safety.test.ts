import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";

// Shared-rooms safety surface (Phase 1): report / block / leave + operator
// review, and — load-bearing — the per-member isolation invariant: an admin
// (operator) cannot read a member's private 1:1 via any new path, and reports
// can only ever be created for shared rooms.
//
// Integration test against the running server on :3001 (restart it after the
// migration). Run: bun test server/test/safety.test.ts

const BASE = "https://localhost:3001/api";
const tls = { rejectUnauthorized: false } as any;
const DATA = process.env.MAURICE_DATA_DIR || join(process.env.HOME || "", ".maurice");

let adminTok = "", adminId = "", memberTok = "", memberId = "";
let roomId = "", privId = "";
const reportIds: string[] = [];

function tokenFor(db: Database, username: string): { id: string; tok: string } {
  const u = db.query(`SELECT id FROM users WHERE username = ?`).get(username) as { id: string };
  const t = db
    .query(`SELECT token_plain FROM api_tokens WHERE user_id = ? AND label = 'mcp-settings'`)
    .get(u.id) as { token_plain: string };
  return { id: u.id, tok: t.token_plain };
}

async function api(tok: string, method: string, p: string, body?: any) {
  const r = await fetch(BASE + p, {
    method,
    headers: { Authorization: "Bearer " + tok, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    tls,
  });
  return { status: r.status, json: await r.json().catch(() => null) } as { status: number; json: any };
}

beforeAll(async () => {
  const db = new Database(join(DATA, "maurice.db"));
  const a = tokenFor(db, "candide"); // admin / operator
  const m = tokenFor(db, "paola");   // standard / member
  adminId = a.id; adminTok = a.tok; memberId = m.id; memberTok = m.tok;
  db.close();

  // A shared room: admin creates it, adds the member → 2 participants.
  const room = await api(adminTok, "POST", "/conversations", {});
  roomId = room.json.id;
  await api(adminTok, "POST", `/conversations/${roomId}/participants`, { member_id: memberId });

  // A private 1:1 owned by the member (admin is NOT a participant).
  const priv = await api(memberTok, "POST", "/conversations", {});
  privId = priv.json.id;
});

afterAll(async () => {
  // Unblock + delete the rooms (cascades messages/participants/reports).
  await api(memberTok, "DELETE", `/users/${adminId}/block`);
  if (roomId) await api(adminTok, "DELETE", `/conversations/${roomId}`);
  if (privId) await api(memberTok, "DELETE", `/conversations/${privId}`);
});

async function roomMessages(tok: string): Promise<any[]> {
  const r = await api(tok, "GET", `/conversations/${roomId}`);
  return r.json?.messages ?? [];
}

describe("shared-rooms safety surface", () => {
  it("reports require a shared room and a valid reason", async () => {
    // Member posts nothing yet; report a member with a bad reason → 400.
    const bad = await api(memberTok, "POST", `/conversations/${roomId}/reports`, {
      target_type: "member", target_id: adminId, reason: "nonsense",
    });
    expect(bad.status).toBe(400);
  });

  it("member can report a message; child_safety sorts first for the operator", async () => {
    // Admin posts a message in the room (no summon → just stored).
    await api(adminTok, "POST", `/conversations/${roomId}/messages`, { content: "alpha", summon: false });
    const msgs = await roomMessages(memberTok);
    const alpha = msgs.find((m) => m.content === "alpha" && m.author_id === adminId);
    expect(alpha).toBeTruthy();

    // Member files a spam report on the message, then a child_safety report.
    const spam = await api(memberTok, "POST", `/conversations/${roomId}/reports`, {
      target_type: "message", target_id: alpha.id, reason: "spam",
    });
    expect(spam.status).toBe(201);
    reportIds.push(spam.json.report_id);

    const cs = await api(memberTok, "POST", `/conversations/${roomId}/reports`, {
      target_type: "member", target_id: adminId, reason: "child_safety", note: "test",
    });
    expect(cs.status).toBe(201);
    reportIds.push(cs.json.report_id);

    // Operator sees open reports, child_safety first, with the reported content.
    const open = await api(adminTok, "GET", `/reports?status=open`);
    expect(open.status).toBe(200);
    const ours = open.json.filter((r: any) => reportIds.includes(r.id));
    expect(ours.length).toBe(2);
    expect(ours[0].reason).toBe("child_safety"); // prioritized
    const spamView = ours.find((r: any) => r.id === spam.json.report_id);
    expect(spamView.reported_message?.content).toBe("alpha");
  });

  it("non-operator cannot review reports", async () => {
    const r = await api(memberTok, "GET", `/reports?status=open`);
    expect(r.status).toBe(403);
  });

  it("operator action removes the reported message", async () => {
    const spamId = reportIds[0];
    const r = await api(adminTok, "POST", `/reports/${spamId}/action`, { remove_message: true });
    expect(r.status).toBe(200);
    const msgs = await roomMessages(adminTok);
    expect(msgs.find((m) => m.content === "alpha")).toBeFalsy();
  });

  it("block hides the blocked member's messages on the read path", async () => {
    await api(adminTok, "POST", `/conversations/${roomId}/messages`, { content: "beta", summon: false });
    // Before blocking, the member sees the admin's message.
    let msgs = await roomMessages(memberTok);
    expect(msgs.find((m) => m.content === "beta")).toBeTruthy();
    // Block the admin (member↔member); the admin's messages vanish for the member.
    const b = await api(memberTok, "POST", `/users/${adminId}/block`, {});
    expect(b.status).toBe(201);
    msgs = await roomMessages(memberTok);
    expect(msgs.some((m) => m.author_id === adminId)).toBeFalse();
  });

  it("member can leave the room", async () => {
    const r = await api(memberTok, "POST", `/conversations/${roomId}/leave`, {});
    expect(r.status).toBe(200);
    const parts = await api(adminTok, "GET", `/conversations/${roomId}/participants`);
    expect(parts.json.some((p: any) => p.member_id === memberId)).toBeFalse();
  });

  it("operator can dismiss a report", async () => {
    const csId = reportIds[1];
    const r = await api(adminTok, "POST", `/reports/${csId}/dismiss`, {});
    expect(r.status).toBe(200);
    expect(r.json.status).toBe("dismissed");
  });
});

describe("isolation invariant (admin cannot reach a member's private data)", () => {
  it("admin cannot read a member's private 1:1 conversation", async () => {
    const r = await api(adminTok, "GET", `/conversations/${privId}`);
    expect(r.status).toBe(404);
  });

  it("a private 1:1 cannot be reported (so the operator review path never exposes it)", async () => {
    const r = await api(memberTok, "POST", `/conversations/${privId}/reports`, {
      target_type: "member", target_id: adminId, reason: "spam",
    });
    expect(r.status).toBe(400);
  });
});
