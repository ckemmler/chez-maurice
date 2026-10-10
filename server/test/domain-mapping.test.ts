/**
 * The nightly mapping and the proposal tools (services/domainMapping.ts,
 * services/domainProposals.ts). The corpus (its groups and its neighbours'
 * vote) and the night model are stubs; what is nailed down is the shape:
 * which conversations are read, the verdict on a group (recurrence and
 * recency), a child and a guest get nothing, the proposals written for the
 * app's list — carried by no conversation, never expiring — the model
 * cutting a small grab-bag, what is new proposed and what was seen not named
 * again, the conversations filed under an adopted domain on their
 * neighbours' word (the group the model recognised, then the net under it),
 * the tools granted to the member while something waits, rename / merge /
 * split / dismiss, and adoption: a domain of kind `domain` created by the
 * member, its conversations bound, its first brief written — and the
 * night's cap that stops a call before it is made. Through all of it
 * Maurice opens no conversation and says nothing in any.
 */
import { beforeAll, beforeEach, expect, test } from "bun:test";

const { default: db } = await import("../src/db");
const budget = await import("../src/services/budget");
const { addModel } = await import("../src/services/models");
const { setPinnedModel } = await import("../src/services/ancillary");
const mapping = await import("../src/services/domainMapping");
const proposals = await import("../src/services/domainProposals");
const briefs = await import("../src/services/domainBriefs");
const { setUserChild } = await import("../src/services/users");
const { setRoomPublisher, setSubscriberCount } = await import("../src/services/roomBus");
const { getMaurice, listMaurices } = await import("../src/services/maurices");
const { domainVoters } = await import("../src/services/domainRecognition");
const { getConversation, setConversationMaurice } = await import("../src/services/conversations");

const ANNA = "map-anna";
const KID = "map-kid";
const GUEST = "map-guest";
const BEN = "map-ben";
const NIGHT = "deepseek-v4-flash-0731";
const TODAY = new Date("2026-09-19T12:00:00Z");

type Req = { system?: string; prompt: string };
let requests: Req[] = [];
let cost = 0.003;
let failNaming = false;

type Match = { id: string; domain: string | null; votes: number; k: number };
/** What the corpus says of a conversation's neighbours; nothing by default. */
let neighbours = new Map<string, { domain: string | null; votes: number; k?: number }>();
let matchCalls: Array<{ member: string; voters: Record<string, string[]>; ids: string[] }> = [];
let matchDown = false;

/** The corpus's `match_domains`: each conversation asked about, with its neighbours' vote. */
async function match(member: string, voters: Record<string, string[]>, ids: string[]): Promise<Match[]> {
  matchCalls.push({ member, voters: JSON.parse(JSON.stringify(voters)), ids: [...ids] });
  if (matchDown) throw new Error("corpus down");
  return ids.map((id) => {
    const n = neighbours.get(id);
    return { id, domain: n?.domain ?? null, votes: n?.votes ?? 0, k: n?.k ?? 12 };
  });
}

/** What Maurice did on his own in the member's conversations: the ones he
 *  opened, and every message of his. Neither moves any more. */
function spoken(member: string): { opened: number; said: number } {
  const opened = db.query(`SELECT COUNT(*) AS n FROM conversations WHERE user_id = ? AND opened_by = 'maurice'`).get(member) as { n: number };
  const said = db
    .query(`SELECT COUNT(*) AS n FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.user_id = ? AND m.role = 'assistant'`)
    .get(member) as { n: number };
  return { opened: opened.n, said: said.n };
}

/** An adopted domain of the member's, with conversations bound to it by hand: its voters. */
function domain(member: string, id: string, name: string, voters = 3): string[] {
  db.run(`INSERT INTO maurices (id, name, kind, prompt, created_by) VALUES (?, ?, 'domain', ?, ?)`, [id, name, `About ${name}.`, member]);
  return Array.from({ length: voters }, (_, i) => convo(member, `Bound ${name} ${i}`, `2026-0${i + 1}-05`, { mauriceId: id }));
}

function boundBy(id: string): { maurice_id: string | null; maurice_bound_by: string | null; maurice_bound_at: string | null } {
  return db.query(`SELECT maurice_id, maurice_bound_by, maurice_bound_at FROM conversations WHERE id = ?`).get(id) as any;
}

function usage(c: number) {
  return { provider: "scaleway", model: NIGHT, rounds: 1, input: 1500, output: 200, cache_read: 0, cache_write: 0, cost: c, cost_uncached: c };
}

