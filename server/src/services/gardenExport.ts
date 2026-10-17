/**
 * The night's export: what a member has outside their garden, written into
 * it as text (17 October 2026), so that a clone of the garden (routes/git.ts)
 * is a vault and a backup at once.
 *
 *   _maurice/README.md                      what this folder is
 *   _maurice/highlights/books/<slug>.md     a book's highlights, linked to its entry
 *   _maurice/highlights/articles/<slug>.md  an article's highlights, likewise
 *   _maurice/reading/progress.jsonl         where each book was left
 *   _maurice/reading/archived.jsonl         the entries taken off the shelf
 *   _maurice/domains/<slug>.md              a domain the member made: Maurice's
 *                                           brief, its instructions, its context,
 *                                           the conversations and mail filed in it
 *   _maurice/conversations/<…>.md           one per conversation — only when
 *                                           the member asked for it
 *
 * life.db is the household's, one file for every member: it is read from a
 * `VACUUM INTO` copy taken once for the night, never live with its WAL, and
 * every query names the member. In a room shared with other members only the
 * member's own messages are written, the rule of the member archive
 * (services/memberArchive.ts). No database, no vector, no credential.
 *
 * The files say what is, not when it was exported: a night with nothing new
 * rewrites nothing and commits nothing. The commit goes through the garden's
 * own autoCommit, limited to `_maurice/` and the `.gitignore`, under an author
 * of its own — `Maurice (export)` — so it is told apart from the member's work
 * and never takes in a write the garden tool staged at the same moment.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { getAppDir } from "../../lib/appDir";
import { getLifeDbPath } from "../../data-api/lib/config";
import { autoCommit, gardenFor, parseFiche, type GardenRef } from "../../data-api/services/gardenFiche";
import db from "../db";
import { snapshotDb } from "./archive";
import { ensureIgnored } from "./gardenIgnore";
import { isOwnRepo } from "./gitHttp";
import { memberConversationList, memberConversations } from "./memberArchive";
import { userLocale } from "./i18n";
import { listUsers } from "./users";

export const EXPORT_DIR = "_maurice";
export const EXPORT_AUTHOR = "Maurice (export) <export@maurice.local>";

export interface BookInfo { title: string; authors: string[] }

export interface ExportDeps {
  /** A Calibre book's title and authors, or null when the library cannot say. */
  book: (id: number) => Promise<BookInfo | null>;
}

export interface ExportResult {
  member: string;
  written: number;
  removed: number;
  committed: boolean;
}

// ── Small pieces ────────────────────────────────────────────────

const slugify = (text: string) =>
  text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "");

/** A server timestamp (naive UTC, `datetime('now')`) as ISO 8601. */
const iso = (ts: string | null | undefined): string | null => {
  if (!ts) return null;
  return /[zZ]|[+-]\d\d:?\d\d$/.test(ts) ? ts : ts.replace(" ", "T") + "Z";
};

const yamlStr = (s: string) => JSON.stringify(s);

const natural = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });

/** A JSON line with its keys in the order given: diffs stay a line per change. */
const line = (obj: Record<string, unknown>) => JSON.stringify(obj);

/** Every file under `dir`, relative to it. */
function walk(dir: string, base = dir): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, base));
    else out.push(relative(base, p));
  }
  return out;
}

