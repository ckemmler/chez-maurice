/**
 * The mail as a source of domains (services/domainMail.ts and the mail pass
 * of services/domainMapping.ts). The corpus and the night model are stubs;
 * the digests are real files in a throwaway garden. What is nailed down: a
 * digest is read for its title, what it is about and the dates of its
 * timeline (not the day it was written); a member with mail and no
 * conversations gets proposals made of mail threads; with proposals already
 * open, what the model recognises is filed under the domain or the proposal
 * and the rest proposed beside them — for the app's list, with no
 * conversation opened and no message left (10 October 2026); an adopted
 * domain's brief reads its threads.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { default: db } = await import("../src/db");
const budget = await import("../src/services/budget");
const { addModel } = await import("../src/services/models");
const { setPinnedModel } = await import("../src/services/ancillary");
const mapping = await import("../src/services/domainMapping");
const proposals = await import("../src/services/domainProposals");
const briefs = await import("../src/services/domainBriefs");
const mail = await import("../src/services/domainMail");
const { createMaurice } = await import("../src/services/maurices");
const { setRoomPublisher, setSubscriberCount } = await import("../src/services/roomBus");

const MAILY = "mail-maily";
const FOLLOW = "mail-follow";
const NIGHT = "deepseek-v4-flash-0731";
const TODAY = new Date("2026-09-27T12:00:00Z");
const GARDENS = mkdtempSync(join(tmpdir(), "maurice-domain-mail-"));
const savedGardens = process.env.MAURICE_GARDENS_DIR;

type Req = { system?: string; prompt: string };
let requests: Req[] = [];

function usage() {
  return { provider: "scaleway", model: NIGHT, rounds: 1, input: 1500, output: 200, cache_read: 0, cache_write: 0, cost: 0.002, cost_uncached: 0.002 };
}

/** The night model: naming by the group's titles; a brief. */
async function write(req: Req) {
  requests.push(req);
  const p = req.prompt;
  const reply = (text: string) => ({ text, model: NIGHT, provider: "scaleway", stop: "end" as const, usage: usage() });
  if (p.includes("Return a JSON object with these keys")) {
    if (/Copro/.test(p)) {
      return reply(JSON.stringify(p.includes("already has") ? { name: "Copropriété", summary: "Le ROI.", is_domain: true, split_hint: "", same_as: "La copropriété" } : { name: "La copropriété", summary: "Le ROI et les panneaux.", is_domain: true, split_hint: "" }));
    }
    if (/Stage/.test(p)) {
      return reply(JSON.stringify(p.includes("Les enfants") ? { name: "Enfants", summary: "Stages.", is_domain: true, split_hint: "", same_as: "les enfants" } : { name: "Les activités des enfants", summary: "Stages et inscriptions.", is_domain: true, split_hint: "" }));
    }
    if (/INASTI/.test(p)) return reply(JSON.stringify({ name: "Cotisations sociales", summary: "INASTI.", is_domain: true, split_hint: "" }));
    // Named exactly like the open proposal, without saying it is the same.
    if (/Banque/.test(p)) return reply(JSON.stringify({ name: "les enfants", summary: "…", is_domain: true, split_hint: "" }));
    return reply(JSON.stringify({ name: "Divers", summary: "…", is_domain: true, split_hint: "" }));
  }
  if (p.includes("Write the brief") || p.includes("Rewrite the brief")) return reply("Le brief de la copropriété.");
  if ((req.system ?? "").includes("one-line index entry")) return reply("La copropriété, le ROI.");
  return reply("{}");
}

/** The corpus on the mail: groups by the title's first word. */
async function mapMail(_member: string, threads: Array<{ path: string; title: string }>) {
  const by = new Map<string, string[]>();
  for (const t of threads) {
    const k = t.title.split(" ")[0]!;
    by.set(k, [...(by.get(k) ?? []), t.path]);
  }
  return { notes: threads.length, groups: [...by.values()].map((ids) => ({ conversation_ids: ids, size: ids.length, cohesion: 0.8, depth: 0, parent_size: null })) };
}