/** The night model, from the prompt's shape: naming or a split (and a brief, for the domains' own service). */
async function write(req: { system?: string; prompt: string }) {
  requests.push(req);
  // The group itself, not the list of what already exists that follows it.
  const p = req.prompt.split(/\n\nDomains \S+ already has/)[0]!;
  const reply = (text: string) => ({ text, model: NIGHT, provider: "scaleway", stop: "end" as const, usage: usage(cost) });
  if (p.includes("Cut it into 2 to 4 domains")) {
    // Every numbered line whose title says "cats" goes to one part, "taxes" to the other.
    const cats: number[] = [];
    const taxes: number[] = [];
    for (const m of p.matchAll(/^(\d+)\. (.+?) \(/gm)) {
      if (/cat/i.test(m[2]!)) cats.push(Number(m[1]));
      else if (/tax/i.test(m[2]!)) taxes.push(Number(m[1]));
    }
    return reply(JSON.stringify({ domains: [{ name: "The cats", summary: "Your two cats.", conversations: cats }, { name: "Taxes", summary: "Your yearly return.", conversations: taxes }] }));
  }
  if (req.prompt.includes("Return a JSON object with these keys")) {
    if (failNaming) throw new Error("model down");
    if (/violin practice/i.test(p)) return reply('{"name": "Violon", "summary": "…", "is_domain": true, "split_hint": "", "same_as": "The violin"}');
    if (/junk/i.test(p)) return reply('{"name": "Explorations", "summary": "A bit of everything.", "is_domain": false, "split_hint": "", "same_as": "The violin"}');
    if (/violin/i.test(p)) return reply('Sure: {"name": "The violin", "summary": "You practise and ask about technique.", "is_domain": true, "split_hint": ""}');
    if (/bread/i.test(p)) return reply('{"name": "Baking bread", "summary": "Sourdough and machines.", "is_domain": true, "split_hint": ""}');
    if (/cat|tax/i.test(p)) return reply('{"name": "Home odds and ends", "summary": "Several things.", "is_domain": false, "split_hint": "the cats on one side, the taxes on the other"}');
    if (/sail/i.test(p)) return reply('{"name": "Sailing", "summary": "A summer that passed.", "is_domain": true, "split_hint": ""}');
    if (/garden/i.test(p)) return reply('{"name": "The garden", "summary": "Tomatoes and a hedge.", "is_domain": true, "split_hint": ""}');
    return reply('{"name": "Misc", "summary": "…", "is_domain": true, "split_hint": ""}');
  }
  return reply("You practise the violin.");
}

/** The corpus: groups by the title's first word. */
async function map(memberId: string, ids: string[]) {
  const rows = db
    .query(`SELECT id, COALESCE(title, '') AS title FROM conversations WHERE id IN (${ids.map(() => "?").join(",")})`)
    .all(...ids) as Array<{ id: string; title: string }>;
  const by = new Map<string, string[]>();
  for (const r of rows) {
    const key = r.title.split(" ")[0]!.toLowerCase().replace(/s$/, "");
    const k = key === "cat" || key === "taxe" ? "home" : key;
    by.set(k, [...(by.get(k) ?? []), r.id]);
  }
  return { conversations: ids.length, groups: [...by.values()].map((g) => ({ conversation_ids: g, size: g.length, cohesion: 0.7, depth: 0, parent_size: null })) };
}

let convoN = 0;
function convo(member: string, title: string, day: string, opts: { mauriceId?: string | null; origin?: string; room?: string; openedBy?: string } = {}) {
  const id = `c-${member}-${++convoN}`;
  db.run(`INSERT INTO conversations (id, user_id, title, maurice_id, origin, opened_by) VALUES (?, ?, ?, ?, ?, ?)`, [
    id, member, title, opts.mauriceId ?? null, opts.origin ?? null, opts.openedBy ?? "member",
  ]);
  db.run(`INSERT INTO conversation_participants (conversation_id, member_id, role) VALUES (?, ?, 'owner')`, [id, member]);
  if (opts.room) db.run(`INSERT INTO conversation_participants (conversation_id, member_id, role) VALUES (?, ?, 'member')`, [id, opts.room]);
  db.run(`INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, 'user', ?, ?)`, [crypto.randomUUID(), id, `About ${title}`, `${day} 10:00:00`]);
  db.run(`INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, 'assistant', 'Sure.', ?)`, [crypto.randomUUID(), id, `${day} 10:01:00`]);
  return id;
}

/** Anna's life: violin (alive, 5 months), bread (alive), sailing (lived, 2025), a home grab-bag (cats + taxes). */
function annaCorpus() {
  const violin = ["2026-05-02", "2026-06-10", "2026-07-15", "2026-08-20", "2026-09-10"].map((d, i) => convo(ANNA, `Violin lesson ${i}`, d));
  const bread = ["2026-04-01", "2026-06-01", "2026-08-01", "2026-09-01"].map((d, i) => convo(ANNA, `Bread machine ${i}`, d, { origin: "chatgpt" }));
  const sailing = ["2025-06-01", "2025-07-01", "2025-08-01"].map((d, i) => convo(ANNA, `Sailing trip ${i}`, d));
  const cats = ["2026-05-03", "2026-07-03", "2026-09-03"].map((d, i) => convo(ANNA, `Cats vet ${i}`, d));
  const taxes = ["2026-03-04", "2026-06-04", "2026-09-04"].map((d, i) => convo(ANNA, `Taxes return ${i}`, d));
  return { violin, bread, sailing, cats, taxes };
}

beforeAll(() => {
  db.run(`INSERT OR IGNORE INTO households (id, name) VALUES ('default', 'Home')`);
  db.run(`UPDATE households SET scaleway_api_key = 'test-key', maurice_opens_min_days = NULL WHERE id = 'default'`);
  for (const [id, name, role] of [[ANNA, "Anna", "standard"], [KID, "Kid", "standard"], [GUEST, "Gus", "guest"], [BEN, "Ben", "standard"]] as const) {
    db.run(`INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES (?, ?, ?, ?)`, [id, id, name, role]);
  }
  setUserChild(KID, true);
  if (!db.query(`SELECT 1 FROM models WHERE id = ?`).get(NIGHT)) {
    addModel({ id: NIGHT, name: "DeepSeek V4 Flash", tier: "cloud", vendor: "deepseek", provider: "scaleway" });
  }
  setPinnedModel("domain_mapping", NIGHT);
  setPinnedModel("domain_brief", NIGHT);
  setRoomPublisher(() => {});
  setSubscriberCount(() => 1);
  mapping.setMappingDeps({ write, map, match, now: () => TODAY });
  briefs.setBriefDeps({ write: write as any, search: async () => [] });
});

beforeEach(() => {
  requests = [];
  cost = 0.003;
  failNaming = false;
  neighbours = new Map();
  matchCalls = [];
  matchDown = false;
  budget.setSystemDailyCap(null);
  db.run(`DELETE FROM spend_ledger WHERE user_id = 'system'`);
  db.run(`DELETE FROM domain_proposals`);
  db.run(`DELETE FROM domain_seen`);
  db.run(`DELETE FROM domain_briefs`);
  db.run(`DELETE FROM conversations WHERE user_id IN (?, ?, ?, ?)`, [ANNA, KID, GUEST, BEN]);
  db.run(`DELETE FROM maurices WHERE created_by IN (?, ?, ?, ?)`, [ANNA, KID, GUEST, BEN]);
});

// ── Reading groups ───────────────────────────────────────────────────────────

test("thresholds: step 0's on a large corpus, gentler on a small one", () => {
  expect(mapping.thresholdsFor(5000)).toEqual({ minSize: 8, minMonths: 4, aliveDays: 180 });
  expect(mapping.thresholdsFor(24)).toEqual({ minSize: 3, minMonths: 2, aliveDays: 365 });
});

test("a group's verdict is recurrence and recency, not volume", () => {
  const th = mapping.thresholdsFor(24);
  const byId = new Map<string, mapping.Convo>();
  const mk = (id: string, first: string, last = first) => byId.set(id, { id, title: id, origin: "maurice", first: `${first} 10:00:00`, last: `${last} 10:00:00`, n_user: 1, opening: "" });
  mk("a1", "2026-05-01"); mk("a2", "2026-07-01"); mk("a3", "2026-09-01");
  mk("l1", "2025-03-01"); mk("l2", "2025-04-01"); mk("l3", "2025-05-01");
  mk("n1", "2026-09-01"); mk("n2", "2026-09-02"); mk("n3", "2026-09-03");
  const g = (ids: string[]) => mapping.readGroup({ conversation_ids: ids, size: ids.length, cohesion: 0.8, depth: 0, parent_size: null }, byId, TODAY, th);
  expect(g(["a1", "a2", "a3"]).stats.verdict).toBe("alive");
  expect(g(["a1", "a2", "a3"]).stats.months_active).toBe(3);
  expect(g(["a1", "a2", "a3"]).stats.recent_90).toBe(2); // July and September fall within ninety days of 19 September
  expect(g(["l1", "l2", "l3"]).stats.verdict).toBe("lived");
  expect(g(["n1", "n2", "n3"]).stats.verdict).toBe("noise"); // one month
  expect(g(["a1", "a2"]).stats.verdict).toBe("noise");       // too few
  expect(g(["a1", "zz"]).ids).toEqual(["a1"]);               // an id the member does not own is dropped
});

test("the model's answers are read leniently", () => {
  expect(mapping.parseNaming('Here: {"name": " Violin ", "summary": "x", "is_domain": true, "split_hint": ""}')).toEqual({ name: "Violin", summary: "x", is_domain: true, split_hint: "" });
  expect(mapping.parseNaming("no json")).toBeNull();
  expect(mapping.parseNaming('{"name": ""}')).toBeNull();
  const parts = mapping.parseSplit('{"domains": [{"name": "A", "summary": "s", "conversations": [1, 2, 9, 2]}, {"name": "B", "conversations": [2, 3]}, {"name": "", "conversations": [4]}]}', 5);
  expect(parts).toEqual([{ name: "A", summary: "s", indexes: [1, 2] }, { name: "B", summary: "", indexes: [3] }]);
});

// ── Which conversations ──────────────────────────────────────────────────────

test("only the member's own, unbound, member-opened, single conversations are mapped", () => {
  db.run(`INSERT INTO maurices (id, name, created_by) VALUES ('dom-x', 'X', ?)`, [ANNA]);
  const free = convo(ANNA, "Free one", "2026-09-01");
  convo(ANNA, "Bound one", "2026-09-01", { mauriceId: "dom-x" });
  convo(ANNA, "Room one", "2026-09-01", { room: BEN });
  convo(ANNA, "Opened by Maurice", "2026-09-01", { openedBy: "maurice" });
  const silent = `c-${ANNA}-silent`;
  db.run(`INSERT INTO conversations (id, user_id, title) VALUES (?, ?, 'Silent')`, [silent, ANNA]);
  db.run(`INSERT INTO conversation_participants (conversation_id, member_id, role) VALUES (?, ?, 'owner')`, [silent, ANNA]);
  db.run(`INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, 'assistant', 'Hello?')`, [crypto.randomUUID(), silent]);
  const refused = convo(ANNA, "Refused one", "2026-09-01");
  const p = proposals.insertProposal({ member_id: ANNA, name: "Old", summary: "", conversation_ids: [refused] });
  proposals.updateProposal(p.id, { state: "dismissed" });
  expect(mapping.unattachedConversations(ANNA).map((c) => c.id)).toEqual([free]);
  expect(mapping.unattachedConversations(ANNA)[0]!.n_user).toBe(1);
});

// ── The night for one member ─────────────────────────────────────────────────

test("a child and a guest get nothing, before anything is spent", async () => {
  for (const who of [KID, GUEST]) {
    for (let i = 0; i < 8; i++) convo(who, `Violin ${i}`, `2026-0${(i % 5) + 4}-1${i}`);
    const r = await mapping.mapMember(who);
    expect(r.outcome).toBe("guarded");
    expect(r.reason).toBe(who === KID ? "child" : "guest");
  }
  expect(requests).toHaveLength(0);
  expect(proposals.listProposals(KID)).toHaveLength(0);
});

test("too few conversations: nothing named, nothing written; one recurring group is enough to propose", async () => {
  convo(ANNA, "Violin a", "2026-09-01");
  const few = await mapping.mapMember(ANNA);
  expect(few.outcome).toBe("too_few");
  expect(requests).toHaveLength(0);
  expect(proposals.listProposals(ANNA)).toHaveLength(0);
  expect(budget.spentTodayUsd(budget.SYSTEM_SPENDER)).toBe(0);
  // One alive group (violin) and one lived (sailing): the night no longer
  // waits for a second alive one.
  ["2026-05-02", "2026-06-10", "2026-07-15", "2026-08-20", "2026-09-10"].forEach((d, i) => convo(ANNA, `Violin lesson ${i}`, d));
  ["2025-06-01", "2025-07-01", "2025-08-01"].forEach((d, i) => convo(ANNA, `Sailing trip ${i}`, d));
  const r = await mapping.mapMember(ANNA);
  expect(r.outcome).toBe("proposed");
  expect(r.groups).toBe(2);
  expect(r.named).toBe(2);
  expect(r.presented).toEqual(["The violin"]);
  expect(proposals.openProposals(ANNA).map((p) => p.name).sort()).toEqual(["Sailing", "The violin"]);
});

test("groups that do not recur: nothing named, nothing spent, nothing proposed", async () => {
  // Eight conversations, all of one month: noise, however many.
  for (let i = 0; i < 8; i++) convo(ANNA, `Violin lesson ${i}`, `2026-09-0${i + 1}`);
  const r = await mapping.mapMember(ANNA);
  expect(r.outcome).toBe("nothing");
  expect(r.groups).toBe(1);
  expect(requests).toHaveLength(0);
  expect(proposals.listProposals(ANNA)).toHaveLength(0);
});

test("a night with something to propose: proposals written for the list, the grab-bag cut by the model, no conversation opened and nothing said", async () => {
  annaCorpus();
  const before = spoken(ANNA);
  const conversations = (db.query(`SELECT COUNT(*) AS n FROM conversations WHERE user_id = ?`).get(ANNA) as { n: number }).n;
  const r = await mapping.mapMember(ANNA);
  expect(r.outcome).toBe("proposed");
  expect(r.conversations).toBe(18);
  // 4 groups named (violin, bread, home, sailing) + 1 split = 5 calls, all charged to the night.
  expect(r.named).toBe(4);
  expect(requests).toHaveLength(5);
  expect(r.cost_usd).toBeCloseTo(0.015, 6);
  expect(budget.spentTodayUsd(budget.SYSTEM_SPENDER)).toBeCloseTo(0.015, 6);
  expect(r.proposals).toBe(5);
  expect(r.attached).toBe(0);
  expect(r).not.toHaveProperty("conversation_id");

  const all = proposals.listProposals(ANNA);
  expect(all.map((p) => p.name).sort()).toEqual(["Baking bread", "Sailing", "Taxes", "The cats", "The violin"]);
  const byName = new Map(all.map((p) => [p.name, p]));
  expect(byName.get("The violin")!.conversation_ids).toHaveLength(5);
  expect(byName.get("The violin")!.stats.verdict).toBe("alive");
  expect(byName.get("The violin")!.stats.imported).toBe(0);
  expect(byName.get("Baking bread")!.stats.imported).toBe(4);
  expect(byName.get("Sailing")!.stats.verdict).toBe("lived");
  expect(byName.get("Sailing")!.presented).toBe(false);
  expect(byName.get("The cats")!.stats.origin).toBe("model_split");
  expect(byName.get("The cats")!.conversation_ids).toHaveLength(3);
  // Every alive proposal is marked presented; the lived one is not.
  expect(all.filter((p) => p.presented).map((p) => p.name).sort()).toEqual(["Baking bread", "Taxes", "The cats", "The violin"]);
  expect(r.presented).toHaveLength(4);
  // No conversation carries them.
  expect(all.every((p) => p.state === "proposed" && p.conversation_id === null)).toBe(true);

  // Maurice opened nothing and said nothing: the app's list is where they wait.
  expect(spoken(ANNA)).toEqual(before);
  expect(spoken(ANNA).opened).toBe(0);
  expect(db.query(`SELECT COUNT(*) AS n FROM conversations WHERE user_id = ?`).get(ANNA)).toEqual({ n: conversations });
  // A member without a domain: no neighbours to ask.
  expect(matchCalls).toHaveLength(0);
  // The badge is the one sign.
  expect(proposals.proposalCounts(ANNA)).toEqual({ open: 5, unseen: 5 });

  // The next night: every conversation waits in a proposal, nothing is named again.
  requests = [];
  const again = await mapping.mapMember(ANNA);
  expect(again.outcome).toBe("too_few");
  expect(again.proposals).toBe(0);
  expect(requests).toHaveLength(0);
  expect(proposals.openProposals(ANNA)).toHaveLength(5);
  expect(spoken(ANNA)).toEqual(before);
});

test("the night's cap stops the naming before the call, and nothing is written", async () => {
  annaCorpus();
  budget.setSystemDailyCap(0.005);
  budget.recordSpend(usage(0.006), budget.SYSTEM_SPENDER);
  const r = await mapping.mapMember(ANNA);
  expect(r.outcome).toBe("capped");
  expect(requests).toHaveLength(0);
  expect(proposals.listProposals(ANNA)).toHaveLength(0);
});

test("a proposal left unanswered does not expire: weeks later it still waits, as it was", async () => {
  annaCorpus();
  expect((await mapping.mapMember(ANNA)).outcome).toBe("proposed");
  db.run(`UPDATE domain_proposals SET created_at = '2026-07-01 04:00:00', updated_at = '2026-07-01 04:00:00' WHERE member_id = ?`, [ANNA]);
  requests = [];
  const later = await mapping.mapMember(ANNA);
  expect(later.proposals).toBe(0);
  expect(requests).toHaveLength(0);
  expect(proposals.listProposals(ANNA, ["expired"])).toHaveLength(0);
  expect(proposals.openProposals(ANNA)).toHaveLength(5);
  expect(proposals.proposalsWaiting(ANNA)).toBe(true);
});

test("proposals open: what is new is proposed beside them, an open one the model recognises grows, what was seen is not named again", async () => {
  annaCorpus();
  const first = await mapping.mapMember(ANNA);
  expect(first.outcome).toBe("proposed");
  const violin = proposals.openProposals(ANNA).find((p) => p.name === "The violin")!;
  const before = spoken(ANNA);

  // New conversations: a garden that recurs, and more violin practice.
  ["2026-06-02", "2026-07-02", "2026-08-02", "2026-09-02"].forEach((d, i) => convo(ANNA, `Garden hedge ${i}`, d));
  ["2026-07-05", "2026-08-05", "2026-09-05"].forEach((d, i) => convo(ANNA, `Violin practice ${i}`, d));
  const after = spoken(ANNA);
  requests = [];
  const next = await mapping.mapMember(ANNA);
  expect(next.outcome).toBe("proposed");
  expect(next.proposals).toBe(1);
  expect(next.presented).toEqual(["The garden"]);
  expect(next.attached).toBe(3);
  // Only the groups with something new were named: the garden, the new violin.
  const named = requests.filter((q) => q.prompt.includes("Return a JSON object with these keys"));
  expect(named).toHaveLength(2);
  expect(named.some((q) => /bread|sail|cat/i.test(q.prompt.split(/\n\nDomains \S+ already has/)[0]!))).toBe(false);
  // The model was told what is already there, to say "same as".
  expect(named[0]!.prompt).toContain("- The violin: You practise and ask about technique.");
  // The garden is a proposal of its own, in no conversation; the violin grew.
  const garden = proposals.openProposals(ANNA).find((p) => p.name === "The garden")!;
  expect(garden.conversation_id).toBeNull();
  expect(garden.conversation_ids).toHaveLength(4);
  expect(proposals.getProposal(violin.id)!.conversation_ids).toHaveLength(8);
  expect(proposals.openProposals(ANNA).filter((p) => /viol/i.test(p.name))).toHaveLength(1);
  expect(proposals.openProposals(ANNA)).toHaveLength(6);
  // Nothing was said about either.
  expect(spoken(ANNA)).toEqual(after);
  expect(after.opened).toBe(before.opened);
  expect(spoken(ANNA).opened).toBe(0);
});

test("a member mapped before anything was marked seen: the conversations of the first night count as seen, once", async () => {
  const old = ["2026-05-02", "2026-06-10", "2026-07-15", "2026-08-20"].map((d, i) => convo(ANNA, `Violin lesson ${i}`, d));
  const kept = convo(ANNA, "Violin lesson x", "2026-04-01");
  proposals.insertProposal({ member_id: ANNA, name: "Old", summary: "", conversation_ids: [kept], stats: { origin: "mapping" } });
  db.run(`UPDATE domain_proposals SET created_at = '2026-09-01 04:00:00', state = 'dismissed' WHERE member_id = ?`, [ANNA]);
  mapping.backfillSeen(ANNA);
  const seen = mapping.seenItems(ANNA, "conversation");
  expect(old.every((id) => seen.has(id))).toBe(true);
  // Once: emptied later, it is not filled again.
  db.run(`DELETE FROM domain_seen WHERE member_id = ? AND item IN (${old.map(() => "?").join(",")})`, [ANNA, ...old]);
  mapping.backfillSeen(ANNA);
  expect(old.some((id) => mapping.seenItems(ANNA, "conversation").has(id))).toBe(false);
});

test("a naming the model fails is skipped, not fatal", async () => {
  annaCorpus();
  failNaming = true;
  const r = await mapping.mapMember(ANNA);
  expect(r.outcome).toBe("nothing");
  expect(r.named).toBe(0);
  expect(proposals.listProposals(ANNA)).toHaveLength(0);
});

test("dry run: names but writes nothing and opens nothing", async () => {
  annaCorpus();
  const r = await mapping.mapMember(ANNA, { dryRun: true });
  expect(r.outcome).toBe("proposed");
  expect(r.dry!.map((d) => d.name).sort()).toEqual(["Baking bread", "Sailing", "Taxes", "The cats", "The violin"]);
  expect(proposals.listProposals(ANNA)).toHaveLength(0);
  expect(mapping.seenItems(ANNA, "conversation").size).toBeLessThanOrEqual(1); // the backfill's marker at most
  expect(spoken(ANNA).opened).toBe(0);
});

// ── Filing under an adopted domain ───────────────────────────────────────────

test("a group the model recognises as an adopted domain: the conversations whose neighbours agree are bound as the night's doing, the others left", async () => {
  const voters = domain(ANNA, "dom-violin", "The violin");
  const breadVoters = domain(ANNA, "dom-bread", "Baking bread", 2);
  const p = ["2026-03-05", "2026-04-05", "2026-05-05", "2026-06-05", "2026-07-05", "2026-08-05", "2026-09-05"].map((d, i) => convo(ANNA, `Violin practice ${i}`, d));
  for (const id of [p[0]!, p[1]!, p[2]!]) neighbours.set(id, { domain: "dom-violin", votes: 5 });
  neighbours.set(p[3]!, { domain: "dom-violin", votes: 4 });            // one neighbour short
  neighbours.set(p[4]!, { domain: "dom-violin", votes: 3, k: 6 });      // a smaller corpus, held to the same share
  neighbours.set(p[5]!, { domain: "dom-violin", votes: 12 });           // taken back out by the member
  db.run(`UPDATE conversations SET maurice_bound_by = 'detached' WHERE id = ?`, [p[5]!]);
  neighbours.set(p[6]!, { domain: "dom-bread", votes: 9 });             // another domain's, plainly
  const before = spoken(ANNA);

  const r = await mapping.mapMember(ANNA);
  expect(r.outcome).toBe("attached");
  expect(r.proposals).toBe(0);
  expect(proposals.listProposals(ANNA)).toHaveLength(0);
  expect(r.named).toBe(1);
  expect(r.attached).toBe(5);

  // Five of twelve are enough when the model named the whole group.
  for (const id of [p[0]!, p[1]!, p[2]!, p[4]!]) {
    const row = boundBy(id);
    expect(row.maurice_id).toBe("dom-violin");
    expect(row.maurice_bound_by).toBe("auto");
    expect(row.maurice_bound_at).toBeTruthy();
  }
  expect(boundBy(p[3]!)).toEqual({ maurice_id: null, maurice_bound_by: null, maurice_bound_at: null });
  // The member's refusal holds, whatever the neighbours say.
  expect(boundBy(p[5]!)).toEqual({ maurice_id: null, maurice_bound_by: "detached", maurice_bound_at: null });
  // The one that is not the violin's goes where its own neighbours are, by the net.
  expect(boundBy(p[6]!)).toMatchObject({ maurice_id: "dom-bread", maurice_bound_by: "auto" });

  // The corpus was asked twice: about the group, then about what was left.
  expect(matchCalls).toHaveLength(2);
  expect(matchCalls[0]!.member).toBe(ANNA);
  expect([...matchCalls[0]!.ids].sort()).toEqual([...p].sort());
  expect(Object.keys(matchCalls[0]!.voters).sort()).toEqual(["dom-bread", "dom-violin"]);
  expect([...matchCalls[0]!.voters["dom-violin"]!].sort()).toEqual([...voters].sort());
  expect([...matchCalls[1]!.ids].sort()).toEqual([p[3]!, p[5]!, p[6]!].sort());
  // What the night bound itself does not vote: a domain must not grow on its own guesses.
  expect([...matchCalls[1]!.voters["dom-violin"]!].sort()).toEqual([...voters].sort());
  expect([...matchCalls[1]!.voters["dom-bread"]!].sort()).toEqual([...breadVoters].sort());

  // Filed in silence, and the domain's brief rewritten for the morning.
  expect(spoken(ANNA)).toEqual(before);
  expect(spoken(ANNA).opened).toBe(0);
  await new Promise((r) => setTimeout(r, 50));
  expect(briefs.getBrief("dom-violin", ANNA)).not.toBeNull();
});

test("the net under the groups: a loose conversation whose neighbours belong to a domain is bound at seven of twelve, not below, never one that waits in a proposal", async () => {
  domain(ANNA, "dom-violin", "The violin");
  const loose = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta", "Eta"].map((w, i) => convo(ANNA, `${w} question`, `2026-0${i + 3}-05`));
  const [seven, six, detached, nowhere] = loose as [string, string, string, string];
  const waiting = convo(ANNA, "Theta question", "2026-09-06");
  proposals.insertProposal({ member_id: ANNA, name: "Something else", summary: "", conversation_ids: [waiting] });
  neighbours.set(seven, { domain: "dom-violin", votes: 7 });
  neighbours.set(six, { domain: "dom-violin", votes: 6 });
  neighbours.set(detached, { domain: "dom-violin", votes: 12 });
  db.run(`UPDATE conversations SET maurice_bound_by = 'detached' WHERE id = ?`, [detached]);
  neighbours.set(nowhere, { domain: null, votes: 12 });
  neighbours.set(waiting, { domain: "dom-violin", votes: 12 });
  const before = spoken(ANNA);

  // A corpus that cannot be asked: the night binds nothing, and does not fail.
  matchDown = true;
  const blind = await mapping.mapMember(ANNA);
  expect(blind.outcome).toBe("nothing");
  expect(blind.attached).toBe(0);
  expect(boundBy(seven).maurice_id).toBeNull();

  matchDown = false;
  matchCalls = [];
  const r = await mapping.mapMember(ANNA);
  // Seven groups of one: nothing to name, nothing to propose.
  expect(requests.filter((q) => q.prompt.includes("Return a JSON object with these keys"))).toHaveLength(0);
  expect(r.outcome).toBe("attached");
  expect(r.attached).toBe(1);
  expect(r.proposals).toBe(0);
  expect(boundBy(seven)).toMatchObject({ maurice_id: "dom-violin", maurice_bound_by: "auto" });
  expect(boundBy(seven).maurice_bound_at).toBeTruthy();
  expect(boundBy(six).maurice_id).toBeNull();
  expect(boundBy(detached)).toMatchObject({ maurice_id: null, maurice_bound_by: "detached" });
  expect(boundBy(nowhere).maurice_id).toBeNull();
  // What waits in a proposal is the member's to settle: not even asked about.
  expect(matchCalls).toHaveLength(1);
  expect(matchCalls[0]!.ids).not.toContain(waiting);
  expect([...matchCalls[0]!.ids].sort()).toEqual([...loose].sort());
  expect(boundBy(waiting).maurice_id).toBeNull();
  expect(spoken(ANNA)).toEqual(before);
  await new Promise((r) => setTimeout(r, 50));
});

test("a grab-bag that merely shares the name of a domain is neither filed under it nor proposed", async () => {
  domain(ANNA, "dom-violin", "The violin");
  const junk = ["2026-04-05", "2026-05-05", "2026-06-05", "2026-07-05", "2026-08-05", "2026-09-05"].map((d, i) => convo(ANNA, `Junk thing ${i}`, d));
  // Enough neighbours for a recognised group (five), not for the net (seven).
  for (const id of junk) neighbours.set(id, { domain: "dom-violin", votes: 6 });
  const r = await mapping.mapMember(ANNA);
  expect(r.named).toBe(1);
  expect(r.outcome).toBe("nothing");
  expect(r.attached).toBe(0);
  expect(proposals.listProposals(ANNA)).toHaveLength(0);
  for (const id of junk) expect(boundBy(id).maurice_id).toBeNull();
  // Only the net asked, each conversation on its own.
  expect(matchCalls).toHaveLength(1);
});

test("the member's hand: a conversation taken out of a domain is marked detached and never filed again; one bound by hand is no longer the night's", async () => {
  const voters = domain(ANNA, "dom-violin", "The violin");
  const loose = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta"].map((w, i) => convo(ANNA, `${w} question`, `2026-0${i + 3}-05`));
  const one = loose[0]!;
  neighbours.set(one, { domain: "dom-violin", votes: 10 });
  expect((await mapping.mapMember(ANNA)).attached).toBe(1);
  expect(boundBy(one)).toMatchObject({ maurice_id: "dom-violin", maurice_bound_by: "auto" });
  expect(getConversation(one, ANNA)!.maurice_bound_by).toBe("auto");
  expect(domainVoters(ANNA)["dom-violin"]!.sort()).toEqual([...voters].sort());

  // Someone who is not in the conversation changes nothing.
  expect(setConversationMaurice(one, BEN, null)).toBe(false);
  expect(boundBy(one).maurice_id).toBe("dom-violin");
  // The member takes it back.
  expect(setConversationMaurice(one, ANNA, null)).toBe(true);
  expect(boundBy(one)).toMatchObject({ maurice_id: null, maurice_bound_by: "detached" });
  expect(getConversation(one, ANNA)!.maurice_bound_by).toBe("detached");
  const again = await mapping.mapMember(ANNA);
  expect(again.attached).toBe(0);
  expect(boundBy(one).maurice_id).toBeNull();

  // Bound by the member: theirs, stamped, and a voter from now on.
  expect(setConversationMaurice(one, ANNA, "dom-violin")).toBe(true);
  const row = boundBy(one);
  expect(row.maurice_id).toBe("dom-violin");
  expect(row.maurice_bound_by).toBeNull();
  expect(row.maurice_bound_at).toBeTruthy();
  expect(domainVoters(ANNA)["dom-violin"]).toContain(one);
  // Unbinding one that was never bound leaves no mark.
  expect(setConversationMaurice(loose[1]!, ANNA, null)).toBe(true);
  expect(boundBy(loose[1]!)).toEqual({ maurice_id: null, maurice_bound_by: null, maurice_bound_at: null });
  await new Promise((r) => setTimeout(r, 50));
});

// ── The tools ────────────────────────────────────────────────────────────────

async function night(): Promise<Map<string, proposals.Proposal>> {
  annaCorpus();
  const r = await mapping.mapMember(ANNA);
  expect(r.outcome).toBe("proposed");
  return new Map(proposals.listProposals(ANNA).map((p) => [p.name, p]));
}

test("the four tools are the member's while proposals wait, whatever the conversation; another member has none and reaches nothing", async () => {
  expect(proposals.domainToolsFor(ANNA)).toEqual([]);
  expect(proposals.proposalPromptSection(ANNA, "Anna")).toBe("");
  const byName = await night();
  expect(proposals.proposalsWaiting(ANNA)).toBe(true);
  expect(proposals.domainToolsFor(ANNA).map((t) => t.name)).toEqual(["domains__propose", "domains__adjust", "domains__adopt", "domains__seed"]);
  expect(proposals.domainToolsFor(BEN)).toEqual([]);
  expect(proposals.domainToolsFor(undefined)).toEqual([]);
  // No conversation carries the proposals: an ordinary one changes nothing to the grant.
  convo(ANNA, "Ordinary chat", "2026-09-18");
  expect(proposals.domainToolsFor(ANNA)).toHaveLength(4);
  expect((await proposals.runDomainTool("domains__propose", {}, ANNA)).isError).toBe(false);

  // Ben has nothing waiting: the tool refuses him.
  const refused = await proposals.runDomainTool("domains__propose", {}, BEN);
  expect(refused.isError).toBe(true);
  expect(refused.text).toContain("no domain proposal is waiting");
  expect((await proposals.runDomainTool("domains__propose", {}, undefined)).isError).toBe(true);
  // With a proposal of his own he has the tools, and still nothing of Anna's.
  proposals.insertProposal({ member_id: BEN, name: "Ben's chess", summary: "", conversation_ids: [] });
  expect(proposals.domainToolsFor(BEN)).toHaveLength(4);
  const violin = byName.get("The violin")!;
  for (const [tool, input] of [
    ["domains__propose", { action: "show", id: violin.id }],
    ["domains__adjust", { action: "rename", id: violin.id, name: "Ben's" }],
    ["domains__adjust", { action: "dismiss", id: violin.id }],
    ["domains__adopt", { id: violin.id }],
    ["domains__seed", { id: violin.id }],
  ] as const) {
    const r = await proposals.runDomainTool(tool, input, BEN);
    expect(r.isError).toBe(true);
    expect(r.text).toBe("Tool error: no such proposal");
  }
  expect(proposals.getProposal(violin.id)).toMatchObject({ name: "The violin", state: "proposed" });
  const bens = (await proposals.runDomainTool("domains__propose", {}, BEN)).data as any;
  expect(bens.proposals.map((p: any) => p.name)).toEqual(["Ben's chess"]);

  // The prompt section is short: that proposals wait and where, the rule, the tools — not the list.
  const section = proposals.proposalPromptSection(ANNA, "Anna");
  expect(section).toContain("## Domain proposals");
  expect(section).toContain("5 proposals wait in the Maurice app");
  expect(section).toContain("Do not bring them up yourself");
  expect(section).toContain("explicit yes");
  expect(section).toContain("domains__adopt");
  expect(section).not.toContain("The violin");
  expect(section).toContain('"brief"');
  expect(proposals.proposalPromptSection(ANNA, "Anna", "fr")).toContain('"cahier"');
  expect(proposals.proposalPromptSection(BEN, "Ben")).toContain("One proposal waits");
  expect(proposals.proposalPromptSection(undefined, "Anna")).toBe("");
  expect(proposals.proposalPromptSection(KID, "Kid")).toBe("");
});

test("propose: list, show, add", async () => {
  const byName = await night();
  const list = await proposals.runDomainTool("domains__propose", {}, ANNA);
  expect(list.isError).toBe(false);
  const data = list.data as any;
  expect(data.proposals.map((p: any) => p.name)).toContain("The violin");
  const violin = data.proposals.find((p: any) => p.name === "The violin");
  expect(violin.conversations).toBe(5);
  expect(violin.sample).toHaveLength(5);
  expect(violin.sample[0]).toMatch(/^2026-\d\d-\d\d — Violin lesson/);
  expect(violin.conversation_ids).toBeUndefined();

  const show = await proposals.runDomainTool("domains__propose", { action: "show", id: byName.get("The violin")!.id }, ANNA);
  expect((show.data as any).conversations).toHaveLength(5);
  expect((show.data as any).conversations[0]).toHaveProperty("id");

  const foreign = convo(BEN, "Ben's", "2026-09-01");
  const mine = convo(ANNA, "Garden plans", "2026-09-01");
  const add = await proposals.runDomainTool("domains__propose", { action: "add", name: "The garden", summary: "Beds and seeds.", conversation_ids: [mine, foreign] }, ANNA);
  expect(add.isError).toBe(false);
  const added = proposals.getProposal((add.data as any).added.id)!;
  expect(added.conversation_ids).toEqual([mine]);
  expect(added.stats.origin).toBe("member");
  expect(added.conversation_id).toBeNull();
  expect(added.member_id).toBe(ANNA);
  expect((await proposals.runDomainTool("domains__propose", { action: "add" }, ANNA)).isError).toBe(true);
});

test("adjust: rename, merge, split, dismiss", async () => {
  const byName = await night();
  const before = spoken(ANNA);
  const violin = byName.get("The violin")!;
  const renamed = await proposals.runDomainTool("domains__adjust", { action: "rename", id: violin.id, name: "Mon violon" }, ANNA);
  expect(renamed.isError).toBe(false);
  expect(proposals.getProposal(violin.id)!.name).toBe("Mon violon");
  expect(proposals.getProposal(violin.id)!.summary).toBe(violin.summary);

  const cats = byName.get("The cats")!;
  const taxes = byName.get("Taxes")!;
  const merged = await proposals.runDomainTool("domains__adjust", { action: "merge", ids: [cats.id, taxes.id], name: "Home", summary: "Cats and taxes." }, ANNA);
  expect(merged.isError).toBe(false);
  const home = proposals.getProposal((merged.data as any).merged.id)!;
  expect(home.conversation_ids).toHaveLength(6);
  expect(home.presented).toBe(true);
  expect(home.stats.verdict).toBe("alive");
  expect(home.stats.origin).toBe("merge");
  expect(proposals.getProposal(cats.id)!.state).toBe("superseded");
  expect(proposals.getProposal(taxes.id)!.state).toBe("superseded");
  expect((await proposals.runDomainTool("domains__adjust", { action: "merge", ids: [cats.id, home.id] }, ANNA)).isError).toBe(true);

  const [a, b] = home.conversation_ids;
  const split = await proposals.runDomainTool("domains__adjust", { action: "split", id: home.id, parts: [{ name: "Just the cats", conversation_ids: [a, b, "not-mine"] }] }, ANNA);
  expect(split.isError).toBe(false);
  expect((split.data as any).left_in_original).toBe(4);
  const part = proposals.getProposal((split.data as any).parts[0].id)!;
  expect(part.conversation_ids).toEqual([a!, b!]);
  expect(proposals.getProposal(home.id)!.conversation_ids).toHaveLength(4);
  expect(proposals.getProposal(home.id)!.state).toBe("proposed");

  const dismissed = await proposals.runDomainTool("domains__adjust", { action: "dismiss", id: byName.get("Sailing")!.id }, ANNA);
  expect(dismissed.isError).toBe(false);
  expect(proposals.getProposal(byName.get("Sailing")!.id)!.state).toBe("dismissed");
  // Its conversations never come up again.
  const taken = proposals.conversationsSpokenFor(ANNA);
  for (const id of byName.get("Sailing")!.conversation_ids) expect(taken.has(id)).toBe(true);
  expect((await proposals.runDomainTool("domains__adjust", { action: "rename", id: "nope", name: "x" }, ANNA)).isError).toBe(true);
  // The tools act; they say nothing of their own in any conversation.
  expect(spoken(ANNA)).toEqual(before);
});

test("adopt: a domain of the member's, its conversations bound, its first brief written", async () => {
  const byName = await night();
  const said = spoken(ANNA);
  const violin = byName.get("The violin")!;
  const before = listMaurices().filter((m) => m.created_by === ANNA).length;
  requests = [];
  const r = await proposals.runDomainTool("domains__adopt", { id: violin.id, name: "Le violon" }, ANNA);
  expect(r.isError).toBe(false);
  const data = r.data as any;
  expect(data.adopted).toBe("Le violon");
  expect(data.conversations_bound).toBe(5);

  const domain = getMaurice(data.domain_id)!;
  expect(domain.kind).toBe("domain");
  expect(domain.created_by).toBe(ANNA);
  expect(domain.name).toBe("Le violon");
  expect(domain.prompt).toBe(violin.summary);
  expect(domain.users).toEqual([ANNA]);
  expect(domain.context.map((i) => i.type)).toEqual(["conversation", "conversation", "conversation"]);
  expect(listMaurices().filter((m) => m.created_by === ANNA)).toHaveLength(before + 1);
  const bound = db.query(`SELECT COUNT(*) AS n FROM conversations WHERE maurice_id = ?`).get(domain.id) as { n: number };
  expect(bound.n).toBe(5);
  // Bound by the member's yes, not by the night: they vote for their domain.
  expect(boundBy(violin.conversation_ids[0]!).maurice_bound_by).toBeNull();
  expect(domainVoters(ANNA)[domain.id]).toHaveLength(5);
  const p = proposals.getProposal(violin.id)!;
  expect(p.state).toBe("adopted");
  expect(p.maurice_id).toBe(domain.id);
  expect(p.name).toBe("Le violon");

  // The first brief, from the bound conversations, on the night model.
  await new Promise((r) => setTimeout(r, 50));
  const brief = briefs.getBrief(domain.id, ANNA);
  expect(brief).not.toBeNull();
  expect(brief!.sources).toHaveLength(5);
  expect(requests.some((q) => q.prompt.includes('The domain is called "Le violon"'))).toBe(true);
  expect(spoken(ANNA)).toEqual(said);

  // Adopted twice is refused; the tools stay while another proposal is open.
  expect((await proposals.runDomainTool("domains__adopt", { id: violin.id }, ANNA)).isError).toBe(true);
  expect(proposals.domainToolsFor(ANNA)).toHaveLength(4);
  // Every proposal settled and the adopted domain's garden notes declined
  // (P2-C: the tools stay until the notes are written or declined, a day at
  // most): the tools go, and the prompt says nothing more.
  for (const p of proposals.openProposals(ANNA)) proposals.updateProposal(p.id, { state: "dismissed" });
  expect(proposals.domainToolsFor(ANNA)).toHaveLength(4);
  expect(proposals.proposalsWaiting(ANNA, new Date(Date.now() + 25 * 60 * 60 * 1000))).toBe(false);
  expect((await proposals.runDomainTool("domains__seed", { id: violin.id, action: "decline" }, ANNA)).isError).toBe(false);
  expect(proposals.domainToolsFor(ANNA)).toEqual([]);
  expect(proposals.proposalPromptSection(ANNA, "Anna")).toBe("");
  // The adopted domain's conversations are not mapped again.
  expect(mapping.unattachedConversations(ANNA).map((c) => c.id)).not.toContain(violin.conversation_ids[0]);
});

test("the whole night: every member once, children and guests counted as skipped, nobody spoken to", async () => {
  annaCorpus();
  for (let i = 0; i < 8; i++) convo(KID, `Violin ${i}`, `2026-0${(i % 5) + 4}-1${i}`);
  const opened = () => (db.query(`SELECT COUNT(*) AS n FROM conversations WHERE opened_by = 'maurice'`).get() as { n: number }).n;
  const said = () => (db.query(`SELECT COUNT(*) AS n FROM messages WHERE role = 'assistant'`).get() as { n: number }).n;
  const before = { opened: opened(), said: said() };
  const outcome = await mapping.runDomainMapping();
  expect(outcome).toBe("done");
  const s = mapping.mappingNightlyStatus();
  expect(Object.keys(s.last_stats!).sort()).toEqual(["attached", "cost_usd", "members", "proposals", "results", "skipped"]);
  expect(s.last_stats!.proposals).toBe(5);
  expect(s.last_stats!.attached).toBe(0);
  expect(s.last_stats!.skipped).toBeGreaterThanOrEqual(2); // the child, the guest
  expect(s.last_stats!.results.find((r) => r.member_id === KID)!.outcome).toBe("guarded");
  expect(s.last_stats!.results.find((r) => r.member_id === GUEST)!.outcome).toBe("guarded");
  expect(s.last_stats!.results.find((r) => r.member_id === ANNA)!.outcome).toBe("proposed");
  expect(s.last_stats!.results.find((r) => r.member_id === ANNA)!.attached).toBe(0);
  expect(s.last_stats!.cost_usd).toBeCloseTo(0.015, 6);
  // In the whole household: no conversation opened, no message left.
  expect({ opened: opened(), said: said() }).toEqual(before);
});
