// Carnet suggestions (9 October 2026, specs/carnet-suggestions.md): what a
// conversation named that is worth an entry in the member's garden.
//
// The rule, as for the life facts: Maurice proposes, the member decides.
// Nothing reaches the garden before a keep, a refusal holds everywhere, and
// the garden is asked before any provider.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "maurice-suggest-"));
process.env.MAURICE_GARDENS_DIR = TMP;

const { default: db } = await import("../src/db");
const sug = await import("../src/services/entrySuggestions");
const routes = (await import("../src/routes/suggestions")).default;
const { createSession } = await import("../src/services/auth");
const { createConversation, addParticipant, listConversations, deleteConversation } = await import("../src/services/conversations");

const ANNA = "es-anna";
const BEN = "es-ben";
const root = path.join(TMP, ANNA);
let annaAuth = "";
let benAuth = "";

afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

function write(rel: string, content: string) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function req(auth: string, p: string, init: RequestInit = {}) {
  return routes.request(p, { ...init, headers: { Authorization: auth, "Content-Type": "application/json", ...(init.headers ?? {}) } });
}

/** What the pass answers, and what the garden tool is asked. */
let modelSays: unknown = { subjects: [] };
let modelCalls = 0;
let lastPrompt = "";
let toolCalls: Array<{ tool: string; args: any }> = [];
let searchResults: Record<string, any[]> = {};

beforeAll(() => {
  db.run(`INSERT OR IGNORE INTO households (id, name) VALUES ('default', 'Home')`);
  for (const [id, name] of [[ANNA, "Anna"], [BEN, "Ben"]] as const) {
    db.run(`INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES (?, ?, ?, 'standard')`, [id, id, name]);
  }
  // Anna's language decides the side of the garden a new fiche is filed on.
  db.run(`INSERT INTO user_preferences (user_id, locale) VALUES (?, 'fr') ON CONFLICT(user_id) DO UPDATE SET locale = 'fr'`, [ANNA]);
  annaAuth = `Bearer ${createSession(ANNA).token}`;
  benAuth = `Bearer ${createSession(BEN).token}`;
  write(
    "series/fr/sugar-fiche.md",
    `---\ntitle: Sugar\nresource_collection: series\nresource_id: sugar\ndate: '2026-08-15'\ntags: []\nlocale: fr\nmeta:\n  year: 2024\n---\n\n## Commentaire\n\n2026-08-15 — Vu le pilote.\n\n## Résonances\n`,
  );
  write(
    "people/fr/jeanne-dupont-fiche.md",
    `---\ntitle: Jeanne Dupont\nresource_collection: people\nresource_id: jeanne-dupont\ndate: '2026-09-01'\ntags: []\nlocale: fr\nstatus: pending\n---\n`,
  );

  sug.setSuggestionModel(async (r) => {
    modelCalls++;
    lastPrompt = r.prompt;
    return { text: typeof modelSays === "string" ? modelSays : JSON.stringify(modelSays), model: "test", provider: "test", stop: "end", usage: null } as any;
  });
  sug.setGardenCall(async (_member, tool, args) => {
    toolCalls.push({ tool, args });
    if (tool === "open_fiche") {
      const slug = String(args.title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      write(
        `${args.resource_collection}/${args.locale}/${slug}-fiche.md`,
        `---\ntitle: ${args.title}\nresource_collection: ${args.resource_collection}\nresource_id: ${slug}\ndate: '2026-10-09'\ntags: []\nlocale: ${args.locale}\n---\n`,
      );
      return { card: "media", resource_id: slug, locale: args.locale, title: args.title };
    }
    return { card: "candidates", results: searchResults[tool] ?? [] };
  });
});

let convo = "";
beforeEach(() => {
  db.run(`DELETE FROM entry_suggestions`);
  convo = createConversation(ANNA).id;
  modelSays = { subjects: [] };
  modelCalls = 0;
  toolCalls = [];
  searchResults = {};
});

const turn = (q = "Qui joue Moira dans Schitt's Creek ?", a = "Catherine O'Hara.") =>
  sug.suggestForTurn(ANNA, convo, "m1", q, a);

describe("reading the pass", () => {
  test("takes JSON bare, fenced or prefixed; drops what it cannot use", () => {
    const one = { kind: "series", title: "Schitt's Creek", year: 2015, note: "Moira est jouée par Catherine O'Hara." };
    expect(sug.parseNamed(JSON.stringify({ subjects: [one] }))).toHaveLength(1);
    expect(sug.parseNamed("```json\n" + JSON.stringify({ subjects: [one] }) + "\n```")).toHaveLength(1);
    expect(sug.parseNamed("nothing here")).toEqual([]);
    const junk = [
      { kind: "places", title: "Paris", note: "x" },      // not a kind
      { kind: "movies", title: "", note: "x" },             // no title
      { kind: "movies", title: "Dune", note: "" },          // nothing to file
      { kind: "people", title: "Catherine", note: "x" },    // a first name alone
    ];
    expect(sug.parseNamed(JSON.stringify({ subjects: junk }))).toEqual([]);
  });

  test("three per turn at most", () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ kind: "movies", title: `Film ${i}`, note: "n" }));
    expect(sug.parseNamed(JSON.stringify({ subjects: many }))).toHaveLength(3);
  });
});

