/**
 * The turn registry: a reply belongs to its conversation, not to the request
 * that started it. What a subscriber sees must equal what the original
 * stream sent — the snapshot for the past, the events for the rest.
 */
import { afterEach, expect, test } from "bun:test";

const {
  beginTurn,
  recordEvent,
  endTurn,
  subscribe,
  stopTurn,
  currentTurn,
  _resetTurns,
} = await import("../src/services/turns");

afterEach(() => _resetTurns());

const C = "turn-convo";
const start = () => beginTurn(C, { mauriceId: null, startedBy: "m" })!;

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const e of it) out.push(e);
  return out;
}

test("the snapshot mid-stream is the text so far, the tool at hand and the data", () => {
  start();
  recordEvent(C, { type: "text_delta", text: "Bon" });
  recordEvent(C, { type: "tool_call", tool: "garden_search", status: "start" });
  recordEvent(C, { type: "text_delta", text: "jour" });
  const mid = subscribe(C)!;
  expect(mid.snapshot.text).toBe("Bonjour");
  expect(mid.snapshot.tool).toBe("garden_search");
  expect(mid.snapshot.finished).toBe(false);
  expect(mid.snapshot.terminal).toBeNull();

  recordEvent(C, { type: "tool_data", tool: "garden_search", data: { hits: 2 } });
  recordEvent(C, { type: "tool_call", tool: "garden_search", status: "end" });
  recordEvent(C, { type: "usage", usage: { provider: "x", model: "y", rounds: 1 } as any });
  const later = subscribe(C)!;
  expect(later.snapshot.tool).toBeNull();
  expect(later.snapshot.data).toEqual([{ tool: "garden_search", data: { hits: 2 } }]);
  expect(later.snapshot.usage).toMatchObject({ provider: "x" });
  // The snapshot is a copy: later data does not leak into an older one.
  expect(mid.snapshot.data).toEqual([]);
});

test("a subscriber joining mid-stream gets only what comes after, up to done", async () => {
  start();
  recordEvent(C, { type: "text_delta", text: "before " });
  const sub = subscribe(C)!;
  const pending = collect(sub.events);
  recordEvent(C, { type: "text_delta", text: "after" });
  recordEvent(C, { type: "done", message_id: "msg-1" });
  endTurn(C);
  const events = await pending;
  expect(events).toEqual([
    { type: "text_delta", text: "after" },
    { type: "done", message_id: "msg-1" },
  ]);
  expect(sub.snapshot.text).toBe("before ");
});

test("a subscriber joining after done, within the window, gets the snapshot and the terminal event", async () => {
  start();
  recordEvent(C, { type: "text_delta", text: "all of it" });
  recordEvent(C, { type: "done", message_id: "msg-2" });
  endTurn(C);
  const late = subscribe(C)!;
  expect(late.snapshot.finished).toBe(true);
  expect(late.snapshot.text).toBe("all of it");
  expect(await collect(late.events)).toEqual([{ type: "done", message_id: "msg-2" }]);
  // An error is a terminal event too.
  _resetTurns();
  start();
  recordEvent(C, { type: "error", message: "boom" });
  endTurn(C);
  expect(await collect(subscribe(C)!.events)).toEqual([{ type: "error", message: "boom" }]);
});

test("nothing is recorded on a finished turn, and after the window nothing remains", async () => {
  start();
  recordEvent(C, { type: "done", message_id: "msg-3" });
  endTurn(C);
  recordEvent(C, { type: "text_delta", text: "too late" });
  expect(subscribe(C)!.snapshot.text).toBe("");
  // The window is a timer; wind it down by hand rather than waiting 60 s.
  const { FINISHED_TURN_TTL_MS } = await import("../src/services/turns");
  expect(FINISHED_TURN_TTL_MS).toBe(60_000);
  _resetTurns();
  expect(subscribe(C)).toBeNull();
  expect(currentTurn(C)).toBeNull();
});

test("stop aborts the controller; nothing to stop is false", () => {
  expect(stopTurn(C)).toBe(false);
  const turn = start();
  expect(turn.controller.signal.aborted).toBe(false);
  expect(stopTurn(C)).toBe(true);
  expect(turn.controller.signal.aborted).toBe(true);
  endTurn(C);
  expect(stopTurn(C)).toBe(false);
});

test("one turn per conversation: a second beginTurn is refused until the first ends", () => {
  const first = start();
  expect(beginTurn(C, { mauriceId: null, startedBy: "n" })).toBeNull();
  expect(currentTurn(C)).toBe(first);
  recordEvent(C, { type: "done", message_id: "msg-4" });
  endTurn(C);
  // A finished turn within its window gives way to a new one.
  const second = start();
  expect(second).not.toBe(first);
  expect(second.snapshot.text).toBe("");
  expect(subscribe(C)!.snapshot.finished).toBe(false);
});

test("a reader that walks away is dropped, and the turn goes on", async () => {
  start();
  const sub = subscribe(C)!;
  const it = sub.events[Symbol.asyncIterator]();
  recordEvent(C, { type: "text_delta", text: "a" });
  expect((await it.next()).value).toEqual({ type: "text_delta", text: "a" });
  await it.return?.(undefined);
  recordEvent(C, { type: "text_delta", text: "b" });
  expect(subscribe(C)!.snapshot.text).toBe("ab");
  endTurn(C);
});
