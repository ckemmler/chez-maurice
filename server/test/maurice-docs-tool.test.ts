/**
 * The documentation tool (services/mauriceDocsTool.ts), which replaced Maurice
 * Maurice on 19 September 2026 (roadmap P3-A). What is nailed down: the reader
 * takes the index and its children and skips internal notes; the tool's
 * description names the notes; a question runs one sub-turn whose system
 * prompt is the digest plus the notes newer than it, and is charged to the
 * member who asked; a note comes back in full without a model call; the
 * member's cap stops the sub-turn before it is made; the model the invocation
 * runs on with no pin is what was the persona's locked one; and the persona
 * is gone from the API.
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
fs.writeFileSync(
  path.join(docsDir, "maurice-server.md"),
  "---\ntitle: The server\ndate: '2026-09-19'\nparent: maurice-docs\n---\n\n# Server\n\nBackups run nightly with restic.\n",
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
// The digest covers the chat note as of the 10th and the server note as of
// the 18th: the server note moved on, so it rides along in full.
fs.writeFileSync(
  path.join(docsDir, "maurice-digest.md"),
  "---\ntitle: Maurice — the digest\ndate: '2026-09-18'\nparent: maurice-docs\ndigest: true\ncovers:\n  maurice-chat: '2026-09-10'\n  maurice-docs: '2026-09-17'\n  maurice-server: '2026-09-18'\n---\n\n# Digest\n\nEverything, briefly.\n",
);

const db = (await import("../src/db")).default;
const routes = (await import("../src/routes/maurices")).default;
const { createSession } = await import("../src/services/auth");
const { canUseMaurice, getMaurice } = await import("../src/services/maurices");
const { loadMauriceDocs, docsForContext, docsModel, findDoc, docCatalogue } = await import("../src/services/mauriceDocs");
const { askMauriceDocs, mauriceDocsTool, docsSystemPrompt, MAURICE_DOCS_INVOCATION } =
  await import("../src/services/mauriceDocsTool");
type DocsCompleter = import("../src/services/mauriceDocsTool").DocsCompleter;
const { recommendedModel, setPinnedModel, ancillaryModel, hasRecommendations } = await import("../src/services/ancillary");
const budget = await import("../src/services/budget");

const MEMBER = "docs-member";
const GUEST = "docs-guest";
let memberAuth = "";
let guestAuth = "";

beforeAll(() => {
  db.run(`INSERT OR IGNORE INTO households (id, name) VALUES ('default', 'Home')`);
  db.run(`INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES (?, ?, ?, 'standard')`, [MEMBER, "docsmember", "Member"]);
  db.run(`INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES (?, ?, ?, 'guest')`, [GUEST, "docsguest", "Guest"]);
  memberAuth = `Bearer ${createSession(MEMBER).token}`;
  guestAuth = `Bearer ${createSession(GUEST).token}`;
});

afterAll(() => {
  try { fs.rmSync(docsDir, { recursive: true, force: true }); } catch {}
  db.run(`DELETE FROM spend_ledger WHERE user_id = ?`, [MEMBER]);
});

/** A provider stand-in: records the request, answers with a fixed text. */
function completer(text = "Nightly, with restic.", cost = 0.05) {
  const seen: Parameters<DocsCompleter>[0][] = [];
  const complete: DocsCompleter = async (req) => {
    seen.push(req);
    return {
      text,
      model: "claude-sonnet-4-6",
      provider: "anthropic",
      stop: "end",
      usage: { provider: "anthropic", model: "claude-sonnet-4-6", rounds: 1, input: 20_000, output: 200, cache_read: 0, cache_write: 0, cost, cost_uncached: cost },
    };
  };
  return { complete, seen };
}

// ── The reader ──────────────────────────────────────────────────────────────

test("the reader takes the index and its children, index first, and skips internal notes", () => {
  const docs = loadMauriceDocs();
  expect(docs.map((d) => d.slug)).toEqual(["maurice-docs", "maurice-chat", "maurice-digest", "maurice-server"]);
  expect(docs[0]!.body.startsWith("# Index")).toBe(true);
  // What a question reads: the digest, then the note that moved on since it.
  expect(docsForContext().map((d) => d.slug)).toEqual(["maurice-digest", "maurice-server"]);
  expect(findDoc("server")?.title).toBe("The server");
  expect(findDoc("maurice-chat")?.slug).toBe("maurice-chat");
  expect(findDoc("digest")).toBeNull();
  expect(findDoc("business")).toBeNull();
  expect(docCatalogue().map((d) => d.slug)).toEqual(["maurice-docs", "maurice-chat", "maurice-server"]);
});

