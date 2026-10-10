/**
 * The member routes of the app's list of proposals (routes/domains.ts,
 * services/domainProposals.ts): the open proposals with their weights and
 * what is new since the member last looked, the settled ones under them, a
 * rename, an adoption (the same as the tool: domain, bound conversations,
 * first brief), a dismissal and the way back from it, a merge, a cut, the
 * whole lot at once — and the conversations of a domain with how each came
 * to it. A proposal of another member's is not found, a settled one is
 * refused, the garden notes are written only when asked for (in the
 * background), the tools keep working beside the list — and nothing here
 * writes a message anywhere: since 10 October 2026 no conversation carries
 * the proposals.
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
const { setConversationMaurice } = await import("../src/services/conversations");
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
  return reply("You practise the violin.");
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

/** The night for Anna: three proposals (violin, bread alive; sailing lived), in no conversation. */
async function night() {
  annaCorpus();
  const r = await mapping.mapMember(ANNA);
  expect(r.outcome).toBe("proposed");
  return { byName: new Map(proposals.openProposals(ANNA).map((p) => [p.name, p])) };
}

/** What Maurice did on his own in the member's conversations: the ones he
 *  opened, and every message of his. */
function spoken(member: string): { opened: number; said: number } {
  const opened = db.query(`SELECT COUNT(*) AS n FROM conversations WHERE user_id = ? AND opened_by = 'maurice'`).get(member) as { n: number };
  const said = db
    .query(`SELECT COUNT(*) AS n FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.user_id = ? AND m.role = 'assistant'`)
    .get(member) as { n: number };
  return { opened: opened.n, said: said.n };
}

/** Nothing opened, nothing said since `before`, and nothing fanned out to a room. */
function expectSilence(before: { opened: number; said: number }) {
  expect(spoken(ANNA)).toEqual(before);
  expect(spoken(ANNA).opened).toBe(0);
  expect(published.filter((p) => p.event.type === "message")).toEqual([]);
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
  mapping.setMappingDeps({ write: write as any, map, match: async () => [], now: () => TODAY });
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
  db.run(`DELETE FROM domain_seen`);
  db.run(`UPDATE users SET domain_proposals_seen_at = NULL WHERE id IN (?, ?)`, [ANNA, BEN]);
  db.run(`DELETE FROM conversations WHERE user_id IN (?, ?)`, [ANNA, BEN]);
  db.run(`DELETE FROM maurices WHERE created_by IN (?, ?)`, [ANNA, BEN]);
});

const post = (path: string, body?: unknown, auth = anna) => req(path, { method: "POST", ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) }, auth);

test("GET /proposals: the member's open proposals, alive first, with weight, share and one line; nothing for a member without any", async () => {
  expect(await (await req("/proposals")).json()).toEqual({ total_conversations: 0, seen_at: null, unseen: 0, proposals: [], settled: [] });
  await night();
  const res = await req("/proposals");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).not.toHaveProperty("conversation_id");
  expect(body.total_conversations).toBe(12);
  expect(body.seen_at).toBeNull();
  expect(body.unseen).toBe(3);
  expect(body.proposals.map((p: any) => p.name)).toEqual(["The violin", "Baking bread", "Sailing"]);
  const violin = body.proposals[0];
  expect(violin).toMatchObject({ state: "proposed", verdict: "alive", conversations: 5, weight: 5, share: 42, recent_90_days: 3, one_line: "You practise and ask about technique.", seed: null, origin: "mapping", is_new: true });
  expect(violin).not.toHaveProperty("conversation_id");
  expect(violin.created_at).toBeTruthy();
  expect(violin.sample).toHaveLength(3);
  expect(body.proposals[1]).toMatchObject({ name: "Baking bread", weight: 4, share: 33 });
  expect(body.proposals[2]).toMatchObject({ name: "Sailing", verdict: "lived", weight: 4, share: 25 });
  expect(body.settled).toEqual([]);
  // Ben sees nothing of Anna's.
  expect(await (await req("/proposals", {}, ben)).json()).toMatchObject({ unseen: 0, proposals: [], settled: [] });
});

