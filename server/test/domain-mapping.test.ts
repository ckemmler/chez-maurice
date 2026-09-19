/**
 * The nightly mapping and the three proposal tools (services/domainMapping.ts,
 * services/domainProposals.ts). The corpus, the night model and the opener
 * are stubs; what is nailed down is the shape: which conversations are read,
 * the verdict on a group (recurrence and recency), the maturity criterion
 * (two alive groups at least, nothing spent before it), a child and a guest
 * get nothing, the proposals written and the conversation opened with the
 * three presented, the model cutting a small grab-bag, the tools granted to
 * that conversation alone, rename / merge / split / dismiss, and adoption:
 * a domain of kind `domain` created by the member, its conversations bound,
 * its first brief written — and the night's cap that stops a call before it
 * is made.
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
const { openingGuard } = await import("../src/services/openedConversations");

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

function usage(c: number) {
  return { provider: "scaleway", model: NIGHT, rounds: 1, input: 1500, output: 200, cache_read: 0, cache_write: 0, cost: c, cost_uncached: c };
}

/** The night model, from the prompt's shape: naming, a split, or the opener. */
async function write(req: { system?: string; prompt: string }) {
  requests.push(req);
  const p = req.prompt;
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
  if (p.includes("Return a JSON object with these keys")) {
    if (failNaming) throw new Error("model down");
    if (/violin/i.test(p)) return reply('Sure: {"name": "The violin", "summary": "You practise and ask about technique.", "is_domain": true, "split_hint": ""}');
    if (/bread/i.test(p)) return reply('{"name": "Baking bread", "summary": "Sourdough and machines.", "is_domain": true, "split_hint": ""}');
    if (/cat|tax/i.test(p)) return reply('{"name": "Home odds and ends", "summary": "Several things.", "is_domain": false, "split_hint": "the cats on one side, the taxes on the other"}');
    if (/sail/i.test(p)) return reply('{"name": "Sailing", "summary": "A summer that passed.", "is_domain": true, "split_hint": ""}');
    return reply('{"name": "Misc", "summary": "…", "is_domain": true, "split_hint": ""}');
  }
  return reply("Bonjour Anna. Cette nuit j'ai relu nos conversations…\n\n- **The violin**\n- **Baking bread**\n\nDis-moi ce que tu en penses.");
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
  mapping.setMappingDeps({ write, map, now: () => TODAY });
  briefs.setBriefDeps({ write: write as any, search: async () => [] });
});

