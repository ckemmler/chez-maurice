// The personas become domains (P3-B of the domains' roadmap). Nailed down
// here: the one-time sort of the rows that predate `maurices.kind` — a book
// followed at the reading position is a reading companion, everything else a
// domain — and that it never revisits a row; a NULL kind reads as `domain`;
// a companion has no brief (the night skips it, the brief routes answer 404,
// the everyday prompt leaves it out); `GET /api/domains` lists a member's
// domains and companions, a guest's granted ones, with the brief's date and
// the companion's pinned conversation; `kind` on POST and PATCH is the
// member's hand on the sort; `hat` and `palette` are no longer read or
// written.

import { beforeAll, beforeEach, expect, test } from "bun:test";

const { default: db, mauriceKindOf, migrateMauriceKinds } = await import("../src/db");
const maurices = await import("../src/services/maurices");
const briefs = await import("../src/services/domainBriefs");
const domainRoutes = (await import("../src/routes/domains")).default;
const mauriceRoutes = (await import("../src/routes/maurices")).default;
const { createSession } = await import("../src/services/auth");

const ANNA = "dk-anna";
const GUEST = "dk-guest";
let annaAuth = "";
let guestAuth = "";

const PROGRESS_BOOK = JSON.stringify({
  items: [{ type: "book", id: 190, representation: "summary", scope: { mode: "progress" }, snapshot: { weight: 2550, count: 3, refs: [], tracksProgress: true, progressChapter: 2 } }],
  resolved_at: "2026-09-18T21:54:53.190Z",
});
const WHOLE_BOOK = JSON.stringify({
  items: [{ type: "book", id: 165, representation: "summary", scope: { mode: "all" }, snapshot: { weight: 16994, count: 31, refs: [] } }],
  resolved_at: "2026-09-18T21:54:53.190Z",
});
const NOTES = JSON.stringify({ items: [{ type: "note", id: "n-1", snapshot: { weight: 100, count: 1 } }], resolved_at: "" });

function req(router: any, auth: string, path: string, init: RequestInit = {}) {
  return router.request(path, { ...init, headers: { Authorization: auth, "Content-Type": "application/json", ...(init.headers ?? {}) } });
}

beforeAll(() => {
  db.run(`INSERT OR IGNORE INTO households (id, name) VALUES ('default', 'Home')`);
  db.run(`INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES (?, ?, 'Anna', 'standard')`, [ANNA, ANNA]);
  db.run(`INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES (?, ?, 'Gus', 'guest')`, [GUEST, GUEST]);
  annaAuth = `Bearer ${createSession(ANNA).token}`;
  guestAuth = `Bearer ${createSession(GUEST).token}`;
});

beforeEach(() => {
  db.run(`DELETE FROM maurices WHERE id LIKE 'dk-%'`);
  db.run(`DELETE FROM conversations WHERE id LIKE 'dk-%'`);
});

// ── The sort ─────────────────────────────────────────────────────────────────

test("a book followed at the reading position is a companion; a whole book, notes, or nothing is a domain", () => {
  expect(mauriceKindOf(PROGRESS_BOOK)).toBe("companion");
  expect(mauriceKindOf(WHOLE_BOOK)).toBe("domain");
  expect(mauriceKindOf(NOTES)).toBe("domain");
  expect(mauriceKindOf('{"items":[]}')).toBe("domain");
  expect(mauriceKindOf("not json")).toBe("domain");
  // A snapshot that tracks progress counts even without the scope.
  expect(mauriceKindOf(JSON.stringify({ items: [{ type: "book", id: 1, snapshot: { tracksProgress: true } }] }))).toBe("companion");
  // Two items are a domain even when one is a followed book.
  expect(mauriceKindOf(JSON.stringify({ items: [{ type: "book", id: 1, scope: { mode: "progress" } }, { type: "note", id: "n" }] }))).toBe("domain");
});

test("the migration sorts the rows that predate the column, once, and leaves a member's hand alone", () => {
  // Rows as an older server left them: no kind at all.
  db.run(`INSERT INTO maurices (id, name, context_json, created_by, kind) VALUES ('dk-jttw', 'JTTW guide', ?, ?, NULL)`, [PROGRESS_BOOK, ANNA]);
  db.run(`INSERT INTO maurices (id, name, context_json, created_by, kind) VALUES ('dk-yijing', 'Yi Jing', ?, ?, NULL)`, [WHOLE_BOOK, ANNA]);
  db.run(`INSERT INTO maurices (id, name, context_json, created_by, kind) VALUES ('dk-chosen', 'Chosen', ?, ?, 'domain')`, [PROGRESS_BOOK, ANNA]);
  migrateMauriceKinds();
  const kinds = Object.fromEntries(
    (db.query(`SELECT id, kind FROM maurices WHERE id LIKE 'dk-%'`).all() as Array<{ id: string; kind: string }>).map((r) => [r.id, r.kind]),
  );
  expect(kinds).toEqual({ "dk-jttw": "companion", "dk-yijing": "domain", "dk-chosen": "domain" });
  // Flipped by hand, then the migration runs again (every boot): untouched.
  db.run(`UPDATE maurices SET kind = 'domain' WHERE id = 'dk-jttw'`);
  migrateMauriceKinds();
  expect((db.query(`SELECT kind FROM maurices WHERE id = 'dk-jttw'`).get() as any).kind).toBe("domain");
});

