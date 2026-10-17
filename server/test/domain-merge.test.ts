// One domain per name (services/maurices.ts domainNamed, services/domainMerge.ts).
// What is held down: a member cannot make, rename into, or re-sort into a
// second domain of a name they have already — compared without case, accents,
// spacing or punctuation — and the routes say so with the domain that has it;
// another member, or a companion, may use the name; a proposal named like an
// existing domain joins it; two domains fold into one losing nothing — the
// conversations and messages, context, instructions, both briefs, mail,
// access, proposals and seeded notes; and at start every set of duplicates a
// household has is folded into the oldest of each name, once.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";

const TMP = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "maurice-domain-merge-"));
const GARDENS = path.join(TMP, "gardens");
fs.mkdirSync(GARDENS, { recursive: true });
process.env.MAURICE_GARDENS_DIR = GARDENS;

const db = (await import("../src/db")).default;
const { createSession } = await import("../src/services/auth");
const maurices = await import("../src/services/maurices");
const { mergeDomains, mergeDuplicateDomains } = await import("../src/services/domainMerge");
const { adoptProposal, insertProposal } = await import("../src/services/domainProposals");
const routes = (await import("../src/routes/maurices")).default;

const ANNA = "dm-anna", BRUNO = "dm-bruno";
const app = new Hono();
app.route("/api/maurices", routes);
let token = "";

const domain = (id: string, name: string, extra: Record<string, unknown> = {}, created = "2026-10-16 20:14:34") => {
  const cols = { id, name, kind: "domain", created_by: ANNA, created_at: created, ...extra };
  const keys = Object.keys(cols);
  db.run(`INSERT INTO maurices (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`, Object.values(cols) as any[]);
};
const convo = (id: string, maurice: string | null, user = ANNA) => {
  db.run(`INSERT INTO conversations (id, user_id, title, maurice_id) VALUES (?, ?, ?, ?)`, [id, user, id, maurice]);
  db.run(`INSERT INTO conversation_participants (conversation_id, member_id, role) VALUES (?, ?, 'owner')`, [id, user]);
};

beforeAll(() => {
  process.env.MAURICE_GARDENS_DIR = GARDENS;
  db.run(`INSERT OR IGNORE INTO households (id, name) VALUES ('default', 'Home')`);
  db.run(`INSERT INTO users (id, username, display_name, role) VALUES (?, 'dmanna', 'Anna', 'standard')`, [ANNA]);
  db.run(`INSERT INTO users (id, username, display_name, role) VALUES (?, 'dmbruno', 'Bruno', 'standard')`, [BRUNO]);
  token = createSession(ANNA).token;
});

afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

const call = (method: string, url: string, body?: unknown) => app.request(url, {
  method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});

describe("one domain per name", () => {
  test("a second domain of the same name is refused, however it is spelt", async () => {
    const first = maurices.createMaurice(ANNA, { name: "Santé et bien-être" }) as maurices.Maurice;
    for (const name of ["Santé et bien-être", "sante et bien etre", "  SANTÉ  et   bien-être ! "]) {
      const r = maurices.createMaurice(ANNA, { name });
      expect("taken" in r && r.taken.id).toBe(first.id);
    }
    const res = await call("POST", "/api/maurices", { name: "santé et bien-être" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "domain_name_taken", existing: { id: first.id, name: "Santé et bien-être" } });
  });

  test("another member, or a companion, may use the name", () => {
    expect("id" in (maurices.createMaurice(BRUNO, { name: "Santé et bien-être" }) as any)).toBe(true);
    expect("id" in (maurices.createMaurice(ANNA, { name: "Santé et bien-être", kind: "companion" }) as any)).toBe(true);
  });

  test("a rename, or a companion re-sorted as a domain, cannot make a duplicate", async () => {
    const other = maurices.createMaurice(ANNA, { name: "Violon" }) as maurices.Maurice;
    expect((await call("PATCH", `/api/maurices/${other.id}`, { name: "Santé et bien-être" })).status).toBe(409);
    expect((await call("PATCH", `/api/maurices/${other.id}`, { name: "Violon" })).status).toBe(200);
    expect((await call("PATCH", `/api/maurices/${other.id}`, { tagline: "Mes gammes" })).status).toBe(200);
    const companion = db.query(`SELECT id FROM maurices WHERE created_by = ? AND kind = 'companion'`).get(ANNA) as { id: string };
    expect((await call("PATCH", `/api/maurices/${companion.id}`, { kind: "domain" })).status).toBe(409);
  });

  test("a proposal named like an existing domain joins it", async () => {
    const existing = maurices.domainNamed(ANNA, "Violon")!;
    convo("dm-c-p1", null);
    convo("dm-c-p2", null);
    const before = (db.query(`SELECT COUNT(*) AS n FROM maurices WHERE created_by = ?`).get(ANNA) as { n: number }).n;
    const p = insertProposal({ member_id: ANNA, name: "violon", summary: "Les cours", conversation_ids: ["dm-c-p1", "dm-c-p2"] });
    const a = adoptProposal(p);
    expect("domain" in a && a.domain.id).toBe(existing.id);
    if ("brief" in a) await a.brief;
    expect((db.query(`SELECT COUNT(*) AS n FROM maurices WHERE created_by = ?`).get(ANNA) as { n: number }).n).toBe(before);
    const bound = db.query(`SELECT maurice_id, maurice_bound_at FROM conversations WHERE id IN ('dm-c-p1', 'dm-c-p2')`).all() as any[];
    expect(bound.every((c) => c.maurice_id === existing.id && c.maurice_bound_at)).toBe(true);
  });
});