// ── The tool ────────────────────────────────────────────────────────────────

test("the tool's description names the notes and says when to call it", () => {
  const t = mauriceDocsTool();
  expect(t.name).toBe("maurice_docs");
  expect(t.description).toContain("about Maurice himself");
  expect(t.description).toContain("server (The server)");
  expect(t.description).not.toContain("digest");
  expect(t.description).not.toContain("business");
  expect(Object.keys(t.input_schema.properties)).toEqual(["question", "note"]);
});

test("a question runs one sub-turn on the digest and the newer notes, charged to the member", async () => {
  const before = budget.spentTodayUsd(MEMBER);
  const { complete, seen } = completer();
  const a = await askMauriceDocs({ question: "Comment Maurice sauvegarde-t-il ?" }, MEMBER, complete);
  expect(a.isError).toBe(false);
  expect(a.text).toBe("Nightly, with restic.");
  expect(a.model).toBe("claude-sonnet-4-6");
  expect(seen.length).toBe(1);
  const req = seen[0]!;
  expect(req.invocation).toBe(MAURICE_DOCS_INVOCATION);
  expect(req.cacheSystem).toBe(true);
  expect(req.prompt).toBe("Question: Comment Maurice sauvegarde-t-il ?");
  // The system prompt: the head, the digest, the server note in full — and
  // neither the chat note (covered) nor the internal one.
  expect(req.system).toBe(docsSystemPrompt());
  expect(req.system).toContain("Documentation note: Maurice — the digest");
  expect(req.system).toContain("Documentation note: The server (last updated 2026-09-19)");
  expect(req.system).toContain("Loaded in full: updated since the digest");
  expect(req.system).toContain("Backups run nightly with restic.");
  expect(req.system).not.toContain("Streaming answers.");
  expect(req.system).not.toContain("Not for other households.");
  expect(req.system).toContain("handed to Maurice as a tool result");
  // The ledger: the member's row, not the night's.
  expect(budget.spentTodayUsd(MEMBER) - before).toBeCloseTo(0.05, 6);
  const row = db.query(`SELECT user_id, model FROM spend_ledger WHERE user_id = ? ORDER BY at DESC LIMIT 1`).get(MEMBER) as any;
  expect(row).toEqual({ user_id: MEMBER, model: "claude-sonnet-4-6" });
});

test("a note comes back in full without a model call; an unknown one lists the notes", async () => {
  const { complete, seen } = completer();
  const full = await askMauriceDocs({ note: "server" }, MEMBER, complete);
  expect(full.isError).toBe(false);
  expect(full.text).toContain("Documentation note: The server (last updated 2026-09-19)");
  expect(full.text).toContain("Backups run nightly with restic.");
  expect(full.text).not.toContain("Loaded in full");
  expect(full.usage).toBeNull();
  const unknown = await askMauriceDocs({ note: "billing" }, MEMBER, complete);
  expect(unknown.isError).toBe(true);
  expect(unknown.text).toContain('No documentation note "billing"');
  expect(unknown.text).toContain("docs, chat, server");
  const empty = await askMauriceDocs({}, MEMBER, complete);
  expect(empty.isError).toBe(true);
  expect(seen.length).toBe(0);
});

test("a cut-short answer says so; a refusal is an error", async () => {
  const cut: DocsCompleter = async () => ({ text: "Half an answer", model: "m", provider: "anthropic", stop: "max_tokens", usage: null });
  const a = await askMauriceDocs({ question: "Everything?" }, MEMBER, cut);
  expect(a.isError).toBe(false);
  expect(a.text).toContain("Half an answer");
  expect(a.text).toContain("cut short");
  const refused: DocsCompleter = async () => ({ text: "", model: "m", provider: "anthropic", stop: "refusal", usage: null });
  expect((await askMauriceDocs({ question: "Everything?" }, MEMBER, refused)).isError).toBe(true);
  const failing: DocsCompleter = async () => { throw new Error("no key"); };
  const f = await askMauriceDocs({ question: "Everything?" }, MEMBER, failing);
  expect(f.isError).toBe(true);
  expect(f.text).toContain("no key");
});

test("the member's own cap stops the sub-turn before it is made", async () => {
  db.run(`UPDATE households SET api_key = 'k-ant' WHERE id = 'default'`);
  setPinnedModel(MAURICE_DOCS_INVOCATION, "claude-sonnet-4-6");
  expect(ancillaryModel(MAURICE_DOCS_INVOCATION)).toBe("claude-sonnet-4-6");
  db.run(`UPDATE users SET spend_cap_daily_usd = 0.01 WHERE id = ?`, [MEMBER]);
  try {
    const { complete, seen } = completer();
    const a = await askMauriceDocs({ question: "How do backups work?" }, MEMBER, complete);
    expect(a.isError).toBe(true);
    expect(a.text).toContain("daily limit");
    expect(seen.length).toBe(0);
  } finally {
    db.run(`UPDATE users SET spend_cap_daily_usd = NULL WHERE id = ?`, [MEMBER]);
    setPinnedModel(MAURICE_DOCS_INVOCATION, null);
  }
});

