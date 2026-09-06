/**
 * Flashcards on a throwaway garden: the plugin syntax round-trips, a pass is
 * anchored to its source by hash, hand edits survive regeneration, and the
 * review schedule follows the plugin's SM-2. Book and chapter sources need a
 * Calibre library and are not exercised here; fiche and fragment are.
 * Run with `bun test`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "maurice-cards-"));
process.env.MAURICE_GARDENS_DIR = TMP;

const {
  cardId, cardsFace, formatCard, generateCards, listCardFiles, listDueCards, nextSchedule,
  parseCardBlock, parseCardFile, parseSchedule, readCardFile, reviewCard, saveCardFileBody,
} = await import("../data-api/services/flashcards");
const { listGardenEntries } = await import("../data-api/services/gardenEntries");

const MEMBER = (await import("../src/db")).default
  .query("SELECT id FROM users ORDER BY created_at LIMIT 1")
  .get() as { id: string };
const { gardenFor } = await import("../data-api/services/gardenFiche");
const garden = () => gardenFor(MEMBER.id)!;

function write(rel: string, content: string) {
  const full = path.join(garden().root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

beforeAll(() => {
  const g = garden().root;
  fs.mkdirSync(g, { recursive: true });
  for (const args of [["init", "-q"], ["config", "user.email", "t@t"], ["config", "user.name", "t"]]) {
    spawnSync("git", args, { cwd: g });
  }
  write(
    "books/fr/being-you-fiche.md",
    `---\ntitle: Being You\nresource_collection: books\nresource_id: being-you\ndate: '2026-03-19'\ntags: []\nlocale: fr\nmeta:\n  author: Anil Seth\n---\n\nLe cerveau prédit plutôt qu'il ne perçoit. Le soi est une perception contrôlée.\n`,
  );
  write(
    "books/fr/being-you-fiche/_fragments/001.frag",
    `---\nsummary: "Chapitre sur la perception"\n---\nLa perception est une hallucination contrôlée : le cerveau devine, et les sens corrigent.`,
  );
  write(
    "articles/fr/china-fiche.md",
    `---\ntitle: A.I. in China\nresource_collection: articles\nresource_id: china\ndate: '2026-09-02'\ntags: []\nlocale: fr\ncards_lang: en\nmeta:\n  url: https://example.org/china\n---\n\nDes consultations gratuites avec des versions IA de grands médecins.\n`,
  );
});

afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

/** A generator that answers with a fixed deck, and records the prompt. */
function fakeGenerator(cards: Array<{ q: string; a: string; type?: string }>, seen: string[] = []) {
  return async (prompt: string) => {
    seen.push(prompt);
    return "```json\n" + JSON.stringify(cards) + "\n```";
  };
}

describe("the plugin's syntax", () => {
  test("single-line, reversed, multi-line and cloze cards parse, with their schedule", () => {
    expect(parseCardBlock("Q one::A one")).toMatchObject({ question: "Q one", answer: "A one", reversed: false });
    expect(parseCardBlock("Q two:::A two <!--SR:!2026-09-20,13,290-->")).toMatchObject({
      question: "Q two", answer: "A two", reversed: true, schedule: { due: "2026-09-20", interval: 13, ease: 290 },
    });
    expect(parseCardBlock("Long question\nover two lines\n?\nAnswer\nlines\n<!--SR:2026-01-01,1,250-->")).toMatchObject({
      question: "Long question\nover two lines", answer: "Answer\nlines", reversed: false,
      schedule: { due: "2026-01-01", interval: 1, ease: 250 },
    });
    expect(parseCardBlock("A ==controlled== hallucination")).toMatchObject({ cloze: true, answer: "controlled" });
    expect(parseCardBlock("just a paragraph of text")).toBeNull();
  });

  test("format → parse is the identity, schedule placement follows the plugin", () => {
    const s = { due: "2026-09-20", interval: 13, ease: 290 };
    const one = formatCard({ question: "Q", answer: "A", reversed: false, cloze: false, schedule: s });
    expect(one).toBe("Q::A <!--SR:!2026-09-20,13,290-->");
    const multi = formatCard({ question: "Q".repeat(80), answer: "A".repeat(80), reversed: true, cloze: false, schedule: s });
    expect(multi.endsWith("\n<!--SR:!2026-09-20,13,290-->")).toBe(true);
    expect(multi).toContain("\n??\n");
    for (const text of [one, multi]) {
      const back = parseCardBlock(text)!;
      expect(back.schedule).toEqual(s);
    }
    expect(parseSchedule("no comment here").schedule).toBeNull();
  });

  test("a card's id follows its question, not its answer or whitespace", () => {
    expect(cardId("What is  the self?")).toBe(cardId(" What is the self? "));
    expect(cardId("What is the self?")).not.toBe(cardId("What is the Self?"));
  });
});