function tablesOf(d: Database): Set<string> {
  return new Set((d.query(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((r) => r.name));
}

// ── The garden's entries, to link to ────────────────────────────

interface Entry { link: string; slug: string; title: string }

/** A collection's entries: the fiche when there is one (it is what a reader's
 *  marks belong with), else the card. Keyed by Calibre id, slug and title. */
function entriesOf(garden: GardenRef, collection: "books" | "articles", locale: string) {
  const byId = new Map<number, Entry>();
  const bySlug = new Map<string, Entry>();
  const byTitle = new Map<string, Entry>();
  const dir = join(garden.root, collection);
  if (!existsSync(dir)) return { byId, bySlug, byTitle };
  // The member's own language first, so its entry wins over a translation.
  const locales = readdirSync(dir).filter((l) => statSync(join(dir, l)).isDirectory())
    .sort((a, b) => (a === locale ? -1 : b === locale ? 1 : a.localeCompare(b)));
  for (const loc of locales) {
    const files = readdirSync(join(dir, loc)).filter((f) => f.endsWith(".md"));
    const slugs = new Set(files.filter((f) => !f.endsWith("-fiche.md")).map((f) => f.slice(0, -3)));
    for (const f of files) if (f.endsWith("-fiche.md")) slugs.add(f.slice(0, -"-fiche.md".length));
    for (const slug of [...slugs].sort()) {
      const fiche = `${slug}-fiche.md`;
      const file = files.includes(fiche) ? fiche : `${slug}.md`;
      let fm: Record<string, any> = {};
      try { fm = parseFiche(readFileSync(join(dir, loc, file), "utf8"))?.frontmatter ?? {}; } catch {}
      const entry: Entry = { link: `${collection}/${loc}/${file.slice(0, -3)}`, slug, title: String(fm.title ?? slug) };
      const id = Number(fm.meta?.calibre_id ?? fm.calibre_id);
      if (Number.isInteger(id) && !byId.has(id)) byId.set(id, entry);
      if (!bySlug.has(`${loc}/${slug}`)) bySlug.set(`${loc}/${slug}`, entry);
      const t = entry.title.trim().toLowerCase();
      if (t && !byTitle.has(t)) byTitle.set(t, entry);
    }
  }
  return { byId, bySlug, byTitle };
}

// ── What is written ─────────────────────────────────────────────

type Files = Map<string, string>;

/** A unique file name in `taken`, from a slug. */
function claim(taken: Set<string>, slug: string, suffix: string): string {
  let name = slug || "untitled";
  if (taken.has(name)) name = `${name}-${suffix}`;
  taken.add(name);
  return name;
}

function quote(text: string): string {
  return text.trim().split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n");
}

function highlightBlock(h: { quote: string; note: string | null; color: string; view: string; created_at: string }): string {
  const meta = [iso(h.created_at)?.slice(0, 10), h.color, h.view === "summary" ? "summary" : null].filter(Boolean).join(" · ");
  return [quote(h.quote), h.note?.trim() ? `\n${h.note.trim()}` : "", `\n*${meta}*`].join("\n").replace(/\n{3,}/g, "\n\n");
}

async function bookHighlights(files: Files, life: Database, memberId: string, garden: GardenRef, locale: string, deps: ExportDeps) {
  const rows = life.query(
    `SELECT book_id, chapter_slug, quote, note, color, start_offset, view, created_at, id
       FROM highlights WHERE member_id = ? ORDER BY book_id, id`,
  ).all(memberId) as any[];
  if (!rows.length) return;
  const entries = entriesOf(garden, "books", locale);
  const byBook = new Map<number, any[]>();
  for (const r of rows) (byBook.get(r.book_id) ?? byBook.set(r.book_id, []).get(r.book_id)!).push(r);
  const taken = new Set<string>();
  for (const [bookId, list] of [...byBook].sort((a, b) => a[0] - b[0])) {
    const info = await deps.book(bookId).catch(() => null);
    const title = info?.title ?? `Book ${bookId}`;
    const entry = entries.byId.get(bookId) ?? entries.byTitle.get(title.trim().toLowerCase()) ?? null;
    const name = claim(taken, entry?.slug ?? slugify(title), String(bookId));
    const head = [
      "---",
      `title: ${yamlStr(title)}`,
      ...(info?.authors.length ? [`authors: [${info.authors.map(yamlStr).join(", ")}]`] : []),
      `calibre_id: ${bookId}`,
      ...(entry ? [`entry: ${yamlStr(`[[${entry.link}]]`)}`] : []),
      `highlights: ${list.length}`,
      "---",
      "",
      `# ${title}`,
      "",
      ...(entry ? [`[[${entry.link}|${entry.title}]]`, ""] : []),
    ];
    const chapters = new Map<string, any[]>();
    for (const h of list) (chapters.get(h.chapter_slug) ?? chapters.set(h.chapter_slug, []).get(h.chapter_slug)!).push(h);
    const body: string[] = [];
    for (const ch of [...chapters.keys()].sort(natural)) {
      body.push(`## ${ch}`, "");
      const hs = chapters.get(ch)!.sort((a, b) => (a.start_offset ?? 0) - (b.start_offset ?? 0) || a.id - b.id);
      for (const h of hs) body.push(highlightBlock(h), "");
    }
    files.set(`highlights/books/${name}.md`, [...head, ...body].join("\n").trimEnd() + "\n");
  }
}

function articleHighlights(files: Files, life: Database, memberId: string, garden: GardenRef, locale: string) {
  const rows = life.query(
    `SELECT locale, slug, quote, note, color, start_offset, view, created_at, id
       FROM article_highlights WHERE member_id = ? ORDER BY locale, slug, id`,
  ).all(memberId) as any[];
  if (!rows.length) return;
  const entries = entriesOf(garden, "articles", locale);
  const byArticle = new Map<string, any[]>();
  for (const r of rows) {
    const k = `${r.locale}/${r.slug}`;
    (byArticle.get(k) ?? byArticle.set(k, []).get(k)!).push(r);
  }
  const taken = new Set<string>();
  for (const [key, list] of [...byArticle].sort((a, b) => a[0].localeCompare(b[0]))) {
    const [loc, slug] = key.split("/") as [string, string];
    const entry = entries.bySlug.get(key) ?? null;
    const title = entry?.title ?? slug;
    const name = claim(taken, slugify(slug), loc);
    const out = [
      "---",
      `title: ${yamlStr(title)}`,
      `article: ${yamlStr(key)}`,
      ...(entry ? [`entry: ${yamlStr(`[[${entry.link}]]`)}`] : []),
      `highlights: ${list.length}`,
      "---",
      "",
      `# ${title}`,
      "",
      ...(entry ? [`[[${entry.link}|${entry.title}]]`, ""] : []),
    ];
    for (const h of list.sort((a, b) => (a.start_offset ?? 0) - (b.start_offset ?? 0) || a.id - b.id)) out.push(highlightBlock(h), "");
    files.set(`highlights/articles/${name}.md`, out.join("\n").trimEnd() + "\n");
  }
}

async function reading(files: Files, life: Database, memberId: string, tables: Set<string>, deps: ExportDeps) {
  if (tables.has("reading_progress")) {
    const rows = life.query(
      `SELECT book_id, chapter_index, chapter_slug, view, enabled, position, updated_at
         FROM reading_progress WHERE member_id = ? ORDER BY book_id`,
    ).all(memberId) as any[];
    const lines: string[] = [];
    for (const r of rows) {
      const info = await deps.book(r.book_id).catch(() => null);
      lines.push(line({
        book_id: r.book_id, title: info?.title ?? null, chapter_index: r.chapter_index, chapter_slug: r.chapter_slug,
        view: r.view, enabled: !!r.enabled, position: r.position, updated_at: iso(r.updated_at),
      }));
    }
    if (lines.length) files.set("reading/progress.jsonl", lines.join("\n") + "\n");
  }
  if (tables.has("shelf_archive")) {
    const rows = life.query(
      `SELECT entry_id, archived_at FROM shelf_archive WHERE member_id = ? ORDER BY entry_id`,
    ).all(memberId) as any[];
    if (rows.length) files.set("reading/archived.jsonl", rows.map((r) => line({ entry_id: r.entry_id, archived_at: iso(r.archived_at) })).join("\n") + "\n");
  }
}

const conversationTitle = (c: Record<string, any>) => String(c.title ?? "").trim() || "Conversation";

/** A conversation's file name in the export: its day, its title, its id. */
function conversationName(c: Record<string, any> & { id: string }): string {
  const day = iso(c.created_at)?.slice(0, 10) ?? "undated";
  return [day, slugify(conversationTitle(c)).slice(0, 40), c.id.slice(0, 8)].filter(Boolean).join("-");
}

/** The member's conversations, one Markdown file each — with the member
 *  archive's rule for rooms (memberConversations). */
function conversations(files: Files, memberId: string, displayName: string) {
  const personas = new Map(
    (db.query(`SELECT id, name FROM maurices`).all() as { id: string; name: string }[]).map((m) => [m.id, m.name]),
  );
  for (const c of memberConversations(memberId)) {
    const messages = c.messages.filter((m) => m.role !== "system");
    if (!messages.length) continue;
    const title = conversationTitle(c);
    const name = conversationName(c);
    const out = [
      "---",
      `title: ${yamlStr(title)}`,
      `conversation: ${yamlStr(c.id)}`,
      `created: ${yamlStr(iso(c.created_at) ?? "")}`,
      `updated: ${yamlStr(iso(c.updated_at) ?? "")}`,
      ...(c.room ? ["room: true  # shared with other members: only your own messages are here"] : []),
      "---",
      "",
      `# ${title}`,
      "",
    ];
    for (const m of messages) {
      const who = m.role === "user" ? displayName : personas.get(m.maurice_id) ?? "Maurice";
      out.push(`**${who}** · ${iso(m.created_at)}`, "", String(m.content).trim(), "");
    }
    files.set(`conversations/${name}.md`, out.join("\n").trimEnd() + "\n");
  }
}

// ── Domains ─────────────────────────────────────────────────────

const DOMAIN_WORDS = {
  fr: {
    brief: "Ce que Maurice en a compris", noBrief: "Pas encore de brief.", updated: "Mis à jour le",
    prompt: "Consignes", context: "Contexte", conversations: "Conversations", mail: "Courrier",
    book: "livre", notYours: "une conversation qui n’est pas la vôtre", missing: "introuvable",
  },
  en: {
    brief: "What Maurice understood", noBrief: "No brief yet.", updated: "Updated",
    prompt: "Instructions", context: "Context", conversations: "Conversations", mail: "Mail",
    book: "book", notYours: "a conversation that is not yours", missing: "missing",
  },
};

/** The garden's hub notes, by the domain they were seeded for
 *  (services/domainSeeding.ts: `meta.domain`, `meta.role: hub`). */
function hubNotes(garden: GardenRef): Map<string, string> {
  const hubs = new Map<string, string>();
  const notes = join(garden.root, "notes");
  if (!existsSync(notes)) return hubs;
  for (const loc of readdirSync(notes).sort()) {
    const dir = join(notes, loc);
    if (!statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".md")).sort()) {
      let meta: any;
      try { meta = parseFiche(readFileSync(join(dir, f), "utf8"))?.frontmatter?.meta; } catch { continue; }
      if (meta?.role === "hub" && typeof meta.domain === "string" && !hubs.has(meta.domain)) {
        hubs.set(meta.domain, `notes/${loc}/${f.slice(0, -3)}`);
      }
    }
  }
  return hubs;
}