test("the badge: GET /api/domains counts what is open and what is new; POST /proposals/seen takes the new away until the night proposes again", async () => {
  expect((await (await req("/")).json()).proposals).toEqual({ open: 0, unseen: 0 });
  const { byName } = await night();
  const home = await (await req("/")).json();
  expect(home.proposals).toEqual({ open: 3, unseen: 3 });
  expect(home.domains).toEqual([]);
  // Reading the list is not opening it: nothing is marked by a GET.
  await req("/proposals");
  expect((await (await req("/")).json()).proposals).toEqual({ open: 3, unseen: 3 });

  // Ben opening his list does nothing to Anna's.
  expect(await (await post("/proposals/seen", undefined, ben)).json()).toEqual({ open: 0, unseen: 0 });
  expect(proposals.proposalCounts(ANNA)).toEqual({ open: 3, unseen: 3 });
  expect(proposals.proposalsSeenAt(ANNA)).toBeNull();

  const seen = await post("/proposals/seen");
  expect(seen.status).toBe(200);
  expect(await seen.json()).toEqual({ open: 3, unseen: 0 });
  expect(proposals.proposalsSeenAt(ANNA)).toBeTruthy();
  const list = await (await req("/proposals")).json();
  expect(list.seen_at).toBe(proposals.proposalsSeenAt(ANNA));
  expect(list.unseen).toBe(0);
  expect(list.proposals.every((p: any) => p.is_new === false)).toBe(true);

  // A later night: one more, and only that one is new.
  const garden = proposals.insertProposal({ member_id: ANNA, name: "The garden", summary: "Beds.", conversation_ids: [], stats: { verdict: "alive", origin: "mapping" } });
  db.run(`UPDATE domain_proposals SET created_at = datetime('now', '+1 day') WHERE id = ?`, [garden.id]);
  expect((await (await req("/")).json()).proposals).toEqual({ open: 4, unseen: 1 });
  const later = await (await req("/proposals")).json();
  expect(later.unseen).toBe(1);
  expect(later.proposals.filter((p: any) => p.is_new).map((p: any) => p.name)).toEqual(["The garden"]);
  // A settled one is never new, and leaves the count.
  await post(`/proposals/${garden.id}/dismiss`);
  await post(`/proposals/${byName.get("Sailing")!.id}/dismiss`);
  expect((await (await req("/")).json()).proposals).toEqual({ open: 2, unseen: 0 });
  expect((await (await req("/proposals")).json()).settled.every((p: any) => p.is_new === false)).toBe(true);
});

test("PATCH /proposals/:id: the member's words on name and summary; someone else's is not found", async () => {
  const { byName } = await night();
  const before = spoken(ANNA);
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
  expectSilence(before);
});

test("GET /proposals/:id: one proposal in full, whatever its state; someone else's is not found", async () => {
  const { byName } = await night();
  const violin = byName.get("The violin")!;
  const res = await req(`/proposals/${violin.id}`);
  expect(res.status).toBe(200);
  const { proposal } = await res.json();
  expect(proposal).toMatchObject({ id: violin.id, name: "The violin", state: "proposed", conversations: 5, mail_threads: 0, weight: 5, share: 42, origin: "mapping" });
  expect(proposal.conversations_list).toHaveLength(5);
  expect(proposal.conversations_list[0]).toEqual({ id: violin.conversation_ids[0]!, date: "2026-05-02", title: "Violin lesson 0" });
  expect(proposal.mail_list).toEqual([]);
  expect((await req(`/proposals/${violin.id}`, {}, ben)).status).toBe(404);
  expect((await req(`/proposals/nope`)).status).toBe(404);
  // Still readable once put away.
  await post(`/proposals/${violin.id}/dismiss`);
  const put = await (await req(`/proposals/${violin.id}`)).json();
  expect(put.proposal).toMatchObject({ state: "dismissed", is_new: false });
  expect(put.proposal.conversations_list).toHaveLength(5);
});

