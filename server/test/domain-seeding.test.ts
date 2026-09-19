/**
 * Seeding the garden at adoption (P2-C of the domains roadmap,
 * services/domainSeeding.ts): no note without the member's yes to the notes
 * themselves, the provenance and the "written by Maurice, not reviewed yet"
 * mark on every note, the member charged for it, and the review — keeping a
 * note in the garden's toolbar, or rewriting it through the garden tool —
 * that takes the mark away.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { beforeAll, beforeEach, expect, test } from "bun:test";

// The real path: macOS hands out /var/folders, a symlink git resolves to
// /private/var, and a relative path between the two starts with "..".
const GARDENS = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "maurice-seed-gardens-"));
process.env.MAURICE_GARDENS_DIR = GARDENS;

const { default: db } = await import("../src/db");
const budget = await import("../src/services/budget");
const { addModel } = await import("../src/services/models");
const { setPinnedModel } = await import("../src/services/ancillary");
const mapping = await import("../src/services/domainMapping");
const proposals = await import("../src/services/domainProposals");
const briefs = await import("../src/services/domainBriefs");
const seeding = await import("../src/services/domainSeeding");
const tools = await import("../src/services/gardenTools");
const { gardensFor } = await import("../src/services/gardens");
const { scanNotes, invalidateNotes } = await import("../src/services/composer/notes");
const { isOpened, parseFiche } = await import("../data-api/services/gardenFiche");
const { setRoomPublisher, setSubscriberCount } = await import("../src/services/roomBus");
const { getMaurice } = await import("../src/services/maurices");

const ANNA = "seed-anna";
const NIGHT = "deepseek-v4-flash-0731";
const TODAY = new Date("2026-09-19T12:00:00Z");

type Req = { invocation: string; system?: string; prompt: string };
let requests: Req[] = [];
let seedAnswer: string | null = null;

function usage(c: number) {
  return { provider: "scaleway", model: NIGHT, rounds: 1, input: 6000, output: 1200, cache_read: 0, cache_write: 0, cost: c, cost_uncached: c };
}

const reply = (text: string) => ({ text, model: NIGHT, provider: "scaleway", stop: "end" as const, usage: usage(0.004) });

/** The night model for the mapping and the briefs (the shapes P2-B stubs). */
async function nightWrite(req: Req) {
  requests.push(req);
  const p = req.prompt;
  if (p.includes("Return a JSON object with these keys")) {
    if (/violin/i.test(p)) return reply('{"name": "The violin", "summary": "You practise and ask about technique.", "is_domain": true, "split_hint": ""}');
    return reply('{"name": "Baking bread", "summary": "Sourdough and machines.", "is_domain": true, "split_hint": ""}');
  }
  if (req.invocation === "domain_brief") return reply("You practise the violin. Your bow arm is the thread of the moment.");
  return reply("Bonjour Anna. Two domains…\n\n- **The violin**\n- **Baking bread**\n");
}

/** The seeding model: four topics offered — one without a title, one drawn
 *  from a single conversation (not salient), one citing a bogus number. */
async function seedWrite(req: Req) {
  requests.push(req);
  if (seedAnswer !== null) return reply(seedAnswer);
  return reply(
    "Here you are:\n" +
      JSON.stringify({
        description: "Five months of lessons and bow work.",
        understood: "You started lessons in May 2026 and have kept at it every month since.\n\nThe bow arm is what you keep coming back to.",
        open_threads: "- Whether to change teacher (August 2026)\n- The recital in October",
        topics: [
          { title: "The bow arm", body: "Your bow arm is the thread that runs through the lessons: the wrist, the elbow, the sound point. ".repeat(4), sources: [1, 2, 9] },
          { title: "", body: "no title", sources: [1] },
          { title: "Only once", body: "Seen in one conversation. ".repeat(6), sources: [4] },
          { title: "Choosing a teacher", body: "You asked twice about changing teacher. ".repeat(6), sources: [3, 4] },
        ],
      }),
  );
}

/** The corpus: groups by the title's first word. */
async function map(_memberId: string, ids: string[]) {
  const rows = db
    .query(`SELECT id, COALESCE(title, '') AS title FROM conversations WHERE id IN (${ids.map(() => "?").join(",")})`)
    .all(...ids) as Array<{ id: string; title: string }>;
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
  const violin = ["2026-05-02", "2026-06-10", "2026-07-15", "2026-08-20", "2026-09-10"].map((d, i) => convo(ANNA, `Violin lesson ${i}`, d));
  const bread = ["2026-04-01", "2026-06-01", "2026-08-01", "2026-09-01"].map((d, i) => convo(ANNA, `Bread machine ${i}`, d));
  return { violin, bread };
}

