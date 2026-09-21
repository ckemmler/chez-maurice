// What a turn is allowed to look up (21 September 2026).
//
// The turn this exists for: "je ne comprends pas ce que l'école de mon fils
// veut que je lui installe — scoodle, plantyn, capture". Six web searches and
// two corpus searches, five rounds, forty source cards under a good answer.

import { describe, expect, test } from "bun:test";

const { newSearchLedger, allowSearch, recordSearch } = await import("../src/services/searchBudget");

/** The turn's six web queries, in the order it asked them. */
const THE_TURN = [
  "Scoodle app école Belgique Plantyn qu'est-ce que c'est",
  "Plantyn application école Belgique éditeur manuels scolaires",
  "Capture app école Belgique primaire exercices",
  '"Capture" application Plantyn ou école primaire Belgique exercices français',
  "Scoodle Play Plantyn gratuit primaire exercices français maths",
  '"Capture" Plantyn méthode français primaire Belgique grammaire conjugaison orthographe',
];

/** Run a list of queries through a fresh ledger; return what actually ran. */
function replay(queries: string[], family: "web" | "corpus" = "web") {
  const ledger = newSearchLedger();
  const ran: string[] = [];
  const refused: string[] = [];
  for (const q of queries) {
    const v = allowSearch(ledger, family, q);
    if (v.run) {
      recordSearch(ledger, family, q);
      ran.push(q);
    } else {
      refused.push(v.text);
    }
  }
  return { ran, refused };
}

describe("the turn that caused this", () => {
  test("six web searches become four", () => {
    const { ran, refused } = replay(THE_TURN);
    expect(ran).toHaveLength(4);
    expect(refused).toHaveLength(2);
  });

  test("the reworded one is caught as a repeat, not as a budget refusal", () => {
    const { refused } = replay(THE_TURN);
    // Query four is query three asked again (overlap 0.56).
    expect(refused[0]).toContain("already ran this search");
    expect(refused[0]).toContain("Capture app école Belgique primaire exercices");
    // The sixth is genuinely a different question, and simply arrives too late.
    expect(refused[1]).toContain("No web searches left");
  });

  test("neither refusal is an error, so the model does not retry around it", () => {
    const ledger = newSearchLedger();
    // Five of the turn's queries, one of them refused as a repeat, which is
    // exactly four searches actually run — the budget.
    for (const q of THE_TURN.slice(0, 5)) {
      const v = allowSearch(ledger, "web", q);
      if (v.run) recordSearch(ledger, "web", q);
    }
    expect(ledger.spent.web).toBe(4);
    const v = allowSearch(ledger, "web", "something else entirely");
    expect(v.run).toBe(false);
    expect("text" in v && v.text).toContain("not a failure");
    expect("text" in v && v.text).toContain("say plainly what you could not establish");
  });
});

describe("what counts as the same question", () => {
  test("a rewording of the same search", () => {
    const { ran } = replay([
      "Capture app école Belgique primaire exercices",
      "exercices Capture à l'école primaire en Belgique, app",
    ]);
    expect(ran).toHaveLength(1);
  });

  test("but not two different questions about one subject", () => {
    const { ran } = replay([
      "Plantyn application école Belgique éditeur manuels scolaires",
      "Scoodle Play Plantyn gratuit primaire exercices français maths",
    ]);
    expect(ran).toHaveLength(2);
  });

  test("accents and punctuation are not a difference", () => {
    const { ran } = replay(["Écoles à Bruxelles : inscriptions", "ecoles a bruxelles, inscriptions"]);
    expect(ran).toHaveLength(1);
  });

  test("the empty words are not a resemblance", () => {
    // Nothing shared but "what is", "the", "how" — two unrelated questions.
    const { ran } = replay(["Quelle est la capitale du Kazakhstan ?", "Quel est le prix du gaz ?"]);
    expect(ran).toHaveLength(2);
  });
});

describe("the two budgets are separate", () => {
  test("the corpus has three, one per layer", () => {
    const { ran } = replay(
      ["le jardin sur ce sujet", "ce qu'il m'a déjà dit là-dessus", "ce qu'il a seulement lu", "et encore autre chose"],
      "corpus",
    );
    expect(ran).toHaveLength(3);
  });

  test("a spent web budget leaves the corpus untouched", () => {
    const ledger = newSearchLedger();
    for (const q of THE_TURN) {
      const v = allowSearch(ledger, "web", q);
      if (v.run) recordSearch(ledger, "web", q);
    }
    expect(allowSearch(ledger, "web", "n'importe quoi d'autre").run).toBe(false);
    expect(allowSearch(ledger, "corpus", "n'importe quoi d'autre").run).toBe(true);
  });

  test("the same query on both sides is not a repeat", () => {
    const ledger = newSearchLedger();
    recordSearch(ledger, "web", "Scoodle Plantyn Capture");
    expect(allowSearch(ledger, "corpus", "Scoodle Plantyn Capture").run).toBe(true);
  });
});

test("a refused search does not spend the budget it was refused by", () => {
  const ledger = newSearchLedger();
  recordSearch(ledger, "web", "Capture app école Belgique primaire exercices");
  // Refused as a repeat, three times over.
  for (let i = 0; i < 3; i++) allowSearch(ledger, "web", "exercices Capture école primaire Belgique app");
  expect(ledger.spent.web).toBe(1);
  expect(allowSearch(ledger, "web", "tout autre chose").run).toBe(true);
});