test("POST /proposals/:id/adopt: the domain as the tool makes it, its brief in the background, not a word in any conversation; no notes unless asked", async () => {
  const { byName } = await night();
  const before = spoken(ANNA);
  const violin = byName.get("The violin")!;
  const res = await post(`/proposals/${violin.id}/adopt`, { name: "Le violon" });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(Object.keys(body)).toEqual(["adopted"]);
  expect(body.adopted).toMatchObject({ id: violin.id, name: "Le violon", conversations_bound: 5, seeding: false });
  const domain = getMaurice(body.adopted.domain_id)!;
  expect(domain.kind).toBe("domain");
  expect(domain.created_by).toBe(ANNA);
  expect(domain.prompt).toBe("You practise and ask about technique. Lately the bow arm.");
  expect(db.query(`SELECT COUNT(*) AS n FROM conversations WHERE maurice_id = ?`).get(domain.id)).toEqual({ n: 5 });
  expect(proposals.getProposal(violin.id)).toMatchObject({ state: "adopted", maurice_id: domain.id, name: "Le violon" });
  // The brief followed.
  await new Promise((r) => setTimeout(r, 50));
  expect(briefs.getBrief(domain.id, ANNA)).not.toBeNull();
  // Maurice said nothing, anywhere: the list shows what was done.
  expectSilence(before);
  const list = await (await req("/proposals")).json();
  expect(list.settled.map((p: any) => [p.name, p.state, p.domain_id])).toEqual([["Le violon", "adopted", domain.id]]);
  expect((await (await req("/")).json()).domains.map((d: any) => d.name)).toEqual(["Le violon"]);
  // The notes were neither written nor declined: a conversation may still offer them.
  expect(proposals.getProposal(violin.id)!.stats.seed).toBeUndefined();
  expect(proposals.domainToolsFor(ANNA)).toHaveLength(4);
  // Adopted twice is a 409; Ben cannot adopt Anna's.
  expect((await post(`/proposals/${violin.id}/adopt`, {})).status).toBe(409);
  expect((await post(`/proposals/${byName.get("Baking bread")!.id}/adopt`, {}, ben)).status).toBe(404);
});

test("POST /proposals/:id/dismiss, then /restore: put away in silence, never mapped again — until the member comes back on it", async () => {
  const { byName } = await night();
  const before = spoken(ANNA);
  const sailing = byName.get("Sailing")!;
  const res = await post(`/proposals/${sailing.id}/dismiss`);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ dismissed: { id: sailing.id, name: "Sailing" } });
  expect(proposals.getProposal(sailing.id)!.state).toBe("dismissed");
  expect(mapping.unattachedConversations(ANNA).map((c) => c.id)).not.toContain(sailing.conversation_ids[0]);
  expect((await post(`/proposals/${sailing.id}/dismiss`)).status).toBe(409);
  const list = await (await req("/proposals")).json();
  expect(list.proposals.map((p: any) => p.name)).toEqual(["The violin", "Baking bread"]);
  expect(list.settled.map((p: any) => [p.name, p.state])).toEqual([["Sailing", "dismissed"]]);

  // Ben cannot bring it back; Anna can, and it is open again as it was.
  expect((await post(`/proposals/${sailing.id}/restore`, undefined, ben)).status).toBe(404);
  const back = await post(`/proposals/${sailing.id}/restore`);
  expect(back.status).toBe(200);
  const { proposal } = await back.json();
  expect(proposal).toMatchObject({ id: sailing.id, name: "Sailing", state: "proposed", conversations: 3, verdict: "lived" });
  expect(proposal.conversations_list).toHaveLength(3);
  expect(proposals.openProposals(ANNA).map((p) => p.id)).toContain(sailing.id);
  expect((await (await req("/proposals")).json()).settled).toEqual([]);
  // An open one is not restored, nor an adopted one.
  const again = await post(`/proposals/${sailing.id}/restore`);
  expect(again.status).toBe(409);
  expect((await again.json()).state).toBe("proposed");
  const violin = byName.get("The violin")!;
  await post(`/proposals/${violin.id}/adopt`, {});
  const adopted = await post(`/proposals/${violin.id}/restore`);
  expect(adopted.status).toBe(409);
  expect((await adopted.json()).state).toBe("adopted");
  expect(proposals.getProposal(violin.id)!.state).toBe("adopted");

  // One the old six-week rule put away is listed with the settled, and comes back the same way.
  const bread = byName.get("Baking bread")!;
  proposals.updateProposal(bread.id, { state: "expired" });
  expect((await (await req("/proposals")).json()).settled.map((p: any) => [p.name, p.state]).sort()).toEqual([["Baking bread", "expired"], ["The violin", "adopted"]]);
  expect((await post(`/proposals/${bread.id}/restore`)).status).toBe(200);
  expect(proposals.getProposal(bread.id)!.state).toBe("proposed");
  await new Promise((r) => setTimeout(r, 50));
  expectSilence(before);
});