function digest(member: string, slug: string, title: string, dates: string[]) {
  const dir = join(GARDENS, member, "notes", "fr");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${slug}.md`),
    `---\ntitle: "${title}"\ndate: "2026-09-26"\nflags: []\nlocale: fr\ntags:\n  - mail\n  - thread\nparent: mon-courrier\nmeta:\n  opened: false\n  author: maurice\n  origin: mail\n  kind: thread\n  key: <${slug}@example>\n---\n\n` +
      `## De quoi il s'agit\n\n${title}, en détail. — [1 janv. 2026, X, « s » · Proton](maurice-mail:fp:abc) ; [2 janv. 2026, Y, « t » · Gmail](maurice-mail:gm:1)\n\n` +
      `## Chronologie\n\n${dates.map((d) => `- ${d} — quelque chose. — [x](maurice-mail:fp:1)`).join("\n")}\n\n` +
      `## D'où ça vient\n\nÉcrit par Maurice.\n`,
  );
}

/** Five threads of a kind over several recent months. */
function threads(member: string, prefix: string, count = 5) {
  for (let i = 0; i < count; i++) digest(member, `${prefix.toLowerCase()}-${i}`, `${prefix} sujet ${i}`, [`2026-0${3 + i}-10`, `2026-0${4 + i}-02`]);
}

beforeAll(() => {
  process.env.MAURICE_GARDENS_DIR = GARDENS;
  db.run(`INSERT OR IGNORE INTO households (id, name) VALUES ('default', 'Home')`);
  db.run(`UPDATE households SET scaleway_api_key = 'test-key', maurice_opens_min_days = NULL WHERE id = 'default'`);
  for (const [id, name] of [[MAILY, "Maily"], [FOLLOW, "Flo"]] as const) {
    db.run(`INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES (?, ?, ?, 'standard')`, [id, id, name]);
  }
  if (!db.query(`SELECT 1 FROM models WHERE id = ?`).get(NIGHT)) {
    addModel({ id: NIGHT, name: "DeepSeek V4 Flash", tier: "cloud", vendor: "deepseek", provider: "scaleway" });
  }
  setPinnedModel("domain_mapping", NIGHT);
  setPinnedModel("domain_brief", NIGHT);
  setRoomPublisher(() => {});
  setSubscriberCount(() => 1);
  mapping.setMappingDeps({ write, mapMail: mapMail as any, map: async () => ({ conversations: 0, groups: [] }), match: async () => [], now: () => TODAY });
  briefs.setBriefDeps({ write: write as any, search: async () => [] });
});

afterAll(() => {
  mapping.setMappingDeps(null);
  briefs.setBriefDeps(null);
  if (savedGardens === undefined) delete process.env.MAURICE_GARDENS_DIR;
  else process.env.MAURICE_GARDENS_DIR = savedGardens;
  rmSync(GARDENS, { recursive: true, force: true });
});

beforeEach(() => {
  requests = [];
  budget.setSystemDailyCap(null);
  for (const m of [MAILY, FOLLOW]) {
    db.run(`DELETE FROM domain_proposals WHERE member_id = ?`, [m]);
    db.run(`DELETE FROM domain_mail WHERE member_id = ?`, [m]);
    db.run(`DELETE FROM domain_seen WHERE member_id = ?`, [m]);
    db.run(`DELETE FROM domain_briefs WHERE member_id = ?`, [m]);
    db.run(`DELETE FROM conversations WHERE user_id = ?`, [m]);
    db.run(`DELETE FROM maurices WHERE created_by = ?`, [m]);
    rmSync(join(GARDENS, m), { recursive: true, force: true });
  }
});

