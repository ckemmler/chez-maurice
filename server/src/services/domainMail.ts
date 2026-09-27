import fs from "node:fs";
import path from "node:path";
import db from "../db";
import { gardenFor } from "../../data-api/services/gardenFiche";
import { corpusCall } from "./mcpClient";

// The mail as a source of domains (27 September 2026).
//
// The mail import writes one digest per thread in the member's garden
// (services/mailDocuments.ts): a note under "My mail", `meta.origin: mail`,
// `meta.kind: thread`, whose timeline lines carry the dates of the exchange.
// Those digests are what the night's mapping reads of the mail — not the
// messages, which stay sealed in the mail store, and not the fiches of
// people, which are people rather than parts of a life.
//
// Three things live here: reading the digests off the garden (title, what the
// thread is about, the real dates — the note's own `date` is the day it was
// written), the corpus's grouping of them (`corpus__map_notes`, the digests
// among themselves: on the owner's store a digest's nearest neighbour was
// another digest at 0.76 and a conversation at 0.65, so a common k-means
// would sort by style before subject), and the digests a domain reads
// (`domain_mail`): those of the proposal it was adopted from, and those the
// mapping later found to be about it.

export interface MailThread {
  /** Garden-relative: `notes/<locale>/<slug>.md`. What proposals and domains keep. */
  path: string;
  /** Absolute, as the corpus indexes it. */
  file: string;
  title: string;
  /** The first section, the citations stripped. */
  about: string;
  /** The days of the timeline, sorted. */
  dates: string[];
}

const ORIGIN_MAIL = /^\s+origin:\s*mail\s*$/m;
const KIND_THREAD = /^\s+kind:\s*thread\s*$/m;
const DATE_LINE = /^- (\d{4}-\d{2}-\d{2}) —/gm;
/** A pointer to a message: `[30 mai 2024, …](maurice-mail:fp:…)`, with the
 *  dash or semicolon that introduced it. */
const CITATION = /\s*[—;]?\s*\[[^\]]*\]\(maurice-mail:[^)]*\)/g;