test("POST /proposals/merge: two or more open proposals into one new one; the parts live on in it", async () => {
  const { byName } = await night();
  const before = spoken(ANNA);
  const violin = byName.get("The violin")!;
  const bread = byName.get("Baking bread")!;
  const sailing = byName.get("Sailing")!;
  // Not his, not enough, not a body.
  expect((await post(`/proposals/merge`, { ids: [violin.id, bread.id] }, ben)).status).toBe(422);
  expect((await post(`/proposals/merge`, { ids: [violin.id] })).status).toBe(422);
  expect((await post(`/proposals/merge`, { ids: [violin.id, violin.id] })).status).toBe(422);
  expect((await post(`/proposals/merge`, { ids: [violin.id, "nope"] })).status).toBe(422);
  expect((await post(`/proposals/merge`, {})).status).toBe(400);
  expect((await post(`/proposals/merge`, "nope")).status).toBe(400);
  expect(proposals.openProposals(ANNA)).toHaveLength(3);

  // Without a name: made of theirs.
  const res = await post(`/proposals/merge`, { ids: [violin.id, bread.id] });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.from).toEqual(["The violin", "Baking bread"]);
  expect(body.proposal).toMatchObject({ name: "The violin & Baking bread", state: "proposed", conversations: 9, origin: "merge", verdict: "alive", recent_90_days: 5 });
  expect(body.proposal.summary).toBe("You practise and ask about technique. Lately the bow arm.\n\nSourdough and machines.");
  expect(body.proposal.conversations_list).toHaveLength(9);
  expect(proposals.getProposal(violin.id)!.state).toBe("superseded");
  expect(proposals.getProposal(bread.id)!.state).toBe("superseded");
  // A superseded part is neither open nor settled, and cannot be merged again.
  const list = await (await req("/proposals")).json();
  expect(list.proposals.map((p: any) => p.name)).toEqual(["The violin & Baking bread", "Sailing"]);
  expect(list.settled).toEqual([]);
  expect((await post(`/proposals/merge`, { ids: [violin.id, sailing.id] })).status).toBe(422);

  // With the member's name and summary.
  const all = await post(`/proposals/merge`, { ids: [body.proposal.id, sailing.id], name: "Loisirs", summary: "Tout ce que je fais de mes mains." });
  expect(all.status).toBe(200);
  expect((await all.json()).proposal).toMatchObject({ name: "Loisirs", summary: "Tout ce que je fais de mes mains.", conversations: 12, share: 100 });
  expect(proposals.openProposals(ANNA).map((p) => p.name)).toEqual(["Loisirs"]);
  expectSilence(before);
});

