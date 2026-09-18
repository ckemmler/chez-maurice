/**
 * The reading companion, after the Journey to the West autopsy: a persona
 * with a book loaded took 40–100 seconds a turn, looked the book up again on
 * every message, guessed calibre ids, called chapter 1 "chapter 3", and paid
 * full price for every round because Mistral caches nothing without a key.
 *
 * Pinned here: the front-matter rule that numbers a scholarly edition the
 * way its reader does; the chapter headers a loaded book carries; the tool
 * trail a turn leaves for the next; and the Chat Completions client's cache
 * key, Stop signal and idle watchdog.
 */

import { expect, test } from "bun:test";

const { classifyChapters } = await import("../src/services/composer/calibre");
const { chapterHeaders } = await import("../src/services/composer/specs");
const { toolTrail } = await import("../src/services/claude");
const { openaiTurn } = await import("../src/services/openaiChat");

// ── Numbering ────────────────────────────────────────────────────

const BIG = 40_000;

test("a translator's apparatus is front matter: chapter 1 is chapter 1", () => {
  const types = classifyChapters([
    { name: "preface to the revised edition", size: 9_000 },
    { name: "preface to the first edition", size: 7_000 },
    { name: "abbreviations", size: 7_000 },
    { name: "introduction", size: 267_000 },
    { name: "1. the divine root conceives", size: BIG },
    { name: "2. fully awoke to bodhi's wondrous truths", size: BIG },
    { name: "notes", size: 194_000 },
  ]);
  expect(types).toEqual([
    "front_matter", "front_matter", "front_matter", "front_matter", "body", "body", "back_matter",
  ]);
});

test("a chronology and a note on the text sit ahead of the body too", () => {
  const types = classifyChapters([
    { name: "chronology", size: 5_000 },
    { name: "note on the translation", size: 3_000 },
    { name: "translator's introduction", size: 30_000 },
    { name: "part one", size: BIG },
  ]);
  expect(types).toEqual(["front_matter", "front_matter", "front_matter", "body"]);
});

test("an introduction after the body has begun is not front matter", () => {
  // The rule is a leading run: once the body has started, a chapter that
  // happens to be called "Introduction" is a chapter.
  const types = classifyChapters([
    { name: "chapter one", size: BIG },
    { name: "introduction", size: BIG },
    { name: "chapter two", size: BIG },
  ]);
  expect(types).toEqual(["body", "body", "body"]);
});

test("chapter headers number the body chapters and label the rest", () => {
  const h = chapterHeaders([
    { ref: "0005-Abbreviations", section_type: "front_matter" },
    { ref: "0007-1. The divine root", section_type: "body" },
    { ref: "0008-2. Fully awoke", section_type: "body" },
    { ref: "0032-Notes", section_type: "back_matter" },
  ]);
  // Titles keep the book's own case: the classifier's lowercased name is
  // for matching, not for reading.
  expect(h.get("0005-Abbreviations")).toBe("## Front matter: Abbreviations");
  expect(h.get("0007-1. The divine root")).toBe("## Chapter 1: 1. The divine root");
  expect(h.get("0008-2. Fully awoke")).toBe("## Chapter 2: 2. Fully awoke");
  expect(h.get("0032-Notes")).toBe("## Back matter: Notes");
});

// ── Tool trail ───────────────────────────────────────────────────

test("an assistant turn carries its tool results forward, compacted", () => {
  const trail = toolTrail({
    role: "assistant",
    data: [
      { tool: "calibre__list_books", data: { id: 190, title: "The Journey to the West" } },
      { tool: "calibre__get_reading_progress", data: { book_id: 190, chapter: 1, chapters_total: 25 } },
    ],
  });
  expect(trail).toContain("[Tool results from this turn");
  expect(trail).toContain('calibre__list_books → {"id":190,"title":"The Journey to the West"}');
  expect(trail).toContain('calibre__get_reading_progress → {"book_id":190,"chapter":1,"chapters_total":25}');
});

test("the trail is bounded: long results are cut, long lists are counted", () => {
  const trail = toolTrail({
    role: "assistant",
    data: [
      { tool: "calibre__list_chapters", data: Array.from({ length: 30 }, (_, i) => ({ index: i, name: "x".repeat(50) })) },
      { tool: "garden__list_notes", data: { body: "y".repeat(1000) } },
    ],
  });
  expect(trail).toContain("…+27]");
  expect(trail.length).toBeLessThan(700);
});

test("user turns and turns without tools leave no trail", () => {
  expect(toolTrail({ role: "user", data: [{ tool: "x", data: 1 }] })).toBe("");
  expect(toolTrail({ role: "assistant", data: null })).toBe("");
  expect(toolTrail({ role: "assistant", data: [] })).toBe("");
});

// ── Chat Completions client ──────────────────────────────────────

function sseResponse(lines: string[]): Response {
  return new Response(lines.join("\n\n") + "\n\n", {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

test("the cache key rides along as prompt_cache_key, and only when given", async () => {
  const realFetch = globalThis.fetch;
  const bodies: any[] = [];
  globalThis.fetch = (async (_url: any, init: any) => {
    bodies.push(JSON.parse(init.body));
    return sseResponse([`data: {"choices":[{"delta":{"content":"ok"}}]}`, `data: [DONE]`]);
  }) as any;
  try {
    for await (const _ of openaiTurn("https://example.invalid/v1", "k", "m", [], [], undefined, { cacheKey: "convo-1" })) {}
    for await (const _ of openaiTurn("https://example.invalid/v1", "k", "m", [], [], undefined)) {}
    expect(bodies[0].prompt_cache_key).toBe("convo-1");
    expect("prompt_cache_key" in bodies[1]).toBe(false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a round that goes silent is given up, with a message that says so", async () => {
  const realFetch = globalThis.fetch;
  // A body that never sends a byte, and closes only when aborted.
  globalThis.fetch = (async (_url: any, init: any) => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        init.signal.addEventListener("abort", () => { try { controller.error(new Error("aborted")); } catch {} });
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as any;
  try {
    const events: any[] = [];
    for await (const ev of openaiTurn("https://example.invalid/v1", "k", "m", [], [], undefined, { idleTimeoutMs: 50 })) events.push(ev);
    expect(events.length).toBe(1);
    expect(events[0].type).toBe("error");
    expect(events[0].message).toMatch(/silent|no answer/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the member's Stop aborts the provider call and yields nothing more", async () => {
  const realFetch = globalThis.fetch;
  let sawAbort = false;
  globalThis.fetch = (async (_url: any, init: any) => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: {"choices":[{"delta":{"content":"hel"}}]}\n\n`));
        init.signal.addEventListener("abort", () => { sawAbort = true; try { controller.error(new Error("aborted")); } catch {} });
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as any;
  try {
    const stop = new AbortController();
    const events: any[] = [];
    for await (const ev of openaiTurn("https://example.invalid/v1", "k", "m", [], [], undefined, { signal: stop.signal })) {
      events.push(ev);
      if (ev.type === "text") stop.abort();
    }
    expect(sawAbort).toBe(true);
    expect(events.map((e) => e.type)).toEqual(["text"]); // no error, no turn_end
  } finally {
    globalThis.fetch = realFetch;
  }
});
