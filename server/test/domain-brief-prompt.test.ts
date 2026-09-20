// The briefs in the everyday Maurice's prompt, and the routes that read,
// correct and erase them (P1-B of the domains' roadmap). Nailed down here:
// the section stays under its budget and says which briefs it left out; a
// member's section holds their own domains' briefs and nobody else's; the
// routes are the creator's alone; a correction is what the next turn reads,
// marked as the member's; an empty correction erases; an unknown id has
// no brief. The room rule (no briefs with more than one participant) lives
// in services/claude.ts beside the composer context and is read there.

import { beforeAll, beforeEach, expect, test } from "bun:test";

const { default: db } = await import("../src/db");
const briefs = await import("../src/services/domainBriefs");
const routes = (await import("../src/routes/domains")).default;
const { createSession } = await import("../src/services/auth");
const { estimateText } = await import("../src/services/contextWindow");

const ANNA = "bp-anna";
const BEN = "bp-ben";
let annaAuth = "";
let benAuth = "";

function req(auth: string, path: string, init: RequestInit = {}) {
  return routes.request(path, { ...init, headers: { Authorization: auth, "Content-Type": "application/json", ...(init.headers ?? {}) } });
}

function brief(
  name: string,
  text: string,
  updated_at: string,
  model: string | null = "night",
  summary: string | null = null,
): briefs.PromptBrief {
  return { name, text, updated_at, model, summary };
}

const para = (n: number, seed: string) => Array.from({ length: n }, (_, i) => `${seed} sentence ${i + 1} of the paragraph.`).join(" ");

beforeAll(() => {
  db.run(`INSERT OR IGNORE INTO households (id, name) VALUES ('default', 'Home')`);
  for (const [id, name] of [[ANNA, "Anna"], [BEN, "Ben"]] as const) {
    db.run(`INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES (?, ?, ?, 'standard')`, [id, id, name]);
  }
  db.run(`INSERT OR IGNORE INTO maurices (id, name, tagline, created_by) VALUES ('bp-health', 'Health', 'Blood tests', ?)`, [ANNA]);
  db.run(`INSERT OR IGNORE INTO maurices (id, name, tagline, created_by) VALUES ('bp-house', 'House', '', ?)`, [ANNA]);
  db.run(`INSERT OR IGNORE INTO maurices (id, name, tagline, created_by) VALUES ('bp-ben', 'Ben''s garden', '', ?)`, [BEN]);
  annaAuth = `Bearer ${createSession(ANNA).token}`;
  benAuth = `Bearer ${createSession(BEN).token}`;
});

beforeEach(() => {
  db.run(`DELETE FROM domain_briefs WHERE member_id IN (?, ?)`, [ANNA, BEN]);
});

// ── The section ──────────────────────────────────────────────────────────────

test("no domain, no section", () => {
  expect(briefs.briefsSection([], "Anna")).toBe("");
});

test("a domain with no brief yet is still named — knowing it exists is the point", () => {
  const s = briefs.briefsSection([brief("Empty", "   ", "2026-09-19 04:00:00")], "Anna");
  expect(s).toContain("**Empty**");
  expect(s).toContain("(no brief yet)");
});

test("the index is one line per domain, most recently rewritten first", () => {
  const s = briefs.briefsSection(
    [
      brief("House", "The flat is quiet since the underlay.", "2026-09-10 04:00:00"),
      brief("Health", "LDL at 160 on 10 September.", "2026-09-19 09:00:00", briefs.MEMBER_AUTHOR, "Cholesterol and the statin decision"),
    ],
    "Anna",
  );
  expect(s).toContain("## Anna's domains");
  expect(s.indexOf("**Health**")).toBeLessThan(s.indexOf("**House**"));
  // The night's one-liner when there is one, the brief's opening otherwise.
  expect(s).toContain("**Health** — Cholesterol and the statin decision");
  expect(s).toContain("**House** — The flat is quiet since the underlay.");
  // The brief itself does not ride: that is what the tool is for.
  expect(s).not.toContain("LDL at 160");
  expect(s).toContain("`domain_brief`");
  expect(s).not.toContain("not listed for room");
});

