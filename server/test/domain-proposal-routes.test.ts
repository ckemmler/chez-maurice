/**
 * The member routes of the drawer "Define my domains" (routes/domains.ts,
 * services/domainProposals.ts, P2-D): the list of open proposals with their
 * weights, a rename, an adoption (the same as the tool: domain, bound
 * conversations, first brief), a dismissal, the whole lot at once — and, each
 * time, the message Maurice leaves in the conversation saying what was done,
 * fanned out to the room. A proposal of another member's is not found, a
 * settled one is refused, the garden notes are written only when asked for
 * (in the background, announced in turn), and the conversation's tools keep
 * working beside the drawer.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { beforeAll, beforeEach, expect, test } from "bun:test";

const GARDENS = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "maurice-drawer-gardens-"));
process.env.MAURICE_GARDENS_DIR = GARDENS;

const { default: db } = await import("../src/db");
const { addModel } = await import("../src/services/models");
const { setPinnedModel } = await import("../src/services/ancillary");
const mapping = await import("../src/services/domainMapping");
const proposals = await import("../src/services/domainProposals");
const briefs = await import("../src/services/domainBriefs");
const seeding = await import("../src/services/domainSeeding");
const { setRoomPublisher, setSubscriberCount } = await import("../src/services/roomBus");
const { createSession } = await import("../src/services/auth");
const { getMaurice } = await import("../src/services/maurices");
const routes = (await import("../src/routes/domains")).default;

const ANNA = "drawer-anna";
const BEN = "drawer-ben";
const NIGHT = "deepseek-v4-flash-0731";
const TODAY = new Date("2026-09-20T12:00:00Z");

let published: Array<{ topic: string; event: any }> = [];
let requests: Array<{ invocation: string; prompt: string }> = [];

function usage(c: number) {
  return { provider: "scaleway", model: NIGHT, rounds: 1, input: 1500, output: 200, cache_read: 0, cache_write: 0, cost: c, cost_uncached: c };
}
const reply = (text: string) => ({ text, model: NIGHT, provider: "scaleway", stop: "end" as const, usage: usage(0.003) });

async function write(req: { invocation: string; prompt: string }) {
  requests.push(req);
  const p = req.prompt;
  if (req.invocation === "domain_seed") {
    return reply(JSON.stringify({
      description: "Lessons and bow work.",
      understood: "You started lessons in May 2026.",
      open_threads: "- The recital",
      topics: [{ title: "The bow arm", body: "Your bow arm is the thread. ".repeat(6), sources: [1, 2] }],
    }));
  }
  if (p.includes("Return a JSON object with these keys")) {
    if (/violin/i.test(p)) return reply('{"name": "The violin", "summary": "You practise and ask about technique. Lately the bow arm.", "is_domain": true, "split_hint": ""}');
    if (/bread/i.test(p)) return reply('{"name": "Baking bread", "summary": "Sourdough and machines.", "is_domain": true, "split_hint": ""}');
    return reply('{"name": "Sailing", "summary": "A summer that passed.", "is_domain": true, "split_hint": ""}');
  }
  if (req.invocation === "domain_brief") return reply("You practise the violin.");
  return reply('{"intro": "Tonight I read our conversations.", "nuances": "", "invitation": "Tell me."}');
}

async function map(_memberId: string, ids: string[]) {
  const rows = db.query(`SELECT id, COALESCE(title, '') AS title FROM conversations WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids) as Array<{ id: string; title: string }>;
  const by = new Map<string, string[]>();
  for (const r of rows) {
    const key = r.title.split(" ")[0]!.toLowerCase();
    by.set(key, [...(by.get(key) ?? []), r.id]);
  }
  return { conversations: ids.length, groups: [...by.values()].map((g) => ({ conversation_ids: g, size: g.length, cohesion: 0.7, depth: 0, parent_size: null })) };
}

let convoN = 0;
function convo(member: string, title: string, day: string) {
  const id = `c-${member}-${++convoN}`;
  db.run(`INSERT INTO conversations (id, user_id, title, opened_by) VALUES (?, ?, ?, 'member')`, [id, member, title]);
  db.run(`INSERT INTO conversation_participants (conversation_id, member_id, role) VALUES (?, ?, 'owner')`, [id, member]);
  db.run(`INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, 'user', ?, ?)`, [crypto.randomUUID(), id, `About ${title}: my bow arm again`, `${day} 10:00:00`]);
  db.run(`INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, 'assistant', 'Sure.', ?)`, [crypto.randomUUID(), id, `${day} 10:01:00`]);
  return id;
}

function annaCorpus() {
  ["2026-05-02", "2026-06-10", "2026-07-15", "2026-08-20", "2026-09-10"].forEach((d, i) => convo(ANNA, `Violin lesson ${i}`, d));
  ["2026-04-01", "2026-06-01", "2026-08-01", "2026-09-01"].forEach((d, i) => convo(ANNA, `Bread machine ${i}`, d));
  ["2025-06-01", "2025-07-01", "2025-08-01"].forEach((d, i) => convo(ANNA, `Sailing trip ${i}`, d));
}

let anna = "";
let ben = "";
const req = (path: string, init: RequestInit = {}, auth = anna) =>
  routes.request(path, { ...init, headers: { Authorization: auth, "Content-Type": "application/json", ...(init.headers as any) } });

/** The night for Anna: three proposals (violin, bread alive; sailing lived) in one conversation. */
async function night() {
  annaCorpus();
  const r = await mapping.mapMember(ANNA);
  expect(r.outcome).toBe("opened");
  const list = proposals.openProposals(ANNA);
  const byName = new Map(list.map((p) => [p.name, p]));
  return { conversationId: r.conversation_id!, byName };
}

