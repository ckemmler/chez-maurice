/**
 * An article shared from the Maurice app's share sheet rides in the
 * conversation as an ```article block. Nothing is filed; it is offered at
 * once behind the Carnet mark, and kept, it becomes an entry of the garden —
 * saved from the text that was shared — and the conversation one held from it
 * (19 October 2026). Run with `bun test`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "maurice-shared-article-"));
process.env.MAURICE_GARDENS_DIR = TMP;

const { default: db } = await import("../src/db");
const sug = await import("../src/services/entrySuggestions");
const { createConversation, addMessage, getConversation, autoTitle } = await import("../src/services/conversations");

const ZOE = "sa-zoe";
const root = path.join(TMP, ZOE);
/** The cleanup and the summary that follow a save call a model: recorded, not run. */
const followed: string[] = [];

beforeAll(() => {
  db.run(`INSERT OR IGNORE INTO households (id, name) VALUES ('default', 'Home')`);
  db.run(`INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES (?, ?, 'Zoé', 'standard')`, [ZOE, ZOE]);
  db.run(`INSERT INTO user_preferences (user_id, locale) VALUES (?, 'fr') ON CONFLICT(user_id) DO UPDATE SET locale = 'fr'`, [ZOE]);
  fs.mkdirSync(root, { recursive: true });
  sug.setAfterArticleSave(async (_m, saved) => { followed.push(saved.slug); });
});

afterAll(() => {
  sug.setAfterArticleSave(null);
  fs.rmSync(TMP, { recursive: true, force: true });
});

const block = (url: string) =>
  "```article\ntitle: Sols vivants\nsite: Le Monde\nauthor: Marc Dupont\nurl: " + url +
  "\n\nLe sol est vivant : vers, champignons et racines le tiennent.\n\nSans eux, il s'effondre.\n```";

describe("an article shared in the conversation", () => {
  test("is offered at once behind the Carnet mark, and titles the conversation", async () => {
    const id = createConversation(ZOE, null).id;
    const content = `${block("https://example.org/sols")}\n\nQu'est-ce qui tient un sol ?`;
    const msg = addMessage(id, "user", content, { authorId: ZOE });
    autoTitle(id);
    expect(getConversation(id, ZOE)!.title).toBe("Qu'est-ce qui tient un sol ?");
    expect(await sug.offerSharedArticle(ZOE, id, msg.id, content)).toBe(true);
    const rows = sug.suggestionsFor(ZOE, id);
    expect(rows.map((r) => [r.kind, r.title, r.subtitle, r.existing])).toEqual([["articles", "Sols vivants", "Le Monde", null]]);
    // Asked again (a retry), nothing more.
    expect(await sug.offerSharedArticle(ZOE, id, msg.id, content)).toBe(false);
  });

  test("a conversation that is only the article takes the article's title", () => {
    const id = createConversation(ZOE, null).id;
    addMessage(id, "user", block("https://example.org/sols-3"), { authorId: ZOE });
    autoTitle(id);
    expect(getConversation(id, ZOE)!.title).toBe("Sols vivants");
  });

  test("kept, it is saved from the text that was shared, and the conversation is held from it", async () => {
    const id = createConversation(ZOE, null).id;
    const content = block("https://example.org/sols-2");
    const msg = addMessage(id, "user", content, { authorId: ZOE });
    addMessage(id, "assistant", "Les vers, surtout.", {});
    await sug.offerSharedArticle(ZOE, id, msg.id, content);
    const row = sug.suggestionsFor(ZOE, id)[0]!;

    const kept = await sug.keepSuggestion(ZOE, row.id);
    expect(kept.state).toBe("kept");
    const ref = getConversation(id, ZOE)!.entry_ref as string;
    expect(ref).toMatch(/^articles\/fr\//);
    expect(kept.kept_path).toBe(ref);
    const slug = ref.split("/")[2]!;
    expect(followed).toEqual([slug]);
    const frags = path.join(root, "articles/fr", `${slug}-fiche`, "_fragments");
    expect(fs.readFileSync(path.join(frags, "001.frag"), "utf-8")).toContain("vers, champignons et racines");
    // The fiche has the link to the conversation.
    expect(fs.readFileSync(path.join(frags, "002.frag"), "utf-8")).toContain(`maurice://conversations/${id}`);
  });

  test("already in the garden, it is offered as the entry it is", async () => {
    const id = createConversation(ZOE, null).id;
    const content = block("https://example.org/sols-2");
    const msg = addMessage(id, "user", content, { authorId: ZOE });
    await sug.offerSharedArticle(ZOE, id, msg.id, content);
    expect(sug.suggestionsFor(ZOE, id)[0]!.existing).toMatch(/^articles\/fr\//);
  });

  test("a message without an article offers nothing", async () => {
    const id = createConversation(ZOE, null).id;
    const msg = addMessage(id, "user", "Bonjour", { authorId: ZOE });
    expect(await sug.offerSharedArticle(ZOE, id, msg.id, "Bonjour")).toBe(false);
  });
});