test("a long brief is reduced to its opening sentence, not carried", () => {
  const long = [para(40, "Health"), para(40, "Health again")].join("\n\n");
  const s = briefs.briefsSection([brief("Health", long, "2026-09-19 04:00:00")], "Anna");
  expect(estimateText(s)).toBeLessThan(400);
  expect(s).toContain("Health sentence 1 of the paragraph.");
  expect(s).not.toContain("Health again");
});

test("eleven domains cost a fraction of what eleven briefs did", () => {
  // The measurement that started this: eleven briefs came to about 4 900
  // tokens and rode into every conversation, whatever it was about.
  const many = Array.from({ length: 11 }, (_, i) =>
    brief(`Domain ${i}`, para(40, `Body ${i}`), `2026-09-${String(10 + i).padStart(2, "0")} 04:00:00`, "night", `A sentence about domain ${i} and what is live in it`));
  const s = briefs.briefsSection(many, "Anna");
  expect(estimateText(s)).toBeLessThan(900);
  for (let i = 0; i < 11; i++) expect(s).toContain(`**Domain ${i}**`);
  expect(s).not.toContain("not listed for room");
});

test("past the budget, whole entries are dropped and still named", () => {
  const many = Array.from({ length: 11 }, (_, i) =>
    brief(`Domain ${i}`, "x", `2026-09-${String(10 + i).padStart(2, "0")} 04:00:00`, "night", para(6, `Long summary ${i}`)));
  const budget = 400;
  const s = briefs.briefsSection(many, "Anna", budget);
  expect(estimateText(s)).toBeLessThanOrEqual(budget + 120); // the "also theirs" line is the only thing past it
  expect(s).toContain("Also theirs, not listed for room:");
  // Newest first, so the oldest are the ones that went.
  expect(s).toContain("**Domain 10**");
  expect(s).toContain("Domain 0");
});

test("a member's section holds their own domains' briefs and nobody else's", () => {
  briefs.setBriefText("bp-health", ANNA, "Anna's health, in her words.");
  briefs.setBriefText("bp-ben", BEN, "Ben's garden, in his words.");
  const anna = briefs.briefsForPrompt(ANNA, "Anna");
  expect(anna).toContain("Anna's health");
  expect(anna).not.toContain("Ben's garden");
  const ben = briefs.briefsForPrompt(BEN, "Ben");
  expect(ben).toContain("Ben's garden");
  expect(ben).not.toContain("Anna's health");
  // A brief stored under another member's id on Anna's domain (a guest's,
  // one day) is not Anna's either.
  db.run(`INSERT INTO domain_briefs (maurice_id, member_id, text) VALUES ('bp-health', ?, 'Not hers')`, [BEN]);
  expect(briefs.briefsForPrompt(ANNA, "Anna")).not.toContain("Not hers");
  expect(briefs.briefsForPrompt(BEN, "Ben")).not.toContain("Not hers");
});

// ── The routes ───────────────────────────────────────────────────────────────

test("GET answers the domain with a null brief before the night wrote one", async () => {
  const r = await req(annaAuth, "/bp-health/brief");
  expect(r.status).toBe(200);
  const j = await r.json();
  expect(j.domain).toEqual({ id: "bp-health", name: "Health", tagline: "Blood tests" });
  expect(j.brief).toBeNull();
});