describe("generation on a fiche", () => {
  const source = { kind: "fiche" as const, collection: "books" as const, locale: "fr", slug: "being-you" };

  test("writes a plugin-native file beside the fragments, git-ignored, anchored to the source", async () => {
    const seen: string[] = [];
    const file = await generateCards(MEMBER.id, source, {
      generator: fakeGenerator([
        { q: "Que prédit le cerveau selon Seth ?", a: "Le monde, plutôt que de le percevoir." },
        { q: "Le soi est une ==perception contrôlée==.", a: "perception contrôlée", type: "cloze" },
      ], seen),
    });
    expect(file.file).toBe("books/fr/being-you-fiche/_cards/fiche.md");
    expect(file.total).toBe(2);
    expect(file.due).toBe(2);              // new cards are due
    expect(file.stale).toBe(false);
    expect(file.meta.lang).toBe("fr");
    expect(file.deck).toBe("#flashcards/books/being-you/fiche");
    expect(seen[0]).toContain("Le cerveau prédit");   // the fiche body went into the prompt
    expect(seen[0]).toContain("Author: Anil Seth");

    const raw = fs.readFileSync(path.join(garden().root, file.file), "utf-8");
    expect(raw).toContain("\n#flashcards/books/being-you/fiche\n");
    expect(raw).toContain("Que prédit le cerveau selon Seth ?::Le monde, plutôt que de le percevoir.");
    expect(raw).toContain("Le soi est une ==perception contrôlée==.");

    const ignore = fs.readFileSync(path.join(garden().root, ".gitignore"), "utf-8");
    expect(ignore).toContain("**/_cards/");
    const status = spawnSync("git", ["status", "--short", "--ignored", "books/fr/being-you-fiche/_cards"], { cwd: garden().root, encoding: "utf-8" });
    expect(status.stdout).toMatch(/^!!/m);
  });

  test("the entries face and the per-entry listing see the cards", async () => {
    const entry = listGardenEntries(garden()).find((e) => e.slug === "being-you")!;
    expect(cardsFace(garden(), entry.fiche!.file)).toMatchObject({ files: 1, total: 2, due: 2 });
    const files = await listCardFiles(MEMBER.id, garden(), entry);
    expect(files.length).toBe(1);
    expect(files[0]!.stale).toBe(false);
  });

  test("editing the fiche marks the pass stale; regenerating keeps hand edits and schedules", async () => {
    const rel = "books/fr/being-you-fiche/_cards/fiche.md";
    // Review one card, edit the other by hand, add a third by hand.
    const first = parseCardFile(garden(), path.join(garden().root, rel))!;
    const q1 = first.cards[0]!;
    const reviewed = reviewCard(garden(), rel, q1.id, "good", "2026-09-06");
    expect(reviewed.schedule).toEqual({ due: "2026-09-07", interval: 1, ease: 250 });

    const before = readCardFile(garden(), rel);
    const edited = before.body
      .replace("Le soi est une ==perception contrôlée==.", "Le soi est une ==perception contrôlée== (Seth).")
      + "\n\nCarte écrite à la main::Sa réponse";
    saveCardFileBody(garden(), rel, edited);
    const afterEdit = parseCardFile(garden(), path.join(garden().root, rel))!;
    // Rewriting a question changes the card's id, so it reads as hand-written
    // rather than edited — either way it is the reader's, and kept.
    const cloze = afterEdit.cards.find((c) => c.cloze)!;
    expect(cloze.manual || cloze.edited).toBe(true);
    expect(afterEdit.cards.find((c) => c.question.startsWith("Carte écrite"))!.manual).toBe(true);
    // Editing only the answer keeps the id and reads as edited; a review
    // rewrites the file and must not launder that.
    const q1After = afterEdit.cards.find((c) => c.id === q1.id)!;
    saveCardFileBody(garden(), rel, readCardFile(garden(), rel).body.replace(q1After.answer, "Réponse retouchée."));
    reviewCard(garden(), rel, q1.id, "easy", "2026-09-06");
    expect(parseCardFile(garden(), path.join(garden().root, rel))!.cards.find((c) => c.id === q1.id)!.edited).toBe(true);

    // The fiche moves on.
    write("books/fr/being-you-fiche.md", fs.readFileSync(path.join(garden().root, "books/fr/being-you-fiche.md"), "utf-8") + "\nNouvelle résonance.\n");
    const entry = listGardenEntries(garden()).find((e) => e.slug === "being-you")!;
    expect((await listCardFiles(MEMBER.id, garden(), entry))[0]!.stale).toBe(true);

    // Regenerate: same first question (keeps its schedule), a new second one.
    const again = await generateCards(MEMBER.id, source, {
      generator: fakeGenerator([
        { q: "Que prédit le cerveau selon Seth ?", a: "Le monde — réponse reformulée." },
        { q: "Qu'est-ce qu'une résonance ?", a: "Un lien vers une autre fiche." },
      ]),
    });
    expect(again.stale).toBe(false);
    const qs = again.cards.map((c) => c.question);
    expect(qs).toContain("Que prédit le cerveau selon Seth ?");
    expect(qs).toContain("Qu'est-ce qu'une résonance ?");
    expect(qs).toContain("Le soi est une ==perception contrôlée== (Seth).");   // edited: kept
    expect(qs).toContain("Carte écrite à la main");                             // manual: kept
    // The reader's answer edit wins over the model's rewrite, and the schedule
    // the "easy" review set is still there.
    const q1Again = again.cards.find((c) => c.question.startsWith("Que prédit"))!;
    expect(q1Again.answer).toBe("Réponse retouchée.");
    expect(q1Again.edited).toBe(true);
    // "good" made it 1 day at 250; "easy" then: ease 270, 1 × 2.7 × 1.3 ≈ 4 days.
    expect(q1Again.schedule).toEqual({ due: "2026-09-10", interval: 4, ease: 270 });
  });
});

