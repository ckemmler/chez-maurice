/**
 * A member imports their own history (routes/import.ts, services/chatImport.ts)
 * and the night sees it (P4 of the domains' roadmap). Nailed down here: the
 * route is the member's own — a guest is refused, only a .zip is taken, the
 * corpus is asked for the caller and the file is where it says; status and
 * history are proxied; the everyday prompt's one sentence about the import
 * exists for a member who never imported and vanishes once a history is in;
 * and the two nights read an imported conversation whatever dates its export
 * carries — the mapping reads it like any unbound conversation, and the
 * briefs read it whole once, when `imported_at` is past the brief's last
 * rewrite, then not again.
 */
import { beforeAll, beforeEach, expect, test } from "bun:test";
import { existsSync } from "fs";

const { default: db } = await import("../src/db");
const chatImport = await import("../src/services/chatImport");
const routes = (await import("../src/routes/import")).default;
const { createSession } = await import("../src/services/auth");
const briefs = await import("../src/services/domainBriefs");
const mapping = await import("../src/services/domainMapping");

const ANNA = "imp-anna";
const GUEST = "imp-guest";
let annaAuth = "";
let guestAuth = "";

let calls: Array<{ memberId: string; tool: string; args: any }> = [];
let fail = false;

beforeAll(() => {
  db.run(`INSERT OR IGNORE INTO households (id, name) VALUES ('default', 'Home')`);
  for (const [id, name, role] of [[ANNA, "Anna", "standard"], [GUEST, "Gus", "guest"]] as const) {
    db.run(`INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES (?, ?, ?, ?)`, [id, id, name, role]);
  }
  annaAuth = `Bearer ${createSession(ANNA).token}`;
  guestAuth = `Bearer ${createSession(GUEST).token}`;
  chatImport.setImportDeps({
    call: async (memberId, tool, args) => {
      calls.push({ memberId, tool, args });
      if (fail) throw new Error("gateway down");
      if (tool === "import_chat_export") return { job_id: "job-1", provider: args.provider };
      if (tool === "import_status") return { phase: "done", status: "done", done: 3, total: 3 };
      return { member_id: memberId, provider: args.provider, watermark: null, history: [] };
    },
  });
  briefs.setBriefDeps({ write: async () => { throw new Error("not called"); }, search: async () => [] });
});

beforeEach(() => {
  calls = [];
  fail = false;
  db.run(`DELETE FROM conversations WHERE user_id IN (?, ?)`, [ANNA, GUEST]);
  db.run(`DELETE FROM domain_briefs`);
  db.run(`DELETE FROM maurices WHERE created_by = ?`, [ANNA]);
});

function upload(auth: string, name: string, query = "?provider=chatgpt") {
  const form = new FormData();
  form.append("file", new File(["PK not really a zip"], name, { type: "application/zip" }));
  return routes.request(`/${query}`, { method: "POST", headers: { Authorization: auth }, body: form });
}

// ── The route ────────────────────────────────────────────────────────────────

test("a guest cannot import: their life is elsewhere", async () => {
  const r = await upload(guestAuth, "export.zip");
  expect(r.status).toBe(403);
  expect(calls).toHaveLength(0);
});

test("only a .zip, only a known provider", async () => {
  expect((await upload(annaAuth, "export.json")).status).toBe(400);
  expect((await upload(annaAuth, "export.zip", "?provider=gemini")).status).toBe(400);
  expect(calls).toHaveLength(0);
});

test("the export is saved and the corpus asked for the caller", async () => {
  const r = await upload(annaAuth, "conversations.zip");
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ job_id: "job-1", provider: "chatgpt" });
  expect(calls).toHaveLength(1);
  const { memberId, tool, args } = calls[0]!;
  expect(memberId).toBe(ANNA);
  expect(tool).toBe("import_chat_export");
  expect(args.member_id).toBe(ANNA);
  expect(args.provider).toBe("chatgpt");
  expect(args.path.startsWith(chatImport.uploadsDir())).toBe(true);
  expect(existsSync(args.path)).toBe(true);
});

test("status and history are proxied for the caller; a gateway down is a 502", async () => {
  const s = await routes.request("/status?job=job-1", { headers: { Authorization: annaAuth } });
  expect(s.status).toBe(200);
  expect((await s.json()).phase).toBe("done");
  const h = await routes.request("/history?provider=anthropic", { headers: { Authorization: annaAuth } });
  expect(await h.json()).toMatchObject({ member_id: ANNA, provider: "anthropic" });
  expect((await routes.request("/status", { headers: { Authorization: annaAuth } })).status).toBe(400);
  fail = true;
  expect((await routes.request("/history", { headers: { Authorization: annaAuth } })).status).toBe(502);
});