test("the brief is the creator's alone, and the old built-in id is just an unknown row", async () => {
  expect((await req(benAuth, "/bp-health/brief")).status).toBe(404);
  expect((await req(benAuth, "/bp-health/brief", { method: "PUT", body: JSON.stringify({ text: "Mine now" }) })).status).toBe(404);
  expect((await req(benAuth, "/bp-health/brief", { method: "DELETE" })).status).toBe(404);
  expect(briefs.getBrief("bp-health", ANNA)).toBeNull();
  // Maurice Maurice (gone since P3-A) is nobody's domain: a plain 404.
  const mm = await req(annaAuth, "/maurice-maurice/brief");
  expect(mm.status).toBe(404);
  expect((await mm.json()).error).toBe("Not found");
  expect((await req("", "/bp-health/brief")).status).toBe(401);
});

test("a correction is stored as the member's and is what the prompt reads; the night knows whose words they are", async () => {
  db.run(
    `INSERT INTO domain_briefs (maurice_id, member_id, text, sources_json, read_until, model) VALUES ('bp-health', ?, 'The night''s text.', '["c-1"]', '2026-09-18 10:00:00', 'deepseek')`,
    [ANNA],
  );
  const r = await req(annaAuth, "/bp-health/brief", { method: "PUT", body: JSON.stringify({ text: "  My LDL is 160, measured on 10 September.\r\n\r\nNothing else.  " }) });
  expect(r.status).toBe(200);
  const j = await r.json();
  expect(j.brief.text).toBe("My LDL is 160, measured on 10 September.\n\nNothing else.");
  expect(j.brief.model).toBe(briefs.MEMBER_AUTHOR);
  expect(j.brief.sources).toEqual(["c-1"]);
  expect(j.brief.read_until).toBe("2026-09-18 10:00:00");
  expect(briefs.briefsForPrompt(ANNA, "Anna")).toContain("My LDL is 160");
  const p = briefs.incrementalPrompt({ id: "bp-health", name: "Health", prompt: "" } as any, j.brief.text, "…", 200, {
    name: "Anna",
    byMember: true,
  });
  expect(p).toContain("as Anna rewrote it by hand");
  expect((await req(annaAuth, "/bp-health/brief", { method: "PUT", body: JSON.stringify({ text: 3 }) })).status).toBe(400);
  expect((await req(annaAuth, "/bp-health/brief", { method: "PUT", body: "nope" })).status).toBe(400);
});

test("an empty correction and DELETE both erase; erasing twice is harmless", async () => {
  briefs.setBriefText("bp-health", ANNA, "Something.");
  const r = await req(annaAuth, "/bp-health/brief", { method: "PUT", body: JSON.stringify({ text: "  " }) });
  expect((await r.json()).brief).toBeNull();
  expect(briefs.getBrief("bp-health", ANNA)).toBeNull();
  briefs.setBriefText("bp-health", ANNA, "Again.");
  const d1 = await req(annaAuth, "/bp-health/brief", { method: "DELETE" });
  expect(await d1.json()).toEqual({ erased: true });
  const d2 = await req(annaAuth, "/bp-health/brief", { method: "DELETE" });
  expect(await d2.json()).toEqual({ erased: false });
  expect(briefs.briefsForPrompt(ANNA, "Anna")).toBe("");
});

test("the domain's prompt is the statement of what it is about, in the writer's prompt and the search", () => {
  const domain = {
    id: "d",
    name: "Yi Jing",
    tagline: "",
    prompt: "The Book of Changes as I study it: the hexagrams, the commentaries, my own castings. Not divination for others. " + "x".repeat(900),
  } as any;
  expect(briefs.domainStatement(domain, 300)).toBe("The Book of Changes as I study it: the hexagrams, the commentaries, my own castings. Not divination for others.");
  expect(briefs.firstPrompt(domain, "Anna", "…")).toContain('Anna describes it so: "The Book of Changes');
  expect(briefs.incrementalPrompt(domain, "old", "…", 200, { name: "Anna" })).toContain("Anna describes it so");
  expect(briefs.firstPrompt({ id: "d", name: "Bare", tagline: "", prompt: "" } as any, "Anna", "…")).not.toContain("describes it so");
});