test("POST /proposals/:id/split: each part a proposal of its own, conversations and mail; what is assigned to none stays", async () => {
  const { byName } = await night();
  const before = spoken(ANNA);
  const violin = byName.get("The violin")!;
  const [a, b, c, d, e] = violin.conversation_ids as [string, string, string, string, string];
  expect((await post(`/proposals/${violin.id}/split`, { parts: [{ name: "Bow", conversation_ids: [a] }] }, ben)).status).toBe(404);
  expect((await post(`/proposals/${violin.id}/split`, {})).status).toBe(400);
  // No part with a name and something of this proposal's.
  expect((await post(`/proposals/${violin.id}/split`, { parts: [{ name: "", conversation_ids: [a] }, { name: "Elsewhere", conversation_ids: ["not-in-it"] }] })).status).toBe(422);
  expect(proposals.getProposal(violin.id)!.conversation_ids).toHaveLength(5);

  const res = await post(`/proposals/${violin.id}/split`, { parts: [{ name: "The bow arm", summary: "My right arm.", conversation_ids: [a, b, "not-in-it"] }] });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.left).toBe(3);
  expect(body.parts).toHaveLength(1);
  expect(body.parts[0]).toMatchObject({ name: "The bow arm", summary: "My right arm.", state: "proposed", conversations: 2, origin: "split", verdict: "alive" });
  expect(body.parts[0].conversations_list.map((l: any) => l.id)).toEqual([a, b]);
  expect(body.original).toMatchObject({ id: violin.id, name: "The violin", conversations: 3 });
  expect(proposals.getProposal(violin.id)!.conversation_ids).toEqual([c, d, e]);

  // Everything assigned: the original lives on in its parts only.
  const rest = await post(`/proposals/${violin.id}/split`, { parts: [{ name: "Scales", conversation_ids: [c] }, { name: "Recital", conversation_ids: [d, e, c] }] });
  const done = await rest.json();
  expect(done.left).toBe(0);
  expect(done.original).toBeNull();
  expect(done.parts.map((p: any) => [p.name, p.conversations])).toEqual([["Scales", 1], ["Recital", 2]]);
  expect(proposals.getProposal(violin.id)!.state).toBe("superseded");
  expect((await post(`/proposals/${violin.id}/split`, { parts: [{ name: "Again", conversation_ids: [a] }] })).status).toBe(409);
  expect(proposals.openProposals(ANNA).map((p) => p.name).sort()).toEqual(["Baking bread", "Recital", "Sailing", "Scales", "The bow arm"]);

  // Mail threads are cut the same way, by their garden paths.
  const post_ = proposals.insertProposal({ member_id: ANNA, name: "The landlord", summary: "", conversation_ids: [], mail: ["mail/fr/lease.md", "mail/fr/boiler.md", "mail/fr/deposit.md"] });
  const cut = await (await post(`/proposals/${post_.id}/split`, { parts: [{ name: "The boiler", mail: ["mail/fr/boiler.md", "mail/fr/unknown.md"] }] })).json();
  expect(cut.left).toBe(2);
  expect(cut.parts[0]).toMatchObject({ name: "The boiler", conversations: 0, mail_threads: 1 });
  expect(proposals.getProposal(cut.parts[0].id)!.mail).toEqual(["mail/fr/boiler.md"]);
  expect(proposals.getProposal(post_.id)!.mail).toEqual(["mail/fr/lease.md", "mail/fr/deposit.md"]);
  expectSilence(before);
});