test("a digest is read for its title, what it is about, and the dates of its timeline", () => {
  digest(MAILY, "copro-roi", "Copro ROI amendé", ["2026-02-10", "2026-02-11", "2026-05-03"]);
  const [t] = mail.listMailThreads(MAILY);
  expect(t!.path).toBe("notes/fr/copro-roi.md");
  expect(t!.title).toBe("Copro ROI amendé");
  expect(t!.dates).toEqual(["2026-02-10", "2026-02-11", "2026-05-03"]); // not the note's own date
  expect(t!.about).toBe("Copro ROI amendé, en détail."); // the pointers stripped
  // Not a thread: a person's fiche, a plain note.
  expect(mail.parseThread("---\ntitle: X\nmeta:\n  origin: mail\n  kind: person\n---\n\n- 2026-01-01 — x", "a.md", "/a.md")).toBeNull();
  expect(mail.parseThread("# no frontmatter", "b.md", "/b.md")).toBeNull();
  const ex = mail.mailExcerpt(MAILY, "notes/fr/copro-roi.md")!;
  expect(ex).toContain('Mail thread "Copro ROI amendé" (2026-02-10 → 2026-05-03)');
  expect(ex).toContain("## Chronologie");
  expect(ex).not.toContain("maurice-mail:");
  expect(ex).not.toContain("D'où ça vient"); // where it comes from is not matter
});

/** What Maurice did on his own in the member's conversations: the ones he
 *  opened, and every message of his. */
function spoken(member: string): { opened: number; said: number } {
  const opened = db.query(`SELECT COUNT(*) AS n FROM conversations WHERE user_id = ? AND opened_by = 'maurice'`).get(member) as { n: number };
  const said = db
    .query(`SELECT COUNT(*) AS n FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.user_id = ? AND m.role = 'assistant'`)
    .get(member) as { n: number };
  return { opened: opened.n, said: said.n };
}

test("mail and no conversations: the proposals are made of threads, written for the list and said nowhere", async () => {
  threads(MAILY, "Copro");
  threads(MAILY, "Stage");
  const r = await mapping.mapMember(MAILY);
  expect(r.outcome).toBe("proposed");
  expect(r.proposals).toBe(2);
  expect(r.attached).toBe(0);
  const open = proposals.openProposals(MAILY);
  expect(open.map((p) => p.name).sort()).toEqual(["La copropriété", "Les activités des enfants"]);
  for (const p of open) {
    expect(p.conversation_ids).toEqual([]);
    expect(p.conversation_id).toBeNull();
    expect(p.mail).toHaveLength(5);
    expect(p.stats.mail).toBe(5);
  }
  const naming = requests.find((q) => q.prompt.includes("Copro sujet"))!;
  expect(naming.prompt).toContain("email threads");
  // Two namings, and no opener: nothing is opened, nothing is said.
  expect(requests).toHaveLength(2);
  expect(spoken(MAILY)).toEqual({ opened: 0, said: 0 });
  // The list counts the threads.
  const listed = proposals.proposalsForMember(MAILY);
  expect(listed.unseen).toBe(2);
  expect(listed.proposals.map((p) => [p.conversations, p.mail_threads, p.weight])).toEqual([[0, 5, 5], [0, 5, 5]]);
  expect(listed.proposals[0]!.sample[0]).toMatch(/^2026-0\d-10 — (Copro|Stage) sujet \d \(mail\)$/);
  // The tools show the threads too, in whatever conversation Maily is in.
  const shown = await proposals.runDomainTool("domains__propose", { action: "show", id: open[0]!.id }, MAILY);
  expect((shown.data as any).mail_threads).toHaveLength(5);
  const detail = proposals.proposalDetail(open[0]!);
  expect(detail.mail_list).toHaveLength(5);
  expect(detail.mail_list.map((t) => t.path)).toEqual(open[0]!.mail);
  expect(detail.mail_list[0]!.from).toMatch(/^2026-0\d-10$/);
  expect(detail.mail_list[0]!.to).toMatch(/^2026-0\d-02$/);
  // Mapped once: the next night finds them spoken for.
  expect(mapping.unattachedThreads(MAILY)).toHaveLength(0);
});