/**
 * The domains the member made, one Markdown file each: what defines it (name,
 * look, instructions, the context it carries), the member's own brief of it,
 * and what is filed in it — the conversations that are the member's to take
 * away (memberConversationList, linked to their file when those are exported)
 * and the mail documents, which are in the garden already. The brief is the
 * one the night wrote last: at 03:30 that is the previous day's.
 */
async function domains(files: Files, memberId: string, garden: GardenRef, locale: "fr" | "en", deps: ExportDeps) {
  const rows = db.query(
    `SELECT * FROM maurices WHERE kind = 'domain' AND created_by = ? ORDER BY created_at, id`,
  ).all(memberId) as Record<string, any>[];
  if (!rows.length) return;
  const w = DOMAIN_WORDS[locale];
  const mine = memberConversationList(memberId);
  const byId = new Map(mine.map((c) => [c.id, c]));
  const filed = new Map<string, typeof mine>();
  for (const c of mine) if (c.maurice_id) (filed.get(c.maurice_id) ?? filed.set(c.maurice_id, []).get(c.maurice_id)!).push(c);
  const hubs = hubNotes(garden);
  const convoLink = (c: Record<string, any> & { id: string }) => {
    const name = conversationName(c);
    return files.has(`conversations/${name}.md`) ? `[[${EXPORT_DIR}/conversations/${name}|${conversationTitle(c)}]]` : conversationTitle(c);
  };
  const ownName = (table: "files" | "folders", id: string) =>
    (db.query(`SELECT name FROM ${table} WHERE id = ? AND user_id = ?`).get(id, memberId) as { name: string } | null)?.name ?? null;

  const taken = new Set<string>();
  for (const d of rows) {
    const id = String(d.id);
    const name = String(d.name ?? "").trim() || "Domain";
    const file = claim(taken, slugify(name), id.slice(0, 8));
    const hub = hubs.get(id) ?? null;
    const convos = filed.get(id) ?? [];
    const brief = db.query(
      `SELECT text, summary, updated_at FROM domain_briefs WHERE maurice_id = ? AND member_id = ?`,
    ).get(id, memberId) as { text: string; summary: string | null; updated_at: string } | null;
    const mail = db.query(
      `SELECT path FROM domain_mail WHERE maurice_id = ? AND member_id = ? ORDER BY path`,
    ).all(id, memberId) as { path: string }[];

    const out = [
      "---",
      `title: ${yamlStr(name)}`,
      `domain: ${yamlStr(id)}`,
      ...(d.icon ? [`icon: ${yamlStr(String(d.icon))}`] : []),
      `palette: ${yamlStr(String(d.palette ?? ""))}`,
      `hat: ${yamlStr(String(d.hat ?? ""))}`,
      ...(d.tagline ? [`tagline: ${yamlStr(String(d.tagline))}`] : []),
      ...(d.model ? [`model: ${yamlStr(String(d.model))}`] : []),
      `created: ${yamlStr(iso(d.created_at) ?? "")}`,
      `updated: ${yamlStr(iso(d.updated_at) ?? "")}`,
      ...(hub ? [`hub: ${yamlStr(`[[${hub}]]`)}`] : []),
      `conversations: ${convos.length}`,
      "---",
      "",
      `# ${name}`,
      "",
      ...(d.tagline ? [`*${String(d.tagline).trim()}*`, ""] : []),
      ...(hub ? [`[[${hub}|${name}]]`, ""] : []),
      `## ${w.brief}`,
      "",
    ];
    if (brief?.text?.trim()) {
      if (brief.summary?.trim()) out.push(`*${brief.summary.trim()}*`, "");
      out.push(brief.text.trim(), "", `*${w.updated} ${iso(brief.updated_at)?.slice(0, 10)}*`, "");
    } else {
      out.push(w.noBrief, "");
    }
    if (String(d.prompt ?? "").trim()) out.push(`## ${w.prompt}`, "", String(d.prompt).trim(), "");

    let items: any[] = [];
    try { items = JSON.parse(String(d.context_json ?? "{}"))?.items ?? []; } catch {}
    if (items.length) {
      out.push(`## ${w.context}`, "");
      for (const it of items) {
        const kind = String(it?.type ?? "");
        let label: string;
        if (kind === "note") label = `[[${it.id}]]`;
        else if (kind === "fiche") label = `[[${it.id}-fiche]]`;
        else if (kind === "book") {
          const info = await deps.book(Number(it.id)).catch(() => null);
          label = `${info?.title ?? `${w.book} ${it.id}`}${info?.authors.length ? ` — ${info.authors.join(", ")}` : ""}`;
        } else if (kind === "conversation") {
          const c = byId.get(String(it.id));
          label = c ? `${convoLink(c)} (${iso(c.created_at)?.slice(0, 10)})` : w.notYours;
        } else if (kind === "file" || kind === "folder") {
          label = ownName(kind === "file" ? "files" : "folders", String(it.id)) ?? w.missing;
        } else continue;
        const how = [it.representation, it.scope?.mode].filter((x) => typeof x === "string" && x).join(", ");
        out.push(`- ${kind}: ${label}${how ? ` · ${how}` : ""}`);
      }
      out.push("");
    }

    if (convos.length) {
      out.push(`## ${w.conversations}`, "");
      for (const c of convos) out.push(`- ${iso(c.created_at)?.slice(0, 10)} · ${convoLink(c)}`);
      out.push("");
    }
    if (mail.length) {
      out.push(`## ${w.mail}`, "");
      for (const m of mail) out.push(`- [[${m.path.replace(/\.md$/, "")}]]`);
      out.push("");
    }
    files.set(`domains/${file}.md`, out.join("\n").trimEnd() + "\n");
  }
}