function messagesOf(conversationId: string): Array<{ role: string; content: string }> {
  return db.query(`SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid`).all(conversationId) as any;
}

beforeAll(() => {
  db.run(`INSERT OR IGNORE INTO households (id, name) VALUES ('default', 'Home')`);
  db.run(`UPDATE households SET scaleway_api_key = 'test-key', maurice_opens_min_days = NULL WHERE id = 'default'`);
  for (const [id, name] of [[ANNA, "Anna"], [BEN, "Ben"]] as const) {
    db.run(`INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES (?, ?, ?, 'standard')`, [id, id, name]);
  }
  db.run(`INSERT OR REPLACE INTO user_preferences (user_id, locale) VALUES (?, 'fr')`, [ANNA]);
  if (!db.query(`SELECT 1 FROM models WHERE id = ?`).get(NIGHT)) {
    addModel({ id: NIGHT, name: "DeepSeek V4 Flash", tier: "cloud", vendor: "deepseek", provider: "scaleway" });
  }
  for (const inv of ["domain_mapping", "domain_brief", "domain_seed"]) setPinnedModel(inv, NIGHT);
  setRoomPublisher((topic, data) => published.push({ topic, event: JSON.parse(data) }));
  setSubscriberCount(() => 1);
  mapping.setMappingDeps({ write: write as any, map, now: () => TODAY });
  briefs.setBriefDeps({ write: write as any, search: async () => [] });
  seeding.setSeedDeps({ write: write as any, now: () => TODAY });
  anna = `Bearer ${createSession(ANNA).token}`;
  ben = `Bearer ${createSession(BEN).token}`;
  // Anna's garden is a git repository, as at home.
  const root = path.join(GARDENS, ANNA);
  fs.mkdirSync(path.join(root, "notes", "fr"), { recursive: true });
  fs.writeFileSync(path.join(root, "notes", "fr", "hello.md"), "---\ntitle: Hello\ndate: 2026-01-01\nflags: []\nlocale: fr\n---\n\nHi.\n");
  spawnSync("git", ["init", "-q"], { cwd: root });
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"], { cwd: root });
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "garden"], { cwd: root });
  spawnSync("git", ["config", "user.email", "t@t"], { cwd: root });
  spawnSync("git", ["config", "user.name", "t"], { cwd: root });
});

beforeEach(() => {
  published = [];
  requests = [];
  db.run(`DELETE FROM domain_proposals`);
  db.run(`DELETE FROM domain_briefs`);
  db.run(`DELETE FROM conversations WHERE user_id IN (?, ?)`, [ANNA, BEN]);
  db.run(`DELETE FROM maurices WHERE created_by IN (?, ?)`, [ANNA, BEN]);
});

