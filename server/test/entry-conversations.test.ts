/**
 * An article's page in Carnet: its summary, meant to be read instead of it;
 * the conversations about it, held from its page or with its fiche in
 * context; and what each came to, kept in the fiche when asked for and
 * rewritten when the conversation went on. Run with `bun test`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "maurice-entry-convos-"));
process.env.MAURICE_GARDENS_DIR = path.join(TMP, "gardens");

const { MEMBER } = await import("./_member");
const { default: db } = await import("../src/db");
const { createConversation, addMessage, emptyEntryConversation } = await import("../src/services/conversations");
const { saveSpec } = await import("../src/services/composer/specs");
const {
  readFullText, storedSummaryOf, summaryWordBudget, summarizeAndStore, setArticleSummaryGenerator, SUMMARY_VERSION,
} = await import("../data-api/services/articleSummary");
const { scanArticleFiches } = await import("../data-api/services/gardenArticles");
const { conversationsAbout, conversationWordBudget, linkConversation, linkOnFiche, summaryFor, setEntryConversationSummarizer, summariseSettledConversations, SETTLED_MS } = await import("../data-api/services/entryConversations");
const { getShelfEntry } = await import("../data-api/services/gardenShelf");

const garden = { root: path.join(process.env.MAURICE_GARDENS_DIR!, MEMBER.username), username: MEMBER.username };
const REF = { collection: "articles", locale: "fr", slug: "sols-vivants" };
const FICHE = path.join(garden.root, "articles/fr/sols-vivants-fiche.md");
const FRAGS = path.join(garden.root, "articles/fr/sols-vivants-fiche/_fragments");

function write(rel: string, content: string) {
  const full = path.join(garden.root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

const ARTICLE = "Les vers de terre retournent le sol. ".repeat(400).trim();
const made: string[] = [];

beforeAll(() => {
  write("articles/fr/sols-vivants-fiche.md",
    `---\ntitle: Sols vivants\nresource_collection: articles\nresource_id: sols-vivants\ndate: '2026-10-18'\ntags: []\nlocale: fr\nmeta:\n  url: https://example.org/sols\n  word_count: 2800\n  lang: fr\n  summary: Un sol, des vers.\n  opened: false\n---\n\n> Le sol vit.\n`);
  write("articles/fr/sols-vivants-fiche/_fragments/001.frag", `---\nsummary: "Texte intégral — Le Monde"\n---\n${ARTICLE}`);
  // The reader reads French: the paragraph is written in it.
  db.run(`INSERT INTO user_preferences (user_id, locale) VALUES (?, 'fr')
          ON CONFLICT(user_id) DO UPDATE SET locale = 'fr'`, [MEMBER.id]);
  setArticleSummaryGenerator(async (input) => {
    expect(input.text).toBe(ARTICLE);
    made.push(input.length!);
    const lang = input.length === "short" ? ` ${input.readerLang}` : "";
    return { text: `${input.length}${lang}: Le sol est vivant.`, usage: null };
  });
});

afterAll(() => {
  db.run(`DELETE FROM user_preferences WHERE user_id = ?`, [MEMBER.id]);
  setArticleSummaryGenerator(null);
  setEntryConversationSummarizer(null);
  fs.rmSync(TMP, { recursive: true, force: true });
});

const articleRef = () => scanArticleFiches(garden).find((f) => f.slug === REF.slug)!;

describe("the article's summary", () => {
  test("a conversation's summary is held to about a third of it, within 60 and 300 words", () => {
    expect(conversationWordBudget("mot ".repeat(90))).toBe(60);
    expect(conversationWordBudget("mot ".repeat(770))).toBe(260);
    expect(conversationWordBudget("mot ".repeat(5000))).toBe(300);
  });

  test("its length follows the article's, within 150 and 600 words", () => {
    expect(summaryWordBudget("mot ".repeat(400))).toBe(150);
    expect(summaryWordBudget("mot ".repeat(2800))).toBe(350);
    expect(summaryWordBudget("mot ".repeat(20000))).toBe(600);
  });

  test("a fiche reads as current only with both, of version 4, the paragraph in the reader's language", () => {
    expect(storedSummaryOf({ summary: "Court." })).toMatchObject({ summary: "Court.", version: 1, current: false });
    expect(storedSummaryOf({ summary: "Long.", summary_version: 2 }).current).toBe(false);
    expect(storedSummaryOf({ summary: "Court.", summary_long: "Long.", summary_version: 3 }, "fr").current).toBe(false);
    const v4 = { summary: "Court.", summary_long: "Long.", summary_version: SUMMARY_VERSION, summary_lang: "fr" };
    expect(storedSummaryOf(v4, "fr").current).toBe(true);
    expect(storedSummaryOf(v4, "en").current).toBe(false);
    expect(storedSummaryOf({}).summary).toBe("");
  });

  test("the page carries it, and says it is an old one", async () => {
    const page = await getShelfEntry(MEMBER.id, garden, REF.collection, REF.locale, REF.slug);
    expect(page?.source).toMatchObject({ type: "article", summary: { text: "Un sol, des vers.", long: "", current: false } });
  });

  test("a version 1 paragraph is written again, in the reader's language, with the long one; then both are left alone", async () => {
    const first = await summarizeAndStore(MEMBER.id, articleRef());
    expect(first).toEqual({ summary: "short fr: Le sol est vivant.", summaryLong: "long: Le sol est vivant.", regenerated: true });
    expect(made.sort()).toEqual(["long", "short"]);
    expect(fs.readFileSync(FICHE, "utf-8")).toContain("summary_lang: fr");
    const again = await summarizeAndStore(MEMBER.id, articleRef());
    expect(again.regenerated).toBe(false);
    expect(made).toHaveLength(2);
    const page = await getShelfEntry(MEMBER.id, garden, REF.collection, REF.locale, REF.slug);
    expect(page?.source).toMatchObject({ summary: { current: true } });
  });

  test("a version 2 text becomes the long one, and only the paragraph is written", async () => {
    made.length = 0;
    const fiche = fs.readFileSync(FICHE, "utf-8");
    fs.writeFileSync(FICHE, fiche
      .replace(/  summary: .*\n/, "  summary: Le texte long d'hier.\n")
      .replace(/  summary_long: .*\n/, "")
      .replace(/  summary_version: .*\n/, "  summary_version: 2\n"));
    const r = await summarizeAndStore(MEMBER.id, articleRef());
    expect(r).toMatchObject({ summary: "short fr: Le sol est vivant.", summaryLong: "Le texte long d'hier." });
    expect(made).toEqual(["short"]);
  });

  test("a version 3 fiche keeps its long summary; only the paragraph is written again", async () => {
    made.length = 0;
    const fiche = fs.readFileSync(FICHE, "utf-8");
    fs.writeFileSync(FICHE, fiche.replace(/  summary_version: .*\n/, "  summary_version: 3\n").replace(/  summary_lang: .*\n/, ""));
    const r = await summarizeAndStore(MEMBER.id, articleRef());
    expect(r.summaryLong).toBe("Le texte long d'hier.");
    expect(made).toEqual(["short"]);
  });

  test("forced, both are written again — and two asks at once make one pass", async () => {
    made.length = 0;
    const [a, b] = await Promise.all([
      summarizeAndStore(MEMBER.id, articleRef(), { force: true }),
      summarizeAndStore(MEMBER.id, articleRef(), { force: true }),
    ]);
    expect(a.summaryLong).toBe(b.summaryLong);
    expect(made.sort()).toEqual(["long", "short"]);
  });
});

describe("the conversations about it", () => {
  let held: string;
  let composed: string;

  beforeAll(() => {
    held = createConversation(MEMBER.id, null, { entryRef: "articles/fr/sols-vivants" }).id;
    addMessage(held, "user", "Pourquoi les vers ?", { authorId: MEMBER.id });
    addMessage(held, "assistant", "Parce qu'ils aèrent le sol.", {});

    // In the Maurice app, the fiche loaded into the composer.
    composed = createConversation(MEMBER.id, null).id;
    saveSpec(MEMBER.id, composed, [{ type: "fiche", id: "articles/fr/sols-vivants-fiche" }]);
    addMessage(composed, "user", "Et le labour ?", { authorId: MEMBER.id });

    // Neither: about something else.
    const other = createConversation(MEMBER.id, null).id;
    addMessage(other, "user", "Bonjour", { authorId: MEMBER.id });
  });

  test("an empty conversation held from the entry is reused, and not listed", () => {
    const empty = createConversation(MEMBER.id, null, { entryRef: "articles/fr/sols-vivants" });
    expect(emptyEntryConversation(MEMBER.id, "articles/fr/sols-vivants", null)?.id).toBe(empty.id);
    expect(emptyEntryConversation(MEMBER.id, "articles/fr/autre", null)).toBeNull();
    expect(conversationsAbout(MEMBER.id, REF).map((c) => c.id)).not.toContain(empty.id);
  });

  test("held from the page, it counts; with the fiche only in context, once the member links it", () => {
    expect(conversationsAbout(MEMBER.id, REF).map((c) => c.id)).toEqual([held]);
    linkConversation(MEMBER.id, composed, "articles/fr/sols-vivants");
    const list = conversationsAbout(MEMBER.id, REF);
    expect(list.map((c) => [c.id, c.via]).sort()).toEqual([[composed, "linked"], [held, "entry"]].sort());
    expect(list.every((c) => c.summary === null)).toBe(true);
  });

  test("after the first exchange, the fiche gets the link alone — once, and not before an answer", () => {
    const fresh = createConversation(MEMBER.id, null, { entryRef: "articles/fr/sols-vivants" }).id;
    addMessage(fresh, "user", "Une question sans réponse", { authorId: MEMBER.id });
    expect(linkOnFiche(MEMBER.id, fresh)).toBeNull();

    const file = linkOnFiche(MEMBER.id, held)!;
    expect(path.basename(file)).toBe("002.frag");
    const raw = fs.readFileSync(file, "utf-8");
    expect(raw).toContain(`conversation: ${held}`);
    expect(raw).toContain(`maurice://conversations/${held}`);
    expect(raw).not.toContain("transcript_hash");
    expect(linkOnFiche(MEMBER.id, held)).toBeNull();
    // Linked, but no answer yet.
    expect(linkOnFiche(MEMBER.id, composed)).toBeNull();
    // Listed with no summary yet: the link is not one.
    expect(conversationsAbout(MEMBER.id, REF).find((c) => c.id === held)?.summary).toBeNull();
  });

  test("a summary is written as a fragment of its own, after the article's text", async () => {
    const seen: string[] = [];
    setEntryConversationSummarizer(async (input) => {
      seen.push(input.transcript);
      return { text: `Résumé ${seen.length}`, usage: null };
    });

    // It fills the fragment the first exchange left.
    const s = await summaryFor(MEMBER.id, REF, held);
    expect(s).toMatchObject({ id: "f:002", text: "Résumé 1", stale: false });
    expect(fs.readdirSync(FRAGS).sort()).toEqual(["001.frag", "002.frag"]);
    const raw = fs.readFileSync(path.join(FRAGS, "002.frag"), "utf-8");
    expect(raw).toContain(`conversation: ${held}`);
    expect(raw).toContain(`maurice://conversations/${held}`);

    // The article's text is still the article's alone.
    expect(readFullText(FICHE)).toBe(ARTICLE);
    // The fiche now has the member's attention.
    expect(fs.readFileSync(FICHE, "utf-8")).not.toContain("opened: false");
    // The page does not list it among the fiche's items: it goes with its conversation.
    const page = await getShelfEntry(MEMBER.id, garden, REF.collection, REF.locale, REF.slug);
    expect(page?.mine?.items.some((i) => i.kind === "fragment")).toBe(false);

    // Asked again with nothing new: read back, no model call.
    expect((await summaryFor(MEMBER.id, REF, held)).text).toBe("Résumé 1");
    expect(seen).toHaveLength(1);

    // The conversation went on: stale in the list, rewritten in place.
    addMessage(held, "user", "Et les champignons ?", { authorId: MEMBER.id });
    expect(conversationsAbout(MEMBER.id, REF).find((c) => c.id === held)?.summary?.stale).toBe(true);
    const again = await summaryFor(MEMBER.id, REF, held);
    expect(again).toMatchObject({ id: "f:002", text: "Résumé 2", stale: false });
    expect(seen[1]).toContain("champignons");

    // A second conversation gets a fragment of its own.
    expect((await summaryFor(MEMBER.id, REF, composed)).id).toBe("f:003");
  });

  test("a settled conversation gets its summary without being asked; one still going does not", async () => {
    setEntryConversationSummarizer(async () => ({ text: "Ce qui en est sorti.", usage: null }));
    const later = createConversation(MEMBER.id, null, { entryRef: "articles/fr/sols-vivants" }).id;
    addMessage(later, "user", "Et les racines ?", { authorId: MEMBER.id });
    addMessage(later, "assistant", "Elles tiennent le sol.", {});
    const mine = () => conversationsAbout(MEMBER.id, REF).find((c) => c.id === later);

    await summariseSettledConversations(Date.now());
    expect(mine()?.summary).toBeNull();

    await summariseSettledConversations(Date.now() + SETTLED_MS + 60_000);
    expect(mine()?.summary).toMatchObject({ text: "Ce qui en est sorti.", stale: false });
  });

  test("a conversation that is not about the entry is refused", async () => {
    const other = createConversation(MEMBER.id, null).id;
    addMessage(other, "user", "Rien à voir", { authorId: MEMBER.id });
    await expect(summaryFor(MEMBER.id, REF, other)).rejects.toThrow(/No such conversation/);
  });
});