const gardenRoot = path.join(GARDENS, ANNA);
const notesDir = path.join(gardenRoot, "notes", "fr");

function gitLog(): string[] {
  const r = spawnSync("git", ["log", "--format=%s"], { cwd: gardenRoot, encoding: "utf-8" });
  return r.status === 0 ? r.stdout.trim().split("\n").filter(Boolean) : [];
}

beforeAll(() => {
  db.run(`INSERT OR IGNORE INTO households (id, name) VALUES ('default', 'Home')`);
  db.run(`UPDATE households SET scaleway_api_key = 'test-key', maurice_opens_min_days = NULL WHERE id = 'default'`);
  db.run(`INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES (?, ?, ?, 'standard')`, [ANNA, ANNA, "Anna"]);
  db.run(`INSERT OR REPLACE INTO user_preferences (user_id, locale) VALUES (?, 'fr')`, [ANNA]);
  if (!db.query(`SELECT 1 FROM models WHERE id = ?`).get(NIGHT)) {
    addModel({ id: NIGHT, name: "DeepSeek V4 Flash", tier: "cloud", vendor: "deepseek", provider: "scaleway" });
  }
  for (const inv of ["domain_mapping", "domain_brief", "domain_seed"]) setPinnedModel(inv, NIGHT);
  setRoomPublisher(() => {});
  setSubscriberCount(() => 1);
  mapping.setMappingDeps({ write: nightWrite as any, map, now: () => TODAY });
  briefs.setBriefDeps({ write: nightWrite as any, search: async () => [] });
  seeding.setSeedDeps({ write: seedWrite as any, now: () => TODAY });
  // Anna's garden is a git repository with an existing note, as at home.
  fs.mkdirSync(notesDir, { recursive: true });
  fs.writeFileSync(path.join(notesDir, "the-violin.md"), "---\ntitle: The violin\ndate: 2026-01-01\nflags: []\nlocale: fr\n---\n\nAn older note of Anna's.\n");
  spawnSync("git", ["init", "-q"], { cwd: gardenRoot });
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"], { cwd: gardenRoot });
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "Anna's garden"], { cwd: gardenRoot });
  spawnSync("git", ["config", "user.email", "t@t"], { cwd: gardenRoot });
  spawnSync("git", ["config", "user.name", "t"], { cwd: gardenRoot });
});

beforeEach(() => {
  requests = [];
  seedAnswer = null;
  budget.setSystemDailyCap(null);
  db.run(`DELETE FROM spend_ledger WHERE user_id IN ('system', ?)`, [ANNA]);
  db.run(`DELETE FROM domain_proposals`);
  db.run(`DELETE FROM domain_briefs`);
  db.run(`DELETE FROM conversations WHERE user_id = ?`, [ANNA]);
  db.run(`DELETE FROM maurices WHERE created_by = ?`, [ANNA]);
  for (const f of fs.readdirSync(notesDir)) if (f !== "the-violin.md") fs.rmSync(path.join(notesDir, f), { recursive: true, force: true });
  invalidateNotes(ANNA);
});

/** The night opens the conversation; Anna adopts the violin. */
async function adopted() {
  annaCorpus();
  const r = await mapping.mapMember(ANNA);
  expect(r.outcome).toBe("opened");
  const conversationId = r.conversation_id!;
  const violin = proposals.listProposals(ANNA).find((p) => p.name === "The violin")!;
  const a = await proposals.runDomainTool("domains__adopt", { id: violin.id }, conversationId);
  expect(a.isError).toBe(false);
  await new Promise((r) => setTimeout(r, 30)); // the brief, in the background
  requests = [];
  return { conversationId, violin: proposals.getProposal(violin.id)!, domainId: (a.data as any).domain_id as string };
}

