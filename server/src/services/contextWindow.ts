// Fitting a conversation into the model's context window.
//
// Every provider has a ceiling — 200k for Claude, 1M for GLM-5.3, 128k for
// GPT-4o, 32k for what we ask of Ollama — and a conversation that keeps going
// eventually crosses it, at which point the API refuses the whole turn. Nothing
// used to stand between the full history and that error.
//
// What this does is decide how many of the *oldest* turns to leave out so the
// rest fits, with room for the answer. Two deliberate choices:
//
//   - Estimation, not counting. Providers count differently and only Anthropic
//     exposes a counter; a character-based estimate with a margin is good
//     enough to keep clear of the ceiling, which is all that is needed.
//   - Hysteresis. Dropping just enough to fit would drop again on every turn,
//     and each drop changes the prefix the prompt cache is keyed on. Once over
//     the line we cut back to a fraction of the budget, then leave the window
//     alone until it fills again. The caller persists where the window starts
//     (see claude.ts) so the prefix stays byte-stable in between.

/** Rough tokens-per-character for prose across the household's languages.
 *  French and English both run near 3.5–4 chars per token; 3 is the pessimistic
 *  side of that, which is where an estimate used as a ceiling should sit. */
const CHARS_PER_TOKEN = 3;

/** What one image costs, absent its dimensions. Anthropic bills about
 *  width*height/750; a phone photo downsized to ~1.15 megapixels comes to
 *  ~1,600, which is also the API's cap for a single image. */
const IMAGE_TOKENS = 1600;

/** A PDF page is about 1,500–3,000 tokens (text plus its rendering); with no
 *  page count, the base64 size is the only handle. ~60 KB per page of a typical
 *  text PDF puts one page at ~80k base64 chars. */
const DOCUMENT_TOKENS_PER_CHAR = 2500 / 80_000;

export function estimateText(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Tokens for one message in Anthropic shape (string or block array). Handles
 *  the OpenAI/Ollama shapes too, which only ever carry strings or text parts. */
export function estimateMessage(message: { content: unknown }): number {
  const content = message.content;
  if (typeof content === "string") return estimateText(content) + 4;
  if (!Array.isArray(content)) return 4;
  let n = 4; // per-message framing
  for (const block of content as any[]) {
    switch (block?.type) {
      case "text":
        n += estimateText(String(block.text ?? ""));
        break;
      case "image":
      case "image_url":
        n += IMAGE_TOKENS;
        break;
      case "document":
        n += Math.ceil(String(block.source?.data ?? "").length * DOCUMENT_TOKENS_PER_CHAR);
        break;
      default:
        n += estimateText(JSON.stringify(block));
    }
  }
  return n;
}

export function estimateMessages(messages: { content: unknown }[]): number {
  let n = 0;
  for (const m of messages) n += estimateMessage(m);
  return n;
}

export interface WindowBudget {
  /** The model's context window, in tokens. */
  contextTokens: number;
  /** Tokens the fixed head of the request takes: system prompt + tool roster. */
  headTokens: number;
  /** Tokens to keep free for the reply (`max_tokens`). */
  replyTokens: number;
}

/** The fraction of the budget we cut back to once over it. Low enough that a
 *  drop buys many turns of stability; high enough that the model keeps most of
 *  what it had. */
const CUTBACK = 0.7;
/** Slack on the estimate itself: 10% of the window, never less than 2k. */
function margin(contextTokens: number): number {
  return Math.max(2_000, Math.floor(contextTokens * 0.1));
}

/** How much of the window to hold back for the reply. The household's
 *  `max_tokens` is a ceiling on the answer, not a promise to fill it, and it is
 *  set with the big cloud windows in mind (32k here). Reserving all of it on a
 *  32k Ollama request would leave the history nothing at all — so the reserve
 *  is capped at a quarter of the window. */
export function replyReserve(contextTokens: number, maxTokens: number): number {
  return Math.min(maxTokens, Math.floor(contextTokens / 4));
}

/** Tokens the conversation itself may occupy. Can be ≤ 0 on a small window
 *  with a big head, in which case only the latest turn survives. */
export function historyBudget(b: WindowBudget): number {
  return b.contextTokens - b.headTokens - b.replyTokens - margin(b.contextTokens);
}

/**
 * How many leading messages to drop so the rest fits. `protectedTail` is the
 * number of trailing messages that are never dropped whatever the budget: the
 * turn being answered and anything appended after it (the time reminder).
 *
 * Messages must alternate starting with a user turn on every provider, so the
 * cut always lands on a user message — dropping a user turn drags the
 * assistant reply after it along.
 */
export function planDrop(
  messages: { role: string; content: unknown }[],
  budget: WindowBudget,
  protectedTail = 2,
): number {
  const allowed = historyBudget(budget);
  const sizes = messages.map(estimateMessage);
  let total = sizes.reduce((a, b) => a + b, 0);
  if (total <= allowed) return 0;

  const target = Math.floor(allowed * CUTBACK);
  const maxDrop = Math.max(0, messages.length - protectedTail);
  let drop = 0;
  while (drop < maxDrop && total > target) {
    total -= sizes[drop]!;
    drop++;
  }
  // Land on a user turn: never open the window with the assistant's half of an
  // exchange the user's half of has been dropped.
  while (drop < maxDrop && messages[drop]!.role !== "user") {
    total -= sizes[drop]!;
    drop++;
  }
  return drop;
}
