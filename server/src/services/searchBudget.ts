// ── What a turn is allowed to go and look up ────────────────────────────────
//
// A turn asked what Scoodle, Plantyn and Capture were — three proper nouns, one
// question — and searched the web six times and the corpus twice, in five
// rounds. Every search drew its own row of five source cards, so the member
// read a good answer under forty sources, six of the queries being the same
// question reworded:
//
//   Scoodle app école Belgique Plantyn qu'est-ce que c'est
//   Plantyn application école Belgique éditeur manuels scolaires
//   Capture app école Belgique primaire exercices
//   "Capture" application Plantyn ou école primaire Belgique exercices français
//   Scoodle Play Plantyn gratuit primaire exercices français maths
//   "Capture" Plantyn méthode français primaire Belgique grammaire ...
//
// Nothing stopped it. The only guard on the loop was MAX_TOOL_ROUNDS, six, and
// a round may hold any number of calls — so the ceiling on searches per turn
// was effectively none. This is the ledger that gives a turn a number.
//
// Two rules, and they do different jobs:
//
//   - **A budget**, per family. Four web searches answer any question a chat
//     turn is going to answer; a fifth is a model circling. The corpus gets
//     three, one per layer the prompt tells it to ask for (garden,
//     conversations, what they have only read).
//   - **A repeat check**, on the query itself: re-running a search spends a
//     round to receive the same pages twice. Of the fifteen pairs above, the
//     content-word overlap is 0.56 for queries three and four — the same
//     search, reworded — then 0.42, 0.36, and down. The threshold sits in that
//     gap. A first pass put it at 0.6 and caught nothing at all, which is the
//     whole reason the number is written here with its measurement: this net
//     is for the obvious case, and it was not even catching that.
//
// The budget is what does the work. Even with the repeat check calibrated, it
// is the budget that takes six searches down to four.
//
// Neither is an error. A tool that fails invites a retry, and a model told
// "error" here would try the other search tool, or the same one reworded. Both
// verdicts come back as an ordinary result saying what happened and what to do
// instead, which is: answer with what you already have.

export type SearchFamily = "web" | "corpus";

/** Per family, per turn. Four for the web; three for the corpus, one per layer
 *  the prompt asks it to search separately. */
const BUDGET: Record<SearchFamily, number> = { web: 4, corpus: 3 };

/** Above this overlap of content words, two queries are one question asked
 *  twice and the second is answered from the first. Between the reworded pair
 *  of the turn above (0.56) and the closest genuinely different pair (0.42). */
const SAME_QUESTION = 0.55;

/** Words that carry no subject and would make any two French or English
 *  questions look alike. Not a stopword list for retrieval — the query still
 *  goes to the search engine whole — only for comparing one query to another. */
const EMPTY = new Set(
  ("le la les un une des du de d au aux et ou où que qui quoi quel quelle quels quelles " +
    "est ce c'est sont a ai as avons avez ont pour par sur sous dans en y il elle ils " +
    "elles je tu nous vous me te se on ne pas plus moins comme avec sans mon ma mes ton " +
    "ta tes son sa ses notre nos votre vos leur leurs " +
    "the a an of to in on for with and or is are was were what which who how why when " +
    "it its this that these those do does did i you we they my your our their").split(" "),
);

export interface SearchLedger {
  spent: Record<SearchFamily, number>;
  /** One entry per search actually run this turn, newest last. */
  past: { family: SearchFamily; words: Set<string>; query: string }[];
}

export function newSearchLedger(): SearchLedger {
  return { spent: { web: 0, corpus: 0 }, past: [] };
}

/** The content words of a query: lowercased, unaccented, punctuation gone,
 *  and the words that mean nothing on their own dropped. */
function words(query: string): Set<string> {
  const flat = query
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ");
  return new Set(flat.split(" ").filter((w) => w.length > 1 && !EMPTY.has(w)));
}

function overlap(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared += 1;
  return shared / (a.size + b.size - shared);
}

export type SearchVerdict =
  | { run: true }
  | { run: false; text: string };

/**
 * May this turn run this search? Consulted before the call, and only for the
 * two search families — every other tool is unbudgeted.
 */
export function allowSearch(ledger: SearchLedger, family: SearchFamily, query: string): SearchVerdict {
  const asked = words(query);

  const twin = ledger.past.find((p) => p.family === family && overlap(p.words, asked) >= SAME_QUESTION);
  if (twin) {
    return {
      run: false,
      text:
        `You already ran this search on this turn — "${twin.query}" — and its results are above. ` +
        `Rewording it returns the same pages. Answer from what you have, or say what is still missing.`,
    };
  }

  if (ledger.spent[family] >= BUDGET[family]) {
    const where = family === "web" ? "web searches" : "corpus searches";
    return {
      run: false,
      text:
        `No ${where} left on this turn — ${BUDGET[family]} is the budget, and the results of all of them are above. ` +
        `This is not a failure and not worth retrying with another tool: answer now with what you found, ` +
        `and say plainly what you could not establish rather than searching around it.`,
    };
  }

  return { run: true };
}

/** Called once a search has actually run. Kept separate from `allowSearch` so
 *  a refused call never counts against the budget it was refused by. */
export function recordSearch(ledger: SearchLedger, family: SearchFamily, query: string): void {
  ledger.spent[family] += 1;
  ledger.past.push({ family, words: words(query), query });
}