test("adopting writes nothing in the garden; the seed tool is offered, and it stays until the notes are written or declined", async () => {
  const { conversationId, violin } = await adopted();
  expect(fs.readdirSync(notesDir)).toEqual(["the-violin.md"]);
  expect(requests).toHaveLength(0);
  // The adoption's answer tells Maurice to offer, not to write.
  const names = proposals.domainToolsFor(conversationId, ANNA).map((t) => t.name);
  expect(names).toContain("domains__seed");
  const section = proposals.proposalPromptSection(conversationId, "Anna", "fr");
  expect(section).toContain("A yes to the domain is not a yes to the notes");
  expect(section).toContain("garden notes not offered yet");
  // Every other proposal settled: the tools stay for the adopted domain's notes.
  for (const p of proposals.openProposals(ANNA)) proposals.updateProposal(p.id, { state: "dismissed" });
  expect(proposals.domainToolsFor(conversationId, ANNA)).toHaveLength(4);
  // Declining is a word too: then they go.
  const d = await proposals.runDomainTool("domains__seed", { id: violin.id, action: "decline" }, conversationId);
  expect(d.isError).toBe(false);
  expect(proposals.getProposal(violin.id)!.stats.seed?.state).toBe("declined");
  expect(proposals.domainToolsFor(conversationId, ANNA)).toEqual([]);
  expect(fs.readdirSync(notesDir)).toEqual(["the-violin.md"]);
  expect(proposals.proposalPromptSection(conversationId, "Anna")).toContain("garden notes declined");
});

test("the seed tool refuses what is not an adopted domain of this conversation", async () => {
  const { conversationId } = await adopted();
  const bread = proposals.listProposals(ANNA).find((p) => p.name === "Baking bread")!;
  expect((await proposals.runDomainTool("domains__seed", { id: bread.id }, conversationId)).isError).toBe(true);
  expect((await proposals.runDomainTool("domains__seed", { id: "nope" }, conversationId)).isError).toBe(true);
  const other = convo(ANNA, "Ordinary chat", "2026-09-18");
  expect((await proposals.runDomainTool("domains__seed", { id: bread.id }, other)).isError).toBe(true);
  expect(fs.readdirSync(notesDir)).toEqual(["the-violin.md"]);
  expect(requests).toHaveLength(0);
});

