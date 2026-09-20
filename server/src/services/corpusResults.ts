// ── What comes back from a corpus search, narrowed ──────────────────────────
//
// A search used to hand the model its raw answer: ten hits, every field the
// index carries, whatever the scores. Measured on one real turn, that was
// 3 233 tokens for a single search — 1 468 of passage and 1 766 of bookkeeping
// — and three searches in one turn came to some 15 500 tokens against an
// 5 655-token prompt. The model was spending four fifths of its reading on
// what it had gone to fetch, much of it the same document four times over.
//
// Four cuts, in this order, each one measured rather than guessed:
//
//   1. the turn's own conversation is dropped. It came back as its own top two
//      hits, and the model already has every word of it;
//   2. hits are grouped by the thing they come from, best passage kept. Six of
//      ten hits were another passage of a document already in the list;
//   3. what is left is held to a floor, and to a distance from the best score.
//      There is no threshold in the corpus itself: ask it about the Galápagos
//      and it answers with the ten least distant things it has, which on that
//      turn ended at "Claude model ID format for opus";
//   4. the fields the model cannot use — the file hash, the chunk id, the
//      member id, the indexing date, the embedding model — are dropped.
//
// The raw rows are kept for the source cards, which need the cover paths and
// the identifiers: the client's view of a search and the model's are narrowed
// differently, and that is on purpose.

/** Below this, a hit is not an answer but the least distant thing in an index
 *  that does not hold the question. */
const SCORE_FLOOR = 0.35;

/** And no further than this below the best hit: a search that found something
 *  good should not also carry what it merely brushed against. */
const SCORE_SPREAD = 0.15;

/** How many sources a search hands the model, once they are distinct. Ten is a
 *  search engine's number; a conversation needs the few that answer. */
const MAX_HITS = 5;

/** How much of a passage travels. Long enough to be quoted from, short enough
 *  that five of them are not a chapter. */
const PASSAGE_CHARS = 700;

export interface NarrowOptions {
  /** The conversation taking the turn, whose own passages are dropped. */
  conversationId?: string;
  maxHits?: number;
}

export interface NarrowedCorpus {
  /** What the model reads: the JSON it is handed in the tool result. */
  text: string;
  /** The hits that survived, raw, for the source cards. */
  rows: any[];
  /** How many distinct sources matched before the cap. */
  total: number;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");

function first(row: any, keys: string[]): string {
  for (const k of keys) {
    const v = str(row?.[k]);
    if (v) return v;
  }
  return "";
}

/** What a hit is a passage *of*: a conversation has no file, a file has no
 *  conversation id, and a hit with neither stands alone. */
function sourceKey(row: any): string {
  return str(row?.conversation_id) || str(row?.file_path) || str(row?.chunk_id);
}

/** The row as the model should read it: what it came from, when, who, and the
 *  passage. Nothing it cannot act on. */
function forModel(row: any): Record<string, unknown> {
  const kind = str(row?.source_type) || "note";
  // A conversation is named by its own title even when the row also carries a
  // `title` from somewhere else: what the passage is *of* is the thread.
  const names = kind === "conversation"
    ? ["conversation_title", "title", "book_title"]
    : ["title", "book_title", "conversation_title"];
  const out: Record<string, unknown> = {
    source: first(row, names) || "(sans titre)",
    kind,
  };
  const when = first(row, ["date", "year", "published_at", "date_read"]).slice(0, 10);
  if (when) out.when = when;
  const who = first(row, ["author", "publication", "host", "director"]);
  if (who) out.who = who;
  const text = str(row?.text).replace(/\s+/g, " ");
  out.passage = text.length > PASSAGE_CHARS ? text.slice(0, PASSAGE_CHARS).trimEnd() + "…" : text;
  if (typeof row?.score === "number") out.score = Math.round(row.score * 100) / 100;
  return out;
}

/**
 * Narrow a `corpus__search` payload. Returns the raw payload's own text when
 * the shape is not the one we know: a changed tool should degrade to what it
 * said, never to a wrong summary of it.
 */
export function narrowCorpusResults(data: unknown, raw: string, opts: NarrowOptions = {}): NarrowedCorpus {
  const all = (data as any)?.results;
  if (!Array.isArray(all)) return { text: raw, rows: [], total: 0 };

  const own = opts.conversationId ?? "";
  const kept = new Map<string, any>();
  for (const row of all) {
    // 1. Not this conversation: the model is already holding it.
    if (own && str(row?.conversation_id) === own) continue;
    // 2. One entry per source, and the corpus sorts by score, so the first
    //    passage of a source is its best.
    const key = sourceKey(row);
    if (key && kept.has(key)) continue;
    kept.set(key || `#${kept.size}`, row);
  }

  // 3. A floor, and a distance from the best.
  let rows = [...kept.values()];
  const best = rows.reduce((m, r) => Math.max(m, Number(r?.score ?? 0)), 0);
  const cut = Math.max(SCORE_FLOOR, best - SCORE_SPREAD);
  const strong = rows.filter((r) => Number(r?.score ?? 0) >= cut);
  // Unless that leaves nothing: a search whose every hit is weak should say so
  // with its best hit rather than with an empty list the model cannot read.
  rows = strong.length ? strong : rows.slice(0, 1);

  const total = rows.length;
  rows = rows.slice(0, opts.maxHits ?? MAX_HITS);

  // 4. And only the fields that mean something to a reader.
  const payload = {
    results: rows.map(forModel),
    ...(total > rows.length ? { more_found: total - rows.length } : {}),
    ...(rows.length === 0 ? { note: "nothing in the corpus answers this" } : {}),
  };
  return { text: JSON.stringify(payload), rows, total };
}