describe("who is offered anything", () => {
  test("nothing named, nothing filed, no provider asked", async () => {
    expect(await turn()).toBe(0);
    expect(modelCalls).toBe(1);
    expect(toolCalls).toEqual([]);
  });

  test("never in a room, and the model is not even called", async () => {
    addParticipant(convo, BEN);
    modelSays = { subjects: [{ kind: "series", title: "Sugar", note: "n" }] };
    expect(await turn()).toBe(0);
    expect(modelCalls).toBe(0);
  });

  test("never in a conversation Maurice opened", async () => {
    convo = createConversation(ANNA, null, { openedBy: "maurice" }).id;
    expect(await turn()).toBe(0);
    expect(modelCalls).toBe(0);
  });

  test("never for a member with no garden", async () => {
    const c = createConversation(BEN).id;
    expect(await sug.suggestForTurn(BEN, c, "m", "q", "a")).toBe(0);
    expect(modelCalls).toBe(0);
  });
});

describe("resolution", () => {
  test("the garden answers first: an entry of theirs asks no provider", async () => {
    modelSays = { subjects: [{ kind: "series", title: "sugar", note: "Colin Farrell joue John Sugar." }] };
    expect(await turn()).toBe(1);
    expect(toolCalls).toEqual([]);
    const [s] = sug.suggestionsFor(ANNA, convo);
    expect(s!.existing).toBe("series/fr/sugar");
    expect(s!.year).toBe(2024);
  });

  test("a sure match is taken; an unsure one keeps its candidates", async () => {
    searchResults.search_series = [{ id: 61662, title: "Schitt's Creek", year: 2015, subtitle: "", image: "https://img/sc.jpg" }];
    searchResults.search_movie = [
      { id: 1, title: "Dune", year: 2021, subtitle: "", image: "" },
      { id: 2, title: "Dune", year: 1984, subtitle: "", image: "" },
    ];
    modelSays = { subjects: [
      { kind: "series", title: "Schitt's Creek", year: 2015, note: "n1" },
      { kind: "movies", title: "Dune", note: "n2" },
    ] };
    expect(await turn()).toBe(2);
    const rows = sug.suggestionsFor(ANNA, convo);
    const creek = rows.find((r) => r.kind === "series")!;
    const dune = rows.find((r) => r.kind === "movies")!;
    expect(creek.key).toBe("id:61662");
    expect(creek.image).toBe("https://img/sc.jpg");
    expect(creek.candidates).toHaveLength(1);
    expect(dune.candidates).toHaveLength(2);
  });

  test("the year settles a title two works share", () => {
    const two = [
      { id: "1", title: "Dune", year: 2021, subtitle: "", image: "" },
      { id: "2", title: "Dune", year: 1984, subtitle: "", image: "" },
    ];
    expect(sug.confident({ kind: "movies", title: "Dune", year: 2021, note: "n" }, two)).toBe(true);
    expect(sug.confident({ kind: "movies", title: "Dune", note: "n" }, two)).toBe(false);
    expect(sug.confident({ kind: "movies", title: "Dune", year: 2021, note: "n" }, [two[1]!])).toBe(false);
  });

  test("someone from their own life is never looked up; a public figure is", async () => {
    searchResults.search_person = [{ id: "Q1", title: "Catherine O'Hara", year: null, subtitle: "Canadian actress", image: "" }];
    modelSays = { subjects: [
      { kind: "people", title: "Marc Lambert", public: false, note: "Le voisin qui prête sa tondeuse." },
      { kind: "people", title: "Catherine O'Hara", public: true, note: "Joue Moira Rose." },
    ] };
    expect(await turn()).toBe(2);
    expect(toolCalls.map((c) => c.args.name)).toEqual(["Catherine O'Hara"]);
  });

  test("a person they already have is found by full name, either order", async () => {
    modelSays = { subjects: [{ kind: "people", title: "Dupont Jeanne", public: false, note: "n" }] };
    await turn();
    expect(sug.suggestionsFor(ANNA, convo)[0]!.existing).toBe("people/fr/jeanne-dupont");
  });

  test("a provider that fails leaves the suggestion standing on its title", async () => {
    sug.setGardenCall(async () => { throw new Error("No TMDB key"); });
    try {
      modelSays = { subjects: [{ kind: "movies", title: "Paris, Texas", year: 1984, note: "n" }] };
      expect(await turn()).toBe(1);
      expect(sug.suggestionsFor(ANNA, convo)[0]!.key).toBe("title:paris texas");
    } finally {
      // Back to the suite's stub.
      sug.setGardenCall(async (_m, tool, args) => {
        toolCalls.push({ tool, args });
        if (tool === "open_fiche") {
          const slug = String(args.title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
          write(`${args.resource_collection}/${args.locale}/${slug}-fiche.md`, `---\ntitle: ${args.title}\nresource_collection: ${args.resource_collection}\nresource_id: ${slug}\ndate: '2026-10-09'\ntags: []\nlocale: ${args.locale}\n---\n`);
          return { card: "media", resource_id: slug, locale: args.locale, title: args.title };
        }
        return { card: "candidates", results: searchResults[tool] ?? [] };
      });
    }
  });
});

describe("one list per conversation", () => {
  test("a second mention updates the row; the pass is told what it already named", async () => {
    modelSays = { subjects: [{ kind: "series", title: "Sugar", note: "Première note." }] };
    await turn();
    modelSays = { subjects: [{ kind: "series", title: "Sugar", note: "Seconde note." }] };
    expect(await turn()).toBe(1);
    expect(lastPrompt).toContain("Already suggested: Sugar");
    const rows = sug.suggestionsFor(ANNA, convo);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.note).toBe("Seconde note.");
    // The same note again changes nothing.
    expect(await turn()).toBe(0);
  });

  test("a refusal of a subject holds in every conversation to come", async () => {
    modelSays = { subjects: [{ kind: "movies", title: "Paris, Texas", note: "n" }] };
    await turn();
    const id = sug.suggestionsFor(ANNA, convo)[0]!.id;
    expect((await req(annaAuth, `/${id}/dismiss`, { method: "POST" })).status).toBe(200);
    expect(sug.pendingCount(ANNA, convo)).toBe(0);
    convo = createConversation(ANNA).id;
    expect(await turn()).toBe(0);
  });

  test("a note turned down on an entry of theirs does not silence the next one", async () => {
    modelSays = { subjects: [{ kind: "series", title: "Sugar", note: "Une note." }] };
    await turn();
    await req(annaAuth, `/${sug.suggestionsFor(ANNA, convo)[0]!.id}/dismiss`, { method: "POST" });
    convo = createConversation(ANNA).id;
    modelSays = { subjects: [{ kind: "series", title: "Sugar", note: "Une autre." }] };
    expect(await turn()).toBe(1);
  });

  test("the list row counts what waits; deleting the conversation drops it", async () => {
    modelSays = { subjects: [{ kind: "series", title: "Sugar", note: "n" }] };
    await turn();
    expect(listConversations(ANNA).find((c) => c.id === convo)!.suggestions).toBe(1);
    deleteConversation(convo, ANNA);
    expect(db.query(`SELECT COUNT(*) AS n FROM entry_suggestions WHERE conversation_id = ?`).get(convo)).toEqual({ n: 0 });
  });
});