test("a NULL kind reads as a domain; hat and palette are neither read nor written", () => {
  db.run(`INSERT INTO maurices (id, name, created_by, kind) VALUES ('dk-null', 'Old', ?, NULL)`, [ANNA]);
  const m = maurices.getMaurice("dk-null")!;
  expect(m.kind).toBe("domain");
  expect(maurices.isDomain(m)).toBe(true);
  expect("hat" in m).toBe(false);
  expect("palette" in m).toBe(false);
  const made = maurices.createMaurice(ANNA, { name: "Fresh", hat: "wizard", palette: "plum" } as any) as maurices.Maurice;
  const row = db.query(`SELECT hat, palette, kind FROM maurices WHERE id = ?`).get(made.id) as any;
  expect(row).toEqual({ hat: "boater", palette: "ink", kind: "domain" });
  db.run(`DELETE FROM maurices WHERE id = ?`, [made.id]);
});

// ── What a companion is not ──────────────────────────────────────────────────

test("a companion is not a domain: no brief for the night, none in the prompt, 404 on the brief routes", async () => {
  db.run(`INSERT INTO maurices (id, name, context_json, created_by, kind) VALUES ('dk-jttw', 'JTTW guide', ?, ?, 'companion')`, [PROGRESS_BOOK, ANNA]);
  db.run(`INSERT INTO maurices (id, name, created_by, kind) VALUES ('dk-health', 'Health', ?, 'domain')`, [ANNA]);
  expect(briefs.domainsOf(ANNA).map((d) => d.id)).toEqual(["dk-health"]);
  expect(maurices.isDomain(maurices.getMaurice("dk-jttw")!)).toBe(false);
  expect(maurices.companionBookId(maurices.getMaurice("dk-jttw")!)).toBe(190);
  expect(maurices.companionBookId(maurices.getMaurice("dk-health")!)).toBeNull();

  // A brief left behind by the night before the sort stays in the table but
  // reaches nobody: not the prompt, not the routes.
  db.run(`INSERT INTO domain_briefs (maurice_id, member_id, text) VALUES ('dk-jttw', ?, 'Chapter 3: Monkey.')`, [ANNA]);
  expect(briefs.briefsForPrompt(ANNA, "Anna")).not.toContain("Monkey");
  const get = await req(domainRoutes, annaAuth, "/dk-jttw/brief");
  expect(get.status).toBe(404);
  expect((await get.json()).error).toContain("reading companion");
  expect((await req(domainRoutes, annaAuth, "/dk-jttw/brief", { method: "PUT", body: JSON.stringify({ text: "x" }) })).status).toBe(404);
  expect((await req(domainRoutes, annaAuth, "/dk-jttw/brief", { method: "DELETE" })).status).toBe(404);
  expect((await req(domainRoutes, annaAuth, "/dk-jttw/brief/refresh", { method: "POST" })).status).toBe(404);
  // The domain beside it is served as before.
  expect((await req(domainRoutes, annaAuth, "/dk-health/brief")).status).toBe(200);
  db.run(`DELETE FROM domain_briefs WHERE maurice_id = 'dk-jttw'`);
});

// ── The list ─────────────────────────────────────────────────────────────────

