// Room broadcast bus.
//
// Decouples request handlers from the Bun.serve WebSocket server: index.ts
// registers a publisher (server.publish) once the socket server exists, and
// route/service code calls publishToRoom() without importing the server (which
// would be circular). Each room is a pub/sub topic; participants' sockets
// subscribe to it, so an authored message or Maurice's reply fans out live.

type Publisher = (topic: string, data: string) => void;

let publisher: Publisher | null = null;

export function setRoomPublisher(p: Publisher): void {
  publisher = p;
}

export function roomTopic(conversationId: string): string {
  return `room:${conversationId}`;
}

/** Per-user channel — a member's global socket subscribes to this regardless of
 *  which room is open, so they learn about new conversations + activity. */
export function userTopic(userId: string): string {
  return `user:${userId}`;
}

/** Fan an event out to every socket subscribed to this room. No-op until the
 *  WebSocket server has registered its publisher. */
export function publishToRoom(conversationId: string, event: unknown): void {
  if (!publisher) return;
  publisher(roomTopic(conversationId), JSON.stringify(event));
}

/** Send an event to a specific user's global socket(s). */
export function publishToUser(userId: string, event: unknown): void {
  if (!publisher) return;
  publisher(userTopic(userId), JSON.stringify(event));
}

// Whether a user currently has a live socket — drives "push only when offline".
let subscriberCount: ((topic: string) => number) | null = null;
export function setSubscriberCount(fn: (topic: string) => number): void {
  subscriberCount = fn;
}
export function userHasSocket(userId: string): boolean {
  return subscriberCount ? subscriberCount(userTopic(userId)) > 0 : false;
}
