// `domain_brief` — the second storey (20 September 2026).
//
// The everyday prompt carries an index of the member's domains, one line each;
// this is the tool that reads the brief behind a line. What matters here is
// that it is scoped to the member taking the turn, that a wrong name is
// answered with the right ones rather than with silence, and that a brief the
// member wrote themselves says so.

import { beforeAll, beforeEach, expect, test } from "bun:test";

const { default: db } = await import("../src/db");
const briefs = await import("../src/services/domainBriefs");
const { domainBriefTool, isDomainBriefTool, runDomainBriefTool } = await import("../src/services/domainTools");

const ANNA = "dbt-anna";
const BEN = "dbt-ben";

beforeAll(() => {
  db.run(`INSERT OR IGNORE INTO households (id, name) VALUES ('default', 'Home')`);
  for (const [id, name] of [[ANNA, "Anna"], [BEN, "Ben"]] as const) {
    db.run(`INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES (?, ?, ?, 'standard')`, [id, id, name]);
  }
  db.run(`INSERT OR IGNORE INTO maurices (id, name, created_by, kind) VALUES ('dbt-violin', 'Pratique du violon', ?, 'domain')`, [ANNA]);
  db.run(`INSERT OR IGNORE INTO maurices (id, name, created_by, kind) VALUES ('dbt-health', 'Santé et bien-être', ?, 'domain')`, [ANNA]);
  db.run(`INSERT OR IGNORE INTO maurices (id, name, created_by, kind) VALUES ('dbt-ben', 'Le potager de Ben', ?, 'domain')`, [BEN]);
});

beforeEach(() => {
  db.run(`DELETE FROM domain_briefs WHERE member_id IN (?, ?)`, [ANNA, BEN]);
  briefs.setBriefText("dbt-violin", ANNA, "La Chaconne est en cours depuis juin.");
  briefs.setBriefText("dbt-ben", BEN, "Les tomates sont en retard.");
});

test("the tool is only itself", () => {
  expect(isDomainBriefTool("domain_brief")).toBe(true);
  expect(isDomainBriefTool("corpus__search")).toBe(false);
  expect(domainBriefTool().name).toBe("domain_brief");
  expect(domainBriefTool().inputSchema.required).toEqual(["name"]);
});

test("it reads the brief behind a line of the index", () => {
  const r = runDomainBriefTool({ name: "Pratique du violon" }, ANNA);
  expect(r.isError).toBe(false);
  expect(r.text).toContain("La Chaconne est en cours depuis juin.");
  expect((r.data as any).domain).toBe("Pratique du violon");
});

test("the name is matched the way a model retypes it, not the way an id is copied", () => {
  expect(runDomainBriefTool({ name: "pratique du violon" }, ANNA).isError).toBe(false);
  expect(runDomainBriefTool({ name: "  Pratique du Violon  " }, ANNA).isError).toBe(false);
  // A fragment of the name resolves too: "the violin domain" is how it gets asked for.
  expect(runDomainBriefTool({ name: "violon" }, ANNA).isError).toBe(false);
});

test("a wrong name is answered with the names that exist", () => {
  const r = runDomainBriefTool({ name: "Jardinage" }, ANNA);
  expect(r.isError).toBe(true);
  expect(r.text).toContain("Pratique du violon");
  expect(r.text).toContain("Santé et bien-être");
});

test("another member's domain does not exist here", () => {
  const r = runDomainBriefTool({ name: "Le potager de Ben" }, ANNA);
  expect(r.isError).toBe(true);
  expect(r.text).not.toContain("tomates");
  // And Ben reaches his own.
  expect(runDomainBriefTool({ name: "Le potager de Ben" }, BEN).text).toContain("tomates");
});

test("a brief in the member's own words says so; an empty one says that instead", () => {
  const mine = runDomainBriefTool({ name: "Pratique du violon" }, ANNA);
  expect((mine.data as any).in_their_own_words).toBe(true);
  expect(mine.text).toContain("prevails");

  // A domain with no brief at all: not an error, just nothing written yet.
  const empty = runDomainBriefTool({ name: "Santé et bien-être" }, ANNA);
  expect(empty.isError).toBe(false);
  expect(empty.text).toContain("empty");
});

test("no member, no briefs", () => {
  expect(runDomainBriefTool({ name: "Pratique du violon" }, undefined).isError).toBe(true);
});