describe("language and mode", () => {
  test("the fiche's cards_lang wins over the default; a call overrides it; vocabulary answers in French", async () => {
    const seen: string[] = [];
    const source = { kind: "fragment" as const, collection: "books" as const, locale: "fr", slug: "being-you", fragment: "001" };
    const f = await generateCards(MEMBER.id, source, { generator: fakeGenerator([{ q: "q", a: "a" }], seen) });
    expect(f.file).toBe("books/fr/being-you-fiche/_cards/fragment-001.md");
    expect(seen[0]).toContain("La perception est une hallucination contrôlée");
    expect(f.meta.lang).toBe("fr");

    const china = { kind: "fiche" as const, collection: "articles" as const, locale: "fr", slug: "china" };
    const en = await generateCards(MEMBER.id, china, { generator: fakeGenerator([{ q: "q", a: "a" }]) });
    expect(en.meta.lang).toBe("en");
    expect(en.meta.answer_lang).toBe("en");

    const zh = await generateCards(MEMBER.id, china, { lang: "zh", mode: "vocabulary", generator: fakeGenerator([{ q: "医生", a: "médecin", type: "reversed" }], seen) });
    expect(zh.meta).toMatchObject({ lang: "zh", answer_lang: "fr", mode: "vocabulary" });
    expect(seen[seen.length - 1]).toContain("vocabulary flashcards");
    expect(zh.cards[0]!.reversed).toBe(true);
  });
});

describe("review", () => {
  test("SM-2 as the plugin does it", () => {
    expect(nextSchedule(null, "good", "2026-09-06")).toEqual({ due: "2026-09-07", interval: 1, ease: 250 });
    expect(nextSchedule(null, "easy", "2026-09-06")).toEqual({ due: "2026-09-10", interval: 4, ease: 270 });
    expect(nextSchedule({ due: "2026-09-06", interval: 10, ease: 250 }, "good", "2026-09-06")).toEqual({ due: "2026-10-01", interval: 25, ease: 250 });
    expect(nextSchedule({ due: "2026-09-06", interval: 10, ease: 250 }, "hard", "2026-09-06")).toEqual({ due: "2026-09-11", interval: 5, ease: 230 });
    expect(nextSchedule({ due: "2026-09-06", interval: 10, ease: 250 }, "easy", "2026-09-06")).toEqual({ due: "2026-10-11", interval: 35, ease: 270 });
    expect(nextSchedule({ due: "x", interval: 1, ease: 130 }, "hard", "2026-09-06").ease).toBe(130);
  });

  test("the due list spans the garden, oldest first, new cards last", () => {
    const due = listDueCards(garden(), "2026-09-08");
    expect(due.length).toBeGreaterThan(0);
    const dates = due.map((c) => c.schedule?.due ?? "9999");
    expect(dates).toEqual([...dates].sort());
    expect(due[0]!.entry.slug).toBeDefined();
    expect(due[0]!.file).toContain("/_cards/");
    // Nothing is due before any card was ever reviewed or created… except new cards.
    expect(listDueCards(garden(), "2026-01-01").every((c) => !c.schedule)).toBe(true);
  });

  test("paths outside a _cards directory are refused", () => {
    expect(() => reviewCard(garden(), "books/fr/being-you-fiche.md", "x", "good")).toThrow(/not a card file/);
    expect(() => reviewCard(garden(), "../../etc/passwd.md", "x", "good")).toThrow(/escapes/);
  });
});