test("POST /proposals/apply: the whole list at once — adopt with notes, rename, put away — and no message, before or after the notes", async () => {
  const { byName } = await night();
  const before = spoken(ANNA);
  const violin = byName.get("The violin")!;
  const bread = byName.get("Baking bread")!;
  const sailing = byName.get("Sailing")!;
  const res = await post(`/proposals/apply`, {
    items: [
      { id: violin.id, action: "adopt", name: "Le violon", seed: true },
      { id: bread.id, action: "keep", summary: "Le pain au levain, surtout." },
      { id: sailing.id, action: "dismiss" },
      { id: "nope", action: "adopt" },
      { id: bread.id, action: "explode" },
    ],
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(Object.keys(body).sort()).toEqual(["adopted", "dismissed", "errors", "renamed"]);
  expect(body.adopted).toHaveLength(1);
  expect(body.adopted[0]).toMatchObject({ name: "Le violon", seeding: true });
  expect(body.dismissed).toEqual([{ id: sailing.id, name: "Sailing" }]);
  expect(body.renamed.map((r: any) => r.name).sort()).toEqual(["Baking bread", "Le violon"]);
  expect(body.errors).toEqual([{ id: "nope", error: "no such proposal" }]);
  expect(proposals.getProposal(bread.id)).toMatchObject({ state: "proposed", summary: "Le pain au levain, surtout." });
  expectSilence(before);

  // The notes, written in the background — and not announced either.
  await proposals.seedingSettled();
  expect(proposals.getProposal(violin.id)!.stats.seed?.state).toBe("written");
  expect(fs.existsSync(path.join(GARDENS, ANNA, "notes", "fr", "le-violon.md"))).toBe(true);
  expect(requests.filter((r) => r.invocation === "domain_seed")).toHaveLength(1);
  await new Promise((r) => setTimeout(r, 50));
  expectSilence(before);

  // The list now shows the one still open, and the settled ones under it.
  const list = await (await req("/proposals")).json();
  expect(list.proposals.map((p: any) => p.name)).toEqual(["Baking bread"]);
  expect(list.settled.map((p: any) => [p.name, p.state]).sort()).toEqual([["Le violon", "adopted"], ["Sailing", "dismissed"]]);
  expect(list.settled.find((p: any) => p.name === "Le violon").seed.state).toBe("written");
  // The domain's page counts its notes.
  const mine = (await (await req("/")).json()).domains.find((d: any) => d.name === "Le violon");
  expect(mine.notes).toMatchObject({ total: 2, unreviewed: 2 });

  // The tools still work beside the list, for the member, in whatever conversation.
  const t = await proposals.runDomainTool("domains__adjust", { action: "rename", id: bread.id, name: "Le pain" }, ANNA);
  expect(t.isError).toBe(false);
  expect(proposals.getProposal(bread.id)!.name).toBe("Le pain");
  // Someone else's items are errors, not acts.
  const bens = await (await post(`/proposals/apply`, { items: [{ id: bread.id, action: "dismiss" }] }, ben)).json();
  expect(bens.errors).toEqual([{ id: bread.id, error: "no such proposal" }]);
  expect(proposals.getProposal(bread.id)!.state).toBe("proposed");
  // A body without items is a 400; an empty list changes nothing.
  expect((await post(`/proposals/apply`, {})).status).toBe(400);
  expect(await (await post(`/proposals/apply`, { items: [] })).json()).toEqual({ adopted: [], dismissed: [], renamed: [], errors: [] });
  expectSilence(before);
});

test("GET /:id/conversations: what is bound to a domain and how it came there, the night's first; taken back by the member, it leaves", async () => {
  const { byName } = await night();
  const violin = byName.get("The violin")!;
  const adopted = (await (await post(`/proposals/${violin.id}/adopt`, {})).json()).adopted;
  const domainId = adopted.domain_id as string;
  await new Promise((r) => setTimeout(r, 50));
  // Two more, filed by the night.
  const filed = [convo(ANNA, "Violin strings", "2026-09-12"), convo(ANNA, "Violin rosin", "2026-09-13")];
  expect(mapping.bindAuto(ANNA, domainId, filed)).toBe(2);

  const res = await req(`/${domainId}/conversations`);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.total).toBe(7);
  expect(body.auto).toBe(2);
  expect(body.conversations).toHaveLength(7);
  expect(Object.keys(body.conversations[0]).sort()).toEqual(["bound_at", "bound_by", "id", "origin", "title", "updated_at"]);
  // The night's come first, marked; the adoption's carry no mark.
  expect(body.conversations.slice(0, 2).map((c: any) => c.id).sort()).toEqual([...filed].sort());
  expect(body.conversations.slice(0, 2).every((c: any) => c.bound_by === "auto" && c.bound_at)).toBe(true);
  expect(body.conversations.slice(2).every((c: any) => c.bound_by === null)).toBe(true);
  expect(body.conversations.slice(2).map((c: any) => c.id).sort()).toEqual([...violin.conversation_ids].sort());
  expect(body.conversations.find((c: any) => c.id === filed[0])!.title).toBe("Violin strings");

  const auto = await (await req(`/${domainId}/conversations?auto=1`)).json();
  expect(auto.conversations.map((c: any) => c.id).sort()).toEqual([...filed].sort());
  expect(auto).toMatchObject({ total: 7, auto: 2 });
  const two = await (await req(`/${domainId}/conversations?limit=2`)).json();
  expect(two.conversations).toHaveLength(2);
  expect(two.total).toBe(7);
  expect((await (await req(`/${domainId}/conversations?limit=0`)).json()).conversations).toHaveLength(7);

  // The domain is its maker's.
  expect((await req(`/${domainId}/conversations`, {}, ben)).status).toBe(404);
  expect((await req(`/nope/conversations`)).status).toBe(404);

  // Taken back: gone from the list, and never filed again.
  expect(setConversationMaurice(filed[0]!, ANNA, null)).toBe(true);
  const after = await (await req(`/${domainId}/conversations`)).json();
  expect(after).toMatchObject({ total: 6, auto: 1 });
  expect(after.conversations.map((c: any) => c.id)).not.toContain(filed[0]);
  expect(mapping.bindAuto(ANNA, domainId, [filed[0]!])).toBe(0);
});