test("GET /proposals: the member's open proposals, alive first, with weight, share and one line; nothing for a member without any", async () => {
  expect(await (await req("/proposals")).json()).toEqual({ conversation_id: null, total_conversations: 0, proposals: [], settled: [] });
  const { conversationId } = await night();
  const res = await req("/proposals");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.conversation_id).toBe(conversationId);
  expect(body.total_conversations).toBe(12);
  expect(body.proposals.map((p: any) => p.name)).toEqual(["The violin", "Baking bread", "Sailing"]);
  const violin = body.proposals[0];
  expect(violin).toMatchObject({ state: "proposed", verdict: "alive", conversations: 5, weight: 5, share: 42, recent_90_days: 3, one_line: "You practise and ask about technique.", conversation_id: conversationId, seed: null });
  expect(violin.sample).toHaveLength(3);
  expect(body.proposals[1]).toMatchObject({ name: "Baking bread", weight: 4, share: 33 });
  expect(body.proposals[2]).toMatchObject({ name: "Sailing", verdict: "lived", weight: 4, share: 25 });
  expect(body.settled).toEqual([]);
  // Ben sees nothing of Anna's.
  expect((await (await req("/proposals", {}, ben)).json()).proposals).toEqual([]);
});

test("PATCH /proposals/:id: the member's words on name and summary; someone else's is not found", async () => {
  const { byName } = await night();
  const violin = byName.get("The violin")!;
  const res = await req(`/proposals/${violin.id}`, { method: "PATCH", body: JSON.stringify({ name: "Le violon", summary: "Ma pratique du violon." }) });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.proposal).toMatchObject({ id: violin.id, name: "Le violon", summary: "Ma pratique du violon.", one_line: "Ma pratique du violon." });
  expect(proposals.getProposal(violin.id)!.name).toBe("Le violon");
  // An empty name keeps the old one; a missing body is a 400.
  expect((await (await req(`/proposals/${violin.id}`, { method: "PATCH", body: JSON.stringify({ name: "  " }) })).json()).proposal.name).toBe("Le violon");
  expect((await req(`/proposals/${violin.id}`, { method: "PATCH", body: "nope" })).status).toBe(400);
  expect((await req(`/proposals/${violin.id}`, { method: "PATCH", body: JSON.stringify({ name: "Mine" }) }, ben)).status).toBe(404);
  expect((await req(`/proposals/nope`, { method: "PATCH", body: JSON.stringify({ name: "Mine" }) })).status).toBe(404);
  // Nothing was said in the conversation for a rename alone through PATCH.
  expect(messagesOf(violin.conversation_id!)).toHaveLength(1);
});

test("POST /proposals/:id/adopt: the domain as the tool makes it, its brief in the background, Maurice's word in the conversation; no notes unless asked", async () => {
  const { conversationId, byName } = await night();
  const violin = byName.get("The violin")!;
  const res = await req(`/proposals/${violin.id}/adopt`, { method: "POST", body: JSON.stringify({ name: "Le violon" }) });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.adopted).toMatchObject({ id: violin.id, name: "Le violon", conversations_bound: 5, seeding: false });
  expect(body.message_id).toBeTruthy();
  const domain = getMaurice(body.adopted.domain_id)!;
  expect(domain.kind).toBe("domain");
  expect(domain.created_by).toBe(ANNA);
  expect(domain.prompt).toBe("You practise and ask about technique. Lately the bow arm.");
  expect(db.query(`SELECT COUNT(*) AS n FROM conversations WHERE maurice_id = ?`).get(domain.id)).toEqual({ n: 5 });
  expect(proposals.getProposal(violin.id)).toMatchObject({ state: "adopted", maurice_id: domain.id, name: "Le violon" });
  // Maurice said it, in Anna's language, and the room heard it.
  const msgs = messagesOf(conversationId);
  expect(msgs).toHaveLength(2);
  expect(msgs[1]!.role).toBe("assistant");
  expect(msgs[1]!.content).toContain("C'est fait, depuis l'app. Adopté : **Le violon**.");
  expect(msgs[1]!.content).toContain("Aucune note n'a été écrite dans ton jardin.");
  const fanned = published.filter((p) => p.event.type === "message");
  expect(fanned).toHaveLength(1);
  expect(fanned[0]!.topic).toContain(conversationId);
  expect(fanned[0]!.event.message.id).toBe(body.message_id);
  // The brief followed.
  await new Promise((r) => setTimeout(r, 50));
  expect(briefs.getBrief(domain.id, ANNA)).not.toBeNull();
  // The notes were neither written nor declined: the conversation may still offer them.
  expect(proposals.getProposal(violin.id)!.stats.seed).toBeUndefined();
  expect(proposals.domainToolsFor(conversationId, ANNA)).toHaveLength(4);
  // Adopted twice is a 409; Ben cannot adopt Anna's.
  expect((await req(`/proposals/${violin.id}/adopt`, { method: "POST", body: "{}" })).status).toBe(409);
  expect((await req(`/proposals/${byName.get("Baking bread")!.id}/adopt`, { method: "POST", body: "{}" }, ben)).status).toBe(404);
});

