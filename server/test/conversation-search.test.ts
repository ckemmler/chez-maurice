import { describe, it, expect, beforeAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Full-text search over conversations: scoped to the member's rooms, matched
// on message content (accent-insensitive, prefix) and on titles, blocked
// authors withheld, and the index kept in step with deletes.

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "maurice-search-"));
// Files in one `bun test` run share the module cache — and so the database
// the first of them pointed db.ts at. Claim the data dir only if nobody has,
// and leave it to the OS: a later file may still be using it.
process.env.MAURICE_DATA_DIR ??= TMP;

let db: any;
let searchConversations: typeof import("../src/services/conversationSearch").searchConversations;
let ftsQuery: typeof import("../src/services/conversationSearch").ftsQuery;
let addMessage: typeof import("../src/services/conversations").addMessage;
let deleteLastAssistantMessage: typeof import("../src/services/conversations").deleteLastAssistantMessage;

function user(id: string) {
  db.run(`INSERT INTO users (id, username, display_name) VALUES (?, ?, ?)`, [id, id, id]);
}
function convo(id: string, owner: string, title: string, members: string[] = []) {
  db.run(`INSERT INTO conversations (id, user_id, title) VALUES (?, ?, ?)`, [id, owner, title]);
  for (const m of [owner, ...members]) {
    db.run(`INSERT INTO conversation_participants (conversation_id, member_id, role) VALUES (?, ?, ?)`, [
      id, m, m === owner ? "owner" : "member",
    ]);
  }
}

beforeAll(async () => {
  db = (await import("../src/db")).default;
  ({ searchConversations, ftsQuery } = await import("../src/services/conversationSearch"));
  ({ addMessage, deleteLastAssistantMessage } = await import("../src/services/conversations"));
  user("s-alice"); user("s-bob"); user("s-carol");
  convo("c1", "s-alice", "Vacances en Bretagne");
  addMessage("c1", "user", "On part à Quimper la deuxième semaine d'août", { authorId: "s-alice" });
  addMessage("c1", "assistant", "Quimper est agréable en août : marée, crêpes, et la cathédrale.");
  convo("c2", "s-bob", "Recette", ["s-alice"]);
  addMessage("c2", "user", "Une recette de crêpes sans gluten ?", { authorId: "s-bob" });
  addMessage("c2", "assistant", "Farine de sarrasin, lait, œufs, sel.");
  convo("c3", "s-carol", "Secret de Carol");
  addMessage("c3", "user", "crêpes crêpes crêpes", { authorId: "s-carol" });
});

describe("ftsQuery", () => {
  it("quotes every term as a prefix and drops FTS syntax", () => {
    expect(ftsQuery("bon mon")).toBe('"bon"* "mon"*');
    expect(ftsQuery('  "AND" near ')).toBe('"AND"* "near"*');
    expect(ftsQuery("   ")).toBe("");
  });
});

describe("searchConversations", () => {
  it("finds a word in a message, only in rooms the member sits in", () => {
    const hits = searchConversations("s-alice", "crêpes");
    expect(hits.map((h) => h.conversation.id).sort()).toEqual(["c1", "c2"]);
    expect(hits.find((h) => h.conversation.id === "c3")).toBeUndefined();
    const c2 = hits.find((h) => h.conversation.id === "c2")!;
    expect(c2.snippet).toContain("⟦crêpes⟧");
    expect(c2.message_id).toBeTruthy();
    expect(c2.hits).toBe(1);
    expect(c2.conversation.participants?.length).toBe(2);
  });

  it("is accent-insensitive and matches prefixes", () => {
    expect(searchConversations("s-alice", "crepe").map((h) => h.conversation.id).sort()).toEqual(["c1", "c2"]);
    expect(searchConversations("s-alice", "quimp").map((h) => h.conversation.id)).toEqual(["c1"]);
  });

  it("matches titles too, ranked after content hits", () => {
    const hits = searchConversations("s-alice", "Bretagne");
    expect(hits.map((h) => h.conversation.id)).toEqual(["c1"]);
    expect(hits[0].message_id).toBeNull();
    expect(hits[0].hits).toBe(0);
  });

  it("returns nothing for an empty query", () => {
    expect(searchConversations("s-alice", "   ")).toEqual([]);
  });

  it("withholds turns by a blocked member", () => {
    db.run(`INSERT INTO blocks (id, member_id, blocked_member_id) VALUES ('b1', 's-alice', 's-bob')`);
    try {
      const hits = searchConversations("s-alice", "gluten");
      expect(hits).toEqual([]);
      // Maurice's answer in the same room is still found.
      expect(searchConversations("s-alice", "sarrasin").map((h) => h.conversation.id)).toEqual(["c2"]);
    } finally {
      db.run(`DELETE FROM blocks WHERE id = 'b1'`);
    }
  });

  it("leaves an earlier answer alone when the thread ends on a member's message", () => {
    // A reply that never came: regenerate must answer the last message, not
    // erase the answer before it.
    const m = addMessage("c1", "user", "et la crypte ?", { authorId: "s-alice" });
    try {
      expect(deleteLastAssistantMessage("c1")).toBe(false);
      expect(searchConversations("s-alice", "cathédrale").length).toBe(1);
    } finally {
      db.run(`DELETE FROM messages WHERE id = ?`, [m.id]);
    }
  });

  it("keeps the index in step with deletes", () => {
    expect(searchConversations("s-alice", "cathédrale").length).toBe(1);
    deleteLastAssistantMessage("c1");
    expect(searchConversations("s-alice", "cathédrale").length).toBe(0);
    db.run(`DELETE FROM conversations WHERE id = 'c2'`);
    expect(searchConversations("s-alice", "sarrasin").length).toBe(0);
  });
});
