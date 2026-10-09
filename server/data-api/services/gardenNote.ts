/**
 * A note on the member's side of a fiche, as text: the dated block and where
 * it goes in the body. Pure functions, apart from gardenWrite.ts, so that a
 * writer which is not the shelf's — the Carnet suggestions
 * (src/services/entrySuggestions.ts) — files the same block without loading
 * the shelf and the reading services behind it.
 */

export interface NoteInput {
  text?: string;
  quote?: string;
  /** A page (a book read on paper), or the chapter being read. */
  where?: { page?: string; chapter_title?: string };
}

export const COMMENT_HEADING = "## Commentaire";

/**
 * One dated block, in the two shapes the shelf reads back: `DATE — text` on a
 * line of its own, or `DATE — <where> :` followed by the quote and the text.
 */
export function noteBlock(date: string, input: NoteInput): string {
  // A line of the member's that opens like a heading would close the section.
  const safe = (s: string) => s.trim().replace(/^(#{1,6}\s)/gm, "\\$1");
  const text = safe(input.text ?? "");
  const quote = (input.quote ?? "").trim();
  const page = (input.where?.page ?? "").trim();
  const chapter = (input.where?.chapter_title ?? "").replace(/\s+/g, " ").trim();
  const where = page ? `p. ${page}` : chapter ? `ch. ${chapter}` : "";

  if (!quote && !where && !text.includes("\n")) return `${date} — ${text}`;
  const blocks = [where ? `${date} — ${where} :` : `${date} :`];
  if (quote) blocks.push(quote.split("\n").map((l) => `> ${l}`.trimEnd()).join("\n"));
  if (text) blocks.push(text);
  return blocks.join("\n\n");
}

/**
 * The body with a block added at the end of `## Commentaire` — the end of the
 * section, not of the file: résonances may follow, and a note left under their
 * heading would be read back as one.
 */
export function withNote(body: string, block: string): string {
  const lines = body.replace(/\s+$/, "").split("\n");
  const at = lines.findIndex((l) => l.trim() === COMMENT_HEADING);
  if (at < 0) {
    const head = lines.join("\n").replace(/^\n+/, "");
    return `\n${head ? `${head}\n\n` : ""}${COMMENT_HEADING}\n\n${block}\n`;
  }
  let end = lines.findIndex((l, i) => i > at && /^##\s/.test(l));
  if (end < 0) end = lines.length;
  const before = lines.slice(0, end).join("\n").replace(/\s+$/, "");
  const after = lines.slice(end).join("\n");
  return `\n${before.replace(/^\n+/, "")}\n\n${block}\n${after ? `\n${after}\n` : ""}`;
}