describe("keeping", () => {
  test("on an entry of theirs: the note lands under Commentaire, before Résonances", async () => {
    modelSays = { subjects: [{ kind: "series", title: "Sugar", note: "Colin Farrell joue John Sugar." }] };
    await turn();
    const id = sug.suggestionsFor(ANNA, convo)[0]!.id;
    const before = fs.readFileSync(path.join(root, "series/fr/sugar-fiche.md"), "utf-8");
    expect(before).not.toContain("Colin Farrell");

    const res = await req(annaAuth, `/${id}/keep`, { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.state).toBe("kept");
    // The garden's own path for the fiche, its `/g/<member>` mount once.
    expect(body.web_path).toBe(`/g/${ANNA}/fr/fiches/series/sugar-fiche`);
    expect(toolCalls).toEqual([]);

    const after = fs.readFileSync(path.join(root, "series/fr/sugar-fiche.md"), "utf-8");
    // What was said, then where: a link to the conversation it came from.
    expect(after).toContain(`Colin Farrell joue John Sugar. *([Conversation avec Maurice](maurice://conversations/${convo}))*`);
    expect(after.indexOf("Colin Farrell")).toBeLessThan(after.indexOf("## Résonances"));
    expect(after).toContain("Vu le pilote.");
  });

  test("on a new subject: the fiche is opened with the pinned id, then the note filed", async () => {
    searchResults.search_series = [{ id: 61662, title: "Schitt's Creek", year: 2015, subtitle: "", image: "" }];
    modelSays = { subjects: [{ kind: "series", title: "Schitt's Creek", year: 2015, note: "Moira est jouée par Catherine O'Hara." }] };
    await turn();
    const id = sug.suggestionsFor(ANNA, convo)[0]!.id;
    await sug.keepSuggestion(ANNA, id);
    const open = toolCalls.find((c) => c.tool === "open_fiche")!;
    expect(open.args.tmdb_id).toBe(61662);
    expect(open.args.skip_metadata).toBeUndefined();
    expect(fs.readFileSync(path.join(root, "series/fr/schitt-s-creek-fiche.md"), "utf-8")).toContain("Moira est jouée");
    // The row now answers under the garden's path: a later mention is a note to add, not a twin.
    modelSays = { subjects: [{ kind: "series", title: "Schitt's Creek", note: "Six saisons." }] };
    expect(await turn()).toBe(1);
    const rows = sug.suggestionsFor(ANNA, convo);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("proposed");
    expect(rows[0]!.existing).toBe("series/fr/schitt-s-creek");
  });

  test("several candidates: a pick is required, and it is the one opened", async () => {
    searchResults.search_movie = [
      { id: 1, title: "Dune", year: 2021, subtitle: "", image: "" },
      { id: 2, title: "Dune", year: 1984, subtitle: "", image: "" },
    ];
    modelSays = { subjects: [{ kind: "movies", title: "Dune", note: "n" }] };
    await turn();
    const id = sug.suggestionsFor(ANNA, convo)[0]!.id;
    expect((await req(annaAuth, `/${id}/keep`, { method: "POST", body: "{}" })).status).toBe(409);
    expect((await req(annaAuth, `/${id}/keep`, { method: "POST", body: JSON.stringify({ candidate: "9" }) })).status).toBe(400);
    expect((await req(annaAuth, `/${id}/keep`, { method: "POST", body: JSON.stringify({ candidate: "2" }) })).status).toBe(200);
    expect(toolCalls.find((c) => c.tool === "open_fiche")!.args.tmdb_id).toBe(2);
  });

  test("someone they know: a plain fiche, no lookup, confirmed by their own hand", async () => {
    modelSays = { subjects: [{ kind: "people", title: "Marc Lambert", public: false, note: "Le voisin qui prête sa tondeuse." }] };
    await turn();
    await sug.keepSuggestion(ANNA, sug.suggestionsFor(ANNA, convo)[0]!.id);
    expect(toolCalls.find((c) => c.tool === "open_fiche")!.args.skip_metadata).toBe(true);
    const fiche = fs.readFileSync(path.join(root, "people/fr/marc-lambert-fiche.md"), "utf-8");
    expect(fiche).toContain("status: confirmed");
    expect(fiche).toContain("tondeuse");
  });

  test("a note on a person the mail found does not confirm them", async () => {
    modelSays = { subjects: [{ kind: "people", title: "Jeanne Dupont", public: false, note: "Elle rend les comptes en mars." }] };
    await turn();
    await sug.keepSuggestion(ANNA, sug.suggestionsFor(ANNA, convo)[0]!.id);
    const fiche = fs.readFileSync(path.join(root, "people/fr/jeanne-dupont-fiche.md"), "utf-8");
    expect(fiche).toContain("status: pending");
    expect(fiche).toContain("comptes en mars");
  });

  test("another member's suggestion is not found", async () => {
    modelSays = { subjects: [{ kind: "series", title: "Sugar", note: "n" }] };
    await turn();
    const id = sug.suggestionsFor(ANNA, convo)[0]!.id;
    expect((await req(benAuth, `/${id}/keep`, { method: "POST", body: "{}" })).status).toBe(404);
    expect((await req(benAuth, `/${id}/dismiss`, { method: "POST" })).status).toBe(404);
    expect((await req(benAuth, `/?conversation=${convo}`)).status).toBe(404);
    expect(((await (await req(annaAuth, `/?conversation=${convo}`)).json()) as any).pending).toBe(1);
  });
});

describe("a conversation held from an entry", () => {
  const held = () => { convo = createConversation(ANNA, null, { entryRef: "series/fr/sugar" }).id; };

  test("only the caller's own entry can be held from", () => {
    expect(sug.ownEntryRef(ANNA, "series/fr/sugar")).toBe("series/fr/sugar");
    expect(sug.ownEntryRef(ANNA, "series/fr/nope")).toBeNull();
    expect(sug.ownEntryRef(ANNA, "series/fr/../../etc")).toBeNull();
    expect(sug.ownEntryRef(BEN, "series/fr/sugar")).toBeNull();
  });

  test("the pass is told which entry; its note is the result, the rest will be linked", async () => {
    held();
    searchResults.search_movie = [{ id: 7, title: "The Lobster", year: 2015, subtitle: "", image: "" }];
    modelSays = { subjects: [
      { kind: "series", title: "Sugar", note: "La série rend hommage au film noir." },
      { kind: "movies", title: "The Lobster", year: 2015, note: "Colin Farrell y joue David." },
    ] };
    expect(await turn()).toBe(2);
    expect(lastPrompt).toContain('held from the person\'s notebook entry "Sugar" (kind: series)');

    const body = (await (await req(annaAuth, `/?conversation=${convo}&settle=1`)).json()) as any;
    expect(body.entry).toBe("series/fr/sugar");
    const sugar = body.suggestions.find((r: any) => r.title === "Sugar");
    const lobster = body.suggestions.find((r: any) => r.title === "The Lobster");
    expect([sugar.bound, sugar.links]).toEqual([true, false]);
    expect([lobster.bound, lobster.links]).toEqual([false, true]);
  });

  test("keeping another entry links it to the one the conversation is held from", async () => {
    held();
    searchResults.search_movie = [{ id: 7, title: "The Lobster", year: 2015, subtitle: "", image: "" }];
    modelSays = { subjects: [{ kind: "movies", title: "The Lobster", year: 2015, note: "Colin Farrell y joue David." }] };
    await turn();
    await sug.keepSuggestion(ANNA, sug.suggestionsFor(ANNA, convo)[0]!.id);

    const lobster = fs.readFileSync(path.join(root, "movies/fr/the-lobster-fiche.md"), "utf-8");
    expect(lobster).toContain("Colin Farrell y joue David.");
    const sugar = fs.readFileSync(path.join(root, "series/fr/sugar-fiche.md"), "utf-8");
    const res = sugar.slice(sugar.indexOf("## Résonances"));
    expect(res).toContain("de [[the-lobster-fiche|The Lobster]] :");
    expect(res).toContain(`(maurice://conversations/${convo})`);
  });

  test("keeping the entry's own note links nothing", async () => {
    held();
    modelSays = { subjects: [{ kind: "series", title: "Sugar", note: "Huit épisodes." }] };
    await turn();
    const before = fs.readFileSync(path.join(root, "series/fr/sugar-fiche.md"), "utf-8");
    await sug.keepSuggestion(ANNA, sug.suggestionsFor(ANNA, convo)[0]!.id);
    const after = fs.readFileSync(path.join(root, "series/fr/sugar-fiche.md"), "utf-8");
    expect(after).toContain("Huit épisodes.");
    expect(after.split("[[").length).toBe(before.split("[[").length);
  });

  test("an entry of a kind the pass does not name on its own can still get its result", () => {
    const one = { kind: "articles", title: "Un article", note: "Ce qu'il en reste." };
    expect(sug.parseNamed(JSON.stringify({ subjects: [one] }))).toEqual([]);
    expect(sug.parseNamed(JSON.stringify({ subjects: [one] }), "articles")).toHaveLength(1);
  });
});

describe("opening a conversation from an entry", () => {
  test("the entry is bound and its fiche is the context from the first turn", async () => {
    const conversations = (await import("../src/routes/conversations")).default;
    const { getSpec, resolveToText } = await import("../src/services/composer/specs");
    const post = (body: unknown) => conversations.request("/", {
      method: "POST", body: JSON.stringify(body),
      headers: { Authorization: annaAuth, "Content-Type": "application/json" },
    });
    const made = await post({ entry: "series/fr/sugar" });
    expect(made.status).toBe(201);
    const convo = (await made.json()) as any;
    expect(convo.entry_ref).toBe("series/fr/sugar");
    expect(getSpec(ANNA, convo.id).items.map((i: any) => [i.type, i.id])).toEqual([["fiche", "series/fr/sugar-fiche"]]);
    // Found, and read: what the model is given holds what is written on the fiche.
    expect(getSpec(ANNA, convo.id).items[0]!.snapshot.count).toBe(1);
    expect(resolveToText(ANNA, convo.id).items[0]!.text).toContain("Vu le pilote.");
    // Not theirs, or not there: no conversation is made.
    expect((await post({ entry: "series/fr/nope" })).status).toBe(404);
  });
});