describe("merging", () => {
  test("folds one domain into the other, losing nothing", async () => {
    domain("dm-keep", "Maurice", {
      tagline: "Toutes les questions sur Maurice", icon: "lightbulb", prompt: "",
      context_json: JSON.stringify({ items: [{ type: "conversation", id: "dm-c-1" }, { type: "note", id: "valeur" }] }),
      tool_families: JSON.stringify(["garden-notes"]),
    });
    domain("dm-drop", "Maurice", {
      tagline: "Your everyday Maurice.", icon: "cpu", prompt: "Réponds en français.",
      context_json: JSON.stringify({ items: [{ type: "note", id: "valeur" }, { type: "note", id: "serveur" }] }),
      tool_families: JSON.stringify(["garden-notes", "corpus"]),
    }, "2026-10-16 20:15:02");
    convo("dm-c-1", "dm-keep");
    convo("dm-c-2", "dm-drop");
    convo("dm-c-3", "dm-drop");
    db.run(`INSERT INTO messages (id, conversation_id, role, content, maurice_id) VALUES ('dm-m-1', 'dm-c-2', 'assistant', 'x', 'dm-drop')`);
    db.run(`INSERT INTO domain_briefs (maurice_id, member_id, text, read_until, updated_at) VALUES ('dm-keep', ?, 'Brief un.', '2026-10-16 20:17:49', '2026-10-17 02:10:45')`, [ANNA]);
    db.run(`INSERT INTO domain_briefs (maurice_id, member_id, text, read_until) VALUES ('dm-drop', ?, 'Brief deux.', '2026-10-16 21:52:38')`, [ANNA]);
    db.run(`INSERT INTO domain_briefs (maurice_id, member_id, text) VALUES ('dm-drop', ?, 'Le brief de Bruno.')`, [BRUNO]);
    db.run(`INSERT INTO domain_mail (maurice_id, member_id, path) VALUES ('dm-drop', ?, 'notes/fr/lettre.md')`, [ANNA]);
    db.run(`INSERT INTO maurice_access (maurice_id, member_id) VALUES ('dm-drop', ?)`, [BRUNO]);
    const p = insertProposal({ member_id: ANNA, name: "Maurice", summary: "", conversation_ids: [] });
    db.run(`UPDATE domain_proposals SET maurice_id = 'dm-drop', state = 'adopted' WHERE id = ?`, [p.id]);

    // A note seeded for the dropped domain, in a garden under git.
    const garden = path.join(GARDENS, "dmanna");
    fs.mkdirSync(path.join(garden, "notes", "fr"), { recursive: true });
    const git = (...a: string[]) => spawnSync("git", a, { cwd: garden, encoding: "utf8" });
    git("init", "-q"); git("config", "user.name", "t"); git("config", "user.email", "t@t");
    fs.writeFileSync(path.join(garden, "notes", "fr", "maurice.md"), "---\ntitle: Maurice\nmeta:\n  domain: dm-drop\n  role: hub\n---\n\nLe hub. dm-drop dans le texte reste.\n");
    git("add", "-A"); git("commit", "-qm", "seed");

    const r = mergeDomains(ANNA, "dm-drop", "dm-keep");
    expect("into" in r).toBe(true);
    if (!("into" in r)) return;
    expect(r.moved).toEqual({ conversations: 2, briefs: 2, mail: 1, notes: 1 });
    expect(db.query(`SELECT id FROM maurices WHERE id = 'dm-drop'`).get()).toBeNull();

    const keep = r.into;
    expect(keep.tagline).toBe("Toutes les questions sur Maurice");
    expect(keep.icon).toBe("lightbulb");
    expect(keep.prompt).toBe("Réponds en français.");
    expect(keep.context.map((i: any) => `${i.type}:${i.id}`)).toEqual(["conversation:dm-c-1", "note:valeur", "note:serveur"]);
    expect(keep.tool_families).toEqual(["garden-notes", "corpus"]);

    const convos = db.query(`SELECT id, maurice_id, maurice_bound_at FROM conversations WHERE id IN ('dm-c-1', 'dm-c-2', 'dm-c-3') ORDER BY id`).all() as any[];
    expect(convos.every((c) => c.maurice_id === "dm-keep")).toBe(true);
    // The moved ones are new to the brief: the next rewrite reads them whole.
    expect(convos.filter((c) => c.maurice_bound_at).map((c) => c.id)).toEqual(["dm-c-2", "dm-c-3"]);
    expect((db.query(`SELECT maurice_id FROM messages WHERE id = 'dm-m-1'`).get() as any).maurice_id).toBe("dm-keep");

    const briefs = db.query(`SELECT member_id, text, read_until FROM domain_briefs WHERE maurice_id = 'dm-keep' ORDER BY member_id`).all() as any[];
    expect(briefs).toEqual([
      { member_id: ANNA, text: "Brief un.\n\nBrief deux.", read_until: "2026-10-16 20:17:49" },
      { member_id: BRUNO, text: "Le brief de Bruno.", read_until: null },
    ]);
    expect(db.query(`SELECT COUNT(*) AS n FROM domain_briefs WHERE maurice_id = 'dm-drop'`).get()).toEqual({ n: 0 });
    expect(db.query(`SELECT maurice_id FROM domain_mail WHERE path = 'notes/fr/lettre.md'`).get()).toEqual({ maurice_id: "dm-keep" });
    expect(db.query(`SELECT 1 AS ok FROM maurice_access WHERE maurice_id = 'dm-keep' AND member_id = ?`).get(BRUNO)).toEqual({ ok: 1 });
    expect(db.query(`SELECT maurice_id FROM domain_proposals WHERE id = ?`).get(p.id)).toEqual({ maurice_id: "dm-keep" });

    const note = fs.readFileSync(path.join(garden, "notes", "fr", "maurice.md"), "utf8");
    expect(note).toContain("  domain: dm-keep\n");
    expect(note).toContain("dm-drop dans le texte reste.");
    expect(git("log", "-1", "--format=%s").stdout.trim()).toBe("Merge domain dm-drop into dm-keep");
    expect(git("status", "--porcelain").stdout.trim()).toBe("");
  });

  test("refuses what is not the member's two domains", async () => {
    domain("dm-bruno-dom", "Bruno's", { created_by: BRUNO });
    domain("dm-x", "X");
    expect(mergeDomains(ANNA, "dm-x", "dm-x")).toEqual({ error: "a domain cannot be merged into itself" });
    expect(mergeDomains(ANNA, "dm-bruno-dom", "dm-x")).toEqual({ error: "not_found" });
    expect(mergeDomains(ANNA, "dm-x", "dm-nope")).toEqual({ error: "not_found" });
    const res = await call("POST", "/api/maurices/dm-x/merge", { into: "dm-bruno-dom" });
    expect(res.status).toBe(404);
    expect(db.query(`SELECT id FROM maurices WHERE id = 'dm-x'`).get()).not.toBeNull();
  });

  test("at start, every set of duplicates is folded into the oldest of its name", () => {
    domain("dm-dup-1", "Cuisine", {}, "2026-01-01 00:00:00");
    domain("dm-dup-2", "cuisine", {}, "2026-02-01 00:00:00");
    domain("dm-dup-3", "Cuisine !", {}, "2026-03-01 00:00:00");
    convo("dm-c-dup", "dm-dup-3");
    expect(mergeDuplicateDomains()).toBe(2);
    expect(db.query(`SELECT id FROM maurices WHERE id LIKE 'dm-dup-%'`).all()).toEqual([{ id: "dm-dup-1" }]);
    expect(db.query(`SELECT maurice_id FROM conversations WHERE id = 'dm-c-dup'`).get()).toEqual({ maurice_id: "dm-dup-1" });
    expect(mergeDuplicateDomains()).toBe(0);
  });
});
