// Narrowing a corpus search before the model reads it (20 September 2026).
//
// The numbers this exists for, measured on one real turn: a single search came
// to 3 233 tokens, of which 1 766 were bookkeeping; six of its ten hits were
// another passage of a document already in the list; and the two best hits of
// a search about the Galápagos were the very conversation asking the question.

import { describe, expect, test } from "bun:test";

const { narrowCorpusResults } = await import("../src/services/corpusResults");

function hit(extra: Record<string, unknown> = {}) {
  return {
    chunk_id: "c1",
    file_path: "/gardens/anna/notes/fr/chine.md",
    file_hash: "deadbeef".repeat(8),
    chunk_index: 0,
    total_chunks: 4,
    indexed_at: "2026-09-19T12:58:14.644216",
    embedding_model: "qwen3-embedding:0.6b",
    member_id: "anna",
    source: "garden-notes",
    source_type: "note",
    title: "Chine 2026",
    date: "2026-05-02",
    text: "Un itinéraire   en famille avec les enfants, trois semaines.",
    score: 0.61,
    ...extra,
  };
}

const parse = (t: string) => JSON.parse(t);

describe("what reaches the model", () => {
  test("only the fields a reader can act on", () => {
    const n = narrowCorpusResults({ results: [hit({ author: "Candide" })] }, "raw");
    const [row] = parse(n.text).results;
    expect(row).toEqual({
      source: "Chine 2026",
      kind: "note",
      when: "2026-05-02",
      who: "Candide",
      passage: "Un itinéraire en famille avec les enfants, trois semaines.",
      score: 0.61,
    });
    // Everything the index needs and a reader does not is gone.
    expect(n.text).not.toContain("deadbeef");
    expect(n.text).not.toContain("qwen3-embedding");
    expect(n.text).not.toContain("indexed_at");
    expect(n.text).not.toContain("member_id");
  });

  test("a passage is cut, not carried whole", () => {
    const long = "phrase. ".repeat(400);
    const [row] = parse(narrowCorpusResults({ results: [hit({ text: long })] }, "raw").text).results;
    expect((row.passage as string).length).toBeLessThan(760);
    expect(row.passage).toEndWith("…");
  });
});

describe("what is dropped", () => {
  test("the turn's own conversation, which the model is already holding", () => {
    const n = narrowCorpusResults(
      {
        results: [
          hit({ conversation_id: "here", file_path: "", source_type: "conversation", conversation_title: "Galápagos", score: 0.46 }),
          hit({ conversation_id: "elsewhere", file_path: "", source_type: "conversation", conversation_title: "Malgas", score: 0.44 }),
        ],
      },
      "raw",
      { conversationId: "here" },
    );
    const rows = parse(n.text).results;
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("Malgas");
  });

  test("passages of a document already listed", () => {
    const chunks = [0, 1, 2, 3].map((i) => hit({ chunk_id: `c${i}`, chunk_index: i, score: 0.61 - i / 100, text: `passage ${i}` }));
    const other = hit({ file_path: "/gardens/anna/notes/fr/autre.md", title: "Autre", score: 0.5 });
    const n = narrowCorpusResults({ results: [...chunks, other] }, "raw");
    const rows = parse(n.text).results;
    expect(rows).toHaveLength(2);
    expect(rows[0].passage).toBe("passage 0"); // the best of the four
    expect(rows[1].source).toBe("Autre");
  });

  test("hits too weak to be an answer, and hits far below the best one", () => {
    const rows = parse(
      narrowCorpusResults(
        {
          results: [
            hit({ chunk_id: "a", file_path: "/a", title: "Fort", score: 0.62 }),
            hit({ chunk_id: "b", file_path: "/b", title: "Proche", score: 0.55 }),
            hit({ chunk_id: "c", file_path: "/c", title: "Loin", score: 0.44 }), // > floor, but far below the best
            hit({ chunk_id: "d", file_path: "/d", title: "Bruit", score: 0.31 }), // below the floor
          ],
        },
        "raw",
      ).text,
    ).results;
    expect(rows.map((r: any) => r.source)).toEqual(["Fort", "Proche"]);
  });

  test("a search that found only weak things keeps its best, and says so", () => {
    // What "Galápagos" did: nothing in the corpus answers it, and ten hits
    // came back anyway, the last of them about Claude model ids.
    const n = narrowCorpusResults(
      {
        results: [
          hit({ chunk_id: "a", file_path: "/a", title: "Malgas", score: 0.33 }),
          hit({ chunk_id: "b", file_path: "/b", title: "EU LLM Providers", score: 0.32 }),
          hit({ chunk_id: "c", file_path: "/c", title: "Claude model ids", score: 0.31 }),
        ],
      },
      "raw",
    );
    const rows = parse(n.text).results;
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("Malgas");
  });

  test("five sources at most, and it says how many more there were", () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      hit({ chunk_id: `k${i}`, file_path: `/f${i}`, title: `Doc ${i}`, score: 0.62 - i / 1000 }));
    const n = narrowCorpusResults({ results: many }, "raw");
    const out = parse(n.text);
    expect(out.results).toHaveLength(5);
    expect(out.more_found).toBe(4);
    expect(n.total).toBe(9);
    expect(n.rows).toHaveLength(5); // and the cards show the same five
  });
});

test("an unrecognised payload is handed back as it came", () => {
  expect(narrowCorpusResults({ rows: [] }, "the raw text").text).toBe("the raw text");
  expect(narrowCorpusResults(null, "the raw text").text).toBe("the raw text");
});

test("an empty result set says so rather than saying nothing", () => {
  const out = JSON.parse(narrowCorpusResults({ results: [] }, "raw").text);
  expect(out.results).toEqual([]);
  expect(out.note).toContain("nothing in the corpus");
});