beforeEach(() => {
  requests = [];
  cost = 0.003;
  failNaming = false;
  budget.setSystemDailyCap(null);
  db.run(`DELETE FROM spend_ledger WHERE user_id = 'system'`);
  db.run(`DELETE FROM domain_proposals`);
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

test("too few conversations, or fewer than two alive groups: nothing named, nothing written", async () => {
  convo(ANNA, "Violin a", "2026-09-01");
  expect((await mapping.mapMember(ANNA)).outcome).toBe("too_few");
  // One alive group (violin) and one lived (sailing): not mature.
  ["2026-05-02", "2026-06-10", "2026-07-15", "2026-08-20", "2026-09-10"].forEach((d, i) => convo(ANNA, `Violin lesson ${i}`, d));
  ["2025-06-01", "2025-07-01", "2025-08-01"].forEach((d, i) => convo(ANNA, `Sailing trip ${i}`, d));
  const r = await mapping.mapMember(ANNA);
  expect(r.outcome).toBe("not_mature");
  expect(r.groups).toBe(2);
  expect(requests).toHaveLength(0);
  expect(proposals.listProposals(ANNA)).toHaveLength(0);
  expect(budget.spentTodayUsd(budget.SYSTEM_SPENDER)).toBe(0);
});

test("a mature member: proposals written, the grab-bag cut by the model, the conversation opened with three presented", async () => {
  annaCorpus();
  const r = await mapping.mapMember(ANNA);
  expect(r.outcome).toBe("opened");
  expect(r.conversations).toBe(18);
  // 4 groups named (violin, bread, home, sailing) + 1 split + 1 opener = 6 calls, all charged to the night.
  expect(r.named).toBe(4);
  expect(requests).toHaveLength(6);
  expect(r.cost_usd).toBeCloseTo(0.018, 6);
  expect(budget.spentTodayUsd(budget.SYSTEM_SPENDER)).toBeCloseTo(0.018, 6);

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
  expect(all.filter((p) => p.presented).map((p) => p.name).sort()).toEqual(["Baking bread", "The cats", "The violin"]);
  expect(r.presented).toHaveLength(3);
  expect(all.every((p) => p.state === "proposed" && p.conversation_id === r.conversation_id)).toBe(true);

  // The conversation is Maurice's, with his message first.
  const conv = db.query(`SELECT opened_by, user_id FROM conversations WHERE id = ?`).get(r.conversation_id!) as any;
  expect(conv).toEqual({ opened_by: "maurice", user_id: ANNA });
  const first = db.query(`SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at LIMIT 1`).get(r.conversation_id!) as any;
  expect(first.role).toBe("assistant");
  expect(first.content).toContain("The violin");
  // The opener prompt carried the three and named the others.
  const opener = requests[5]!.prompt;
  expect(opener).toContain("The three domains to present");
  expect(opener).toContain("Sailing");
  expect(opener).toContain("Taxes");
  expect(requests[5]!.system).toContain("English");

  // Waiting from now on: nothing mapped again, nothing spent.
  requests = [];
  expect((await mapping.mapMember(ANNA)).outcome).toBe("waiting");
  expect(requests).toHaveLength(0);
  expect(openingGuard(ANNA, TODAY).ok).toBe(false);
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

test("a failed opener leaves the proposals for the next night, which opens without mapping again", async () => {
  annaCorpus();
  const failOnce = mapping.setMappingDeps({
    write: async (req) => {
      if (!req.prompt.includes("Return a JSON") && !req.prompt.includes("Cut it into")) throw new Error("opener down");
      return write(req);
    },
    map, now: () => TODAY,
  });
  const r = await mapping.mapMember(ANNA);
  expect(r.outcome).toBe("proposed");
  expect(proposals.openProposals(ANNA)).toHaveLength(5);
  expect(proposals.openProposals(ANNA).every((p) => p.conversation_id === null)).toBe(true);
  mapping.setMappingDeps({ write, map, now: () => TODAY });
  requests = [];
  const again = await mapping.mapMember(ANNA);
  expect(again.outcome).toBe("opened");
  expect(requests).toHaveLength(1); // the opener only
  expect(proposals.openProposals(ANNA).every((p) => p.conversation_id === again.conversation_id)).toBe(true);
  void failOnce;
});

test("a proposal left unanswered expires, and the night maps again", async () => {
  annaCorpus();
  const r = await mapping.mapMember(ANNA);
  expect(r.outcome).toBe("opened");
  db.run(`UPDATE domain_proposals SET created_at = '2026-07-01 04:00:00' WHERE member_id = ?`, [ANNA]);
  db.run(`UPDATE conversations SET created_at = '2026-07-01 04:00:00' WHERE id = ?`, [r.conversation_id!]);
  const later = await mapping.mapMember(ANNA);
  expect(later.outcome).toBe("opened");
  expect(proposals.listProposals(ANNA, ["expired"])).toHaveLength(5);
  expect(proposals.openProposals(ANNA)).toHaveLength(5);
});

test("a naming the model fails is skipped, not fatal", async () => {
  annaCorpus();
  failNaming = true;
  const r = await mapping.mapMember(ANNA);
  expect(r.outcome).toBe("not_mature");
  expect(r.named).toBe(0);
});

test("dry run: names but writes nothing and opens nothing", async () => {
  annaCorpus();
  const r = await mapping.mapMember(ANNA, { dryRun: true });
  expect(r.outcome).toBe("proposed");
  expect(r.dry!.map((d) => d.name).sort()).toEqual(["Baking bread", "Sailing", "Taxes", "The cats", "The violin"]);
  expect(proposals.listProposals(ANNA)).toHaveLength(0);
  expect(db.query(`SELECT COUNT(*) AS n FROM conversations WHERE user_id = ? AND opened_by = 'maurice'`).get(ANNA)).toEqual({ n: 0 });
});

// ── The tools ────────────────────────────────────────────────────────────────

async function opened(): Promise<{ conversationId: string; byName: Map<string, proposals.Proposal> }> {
  annaCorpus();
  const r = await mapping.mapMember(ANNA);
  expect(r.outcome).toBe("opened");
  return { conversationId: r.conversation_id!, byName: new Map(proposals.listProposals(ANNA).map((p) => [p.name, p])) };
}

test("the three tools exist in the proposal conversation only, for its member only", async () => {
  const { conversationId } = await opened();
  expect(proposals.domainToolsFor(conversationId, ANNA).map((t) => t.name)).toEqual(["domains__propose", "domains__adjust", "domains__adopt", "domains__seed"]);
  expect(proposals.domainToolsFor(conversationId, BEN)).toEqual([]);
  const other = convo(ANNA, "Ordinary chat", "2026-09-18");
  expect(proposals.domainToolsFor(other, ANNA)).toEqual([]);
  const r = await proposals.runDomainTool("domains__propose", {}, other);
  expect(r.isError).toBe(true);
  // The prompt section names the proposals and the rules.
  const section = proposals.proposalPromptSection(conversationId, "Anna");
  expect(section).toContain("## Proposing domains");
  expect(section).toContain("The violin");
  expect(section).toContain("presented in your opening message");
  expect(section).toContain("lived, quiet now");
  expect(proposals.proposalPromptSection(other, "Anna")).toBe("");
});

test("propose: list, show, add", async () => {
  const { conversationId, byName } = await opened();
  const list = await proposals.runDomainTool("domains__propose", {}, conversationId);
  expect(list.isError).toBe(false);
  const data = list.data as any;
  expect(data.proposals.map((p: any) => p.name)).toContain("The violin");
  const violin = data.proposals.find((p: any) => p.name === "The violin");
  expect(violin.conversations).toBe(5);
  expect(violin.sample).toHaveLength(5);
  expect(violin.sample[0]).toMatch(/^2026-\d\d-\d\d — Violin lesson/);
  expect(violin.conversation_ids).toBeUndefined();

  const show = await proposals.runDomainTool("domains__propose", { action: "show", id: byName.get("The violin")!.id }, conversationId);
  expect((show.data as any).conversations).toHaveLength(5);
  expect((show.data as any).conversations[0]).toHaveProperty("id");

  const foreign = convo(BEN, "Ben's", "2026-09-01");
  const mine = convo(ANNA, "Garden plans", "2026-09-01");
  const add = await proposals.runDomainTool("domains__propose", { action: "add", name: "The garden", summary: "Beds and seeds.", conversation_ids: [mine, foreign] }, conversationId);
  expect(add.isError).toBe(false);
  const added = proposals.getProposal((add.data as any).added.id)!;
  expect(added.conversation_ids).toEqual([mine]);
  expect(added.stats.origin).toBe("member");
  expect(added.conversation_id).toBe(conversationId);
  expect((await proposals.runDomainTool("domains__propose", { action: "add" }, conversationId)).isError).toBe(true);
});

test("adjust: rename, merge, split, dismiss", async () => {
  const { conversationId, byName } = await opened();
  const violin = byName.get("The violin")!;
  const renamed = await proposals.runDomainTool("domains__adjust", { action: "rename", id: violin.id, name: "Mon violon" }, conversationId);
  expect(renamed.isError).toBe(false);
  expect(proposals.getProposal(violin.id)!.name).toBe("Mon violon");
  expect(proposals.getProposal(violin.id)!.summary).toBe(violin.summary);

  const cats = byName.get("The cats")!;
  const taxes = byName.get("Taxes")!;
  const merged = await proposals.runDomainTool("domains__adjust", { action: "merge", ids: [cats.id, taxes.id], name: "Home", summary: "Cats and taxes." }, conversationId);
  expect(merged.isError).toBe(false);
  const home = proposals.getProposal((merged.data as any).merged.id)!;
  expect(home.conversation_ids).toHaveLength(6);
  expect(home.presented).toBe(true);
  expect(home.stats.verdict).toBe("alive");
  expect(proposals.getProposal(cats.id)!.state).toBe("superseded");
  expect(proposals.getProposal(taxes.id)!.state).toBe("superseded");
  expect((await proposals.runDomainTool("domains__adjust", { action: "merge", ids: [cats.id, home.id] }, conversationId)).isError).toBe(true);

  const [a, b] = home.conversation_ids;
  const split = await proposals.runDomainTool("domains__adjust", { action: "split", id: home.id, parts: [{ name: "Just the cats", conversation_ids: [a, b, "not-mine"] }] }, conversationId);
  expect(split.isError).toBe(false);
  expect((split.data as any).left_in_original).toBe(4);
  const part = proposals.getProposal((split.data as any).parts[0].id)!;
  expect(part.conversation_ids).toEqual([a, b]);
  expect(proposals.getProposal(home.id)!.conversation_ids).toHaveLength(4);
  expect(proposals.getProposal(home.id)!.state).toBe("proposed");

  const dismissed = await proposals.runDomainTool("domains__adjust", { action: "dismiss", id: byName.get("Sailing")!.id }, conversationId);
  expect(dismissed.isError).toBe(false);
  expect(proposals.getProposal(byName.get("Sailing")!.id)!.state).toBe("dismissed");
  // Its conversations never come up again.
  const spoken = proposals.conversationsSpokenFor(ANNA);
  for (const id of byName.get("Sailing")!.conversation_ids) expect(spoken.has(id)).toBe(true);
  expect((await proposals.runDomainTool("domains__adjust", { action: "rename", id: "nope", name: "x" }, conversationId)).isError).toBe(true);
});

test("adopt: a domain of the member's, its conversations bound, its first brief written", async () => {
  const { conversationId, byName } = await opened();
  const violin = byName.get("The violin")!;
  const before = listMaurices().filter((m) => m.created_by === ANNA).length;
  requests = [];
  const r = await proposals.runDomainTool("domains__adopt", { id: violin.id, name: "Le violon" }, conversationId);
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

  // Adopted twice is refused; the tools stay while another proposal is open.
  expect((await proposals.runDomainTool("domains__adopt", { id: violin.id }, conversationId)).isError).toBe(true);
  expect(proposals.domainToolsFor(conversationId, ANNA)).toHaveLength(4);
  // Every proposal settled and the adopted domain's garden notes declined
  // (P2-C: the tools stay until the notes are written or declined): the
  // tools go, the section says so.
  for (const p of proposals.openProposals(ANNA)) proposals.updateProposal(p.id, { state: "dismissed" });
  expect(proposals.domainToolsFor(conversationId, ANNA)).toHaveLength(4);
  expect((await proposals.runDomainTool("domains__seed", { id: violin.id, action: "decline" }, conversationId)).isError).toBe(false);
  expect(proposals.domainToolsFor(conversationId, ANNA)).toEqual([]);
  expect(proposals.proposalPromptSection(conversationId, "Anna")).toContain("No proposal is open any more");
  // The adopted domain's conversations are not mapped again.
  expect(mapping.unattachedConversations(ANNA).map((c) => c.id)).not.toContain(violin.conversation_ids[0]);
});

test("the whole night: every member once, children and guests counted as skipped", async () => {
  annaCorpus();
  for (let i = 0; i < 8; i++) convo(KID, `Violin ${i}`, `2026-0${(i % 5) + 4}-1${i}`);
  const outcome = await mapping.runDomainMapping();
  expect(outcome).toBe("done");
  const s = mapping.mappingNightlyStatus();
  expect(s.last_stats!.opened).toBe(1);
  expect(s.last_stats!.proposals).toBe(5);
  expect(s.last_stats!.results.find((r) => r.member_id === KID)!.outcome).toBe("guarded");
  expect(s.last_stats!.results.find((r) => r.member_id === ANNA)!.outcome).toBe("opened");
  expect(s.last_stats!.cost_usd).toBeCloseTo(0.018, 6);
});
