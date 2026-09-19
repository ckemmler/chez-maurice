/**
 * In-flight turns, by conversation.
 *
 * A turn belongs to the conversation, not to the HTTP request that started
 * it. iOS suspends the app when the screen locks and the streaming request
 * dies with it; the reply still lands in the database, but the app came back
 * to a broken stream and an error. So the route records every event it
 * sends here, and a client that lost its stream re-attaches through
 * GET /:id/turn: it gets a snapshot of what it missed, then the rest live.
 * Stopping is explicit (POST /:id/turn/stop) rather than a hang-up.
 *
 * In memory only, one turn per conversation at a time; a finished turn stays
 * for 60 s so a late re-attach still finds its terminal event.
 */
import type { TurnUsage } from "./pricing";

export interface TurnEvent {
  type:
    | "text_delta"
    | "thinking"
    | "tool_call"
    | "tool_data"
    | "image_loading"
    | "image"
    | "usage"
    | "done"
    | "error";
  text?: string;
  message_id?: string;
  message?: string;
  tool?: string;
  status?: "start" | "end";
  data?: unknown;
  usage?: TurnUsage;
  image_url?: string;
}

export interface TurnSnapshot {
  started_at: string;
  /** Every text_delta so far, in order — what a client has received. */
  text: string;
  data: { tool: string; data: unknown }[];
  /** The tool running right now, null between tools. */
  tool: string | null;
  usage: TurnUsage | null;
  finished: boolean;
  /** `done` (with its message id) or `error`, once recorded. */
  terminal: TurnEvent | null;
}

export interface Turn {
  conversationId: string;
  mauriceId: string | null;
  startedBy: string;
  startedAt: Date;
  controller: AbortController;
  snapshot: TurnSnapshot;
}

interface Subscriber {
  queue: TurnEvent[];
  wake: (() => void) | null;
  closed: boolean;
}

interface Record {
  turn: Turn;
  subscribers: Set<Subscriber>;
  expiry: ReturnType<typeof setTimeout> | null;
}

/** How long a finished turn stays reachable after its end. */
export const FINISHED_TURN_TTL_MS = 60_000;

const records = new Map<string, Record>();

export function beginTurn(
  conversationId: string,
  opts: { mauriceId: string | null; startedBy: string },
): Turn | null {
  const existing = records.get(conversationId);
  if (existing) {
    if (!existing.turn.snapshot.finished) return null;
    // A finished turn still within its window: the new one replaces it.
    forget(conversationId);
  }
  const startedAt = new Date();
  const turn: Turn = {
    conversationId,
    mauriceId: opts.mauriceId,
    startedBy: opts.startedBy,
    startedAt,
    controller: new AbortController(),
    snapshot: {
      started_at: startedAt.toISOString(),
      text: "",
      data: [],
      tool: null,
      usage: null,
      finished: false,
      terminal: null,
    },
  };
  records.set(conversationId, { turn, subscribers: new Set(), expiry: null });
  return turn;
}

/** Fold the event into the snapshot and hand it to every live subscriber. */
export function recordEvent(conversationId: string, event: TurnEvent): void {
  const rec = records.get(conversationId);
  if (!rec || rec.turn.snapshot.finished) return;
  const s = rec.turn.snapshot;
  switch (event.type) {
    case "text_delta":
      if (event.text) s.text += event.text;
      break;
    case "tool_call":
      s.tool = event.status === "start" ? (event.tool ?? "tool") : null;
      break;
    case "tool_data":
      if (event.data != null) s.data.push({ tool: event.tool ?? "tool", data: event.data });
      break;
    case "usage":
      if (event.usage) s.usage = event.usage;
      break;
    case "done":
    case "error":
      s.terminal = event;
      break;
  }
  for (const sub of rec.subscribers) push(sub, event);
  // `done` is the last thing a turn says; a provider `error` may not be (the
  // route persists what streamed and can still say `done`), so only `done`
  // ends the subscribers here — endTurn ends the rest.
  if (event.type === "done") closeSubscribers(rec);
}

/** The turn is over: keep its record for a while, then forget it. */
export function endTurn(conversationId: string): void {
  const rec = records.get(conversationId);
  if (!rec || rec.turn.snapshot.finished) return;
  rec.turn.snapshot.finished = true;
  closeSubscribers(rec);
  rec.expiry = setTimeout(() => forget(conversationId), FINISHED_TURN_TTL_MS);
  rec.expiry.unref?.();
}

/**
 * Attach to the conversation's turn: what has happened so far, and an
 * iterable of what happens next, ending after the terminal event. A finished
 * turn yields its terminal event only. Null when nothing is known.
 */
export function subscribe(
  conversationId: string,
): { snapshot: TurnSnapshot; events: AsyncIterable<TurnEvent> } | null {
  const rec = records.get(conversationId);
  if (!rec) return null;
  const snapshot: TurnSnapshot = {
    ...rec.turn.snapshot,
    data: [...rec.turn.snapshot.data],
  };
  const sub: Subscriber = { queue: [], wake: null, closed: false };
  if (snapshot.finished) {
    if (snapshot.terminal) sub.queue.push(snapshot.terminal);
    sub.closed = true;
  } else {
    rec.subscribers.add(sub);
  }
  return { snapshot, events: drain(rec, sub) };
}

/** Abort the running turn. False when nothing is running. */
export function stopTurn(conversationId: string): boolean {
  const rec = records.get(conversationId);
  if (!rec || rec.turn.snapshot.finished) return false;
  rec.turn.controller.abort();
  return true;
}

/** The turn known for this conversation, running or recently finished. */
export function currentTurn(conversationId: string): Turn | null {
  return records.get(conversationId)?.turn ?? null;
}

/** Test hook: drop every record, timers included. */
export function _resetTurns(): void {
  for (const id of [...records.keys()]) forget(id);
}

function forget(conversationId: string): void {
  const rec = records.get(conversationId);
  if (!rec) return;
  if (rec.expiry) clearTimeout(rec.expiry);
  closeSubscribers(rec);
  records.delete(conversationId);
}

function push(sub: Subscriber, event: TurnEvent): void {
  if (sub.closed) return;
  sub.queue.push(event);
  sub.wake?.();
}

function closeSubscribers(rec: Record): void {
  for (const sub of rec.subscribers) {
    sub.closed = true;
    sub.wake?.();
  }
  rec.subscribers.clear();
}

async function* drain(rec: Record, sub: Subscriber): AsyncGenerator<TurnEvent> {
  try {
    for (;;) {
      if (sub.queue.length) {
        yield sub.queue.shift()!;
        continue;
      }
      if (sub.closed) return;
      await new Promise<void>((resolve) => {
        sub.wake = () => {
          sub.wake = null;
          resolve();
        };
      });
    }
  } finally {
    // The reader went away (its own request died): stop queueing for it.
    sub.closed = true;
    rec.subscribers.delete(sub);
  }
}