const README: Record<"fr" | "en", (convos: boolean) => string> = {
  fr: (convos) => `# _maurice

Ce dossier est écrit chaque nuit par Maurice, à partir de ce que le foyer garde
de vous hors du jardin. Ne le modifiez pas : il est réécrit à chaque export, et
ses commits sont signés « Maurice (export) ».

- \`highlights/books/\` et \`highlights/articles/\` : vos surlignages, un fichier
  par livre ou par article, liés à sa fiche quand elle existe ;
- \`reading/progress.jsonl\` : où vous en êtes dans chaque livre ;
- \`reading/archived.jsonl\` : les entrées que vous avez archivées ;
- \`domains/\` : vos domaines, un fichier chacun — le brief de Maurice, les
  consignes, le contexte, les conversations et le courrier qui y sont rangés.
  Le brief est celui de la veille : il est réécrit après cet export ;
${convos
    ? "- `conversations/` : vos conversations, une par fichier ; dans un salon partagé, seulement vos messages."
    : "- vos conversations n'y sont pas : activez-les dans l'app, Réglages → Mes données."}

Ce clone n'est pas chiffré : les notes marquées privées y sont en clair. Il ne
contient ni votre courrier, ni l'index de recherche, ni les données des autres
membres. Pour une copie complète, utilisez l'export « Mes données ».
`,
  en: (convos) => `# _maurice

This folder is written every night by Maurice, from what the household keeps
of you outside your garden. Do not edit it: each export rewrites it, and its
commits are signed "Maurice (export)".

- \`highlights/books/\` and \`highlights/articles/\`: your highlights, one file per
  book or article, linked to its entry when there is one;
- \`reading/progress.jsonl\`: where you are in each book;
- \`reading/archived.jsonl\`: the entries you archived;
- \`domains/\`: your domains, one file each — Maurice's brief, the
  instructions, the context, the conversations and mail filed in them. The
  brief is the previous day's: it is rewritten after this export;
${convos
    ? "- `conversations/`: your conversations, one per file; in a room shared with others, only your own messages."
    : "- your conversations are not here: turn them on in the app, Settings → My data."}

This clone is not encrypted: notes marked private are in clear text. It holds
neither your mail, nor the search index, nor other members' data. For a full
copy, use the "My data" export.
`,
};