test("POST /proposals/:id/dismiss: put away, said in the conversation, never mapped again", async () => {
  const { conversationId, byName } = await night();
  const sailing = byName.get("Sailing")!;
  const res = await req(`/proposals/${sailing.id}/dismiss`, { method: "POST" });
  expect(res.status).toBe(200);
  expect((await res.json()).dismissed).toEqual({ id: sailing.id, name: "Sailing" });
  expect(proposals.getProposal(sailing.id)!.state).toBe("dismissed");
  expect(messagesOf(conversationId)[1]!.content).toBe("Rangé : **Sailing** — leurs conversations ne remonteront plus.");
  expect(mapping.unattachedConversations(ANNA).map((c) => c.id)).not.toContain(sailing.conversation_ids[0]);
  expect((await req(`/proposals/${sailing.id}/dismiss`, { method: "POST" })).status).toBe(409);
});

test("POST /proposals/apply: the whole drawer at once — adopt with notes, rename, put away — one message, the notes announced after", async () => {
  const { conversationId, byName } = await night();
  const violin = byName.get("The violin")!;
  const bread = byName.get("Baking bread")!;
  const sailing = byName.get("Sailing")!;
  const res = await req(`/proposals/apply`, {
    method: "POST",
    body: JSON.stringify({
      items: [
        { id: violin.id, action: "adopt", name: "Le violon", seed: true },
        { id: bread.id, action: "keep", summary: "Le pain au levain, surtout." },
        { id: sailing.id, action: "dismiss" },
        { id: "nope", action: "adopt" },
        { id: bread.id, action: "explode" },
      ],
    }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.adopted).toHaveLength(1);
  expect(body.adopted[0]).toMatchObject({ name: "Le violon", seeding: true });
  expect(body.dismissed).toEqual([{ id: sailing.id, name: "Sailing" }]);
  expect(body.renamed.map((r: any) => r.name).sort()).toEqual(["Baking bread", "Le violon"]);
  expect(body.errors).toEqual([{ id: "nope", error: "no such proposal" }]);
  expect(body.conversation_id).toBe(conversationId);
  expect(proposals.getProposal(bread.id)).toMatchObject({ state: "proposed", summary: "Le pain au levain, surtout." });

  const said = messagesOf(conversationId)[1]!.content;
  expect(said).toContain("Adopté : **Le violon**.");
  expect(said).toContain("Rangé : **Sailing**");
  expect(said).toContain("Corrigé : **Baking bread**.");
  expect(said).toContain("Tu as demandé des notes de jardin sur **Le violon**");
  expect(said).not.toContain("Aucune note");

  // The notes, written in the background and announced in turn.
  await proposals.seedingSettled();
  const msgs = messagesOf(conversationId);
  expect(msgs).toHaveLength(3);
  expect(msgs[2]!.content).toContain("Les notes sur **Le violon** sont dans ton jardin (2 notes)");
  expect(msgs[2]!.content).toContain("](/g/");
  expect(proposals.getProposal(violin.id)!.stats.seed?.state).toBe("written");
  expect(fs.existsSync(path.join(GARDENS, ANNA, "notes", "fr", "le-violon.md"))).toBe(true);
  expect(requests.filter((r) => r.invocation === "domain_seed")).toHaveLength(1);

  // The drawer now shows the one still open, and the settled ones for the record.
  const list = await (await req("/proposals")).json();
  expect(list.proposals.map((p: any) => p.name)).toEqual(["Baking bread"]);
  expect(list.settled.map((p: any) => [p.name, p.state]).sort()).toEqual([["Le violon", "adopted"], ["Sailing", "dismissed"]]);
  expect(list.settled.find((p: any) => p.name === "Le violon").seed.state).toBe("written");

  // The conversation's tools still work beside the drawer.
  const t = await proposals.runDomainTool("domains__adjust", { action: "rename", id: bread.id, name: "Le pain" }, conversationId);
  expect(t.isError).toBe(false);
  expect(proposals.getProposal(bread.id)!.name).toBe("Le pain");
  // A body without items is a 400; an empty drawer changes nothing and says nothing.
  expect((await req(`/proposals/apply`, { method: "POST", body: "{}" })).status).toBe(400);
  const nothing = await (await req(`/proposals/apply`, { method: "POST", body: JSON.stringify({ items: [] }) })).json();
  expect(nothing.message_id).toBeNull();
  expect(messagesOf(conversationId)).toHaveLength(3);
});