test("on the yes: the hub and its topics, marked unreviewed, with their provenance, charged to the member, committed", async () => {
  const { conversationId, violin, domainId } = await adopted();
  const r = await proposals.runDomainTool("domains__seed", { id: violin.id }, conversationId);
  expect(r.isError).toBe(false);
  const data = r.data as any;
  expect(data.seeded).toBe("The violin");
  expect(data.from_conversations).toBe(5);
  expect(data.notes.map((n: any) => n.role)).toEqual(["hub", "topic", "topic"]);
  // The slug "the-violin" was taken by Anna's own note: the hub steps aside.
  expect(data.notes[0].link).toBe(`/g/${ANNA}/fr/notes/the-violin-2`);
  expect(data.notes.map((n: any) => n.title)).toEqual(["The violin", "The bow arm", "Choosing a teacher"]);

  // One model call, on the seeding invocation, in French, with the numbered excerpts and the brief.
  expect(requests).toHaveLength(1);
  expect(requests[0]!.invocation).toBe("domain_seed");
  expect(requests[0]!.system).toContain("French");
  expect(requests[0]!.prompt).toContain("[5] — 2026-09-10 — \"Violin lesson 4\"");
  expect(requests[0]!.prompt).toContain("Your brief on it");
  // Charged to Anna, not to the night: the night's spender holds the mapping
  // and the brief of the adoption (four calls), nothing of the seeding.
  expect(budget.spentTodayUsd(ANNA)).toBeCloseTo(0.004, 6);
  expect(budget.spentTodayUsd(budget.SYSTEM_SPENDER)).toBeCloseTo(0.016, 6);

  // The hub: a MOC, the three sections, the topics as wiki-links, the mark and the provenance.
  const hub = fs.readFileSync(path.join(notesDir, "the-violin-2.md"), "utf-8");
  const fm = parseFiche(hub)!.frontmatter;
  expect(fm.title).toBe("The violin");
  expect(fm.flags).toEqual(["moc"]);
  expect(fm.locale).toBe("fr");
  expect(fm.description).toBe("Five months of lessons and bow work");
  expect(isOpened(fm)).toBe(false);
  expect(fm.meta.author).toBe("maurice");
  expect(fm.meta.domain).toBe(domainId);
  expect(fm.meta.role).toBe("hub");
  expect(fm.meta.model).toBe(NIGHT);
  expect(fm.meta.sources).toHaveLength(5);
  expect([...fm.meta.sources].sort()).toEqual([...violin.conversation_ids].sort());
  expect(hub).toContain("## Ce que j'ai compris");
  expect(hub).toContain("## Les fils ouverts");
  expect(hub).toContain("- Whether to change teacher");
  expect(hub).toContain("## Notes\n\n[[the-bow-arm|The bow arm]]\n\n[[choosing-a-teacher|Choosing a teacher]]");
  expect(hub).toContain("## D'où ça vient");
  expect(hub).toContain("Écrite par Maurice le 19 septembre 2026 à partir de 5 conversations, avec deepseek-v4-flash-0731. Pas encore relue");
  expect(hub).toContain("- 2026-05-02 — Violin lesson 0");

  // A topic: under the hub, its own sources (the bogus 9 dropped; a topic from one conversation dropped).
  const bow = parseFiche(fs.readFileSync(path.join(notesDir, "the-bow-arm.md"), "utf-8"))!;
  expect(bow.frontmatter.parent).toBe("the-violin-2");
  expect(bow.frontmatter.meta.role).toBe("topic");
  expect(bow.frontmatter.meta.sources).toHaveLength(2);
  expect(isOpened(bow.frontmatter)).toBe(false);
  expect(bow.body).toContain("## D'où ça vient");
  expect(bow.body).toContain("à partir de 2 conversations");
  const teacher = parseFiche(fs.readFileSync(path.join(notesDir, "choosing-a-teacher.md"), "utf-8"))!;
  expect(teacher.frontmatter.meta.sources).toHaveLength(2);
  expect(fs.existsSync(path.join(notesDir, "only-once.md"))).toBe(false);

  // One commit for the three files.
  expect(gitLog()[0]).toBe("Seed domain notes: The violin");
  expect(spawnSync("git", ["status", "--porcelain"], { cwd: gardenRoot, encoding: "utf-8" }).stdout.trim()).toBe("");

  // The proposal remembers; a second seeding is refused; the tools go.
  expect(proposals.getProposal(violin.id)!.stats.seed).toEqual({ state: "written", at: expect.any(String), notes: ["the-violin-2", "the-bow-arm", "choosing-a-teacher"] });
  expect((await proposals.runDomainTool("domains__seed", { id: violin.id }, conversationId)).isError).toBe(true);
  for (const p of proposals.openProposals(ANNA)) proposals.updateProposal(p.id, { state: "dismissed" });
  expect(proposals.domainToolsFor(conversationId, ANNA)).toEqual([]);
  expect(proposals.proposalPromptSection(conversationId, "Anna")).toContain("3 note(s) seeded in the garden");

  // What the app reads: the garden's list marks them, the domain counts them.
  invalidateNotes(ANNA);
  const mine = gardensFor(ANNA).find((g) => g.mine)!;
  const marked = mine.notes.filter((n) => n.unreviewed).map((n) => n.slug).sort();
  expect(marked).toEqual(["choosing-a-teacher", "the-bow-arm", "the-violin-2"]);
  expect(mine.notes.find((n) => n.slug === "the-violin")!.unreviewed).toBeUndefined();
  expect(seeding.seededNotesOf(ANNA, domainId)).toEqual({ total: 3, unreviewed: 3, web_path: `/g/${ANNA}/fr/notes/the-violin-2` });
  const domain = getMaurice(domainId)!;
  expect(scanNotes(ANNA).get("the-bow-arm")!.domain).toBe(domain.id);
});

