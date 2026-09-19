/**
 * The demo household's history (scripts/demo-conversations.ts) is ripe for
 * the domains' night: seeded for a member on a fixed day, the mapping's
 * arithmetic — a corpus stub that groups by the set's own topics, the night
 * model stubbed to name what it is given — finds at least two alive groups
 * and proposes, on a dry run, without writing a proposal or opening
 * anything; the bike is a group that lived; the one-offs stay noise; and
 * seeding twice adds nothing. The real embedding's separation of the topics
 * is what the trial on a seeded household checks, not this file.
 */
import { beforeAll, beforeEach, expect, test } from "bun:test";

const { default: db } = await import("../src/db");
const demo = await import("../scripts/demo-conversations");
const mapping = await import("../src/services/domainMapping");
const { addModel } = await import("../src/services/models");
const { setPinnedModel } = await import("../src/services/ancillary");
const { setRoomPublisher, setSubscriberCount } = await import("../src/services/roomBus");

const THEO = "demo-theo-test";
const NIGHT = "deepseek-v4-flash-0731";
const TODAY = new Date("2026-09-19T12:00:00Z");

let seeded: ReturnType<typeof demo.seedDemoConversations>;
let named: string[] = [];

/** The corpus: groups by the set's topic. */
async function map(_memberId: string, ids: string[]) {
  const want = new Set(ids);
  const groups = [...seeded.byTopic.values()].map((g) => g.filter((id) => want.has(id))).filter((g) => g.length);
  return { conversations: ids.length, groups: groups.map((g) => ({ conversation_ids: g, size: g.length, cohesion: 0.8, depth: 0, parent_size: null })) };
}

/** The night model: names a group after its first title. */
async function write(req: { system?: string; prompt: string }) {
  const reply = (text: string) => ({ text, model: NIGHT, provider: "scaleway", stop: "end" as const, usage: { provider: "scaleway", model: NIGHT, rounds: 1, input: 1000, output: 100, cache_read: 0, cache_write: 0, cost: 0.002, cost_uncached: 0.002 } });
  const title = req.prompt.match(/^1\. (.+?) \(/m)?.[1] ?? "Something";
  named.push(title);
  return reply(JSON.stringify({ name: title, summary: `About ${title.toLowerCase()}.`, is_domain: true, split_hint: "" }));
}

beforeAll(() => {
  db.run(`INSERT OR IGNORE INTO households (id, name) VALUES ('default', 'Home')`);
  db.run(`UPDATE households SET scaleway_api_key = 'test-key', maurice_opens_min_days = NULL WHERE id = 'default'`);
  db.run(`INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES (?, ?, 'Théo', 'standard')`, [THEO, THEO]);
  if (!db.query(`SELECT 1 FROM models WHERE id = ?`).get(NIGHT)) {
    addModel({ id: NIGHT, name: "DeepSeek V4 Flash", tier: "cloud", vendor: "deepseek", provider: "scaleway" });
  }
  setPinnedModel("domain_mapping", NIGHT);
  setRoomPublisher(() => {});
  setSubscriberCount(() => 1);
  mapping.setMappingDeps({ write, map, now: () => TODAY });
});

beforeEach(() => {
  named = [];
  db.run(`DELETE FROM domain_proposals`);
  db.run(`DELETE FROM conversations WHERE user_id = ?`, [THEO]);
  seeded = demo.seedDemoConversations(THEO, TODAY);
});

test("the set: three living groups of three or more, one that lived, two one-offs, mostly imported", () => {
  expect(seeded.ids).toHaveLength(demo.DEMO_CONVERSATIONS.length);
  for (const t of ["bread", "garden", "japanese"] as const) expect(seeded.byTopic.get(t)!.length).toBeGreaterThanOrEqual(3);
  expect(seeded.byTopic.get("bike")!.length).toBeGreaterThanOrEqual(3);
  expect(seeded.byTopic.get("noise")!.length).toBe(2);
  expect(seeded.imported).toBeGreaterThan(seeded.ids.length / 2);
  const imported = db.query(`SELECT COUNT(*) c FROM conversations WHERE user_id = ? AND origin = 'chatgpt' AND imported_at IS NOT NULL`).get(THEO) as { c: number };
  expect(imported.c).toBe(seeded.imported);
  // Every conversation has a turn of Théo's, dated in the past.
  const turns = db.query(`SELECT COUNT(*) c FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.user_id = ? AND m.role = 'user' AND m.created_at <= ?`).get(THEO, "2026-09-19 12:00:00") as { c: number };
  expect(turns.c).toBeGreaterThanOrEqual(seeded.ids.length);
});

test("dates are relative to the seed day and never in the future", () => {
  expect(demo.demoDate(TODAY, 0, 6, 9)).toBe("2026-09-06 09:00:00");
  expect(demo.demoDate(TODAY, 1, 31, 9)).toBe("2026-08-31 09:00:00");
  expect(demo.demoDate(TODAY, 7, 30, 9)).toBe("2026-02-28 09:00:00");
  expect(demo.demoDate(TODAY, 0, 25, 9) < "2026-09-19 12:00:00").toBe(true);
});

test("the mapping's reading: bread, garden and Japanese alive; the bike lived; the one-offs noise", () => {
  const convos = mapping.unattachedConversations(THEO);
  expect(convos).toHaveLength(seeded.ids.length);
  const byId = new Map(convos.map((c) => [c.id, c]));
  const th = mapping.thresholdsFor(convos.length);
  const verdict = (topic: demo.DemoTopic) => {
    const ids = seeded.byTopic.get(topic)!;
    return mapping.readGroup({ conversation_ids: ids, size: ids.length, cohesion: 0.8, depth: 0, parent_size: null }, byId, TODAY, th).stats.verdict;
  };
  expect(verdict("bread")).toBe("alive");
  expect(verdict("garden")).toBe("alive");
  expect(verdict("japanese")).toBe("alive");
  expect(verdict("bike")).toBe("lived");
  expect(verdict("noise")).toBe("noise");
});

test("a dry run proposes at least two alive domains and writes nothing", async () => {
  const r = await mapping.mapMember(THEO, { dryRun: true });
  expect(r.outcome).toBe("proposed");
  expect(r.conversations).toBe(seeded.ids.length);
  const alive = (r.dry ?? []).filter((d) => d.stats.verdict === "alive");
  expect(alive.length).toBeGreaterThanOrEqual(2);
  expect((r.dry ?? []).some((d) => d.stats.verdict === "lived")).toBe(true);
  expect(named.some((n) => /rain|oven/i.test(n))).toBe(false); // the one-offs were never named
  expect((db.query(`SELECT COUNT(*) c FROM domain_proposals WHERE member_id = ?`).get(THEO) as { c: number }).c).toBe(0);
  expect((db.query(`SELECT COUNT(*) c FROM conversations WHERE user_id = ? AND opened_by = 'maurice'`).get(THEO) as { c: number }).c).toBe(0);
});

test("seeding again adds nothing", () => {
  const again = demo.seedDemoConversations(THEO, TODAY);
  expect(again.ids).toEqual(seeded.ids);
  const n = db.query(`SELECT COUNT(*) c FROM conversations WHERE user_id = ?`).get(THEO) as { c: number };
  expect(n.c).toBe(seeded.ids.length);
});