test("proposals open: the mail is filed under what it belongs to, the rest proposed beside them, in silence", async () => {
  // What Flo already has: a domain, and a proposal waiting in the list.
  const domain = createMaurice(FOLLOW, { name: "La copropriété", kind: "domain", tagline: "", prompt: "Le ROI.", context: [], users: [FOLLOW] });
  if ("errors" in domain) throw new Error("domain");
  const waiting = proposals.insertProposal({ member_id: FOLLOW, name: "Les enfants", summary: "École.", conversation_ids: [], presented: true, stats: { verdict: "alive" } });
  threads(FOLLOW, "Copro");
  threads(FOLLOW, "Stage");
  threads(FOLLOW, "INASTI");
  threads(FOLLOW, "Banque");

  const r = await mapping.mapMember(FOLLOW);
  expect(r.outcome).toBe("proposed");
  expect(r.proposals).toBe(1);
  expect(r.presented).toEqual(["Cotisations sociales"]);
  // Fifteen threads filed: five under the domain, ten under the open proposal.
  expect(r.attached).toBe(15);
  // Recognised: under the domain, and under the open proposal.
  expect(mail.domainMail(domain.id, FOLLOW)).toHaveLength(5);
  expect(proposals.getProposal(waiting.id)!.mail).toHaveLength(10); // the Stage threads, and the Banque ones named like it
  expect(proposals.openProposals(FOLLOW).filter((p) => p.name.toLowerCase() === "les enfants")).toHaveLength(1);
  // New: a proposal of its own, carried by no conversation.
  const fresh = proposals.openProposals(FOLLOW).find((p) => p.name === "Cotisations sociales")!;
  expect(fresh.conversation_id).toBeNull();
  expect(fresh.mail).toHaveLength(5);
  // Nothing opened, nothing said about any of it.
  expect(spoken(FOLLOW)).toEqual({ opened: 0, said: 0 });
  expect(db.query(`SELECT COUNT(*) AS n FROM conversations WHERE user_id = ?`).get(FOLLOW)).toEqual({ n: 0 });
  // The domain's brief is rewritten from its threads.
  const brief = await briefs.refreshBrief(domain, FOLLOW);
  expect(["written", "unchanged"]).toContain(brief.outcome);
  const briefReq = requests.find((q) => q.prompt.includes("Write the brief"))!;
  expect(briefReq.prompt).toContain("summaries you wrote of their email threads");
  expect(briefReq.prompt).toContain('Mail thread "Copro sujet');
  expect(briefs.getBrief(domain.id, FOLLOW)!.sources.filter((s: string) => s.startsWith("mail:"))).toHaveLength(5);

  // The next night: nothing new in the mail, nothing named, nothing proposed.
  requests = [];
  const again = await mapping.mapMember(FOLLOW);
  expect(again.proposals).toBe(0);
  expect(again.attached).toBe(0);
  expect(requests).toHaveLength(0);
  expect(proposals.openProposals(FOLLOW)).toHaveLength(2);
});

test("adopting a proposal of threads attaches them to the domain", async () => {
  threads(MAILY, "Copro");
  threads(MAILY, "Stage");
  await mapping.mapMember(MAILY);
  const p = proposals.openProposals(MAILY).find((x) => x.name === "La copropriété")!;
  const out = await proposals.runDomainTool("domains__adopt", { id: p.id }, MAILY);
  expect(out.isError).toBe(false);
  const domainId = (out.data as any).domain_id;
  expect(mail.domainMail(domainId, FOLLOW)).toHaveLength(0);
  expect(mail.domainMail(domainId, MAILY)).toHaveLength(5);
  // Another member cannot adopt it, nor see it.
  const other = proposals.openProposals(MAILY).find((x) => x.name === "Les activités des enfants")!;
  proposals.insertProposal({ member_id: FOLLOW, name: "Flo's own", summary: "", conversation_ids: [] });
  expect((await proposals.runDomainTool("domains__adopt", { id: other.id }, FOLLOW)).text).toBe("Tool error: no such proposal");
  expect(proposals.getProposal(other.id)!.state).toBe("proposed");
  expect(spoken(MAILY)).toEqual({ opened: 0, said: 0 });
});

test("the night waits for the mail's night", () => {
  // Off under test, so never waited for here; the rule itself is the status.
  expect(mapping.mailStillToCome(TODAY)).toBe(false);
});