test("the review: keeping a note in the garden takes the mark away and leaves the file as it was", async () => {
  const { conversationId, violin, domainId } = await adopted();
  expect((await proposals.runDomainTool("domains__seed", { id: violin.id }, conversationId)).isError).toBe(false);
  const garden = { root: gardenRoot, username: ANNA };
  const before = fs.readFileSync(path.join(notesDir, "the-bow-arm.md"), "utf-8");
  expect(tools.reviewState(garden, `/g/${ANNA}/fr/notes/the-bow-arm`)).toEqual({ file: path.join(notesDir, "the-bow-arm.md"), unreviewed: true });

  const r = tools.reviewNote(garden, `/g/${ANNA}/fr/notes/the-bow-arm`);
  expect(r).toEqual({ file: path.join(notesDir, "the-bow-arm.md"), unreviewed: false, reviewed: true });
  const after = fs.readFileSync(path.join(notesDir, "the-bow-arm.md"), "utf-8");
  expect(after).toBe(before.replace("  opened: false\n", ""));
  const fm = parseFiche(after)!.frontmatter;
  expect(isOpened(fm)).toBe(true);
  expect(fm.meta.author).toBe("maurice"); // the provenance stays
  expect(fm.meta.sources).toHaveLength(2);
  expect(gitLog()[0]).toBe("Review note: the-bow-arm");

  // Idempotent; the other notes are untouched; the counts follow.
  expect(tools.reviewNote(garden, `/g/${ANNA}/fr/notes/the-bow-arm`)!.reviewed).toBe(false);
  expect(tools.reviewState(garden, `/g/${ANNA}/fr/notes/the-violin-2`)!.unreviewed).toBe(true);
  invalidateNotes(ANNA);
  expect(seeding.seededNotesOf(ANNA, domainId)).toEqual({ total: 3, unreviewed: 2, web_path: `/g/${ANNA}/fr/notes/the-violin-2` });
  // Not a note, not a page: nothing.
  expect(tools.reviewNote(garden, `/g/${ANNA}/fr/notes/nope`)).toBeNull();

  // A `meta:` block with only the mark goes entirely; one a person wrote keeps its other keys.
  expect(tools.clearUnreviewed("---\ntitle: X\nmeta:\n  opened: false\nlocale: fr\n---\n\nBody.\n")).toBe("---\ntitle: X\nlocale: fr\n---\n\nBody.\n");
  expect(tools.clearUnreviewed("---\ntitle: X\nmeta:\n  opened: false\n  author: maurice\n---\n\nBody.\n")).toBe("---\ntitle: X\nmeta:\n  author: maurice\n---\n\nBody.\n");
  expect(tools.clearUnreviewed("---\ntitle: X\n---\n\nmeta:\n  opened: false\n")).toBe("---\ntitle: X\n---\n\nmeta:\n  opened: false\n");
  expect(tools.isUnreviewed("---\ntitle: X\nmeta:\n  opened: true\n---\n")).toBe(false);
});

test("the member's fuse, and a model that returns nothing usable: no note, no mark", async () => {
  const { conversationId, violin } = await adopted();
  // The fuse: Anna's own daily cap, spent.
  budget.setMemberDailyCap(ANNA, 0.001);
  budget.recordSpend(usage(0.002) as any, ANNA);
  let r = await proposals.runDomainTool("domains__seed", { id: violin.id }, conversationId);
  expect(r.isError).toBe(true);
  expect(r.text).toContain("not written");
  expect(requests).toHaveLength(0);
  budget.setMemberDailyCap(ANNA, null);
  db.run(`DELETE FROM spend_ledger WHERE user_id = ?`, [ANNA]);
  // Nothing usable: paid, logged, no file, and the offer still stands.
  seedAnswer = "I would rather not.";
  r = await proposals.runDomainTool("domains__seed", { id: violin.id }, conversationId);
  expect(r.isError).toBe(true);
  expect(fs.readdirSync(notesDir)).toEqual(["the-violin.md"]);
  expect(proposals.getProposal(violin.id)!.stats.seed).toBeUndefined();
  expect(proposals.domainToolsFor(conversationId, ANNA).map((t) => t.name)).toContain("domains__seed");
});

test("a domain with no conversation of the member's: nothing to write from, nothing spent", async () => {
  const { conversationId, violin, domainId } = await adopted();
  db.run(`UPDATE conversations SET maurice_id = NULL WHERE maurice_id = ?`, [domainId]);
  const r = await proposals.runDomainTool("domains__seed", { id: violin.id }, conversationId);
  expect(r.isError).toBe(true);
  expect(r.text).toContain("nothing to write from");
  expect(requests).toHaveLength(0);
  expect(budget.spentTodayUsd(ANNA)).toBe(0);
});

test("the model's answer is read leniently", () => {
  expect(seeding.parseSeed("no json", 3)).toBeNull();
  expect(seeding.parseSeed('{"understood": ""}', 3)).toBeNull();
  const s = seeding.parseSeed('Sure: {"understood": " x ", "description": "A line.", "topics": [{"title": "T", "body": "b", "sources": [2, 2, 7, "3"]}, {"title": "U", "body": "b"}, {"title": "V", "body": "b", "sources": [1, 2]}, {"title": "W", "body": "b", "sources": [1, 3]}, {"title": "X", "body": "b", "sources": [2, 3]}]}', 3)!;
  expect(s.description).toBe("A line");
  expect(s.understood).toBe("x");
  expect(s.open_threads).toBe("");
  expect(s.topics.map((t) => t.title)).toEqual(["T", "V", "W"]); // U has no sources; X is a fourth
  expect(s.topics[0]).toEqual({ title: "T", body: "b", sources: [2, 3] });
});