// ── The export ──────────────────────────────────────────────────

export function exportsConversations(memberId: string): boolean {
  const row = db.query(`SELECT export_conversations FROM user_preferences WHERE user_id = ?`).get(memberId) as { export_conversations: number } | null;
  return !!row?.export_conversations;
}

export function setExportsConversations(memberId: string, on: boolean): void {
  db.run(`INSERT OR IGNORE INTO user_preferences (user_id) VALUES (?)`, [memberId]);
  db.run(`UPDATE user_preferences SET export_conversations = ?, updated_at = datetime('now') WHERE user_id = ?`, [on ? 1 : 0, memberId]);
}

/**
 * Write one member's export into their garden, from an open snapshot of
 * life.db (or null when the household has none), and commit what changed.
 *
 * Only into a garden that is a repository of its own: the folder exists for a
 * clone, and a garden nobody has cloned would only hold a second copy of the
 * member's conversations on the disk and in their archive. A garden becomes
 * one at its first clone, which exports it then (routes/git.ts).
 */
export async function exportMemberGarden(memberId: string, life: Database | null, deps: ExportDeps): Promise<ExportResult | null> {
  const user = db.query(`SELECT username, display_name FROM users WHERE id = ?`).get(memberId) as { username: string; display_name: string } | null;
  const garden = gardenFor(memberId);
  if (!user || !garden || !existsSync(garden.root) || !statSync(garden.root).isDirectory()) return null;
  if (!isOwnRepo(garden.root)) return null;

  const locale = userLocale(memberId) === "fr" ? "fr" : "en";
  const convos = exportsConversations(memberId);
  const files: Files = new Map();
  files.set("README.md", README[locale](convos));
  if (life) {
    const tables = tablesOf(life);
    if (tables.has("highlights")) await bookHighlights(files, life, memberId, garden, locale, deps);
    if (tables.has("article_highlights")) articleHighlights(files, life, memberId, garden, locale);
    await reading(files, life, memberId, tables, deps);
  }
  if (convos) conversations(files, memberId, user.display_name || user.username);
  await domains(files, memberId, garden, locale, deps);

  const dir = join(garden.root, EXPORT_DIR);
  const changed = new Set<string>();
  let written = 0;
  let removed = 0;
  for (const rel of walk(dir)) {
    if (files.has(rel)) continue;
    rmSync(join(dir, rel), { force: true });
    removed++;
    changed.add(rel.split("/")[0]!);
  }
  pruneEmpty(dir);
  for (const [rel, content] of files) {
    const p = join(dir, rel);
    if (existsSync(p) && readFileSync(p, "utf8") === content) continue;
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
    written++;
    changed.add(rel.split("/")[0]!);
  }
  const ignoreChanged = ensureIgnored(garden.root);

  let committed = false;
  if (changed.size || ignoreChanged) {
    const parts = [...changed].map((c) => c.replace(/\.md$/, "")).sort();
    committed = autoCommit(
      garden,
      [dir, join(garden.root, ".gitignore")],
      `Daily export: ${parts.length ? parts.join(", ") : ".gitignore"}`,
      { author: EXPORT_AUTHOR, only: true },
    );
  }
  return { member: user.username, written, removed, committed };
}

