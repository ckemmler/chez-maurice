/**
 * Maurice Maurice, the built-in persona: the specialist of Maurice itself. He
 * heads every member's list — standard members and guests alike — without a
 * database row, carries the whole system documentation as his context, runs on
 * a model the server picks (never the member), and cannot be edited or deleted.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const docsDir = fs.mkdtempSync(path.join(os.tmpdir(), "maurice-docs-"));
process.env.MAURICE_DOCS_DIR = docsDir;
fs.writeFileSync(
  path.join(docsDir, "maurice-docs.md"),
  "---\ntitle: Maurice — system documentation\ndate: '2026-09-17'\nparent: maurice\n---\n\n# Index\n\nSee [[maurice-chat]].\n",
);
fs.writeFileSync(
  path.join(docsDir, "maurice-chat.md"),
  "---\ntitle: The chat experience\ndate: '2026-09-10'\nparent: maurice-docs\n---\n\n# Chat\n\nStreaming answers.\n",
);
// A maurice-* note that is not part of the docs tree stays out; so does one
// under the index marked internal.
fs.writeFileSync(
  path.join(docsDir, "maurice-commercial-plan.md"),
  "---\ntitle: Private\nparent: maurice\n---\n\nNot documentation.\n",
);
fs.writeFileSync(
  path.join(docsDir, "maurice-business.md"),
  "---\ntitle: Business\ndate: '2026-09-18'\nparent: maurice-docs\ninternal: true\n---\n\nNot for other households.\n",
);

const db = (await import("../src/db")).default;
const routes = (await import("../src/routes/maurices")).default;
const { createSession } = await import("../src/services/auth");
const {
  BUILTIN_MAURICE_ID,
  builtinMaurice,
  builtinMauriceModel,
  canUseMaurice,
  getMaurice,
  resolveMauriceContext,
  updateMaurice,
  deleteMaurice,
} = await import("../src/services/maurices");
const { loadMauriceDocs, docsForContext } = await import("../src/services/mauriceDocs");

const MEMBER = "mm-member";
const GUEST = "mm-guest";
let memberAuth = "";
let guestAuth = "";

beforeAll(() => {
  db.run(`INSERT OR IGNORE INTO households (id, name) VALUES ('default', 'Home')`);
  db.run(
    `INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES (?, ?, ?, 'standard')`,
    [MEMBER, "mmmember", "Member"],
  );
  db.run(
    `INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES (?, ?, ?, 'guest')`,
    [GUEST, "mmguest", "Guest"],
  );
  memberAuth = `Bearer ${createSession(MEMBER).token}`;
  guestAuth = `Bearer ${createSession(GUEST).token}`;
});

afterAll(() => {
  try { fs.rmSync(docsDir, { recursive: true, force: true }); } catch {}
});

async function list(auth: string): Promise<any[]> {
  const res = await routes.request("/", { headers: { Authorization: auth } });
  expect(res.status).toBe(200);
  return (await res.json()) as any[];
}

test("the docs reader takes the index and its children, index first", () => {
  const docs = loadMauriceDocs();
  expect(docs.map((d) => d.slug)).toEqual(["maurice-docs", "maurice-chat"]);
  expect(docs[0]!.title).toBe("Maurice — system documentation");
  expect(docs[0]!.body.startsWith("# Index")).toBe(true);
});

test("Maurice Maurice heads a standard member's list and a guest's", async () => {
  const forMember = await list(memberAuth);
  expect(forMember[0].id).toBe(BUILTIN_MAURICE_ID);
  expect(forMember[0].name).toBe("Maurice Maurice");
  expect(forMember[0].builtin).toBe(true);
  expect(forMember[0].count).toBe(2);
  expect(forMember[0].weight).toBeGreaterThan(0);

  const forGuest = await list(guestAuth);
  expect(forGuest[0].id).toBe(BUILTIN_MAURICE_ID);
  expect(forGuest[0].builtin).toBe(true);

  const one = await routes.request(`/${BUILTIN_MAURICE_ID}`, { headers: { Authorization: guestAuth } });
  expect(one.status).toBe(200);
  expect(canUseMaurice(BUILTIN_MAURICE_ID, GUEST)).toBe(true);
  expect(db.query(`SELECT COUNT(*) AS n FROM maurices WHERE id = ?`).get(BUILTIN_MAURICE_ID)).toEqual({ n: 0 });
});

test("the tagline follows the member's language", () => {
  expect(builtinMaurice("fr").tagline).toMatch(/spécialiste de Maurice/);
  expect(builtinMaurice("en").tagline).toMatch(/Maurice specialist/);
  expect(builtinMaurice("xx").tagline).toMatch(/Maurice specialist/);
});

test("his context is the documentation, resolved for any member", () => {
  const m = getMaurice(BUILTIN_MAURICE_ID)!;
  const payload = resolveMauriceContext(GUEST, m);
  expect(payload.items.map((i) => i.id)).toEqual(["docs:maurice-docs", "docs:maurice-chat"]);
  expect(payload.items[1]!.text).toContain("Documentation note: The chat experience (last updated 2026-09-10)");
  expect(payload.items[1]!.text).toContain("Streaming answers.");
  expect(payload.total).toBeGreaterThan(0);
});

test("an edited note is picked up without a restart", () => {
  const p = path.join(docsDir, "maurice-chat.md");
  const later = new Date(Date.now() + 5000);
  fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace("Streaming answers.", "Streaming answers, with cards."));
  fs.utimesSync(p, later, later);
  const payload = resolveMauriceContext(MEMBER, getMaurice(BUILTIN_MAURICE_ID)!);
  expect(payload.items[1]!.text).toContain("with cards");
});

test("he cannot be edited or deleted, over the API or in the service", async () => {
  const patch = await routes.request(`/${BUILTIN_MAURICE_ID}`, {
    method: "PATCH",
    headers: { Authorization: memberAuth, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "claude-haiku-4-5-20251001" }),
  });
  expect(patch.status).toBe(403);
  const del = await routes.request(`/${BUILTIN_MAURICE_ID}`, {
    method: "DELETE",
    headers: { Authorization: memberAuth },
  });
  expect(del.status).toBe(403);
  expect(updateMaurice(BUILTIN_MAURICE_ID, MEMBER, { name: "x" })).toBeNull();
  expect(deleteMaurice(BUILTIN_MAURICE_ID)).toBe(false);
  expect(getMaurice(BUILTIN_MAURICE_ID)!.name).toBe("Maurice Maurice");
});

test("with a digest, he reads the digest plus the notes updated since it", () => {
  // The digest covers the chat note as of the 10th and never saw a "life" note.
  fs.writeFileSync(
    path.join(docsDir, "maurice-digest.md"),
    "---\ntitle: Maurice — the digest\ndate: '2026-09-18'\nparent: maurice-docs\ndigest: true\ncovers:\n  maurice-chat: '2026-09-10'\n  maurice-docs: '2026-09-17'\n---\n\n# Digest\n\nEverything, briefly.\n",
  );
  fs.writeFileSync(
    path.join(docsDir, "maurice-life.md"),
    "---\ntitle: Life\ndate: '2026-09-01'\nparent: maurice-docs\n---\n\nNot in the digest.\n",
  );
  let set = docsForContext();
  expect(set.map((d) => d.slug)).toEqual(["maurice-digest", "maurice-life"]);

  const payload = resolveMauriceContext(MEMBER, getMaurice(BUILTIN_MAURICE_ID)!);
  expect(payload.items.map((i) => i.id)).toEqual(["docs:maurice-digest", "docs:maurice-life"]);
  expect(payload.items[0]!.text).not.toContain("Loaded in full");
  expect(payload.items[1]!.text).toContain("Loaded in full: updated since the digest");
  expect(getMaurice(BUILTIN_MAURICE_ID)!.count).toBe(2);

  // The chat note moves on past its covered date → it rides along in full.
  const chat = path.join(docsDir, "maurice-chat.md");
  fs.writeFileSync(chat, fs.readFileSync(chat, "utf8").replace("date: '2026-09-10'", "date: '2026-09-19'"));
  const later = new Date(Date.now() + 10_000);
  fs.utimesSync(chat, later, later);
  set = docsForContext();
  expect(set.map((d) => d.slug)).toEqual(["maurice-digest", "maurice-chat", "maurice-life"]);

  // Without a digest, everything is loaded, index first, and nothing is a delta.
  fs.rmSync(path.join(docsDir, "maurice-digest.md"));
  set = docsForContext();
  expect(set.map((d) => d.slug)).toEqual(["maurice-docs", "maurice-chat", "maurice-life"]);
  const full = resolveMauriceContext(MEMBER, getMaurice(BUILTIN_MAURICE_ID)!);
  expect(full.items.every((i) => !i.text.includes("Loaded in full"))).toBe(true);
});

test("his model is a strong cloud model from a provider with a key", () => {
  db.run(`UPDATE households SET api_key = NULL, scaleway_api_key = NULL, openai_api_key = NULL, mistral_api_key = NULL, zai_api_key = NULL WHERE id = 'default'`);
  db.run(`UPDATE households SET default_model = 'claude-sonnet-4-6' WHERE id = 'default'`);

  // Anthropic key → Sonnet, whatever the member may use (no allow-list rows).
  db.run(`UPDATE households SET api_key = 'k-ant' WHERE id = 'default'`);
  expect(builtinMauriceModel()).toBe("claude-sonnet-4-6");

  // Scaleway only → its strongest hosted candidate that the roster knows.
  db.run(`UPDATE households SET api_key = NULL, scaleway_api_key = 'k-scw' WHERE id = 'default'`);
  const scw = builtinMauriceModel();
  expect(["mistral-medium-3.5-128b", "qwen3.5-397b-a17b", "glm-5.2", "gpt-oss-120b", "claude-sonnet-4-6"]).toContain(scw);
  if (db.query(`SELECT 1 FROM models WHERE id = 'mistral-medium-3.5-128b'`).get()) {
    expect(scw).toBe("mistral-medium-3.5-128b");
  }

  // Both keys, household default on Scaleway → stays with the household's provider.
  db.run(`UPDATE households SET api_key = 'k-ant', default_model = 'mistral-small-3.2-24b-instruct-2506' WHERE id = 'default'`);
  if (db.query(`SELECT 1 FROM models WHERE id = 'mistral-small-3.2-24b-instruct-2506'`).get()) {
    expect(builtinMauriceModel()).toBe("mistral-medium-3.5-128b");
  }

  // No key at all → the household default, whatever it is.
  db.run(`UPDATE households SET api_key = NULL, scaleway_api_key = NULL, default_model = 'claude-sonnet-4-6' WHERE id = 'default'`);
  expect(builtinMauriceModel()).toBe("claude-sonnet-4-6");
});