test("GET /api/domains lists a member's domains with their brief's date, and their companions with the pinned conversation", async () => {
  db.run(`INSERT INTO maurices (id, name, tagline, created_by, kind) VALUES ('dk-health', 'Health', 'Blood tests', ?, 'domain')`, [ANNA]);
  db.run(`INSERT INTO maurices (id, name, created_by, kind) VALUES ('dk-house', 'House', ?, 'domain')`, [ANNA]);
  db.run(`INSERT INTO maurices (id, name, context_json, created_by, kind) VALUES ('dk-jttw', 'JTTW guide', ?, ?, 'companion')`, [PROGRESS_BOOK, ANNA]);
  db.run(`INSERT INTO domain_briefs (maurice_id, member_id, text, updated_at, sources_json, model) VALUES ('dk-health', ?, 'LDL 160.', '2026-09-19 04:00:00', '["c-1","c-2"]', 'deepseek')`, [ANNA]);
  db.run(`INSERT INTO conversations (id, user_id, title, maurice_id, updated_at) VALUES ('dk-c-old', ?, 'Chapter 1', 'dk-jttw', '2026-09-10 10:00:00')`, [ANNA]);
  db.run(`INSERT INTO conversation_participants (conversation_id, member_id, role) VALUES ('dk-c-old', ?, 'owner')`, [ANNA]);
  db.run(`INSERT INTO conversations (id, user_id, title, maurice_id, updated_at) VALUES ('dk-c-new', ?, 'Chapter 3', 'dk-jttw', '2026-09-18 10:00:00')`, [ANNA]);
  db.run(`INSERT INTO conversation_participants (conversation_id, member_id, role) VALUES ('dk-c-new', ?, 'owner')`, [ANNA]);

  const r = await req(domainRoutes, annaAuth, "/");
  expect(r.status).toBe(200);
  const j = await r.json();
  expect(j.domains.map((d: any) => d.id)).toEqual(["dk-health", "dk-house"]);
  expect(j.domains[0]).toMatchObject({ name: "Health", tagline: "Blood tests", kind: "domain", mine: true, brief: { updated_at: "2026-09-19 04:00:00", model: "deepseek", sources: 2 } });
  expect(j.domains[1].brief).toBeNull();
  expect(j.companions).toEqual([
    expect.objectContaining({ id: "dk-jttw", name: "JTTW guide", kind: "companion", mine: true, book_id: 190, conversation_id: "dk-c-new" }),
  ]);
  db.run(`DELETE FROM domain_briefs WHERE maurice_id = 'dk-health'`);
  db.run(`DELETE FROM conversation_participants WHERE conversation_id LIKE 'dk-%'`);
});

test("a guest lists what was granted to them, as not theirs and without a brief; a member never lists another's", async () => {
  db.run(`INSERT INTO maurices (id, name, created_by, kind) VALUES ('dk-health', 'Health', ?, 'domain')`, [ANNA]);
  db.run(`INSERT INTO maurices (id, name, context_json, created_by, kind) VALUES ('dk-jttw', 'JTTW guide', ?, ?, 'companion')`, [PROGRESS_BOOK, ANNA]);
  db.run(`INSERT INTO domain_briefs (maurice_id, member_id, text) VALUES ('dk-health', ?, 'Hers.')`, [ANNA]);
  maurices.setAccess("dk-health", [ANNA, GUEST]);
  maurices.setAccess("dk-jttw", [ANNA]);

  const j = await (await req(domainRoutes, guestAuth, "/")).json();
  expect(j.domains).toEqual([expect.objectContaining({ id: "dk-health", mine: false, brief: null })]);
  expect(j.companions).toEqual([]);
  expect((await req(domainRoutes, guestAuth, "/dk-health/brief")).status).toBe(404);
  // Through /api/maurices the guest reaches the same row, and nothing else.
  const list = await (await req(mauriceRoutes, guestAuth, "/")).json();
  expect(list.map((m: any) => m.id)).toEqual(["dk-health"]);
  expect((await req(domainRoutes, "", "/")).status).toBe(401);
  db.run(`DELETE FROM domain_briefs WHERE maurice_id = 'dk-health'`);
});

// ── The member's hand ────────────────────────────────────────────────────────

test("kind rides on POST and PATCH; anything else is ignored; the flip keeps the rest of the row", async () => {
  const post = await req(mauriceRoutes, annaAuth, "/", { method: "POST", body: JSON.stringify({ name: "Journey", kind: "companion", hat: "wizard" }) });
  expect(post.status).toBe(201);
  const made = await post.json();
  expect(made.kind).toBe("companion");
  expect(made.hat).toBeUndefined();
  const asDomain = await req(mauriceRoutes, annaAuth, `/${made.id}`, { method: "PATCH", body: JSON.stringify({ kind: "domain" }) });
  expect((await asDomain.json()).kind).toBe("domain");
  const nonsense = await req(mauriceRoutes, annaAuth, `/${made.id}`, { method: "PATCH", body: JSON.stringify({ kind: "persona", tagline: "kept" }) });
  const after = await nonsense.json();
  expect(after.kind).toBe("domain");
  expect(after.tagline).toBe("kept");
  expect(after.name).toBe("Journey");
  // Once a domain, it has a brief to serve; once a companion again, not.
  expect((await req(domainRoutes, annaAuth, `/${made.id}/brief`)).status).toBe(200);
  await req(mauriceRoutes, annaAuth, `/${made.id}`, { method: "PATCH", body: JSON.stringify({ kind: "companion" }) });
  expect((await req(domainRoutes, annaAuth, `/${made.id}/brief`)).status).toBe(404);
  db.run(`DELETE FROM maurices WHERE id = ?`, [made.id]);
});