// ── The one sentence of the prompt ───────────────────────────────────────────

test("the prompt mentions the import to a member who never did it, never to a guest, not after", () => {
  expect(chatImport.importHintSection(GUEST, "Gus")).toBe("");
  const s = chatImport.importHintSection(ANNA, "Anna");
  expect(s).toContain("Import my conversations");
  expect(s).toContain("Do not bring it up otherwise");
  db.run(`INSERT INTO conversations (id, user_id, title, origin, imported_at) VALUES ('imp-c1', ?, 'Old thread', 'chatgpt', datetime('now'))`, [ANNA]);
  expect(chatImport.hasImported(ANNA)).toBe(true);
  expect(chatImport.importHintSection(ANNA, "Anna")).toBe("");
});

// ── The nights ───────────────────────────────────────────────────────────────

function imported(id: string, title: string, when: string, importedAt: string) {
  db.run(`INSERT INTO conversations (id, user_id, title, origin, imported_at, created_at, updated_at) VALUES (?, ?, ?, 'chatgpt', ?, ?, ?)`, [id, ANNA, title, importedAt, when, when]);
  db.run(`INSERT INTO conversation_participants (conversation_id, member_id, role) VALUES (?, ?, 'owner')`, [id, ANNA]);
  db.run(`INSERT INTO messages (id, conversation_id, role, content, created_at, author_id) VALUES (?, ?, 'user', ?, ?, ?)`, [crypto.randomUUID(), id, `About ${title}, at length.`, when, ANNA]);
  db.run(`INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, 'assistant', 'Here is what I know.', ?)`, [crypto.randomUUID(), id, when.replace(":00:00", ":01:00")]);
}

test("the mapping reads an imported conversation like any unbound one, old dates included", () => {
  imported("imp-m1", "Bread in 2024", "2024-03-02 10:00:00", "2026-09-19 10:00:00");
  const ids = mapping.unattachedConversations(ANNA).map((c) => c.id);
  expect(ids).toContain("imp-m1");
  const c = mapping.unattachedConversations(ANNA).find((c) => c.id === "imp-m1")!;
  expect(c.origin).toBe("chatgpt");
  expect(c.first.startsWith("2024-03-02")).toBe(true);
});

test("the briefs read an imported conversation whole once, then not again", async () => {
  db.run(`INSERT INTO maurices (id, name, tagline, created_by, kind) VALUES ('imp-dom', 'Bread', 'Sourdough', ?, 'domain')`, [ANNA]);
  const domain = { id: "imp-dom", name: "Bread", tagline: "Sourdough", prompt: null } as any;
  // A brief written on the 11th that read up to a message of the 10th.
  db.run(`INSERT INTO domain_briefs (maurice_id, member_id, text, updated_at, sources_json, read_until, model) VALUES ('imp-dom', ?, 'You bake.', '2026-09-11 04:00:00', '[]', '2026-09-10 21:00:00', 'night')`, [ANNA]);
  // An old ChatGPT thread, bound to the domain, imported on the 15th.
  imported("imp-b1", "Starter troubles", "2024-05-06 10:00:00", "2026-09-15 12:00:00");
  db.run(`UPDATE conversations SET maurice_id = 'imp-dom' WHERE id = 'imp-b1'`);

  // The timestamp alone would miss it: nothing after read_until.
  const blind = await briefs.findMaterial(ANNA, domain, "2026-09-10 21:00:00", "Anna");
  expect(blind.map((m) => m.conversation_id)).not.toContain("imp-b1");
  // With the brief's wall-clock, it is read whole.
  const seen = await briefs.findMaterial(ANNA, domain, "2026-09-10 21:00:00", "Anna", "2026-09-11 04:00:00");
  const m = seen.find((m) => m.conversation_id === "imp-b1")!;
  expect(m).toBeDefined();
  expect(m.turns).toHaveLength(2);
  expect(m.turns[0]!.created_at.startsWith("2024-05-06")).toBe(true);
  // A brief rewritten after the import (its updated_at past imported_at): not again.
  const after = await briefs.findMaterial(ANNA, domain, "2026-09-10 21:00:00", "Anna", "2026-09-16 04:00:00");
  expect(after.map((m) => m.conversation_id)).not.toContain("imp-b1");
  // And the material never moves read_until backwards: doRefresh seeds the
  // reduce with `since`, which this file checks by the shape of turns only.
});
