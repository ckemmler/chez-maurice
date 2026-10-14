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

describe("a note's length", () => {
  test("a note that runs over ends on its last whole sentence, never inside a word", () => {
    const short = "Créée par Eugene Levy et son fils Dan.";
    expect(sug.clipNote(short)).toBe(short);
    const long = "Première phrase assez longue pour compter. Deuxième phrase qui tient encore. Troisième phrase qui dépasse la limite et serait coupée au milieu d'un mot.";
    expect(sug.clipNote(long, 100)).toBe("Première phrase assez longue pour compter. Deuxième phrase qui tient encore.");
    // No sentence to stop at: the last whole word, and a mark that it goes on.
    expect(sug.clipNote("un mot puis un autre et encore un autre sans jamais de point final ici", 30)).toBe("un mot puis un autre et…");
    const [named] = sug.parseNamed(JSON.stringify({ subjects: [{ kind: "series", title: "Sugar", note: `${"Une phrase entière. ".repeat(60)}` }] }));
    expect(named!.note.length).toBeLessThanOrEqual(900);
    expect(named!.note.endsWith("entière.")).toBe(true);
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

describe("looking again (14 October 2026)", () => {
  const sportsDailies = [
    { id: "52833", title: "Locked On Warriors – Daily Podcast", year: null, subtitle: "Locked On Podcast Network", image: "https://img/w.jpg" },
    { id: "217331", title: "Locked On NBA – Daily Podcast", year: null, subtitle: "Locked On Podcast Network", image: "" },
  ];
  const theDaily = [
    { id: "743229", title: "The Daily", year: null, subtitle: "The New York Times", image: "https://img/daily.jpg" },
    { id: "7467411", title: "The Daily", year: null, subtitle: "The New York Times", image: "" },
  ];
  const named = (extra: Record<string, unknown> = {}) =>
    ({ subjects: [{ kind: "podcasts", title: "The Daily", creator: "The New York Times", note: "Un professeur de mathématiques face à l'IA.", ...extra }] });

  test("a podcast is searched with its maker, and the maker settles its copies", async () => {
    searchResults.search_podcast = theDaily;
    modelSays = named();
    await turn();
    expect(toolCalls[0]!.args.title).toBe("The Daily The New York Times");
    const [s] = sug.suggestionsFor(ANNA, convo);
    expect(s!.key).toBe("id:743229");
  });

  test("their own term: all it finds, one to pick even when it is alone, and the pick is what is opened", async () => {
    searchResults.search_podcast = sportsDailies;
    modelSays = named({ creator: "" });
    await turn();
    const id = sug.suggestionsFor(ANNA, convo)[0]!.id;
    searchResults.search_podcast = [theDaily[0]];
    toolCalls = [];
    const res = await req(annaAuth, `/${id}/search`, { method: "POST", body: JSON.stringify({ query: "The Daily New York Times" }) });
    expect(res.status).toBe(200);
    const row = await res.json() as any;
    expect(row.found).toBe(1);
    expect(row.query).toBe("The Daily New York Times");
    expect(row.candidates.map((c: any) => c.id)).toEqual(["743229"]);
    expect(toolCalls[0]!.args).toMatchObject({ title: "The Daily New York Times" });
    expect(modelCalls).toBe(1); // the pass only: their term needs no model

    expect((await req(annaAuth, `/${id}/keep`, { method: "POST", body: JSON.stringify({ candidate: "743229" }) })).status).toBe(200);
    expect(toolCalls.find((c) => c.tool === "open_fiche")!.args.podcastindex_id).toBe(743229);
    // Not in the garden for the tests that follow.
    fs.rmSync(path.join(root, "podcasts"), { recursive: true, force: true });
  });

  test("asked to look again, Maurice rephrases from what was wrong and shows only what is new", async () => {
    searchResults.search_podcast = sportsDailies;
    modelSays = named({ creator: "" });
    const q = "Je viens d'écouter le daily du New York Times";
    const mid = `m-${convo}`;
    db.run(`INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, 'user', ?, datetime('now', '-1 second'))`, [`q-${convo}`, convo, q]);
    db.run(`INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, 'assistant', 'Un témoignage fort.')`, [mid, convo]);
    await sug.suggestForTurn(ANNA, convo, mid, q, "Un témoignage fort.");
    const id = sug.suggestionsFor(ANNA, convo)[0]!.id;
    modelSays = { query: "The Daily New York Times" };
    searchResults.search_podcast = [...sportsDailies, ...theDaily];
    toolCalls = [];
    const row = await (await req(annaAuth, `/${id}/search`, { method: "POST", body: "{}" })).json() as any;
    expect(lastPrompt).toContain("Locked On Warriors");
    expect(lastPrompt).toContain("le daily du New York Times"); // what they said
    expect(toolCalls[0]!.args.title).toBe("The Daily New York Times");
    // The copies of the feed fold into one: the show is settled.
    expect(row.candidates.map((c: any) => c.id)).toEqual(["743229"]);
    expect(row.image).toBe("https://img/daily.jpg");

    // Nothing new the next time — the sports dailies do not bear the title
    // named, so they do not count: the row stays as it was.
    const again = await (await req(annaAuth, `/${id}/search`, { method: "POST", body: "{}" })).json() as any;
    expect(again.found).toBe(0);
    expect(again.candidates.map((c: any) => c.id)).toEqual(["743229"]);
  });

  test("Maurice's term finds nothing: the title with its maker is tried next", async () => {
    searchResults.search_podcast = sportsDailies;
    modelSays = named();
    // The first look finds only the sports dailies, whatever is asked.
    await turn();
    const id = sug.suggestionsFor(ANNA, convo)[0]!.id;
    // The catalogue reads words literally: "by" finds nothing.
    sug.setGardenCall(async (_m, tool, args) => {
      toolCalls.push({ tool, args });
      return { card: "candidates", results: String(args.title).includes(" by ") ? [] : theDaily };
    });
    try {
      modelSays = { query: "The Daily by The New York Times" };
      toolCalls = [];
      const row = await (await req(annaAuth, `/${id}/search`, { method: "POST", body: "{}" })).json() as any;
      expect(toolCalls.map((c) => c.args.title)).toEqual(["The Daily by The New York Times", "The Daily The New York Times"]);
      expect(row.found).toBe(1);
      expect(row.query).toBe("The Daily The New York Times");
    } finally {
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

  test("copies of one feed are one candidate, and the pass settles on it", async () => {
    const copies = [
      { id: "743229", title: "The Daily", year: null, subtitle: "The New York Times", image: "a" },
      { id: "6296135", title: "The Daily", year: null, subtitle: "", image: "" },
      { id: "7467411", title: "The Daily", year: null, subtitle: "The New York Times", image: "" },
    ];
    expect(sug.distinct(copies).map((c) => c.id)).toEqual(["743229", "6296135"]);
    searchResults.search_podcast = copies;
    modelSays = named();
    await turn();
    const [s] = sug.suggestionsFor(ANNA, convo);
    expect(s!.candidates.map((c) => c.id)).toEqual(["743229"]);
  });

  test("their term names an entry of theirs: it is that entry, no provider asked", async () => {
    searchResults.search_series = [{ id: 9, title: "Sugar Rush", year: 2018, subtitle: "", image: "" }];
    modelSays = { subjects: [{ kind: "series", title: "Sugar Rush", note: "n" }] };
    await turn();
    const id = sug.suggestionsFor(ANNA, convo)[0]!.id;
    toolCalls = [];
    const row = await (await req(annaAuth, `/${id}/search`, { method: "POST", body: JSON.stringify({ query: "Sugar" }) })).json() as any;
    expect(toolCalls).toEqual([]);
    expect(row.existing).toBe(true);
    expect(row.entry).toBe("series/fr/sugar");
    expect(row.candidates).toEqual([]);
  });

  test("not for someone from their own life, nor for another member", async () => {
    modelSays = { subjects: [{ kind: "people", title: "Marc Lambert", public: false, note: "Le voisin." }] };
    await turn();
    const s = sug.suggestionsFor(ANNA, convo)[0]!;
    expect((await req(annaAuth, `/${s.id}/search`, { method: "POST", body: "{}" })).status).toBe(409);
    expect((await req(benAuth, `/${s.id}/search`, { method: "POST", body: "{}" })).status).toBe(404);
    const list = await (await req(annaAuth, `/?conversation=${convo}`)).json() as any;
    expect(list.suggestions[0].searchable).toBe(false);
  });
});

describe("a podcast's episodes (14 October 2026)", () => {
  const EPISODES = [
    { id: 61667039106, title: "Mathematicians’ Latest Problem: What if A.I. Can Do Our Job?", datePublished: 1791884700, duration: 1997, image: "https://img/ep1.jpg", description: "Steven Strogatz on A.I. and the grief of mathematicians." },
    { id: 61667039100, title: "The Israeli Film Directors Pushing for a Reckoning", datePublished: 1791798300, duration: 1920, image: "", description: "A documentary." },
  ];
  const stub = (_m: string, tool: string, args: any) => {
    toolCalls.push({ tool, args });
    if (tool === "search_podcast_episodes") return { feed_id: args.podcastindex_id, episodes: EPISODES };
    if (tool === "open_fiche" && args.podcast_episode_id) {
      const ep = EPISODES.find((e) => e.id === args.podcast_episode_id)!;
      const slug = `the-daily--${ep.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
      write(`podcasts/${args.locale}/${slug}-fiche.md`, `---\ntitle: "${ep.title}"\nresource_collection: podcasts\nresource_id: ${slug}\ndate: '2026-10-14'\ntags: []\nlocale: ${args.locale}\nmeta:\n  show: the-daily\n  show_title: The Daily\n---\n`);
      return { card: "media", resource_id: slug, locale: args.locale, title: ep.title };
    }
    return { card: "candidates", results: searchResults[tool] ?? [] };
  };
  const theDaily = [{ id: "743229", title: "The Daily", year: null, subtitle: "The New York Times", image: "" }];

  beforeEach(() => {
    sug.forgetEpisodes();
    sug.setGardenCall(async (m, tool, args) => stub(m, tool, args));
  });
  afterAll(() => {
    fs.rmSync(path.join(root, "podcasts"), { recursive: true, force: true });
    sug.setGardenCall(async (_m, tool, args) => {
      toolCalls.push({ tool, args });
      if (tool === "open_fiche") {
        const slug = String(args.title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        write(`${args.resource_collection}/${args.locale}/${slug}-fiche.md`, `---\ntitle: ${args.title}\nresource_collection: ${args.resource_collection}\nresource_id: ${slug}\ndate: '2026-10-09'\ntags: []\nlocale: ${args.locale}\n---\n`);
        return { card: "media", resource_id: slug, locale: args.locale, title: args.title };
      }
      return { card: "candidates", results: searchResults[tool] ?? [] };
    });
  });

  test("the show's episodes, newest first, with the one the conversation was about picked", async () => {
    searchResults.search_podcast = theDaily;
    modelSays = { subjects: [{ kind: "podcasts", title: "The Daily", creator: "The New York Times", note: "Un mathématicien face à l'IA." }] };
    await turn();
    const id = sug.suggestionsFor(ANNA, convo)[0]!.id;
    modelSays = { episode: "61667039106" };
    const list = await (await req(annaAuth, `/${id}/episodes`)).json() as any;
    expect(list.feed).toBe("743229");
    expect(list.episodes.map((e: any) => e.id)).toEqual(["61667039106", "61667039100"]);
    expect(list.episodes[0]).toMatchObject({ duration: 1997, image: "https://img/ep1.jpg" });
    expect(list.episodes[0].date).toStartWith("2026-");
    expect(list.suggested).toBe("61667039106");
    expect(lastPrompt).toContain("Strogatz");
    // Read once: the drawer reopened asks neither the catalogue nor the model.
    const calls = modelCalls;
    await req(annaAuth, `/${id}/episodes`);
    expect(modelCalls).toBe(calls);
    expect(toolCalls.filter((c) => c.tool === "search_podcast_episodes")).toHaveLength(1);
  });

  test("keeping an episode opens its own fiche and files the note there", async () => {
    searchResults.search_podcast = theDaily;
    modelSays = { subjects: [{ kind: "podcasts", title: "The Daily", creator: "The New York Times", note: "Un mathématicien face à l'IA." }] };
    await turn();
    const id = sug.suggestionsFor(ANNA, convo)[0]!.id;
    modelSays = { episode: null };
    await req(annaAuth, `/${id}/episodes`);
    const res = await req(annaAuth, `/${id}/keep`, { method: "POST", body: JSON.stringify({ episode: "61667039106" }) });
    expect(res.status).toBe(200);
    const row = await res.json() as any;
    expect(row.entry).toBe("podcasts/fr/the-daily--mathematicians-latest-problem-what-if-a-i-can-do-our-job");
    expect(row.title).toBe("Mathematicians’ Latest Problem: What if A.I. Can Do Our Job?");
    expect(row.image).toBe("https://img/ep1.jpg");
    const open = toolCalls.find((c) => c.tool === "open_fiche")!.args;
    expect(open).toMatchObject({ podcastindex_id: 743229, podcast_episode_id: 61667039106 });
    const fiche = fs.readFileSync(path.join(root, "podcasts/fr/the-daily--mathematicians-latest-problem-what-if-a-i-can-do-our-job-fiche.md"), "utf-8");
    expect(fiche).toContain("Un mathématicien face à l'IA.");
    // The garden lists it as an episode of its show.
    const { listGardenEntries } = await import("../data-api/services/gardenEntries");
    const entry = listGardenEntries({ username: ANNA, root } as any).find((e) => e.slug.startsWith("the-daily--"))!;
    expect(entry.show).toEqual({ slug: "the-daily", title: "The Daily" });
  });

  test("several episodes: each its own fiche, the note on every one", async () => {
    searchResults.search_podcast = theDaily;
    modelSays = { subjects: [{ kind: "podcasts", title: "The Daily", creator: "The New York Times", note: "Deux épisodes sur l'IA." }] };
    await turn();
    const id = sug.suggestionsFor(ANNA, convo)[0]!.id;
    modelSays = { episode: null };
    await req(annaAuth, `/${id}/episodes`);
    toolCalls = [];
    const res = await req(annaAuth, `/${id}/keep`, {
      method: "POST", body: JSON.stringify({ episodes: ["61667039106", "61667039100"] }),
    });
    expect(res.status).toBe(200);
    const row = await res.json() as any;
    expect(toolCalls.filter((c) => c.tool === "open_fiche").map((c) => c.args.podcast_episode_id)).toEqual([61667039106, 61667039100]);
    for (const slug of ["mathematicians-latest-problem-what-if-a-i-can-do-our-job", "the-israeli-film-directors-pushing-for-a-reckoning"]) {
      expect(fs.readFileSync(path.join(root, `podcasts/fr/the-daily--${slug}-fiche.md`), "utf-8")).toContain("Deux épisodes sur l'IA.");
    }
    expect(row.entry).toBe("podcasts/fr/the-daily--mathematicians-latest-problem-what-if-a-i-can-do-our-job");
    expect(row.title).toBe("Mathematicians’ Latest Problem: What if A.I. Can Do Our Job? (+1)");
  });

  test("several shows: the one picked is the one listed; episodes are for podcasts only", async () => {
    searchResults.search_podcast = [...theDaily, { id: "6296135", title: "The Daily", year: null, subtitle: "", image: "" }];
    modelSays = { subjects: [
      { kind: "podcasts", title: "The Daily", note: "n" },
      { kind: "movies", title: "Dune", note: "n" },
    ] };
    searchResults.search_movie = [{ id: 1, title: "Dune", year: 2021, subtitle: "", image: "" }];
    await turn();
    const rows = sug.suggestionsFor(ANNA, convo);
    const pod = rows.find((r) => r.kind === "podcasts")!;
    const dune = rows.find((r) => r.kind === "movies")!;
    expect((await req(annaAuth, `/${pod.id}/episodes`)).status).toBe(409);
    expect((await req(annaAuth, `/${pod.id}/episodes?feed=999`)).status).toBe(400);
    modelSays = { episode: null };
    const list = await (await req(annaAuth, `/${pod.id}/episodes?feed=6296135`)).json() as any;
    expect(list.feed).toBe("6296135");
    expect((await req(annaAuth, `/${dune.id}/episodes`)).status).toBe(400);
    expect((await req(benAuth, `/${pod.id}/episodes?feed=6296135`)).status).toBe(404);
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