// ── The model ───────────────────────────────────────────────────────────────

test("the docs model is a strong cloud model of a provider with a key, and is what the invocation runs on unpinned", () => {
  db.run(`UPDATE households SET api_key = NULL, scaleway_api_key = NULL, openai_api_key = NULL, mistral_api_key = NULL, zai_api_key = NULL WHERE id = 'default'`);
  db.run(`UPDATE households SET default_model = 'claude-sonnet-4-6', ancillary_model = 'claude-sonnet-4-6' WHERE id = 'default'`);
  db.run(`DELETE FROM ancillary_models WHERE invocation = ?`, [MAURICE_DOCS_INVOCATION]);

  // Anthropic key → Sonnet, as the effective model; not as advice, which
  // would mark an Anthropic-only household as seeded.
  db.run(`UPDATE households SET api_key = 'k-ant' WHERE id = 'default'`);
  expect(docsModel()).toBe("claude-sonnet-4-6");
  expect(ancillaryModel(MAURICE_DOCS_INVOCATION)).toBe("claude-sonnet-4-6");
  expect(recommendedModel(MAURICE_DOCS_INVOCATION)).toBeNull();
  expect(hasRecommendations()).toBe(false);

  // Scaleway only → its strongest hosted candidate that the roster knows.
  db.run(`UPDATE households SET api_key = NULL, scaleway_api_key = 'k-scw' WHERE id = 'default'`);
  const scw = docsModel();
  expect(["mistral-medium-3.5-128b", "qwen3.5-397b-a17b", "glm-5.2", "gpt-oss-120b"]).toContain(scw!);
  if (db.query(`SELECT 1 FROM models WHERE id = 'mistral-medium-3.5-128b'`).get()) {
    expect(scw).toBe("mistral-medium-3.5-128b");
  }
  expect(ancillaryModel(MAURICE_DOCS_INVOCATION)).toBe(scw!);
  // Still no advice: the tier's list (gpt-oss) must never be pinned on it.
  expect(recommendedModel(MAURICE_DOCS_INVOCATION)).toBeNull();
  // A pin wins over the computed default.
  setPinnedModel(MAURICE_DOCS_INVOCATION, "gpt-oss-120b");
  if (db.query(`SELECT 1 FROM models WHERE id = 'gpt-oss-120b'`).get()) {
    expect(ancillaryModel(MAURICE_DOCS_INVOCATION)).toBe("gpt-oss-120b");
  }
  setPinnedModel(MAURICE_DOCS_INVOCATION, null);

  // Both keys, household default on Scaleway → stays with the household's provider.
  db.run(`UPDATE households SET api_key = 'k-ant', default_model = 'mistral-small-3.2-24b-instruct-2506' WHERE id = 'default'`);
  if (db.query(`SELECT 1 FROM models WHERE id = 'mistral-small-3.2-24b-instruct-2506'`).get()) {
    expect(docsModel()).toBe("mistral-medium-3.5-128b");
  }

  // No key at all → no computed default; the invocation falls back like any other.
  db.run(`UPDATE households SET api_key = NULL, scaleway_api_key = NULL, default_model = 'claude-sonnet-4-6' WHERE id = 'default'`);
  expect(docsModel()).toBeNull();
  expect(ancillaryModel(MAURICE_DOCS_INVOCATION)).toBe("claude-sonnet-4-6");
});

// ── The persona is gone ─────────────────────────────────────────────────────

test("Maurice Maurice heads nobody's list and answers 404 everywhere", async () => {
  for (const auth of [memberAuth, guestAuth]) {
    const res = await routes.request("/", { headers: { Authorization: auth } });
    expect(res.status).toBe(200);
    const list = (await res.json()) as any[];
    expect(list.some((m) => m.id === "maurice-maurice" || m.builtin)).toBe(false);
    const one = await routes.request("/maurice-maurice", { headers: { Authorization: auth } });
    expect(one.status).toBe(404);
  }
  expect(getMaurice("maurice-maurice")).toBeNull();
  expect(canUseMaurice("maurice-maurice", MEMBER)).toBe(false);
  expect(canUseMaurice(null, GUEST)).toBe(true);
});