function unquote(v: string): string {
  const t = v.trim();
  if (t.startsWith('"')) {
    try {
      return JSON.parse(t);
    } catch {
      return t.slice(1, -1);
    }
  }
  if (t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
  return t;
}

/** The body's `## ` sections, in order, headings dropped. */
function sections(body: string): string[] {
  return body
    .split(/^## .*$/m)
    .slice(1)
    .map((s) => s.trim());
}

export function stripCitations(text: string): string {
  return text.replace(CITATION, "").replace(/[ \t]+$/gm, "").trim();
}

/** One digest from its file's text, or null when it is not a thread digest. */
export function parseThread(text: string, rel: string, file: string): MailThread | null {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return null;
  const [, fm, body] = m;
  if (!ORIGIN_MAIL.test(fm!) || !KIND_THREAD.test(fm!)) return null;
  const titleLine = fm!.match(/^title:\s*(.*)$/m);
  const title = titleLine ? unquote(titleLine[1]!) : path.basename(rel, ".md");
  const secs = sections(body!);
  const about = stripCitations(secs[0] ?? "").replace(/\s+/g, " ");
  const dates = [...new Set([...body!.matchAll(DATE_LINE)].map((d) => d[1]!))].sort();
  return { path: rel, file, title, about, dates };
}

/** Every thread digest in the member's garden that has dated lines. */
export function listMailThreads(memberId: string): MailThread[] {
  const garden = gardenFor(memberId);
  if (!garden) return [];
  const notes = path.join(garden.root, "notes");
  let locales: string[] = [];
  try {
    locales = fs.readdirSync(notes, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  const out: MailThread[] = [];
  for (const locale of locales) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(path.join(notes, locale)).filter((n) => n.endsWith(".md"));
    } catch {
      continue;
    }
    for (const n of names) {
      const file = path.join(notes, locale, n);
      let text: string;
      try {
        text = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      if (!text.includes("origin: mail")) continue;
      const t = parseThread(text, `notes/${locale}/${n}`, file);
      if (t && t.dates.length) out.push(t);
    }
  }
  return out;
}

/** One digest by its garden path, or null (moved, thrown away, not a digest). */
export function readMailThread(memberId: string, rel: string): MailThread | null {
  const garden = gardenFor(memberId);
  if (!garden || rel.includes("..")) return null;
  const file = path.join(garden.root, rel);
  try {
    return parseThread(fs.readFileSync(file, "utf8"), rel, file);
  } catch {
    return null;
  }
}

/** The corpus's grouping of some digests, their paths made garden-relative. */
export async function mapMailThreads(memberId: string, threads: MailThread[]): Promise<{ notes: number; groups: Array<{ conversation_ids: string[]; size: number; cohesion: number; depth: number; parent_size: number | null }> }> {
  const byFile = new Map(threads.map((t) => [t.file, t.path]));
  const r = await corpusCall(memberId, "map_notes", { origin: "mail", kind: "thread", paths: threads.map((t) => t.file) });
  if (r?.error || r?.raw) throw new Error(String(r.error ?? r.raw));
  const groups = ((r?.groups ?? []) as Array<{ note_paths: string[]; size: number; cohesion: number; depth: number; parent_size: number | null }>).map((g) => {
    const ids = g.note_paths.map((f) => byFile.get(f)).filter((p): p is string => !!p);
    return { conversation_ids: ids, size: ids.length, cohesion: g.cohesion, depth: g.depth, parent_size: g.parent_size };
  });
  return { notes: Number(r?.notes ?? 0), groups };
}

// ── What a domain reads ──────────────────────────────────────────────────────

/** Record digests as a domain's; the ones it already has are left alone. */
export function attachMail(domainId: string, memberId: string, paths: string[]): number {
  let n = 0;
  for (const p of new Set(paths)) {
    const r = db.run(`INSERT OR IGNORE INTO domain_mail (maurice_id, member_id, path) VALUES (?, ?, ?)`, [domainId, memberId, p]);
    n += Number(r.changes ?? 0);
  }
  return n;
}

/** Every digest attached to some domain of the member's. */
export function mailOfDomains(memberId: string): Set<string> {
  const rows = db.query(`SELECT path FROM domain_mail WHERE member_id = ?`).all(memberId) as Array<{ path: string }>;
  return new Set(rows.map((r) => r.path));
}

/** A domain's digests, those attached after `after` when given (the brief
 *  reads each once), oldest first. */
export function domainMail(domainId: string, memberId: string, after: string | null = null): Array<{ path: string; added_at: string }> {
  return (
    after
      ? db.query(`SELECT path, added_at FROM domain_mail WHERE maurice_id = ? AND member_id = ? AND added_at > ? ORDER BY added_at, path`).all(domainId, memberId, after)
      : db.query(`SELECT path, added_at FROM domain_mail WHERE maurice_id = ? AND member_id = ? ORDER BY added_at, path`).all(domainId, memberId)
  ) as Array<{ path: string; added_at: string }>;
}

/** What the brief carries of a digest: its title and span, then its sections
 *  but the last (where it comes from), the pointers stripped. */
export function mailExcerpt(memberId: string, rel: string, chars = 1500): string | null {
  const garden = gardenFor(memberId);
  if (!garden || rel.includes("..")) return null;
  let text: string;
  try {
    text = fs.readFileSync(path.join(garden.root, rel), "utf8");
  } catch {
    return null;
  }
  const t = parseThread(text, rel, path.join(garden.root, rel));
  if (!t) return null;
  const body = text.replace(/^---\n[\s\S]*?\n---\n?/, "");
  const parts = body.split(/^(?=## )/m).filter((s) => s.startsWith("## "));
  const kept = stripCitations(parts.slice(0, Math.max(1, parts.length - 1)).join("\n\n")).replace(/\n{3,}/g, "\n\n");
  const span = t.dates.length ? `${t.dates[0]} → ${t.dates[t.dates.length - 1]}` : "";
  const head = `— Mail thread "${t.title}"${span ? ` (${span})` : ""}`;
  const room = Math.max(200, chars - head.length);
  return `${head}\n${kept.length > room ? kept.slice(0, room - 1).trimEnd() + "…" : kept}`;
}