function pruneEmpty(dir: string): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      pruneEmpty(p);
      if (!readdirSync(p).length) rmSync(p, { recursive: true, force: true });
    }
  }
}

/** A consistent copy of a database being written to: `VACUUM INTO` a file of
 *  its own, opened read-only. The caller closes it and calls `done`. */
export function snapshot(src: string): { db: Database; done: () => void } | null {
  if (!existsSync(src)) return null;
  const tmpRoot = join(getAppDir(), "tmp");
  mkdirSync(tmpRoot, { recursive: true });
  const tmp = mkdtempSync(join(tmpRoot, "garden-export-"));
  const dest = join(tmp, "life.db");
  try {
    snapshotDb(src, dest);
    const d = new Database(dest, { readonly: true });
    return { db: d, done: () => { try { d.close(); } catch {} rmSync(tmp, { recursive: true, force: true }); } };
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
}

async function calibreBook(id: number): Promise<BookInfo | null> {
  const { getBookMetadata } = await import("../../data-api/services/calibre");
  const meta = await getBookMetadata(id);
  return meta ? { title: meta.title, authors: meta.authors } : null;
}

/** One member's export, now: their garden has just become a repository. */
export async function exportGardenNow(memberId: string, deps: ExportDeps = { book: calibreBook }, lifePath = getLifeDbPath()): Promise<ExportResult | null> {
  const snap = snapshot(lifePath);
  try {
    return await exportMemberGarden(memberId, snap?.db ?? null, deps);
  } finally {
    snap?.done();
  }
}

/** Export every member with a garden. One snapshot of life.db for the night. */
export async function exportAllGardens(deps: ExportDeps = { book: calibreBook }, lifePath = getLifeDbPath()): Promise<ExportResult[]> {
  const snap = snapshot(lifePath);
  const results: ExportResult[] = [];
  // Titles are looked up once per book for the whole household.
  const cache = new Map<number, Promise<BookInfo | null>>();
  const cached: ExportDeps = {
    book: (id) => cache.get(id) ?? cache.set(id, deps.book(id).catch(() => null)).get(id)!,
  };
  try {
    for (const u of listUsers()) {
      try {
        const r = await exportMemberGarden(u.id, snap?.db ?? null, cached);
        if (r) results.push(r);
      } catch (e) {
        console.error(`[garden-export] ${u.username}: ${(e as Error).message}`);
      }
    }
  } finally {
    snap?.done();
  }
  return results;
}

// ── The night ───────────────────────────────────────────────────

const TICK_MS = 10 * 60 * 1000;
const FIRST_TICK_MS = 45_000;

export interface ExportState {
  last_run_at: string | null;
  last_error: string | null;
  members: number;
  commits: number;
}

/** `HH:MM` local time, from MAURICE_GARDEN_EXPORT_AT (default 03:30); null
 *  when it says `off`, or under test. */
export function exportTime(env = process.env): { hour: number; minute: number } | null {
  const raw = env.MAURICE_GARDEN_EXPORT_AT?.trim() || "03:30";
  if (raw === "off") return null;
  const m = raw.match(/^(\d{1,2}):(\d{2})$/);
  const hour = m ? Number(m[1]) : 3;
  const minute = m ? Number(m[2]) : 30;
  if (!m || hour > 23 || minute > 59) {
    console.warn(`[garden-export] MAURICE_GARDEN_EXPORT_AT=${raw} is not HH:MM; using 03:30`);
    return { hour: 3, minute: 30 };
  }
  return { hour, minute };
}

const localDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Due once per local day, from the set time on: a server that was down then
 *  runs it when it comes back rather than skipping the day. */
export function exportDue(now: Date, lastRunAt: string | null, at: { hour: number; minute: number }): boolean {
  if (now.getHours() * 60 + now.getMinutes() < at.hour * 60 + at.minute) return false;
  if (!lastRunAt) return true;
  const last = new Date(lastRunAt);
  return Number.isNaN(last.getTime()) || localDay(last) !== localDay(now);
}

const stateFile = () => join(getAppDir(), "garden-export-nightly.json");

export function loadState(): ExportState {
  try { return JSON.parse(readFileSync(stateFile(), "utf8")); } catch {
    return { last_run_at: null, last_error: null, members: 0, commits: 0 };
  }
}

let running: Promise<boolean> | null = null;

/**
 * Export every garden now. `nightly` is the scheduled pass: only it, and only
 * when it got through, marks the day as done — a failed night (life.db could
 * not be copied, the disk was full) is tried again at the next tick, and an
 * admin's run at 01:00 does not stand in for the 03:30 one. True on success.
 */
export function runGardenExportNow(
  opts: { nightly?: boolean; exportAll?: () => Promise<ExportResult[]> } = {},
): Promise<boolean> {
  if (running) return running;
  running = (async () => {
    const started = Date.now();
    const previous = loadState();
    const state: ExportState = { ...previous, last_error: null };
    let ok = true;
    try {
      const results = await (opts.exportAll ?? exportAllGardens)();
      state.members = results.length;
      state.commits = results.filter((r) => r.committed).length;
      if (opts.nightly) state.last_run_at = new Date(started).toISOString();
      console.log(`[garden-export] ${state.members} garden(s), ${state.commits} commit(s) in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    } catch (e) {
      ok = false;
      state.last_error = (e as Error).message;
      console.error(`[garden-export] failed: ${state.last_error}`);
    }
    try {
      mkdirSync(dirname(stateFile()), { recursive: true });
      writeFileSync(stateFile(), JSON.stringify(state, null, 2) + "\n");
    } catch {}
    return ok;
  })().finally(() => { running = null; });
  return running;
}

/** Tick every ten minutes; export once per local day from the set time. */
export function scheduleGardenExport(): void {
  const at = exportTime();
  if (!at || process.env.NODE_ENV === "test") {
    console.log("[garden-export] nightly export off");
    return;
  }
  const tick = () => {
    if (running || !exportDue(new Date(), loadState().last_run_at, at)) return;
    runGardenExportNow({ nightly: true }).catch(() => {});
  };
  setTimeout(() => {
    tick();
    setInterval(tick, TICK_MS).unref();
  }, FIRST_TICK_MS).unref();
}
