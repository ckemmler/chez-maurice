import fs from "node:fs";
import path from "node:path";
import { fragmentsDir, gardenFor, parseFiche } from "../../data-api/services/gardenFiche";
import { contactCards } from "./contactAccounts";
import { wordsFor } from "./mailDocuments";
import { fragmentHash, sectionOf, withoutSection } from "./mailPeople";
import { noteFiche } from "./reviewFooter";

// The person beside a corpus hit — lot 5 of specs/contacts.md, 27 September
// 2026.
//
// A year-old note about a feature says a colleague works at the client's;
// he has left since. The note is the member's own word — confirmed, and right
// when it was written — so no status warns about it. What it needs is the
// person's relation beside it, dated: "Jean Dupont — colleague at Acme,
// 2021 → 2026-03". So when a corpus hit mentions someone who has a fiche with
// a relation, the server attaches one line to that hit, without a model:
//
//   - a link to the fiche — `[[jean-dupont-fiche]]`, `people/fr/jean-dupont-fiche`;
//   - or a full name: the fiche's title, the card's full name, an alias —
//     two words at least, in either order ("Magi Paola", "Paola Magi"),
//     accents and case aside. A first name alone is never enough: too many
//     Marcs.
//
// A hit that is the person's own fiche or fragment gets nothing (it says it
// already), and a pending relation attached this way enters the "À vérifier"
// footer like anything else pending (services/reviewFooter.ts).

export interface PersonEntry {
  locale: string;
  basename: string;
  title: string;
  /** Each name as its words, normalised. */
  names: string[][];
  relation: string;
  status: "pending" | "confirmed" | "rejected";
  since: string | null;
  until: string | null;
}

const words = (s: string): string[] =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

const cache = new Map<string, { at: number; entries: PersonEntry[] }>();
const TTL_MS = 60_000;

/** The member's person fiches that say who someone is — cached a minute. */
export function peopleIndex(memberId: string): PersonEntry[] {
  const hit = cache.get(memberId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.entries;
  const garden = gardenFor(memberId);
  const entries: PersonEntry[] = [];
  const root = garden ? path.join(garden.root, "people") : "";
  const cards = new Map(contactCards(memberId).filter((c) => c.uid).map((c) => [c.uid!, c]));
  for (const locale of root && fs.existsSync(root) ? fs.readdirSync(root) : []) {
    const dir = path.join(root, locale);
    if (!/^[a-z]{2}$/.test(locale) || !fs.statSync(dir).isDirectory()) continue;
    const w = wordsFor(locale);
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith("-fiche.md"))) {
      const parsed = parseFiche(fs.readFileSync(path.join(dir, f), "utf8"));
      if (!parsed) continue;
      const { frontmatter: fm, body } = parsed;
      const text = sectionOf(body, w.relationship);
      const rel = fm.relation && typeof fm.relation === "object" ? fm.relation : null;
      if (!text || !rel || rel.status === "rejected") continue;
      const edited = !!rel.written_hash && fragmentHash(text) !== String(rel.written_hash);
      const card = fm.carddav_uid ? cards.get(String(fm.carddav_uid)) : undefined;
      const aliases = Array.isArray(fm.aliases) ? fm.aliases.map(String) : typeof fm.aliases === "string" ? [fm.aliases] : [];
      const names = [String(fm.title ?? ""), card?.full_name ?? "", ...(card?.nickname ?? []), ...aliases]
        .map(words).filter((n) => n.length >= 2);
      const unique = [...new Map(names.map((n) => [[...n].sort().join(" "), n])).values()];
      entries.push({
        locale, basename: f.slice(0, -3), title: String(fm.title ?? f),
        names: unique,
        relation: text.replace(/\s+—\s+\[[\s\S]*$/, "").replace(/\s+/g, " ").trim(),
        status: edited || rel.status === "confirmed" ? "confirmed" : "pending",
        since: rel.since ? String(rel.since) : null,
        until: rel.until ? String(rel.until) : null,
      });
    }
  }
  cache.set(memberId, { at: Date.now(), entries });
  return entries;
}

/** Tests only. */
export function _clearPeopleIndex(): void {
  cache.clear();
}

/** The people a text mentions: by a link to their fiche, or by a full name. */
export function mentionsIn(text: string, entries: PersonEntry[]): PersonEntry[] {
  const found: PersonEntry[] = [];
  const toks = words(text);
  for (const e of entries) {
    const slug = e.basename.replace(/-fiche$/, "");
    const linked = text.includes(`[[${e.basename}`) || text.includes(`people/${e.locale}/${e.basename}`) || text.includes(`[[${slug}]]`) || text.includes(`[[${slug}|`);
    const named = !linked && e.names.some((n) => {
      const want = [...n].sort().join(" ");
      for (let i = 0; i + n.length <= toks.length; i++) {
        if ([...toks.slice(i, i + n.length)].sort().join(" ") === want) return true;
      }
      return false;
    });
    if (linked || named) found.push(e);
  }
  return found;
}

/** One line for the model: who, the relation, its dates, whether the member
 *  confirmed it. */
export function personLine(e: PersonEntry): string {
  const clip = e.relation.length > 220 ? `${e.relation.slice(0, 219)}…` : e.relation;
  const dates = e.since || e.until ? ` (${e.since ?? "?"} → ${e.until ?? "…"})` : "";
  return `${e.title} — ${clip}${dates}${e.status === "confirmed" ? " [confirmed by the member]" : " [not confirmed yet]"}`;
}

const PEOPLE_PATH = /\/people\/([a-z]{2})\/([a-z0-9-]+-fiche)(?:\.md|\/_fragments\/)/;

/** Attach the people each hit mentions to the narrowed corpus text the model
 *  reads (`{results:[…]}`, in the order of `rows`). Returns the text as it
 *  was when there is nothing to attach or the shape is not the known one. */
export function attachPeople(conversationId: string, memberId: string | null | undefined, narrowed: string, rows: any[]): string {
  if (!memberId || !rows.length) return narrowed;
  let payload: any;
  try {
    payload = JSON.parse(narrowed);
  } catch {
    return narrowed;
  }
  if (!Array.isArray(payload?.results) || payload.results.length !== rows.length) return narrowed;
  const entries = peopleIndex(memberId);
  if (!entries.length) return narrowed;
  let attached = false;
  payload.results.forEach((r: any, i: number) => {
    const row = rows[i] ?? {};
    const own = String(row.file_path ?? "").match(PEOPLE_PATH)?.[2] ?? null;
    const text = [row.title, row.text].filter(Boolean).join("\n");
    const people = mentionsIn(text, entries).filter((e) => e.basename !== own);
    if (!people.length) return;
    r.people = people.slice(0, 4).map(personLine);
    attached = true;
    for (const p of people) if (p.status === "pending") noteFiche(conversationId, p.locale, p.basename);
  });
  return attached ? JSON.stringify(payload) : narrowed;
}

// ── The person behind an address ─────────────────────────────────────────
//
// `email__exchanges` answers from the header store, by address: the person's
// fiche says what those messages mean — who they are, what is going on,
// what was promised, what is left open. A model that asked the store by name
// never learns there is a fiche (27 September 2026: the accountant's
// exchanges read, her fiche with every open question never opened). So the
// server says, beside the result, which fiches hold those addresses.

const byAddressCache = new Map<string, { at: number; map: Map<string, { locale: string; basename: string; title: string }> }>();

function fichesByAddress(memberId: string): Map<string, { locale: string; basename: string; title: string }> {
  const hit = byAddressCache.get(memberId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.map;
  const map = new Map<string, { locale: string; basename: string; title: string }>();
  const garden = gardenFor(memberId);
  const root = garden ? path.join(garden.root, "people") : "";
  for (const locale of root && fs.existsSync(root) ? fs.readdirSync(root) : []) {
    const dir = path.join(root, locale);
    if (!/^[a-z]{2}$/.test(locale) || !fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith("-fiche.md"))) {
      const parsed = parseFiche(fs.readFileSync(path.join(dir, f), "utf8"));
      const ids = Array.isArray(parsed?.frontmatter.identities) ? parsed!.frontmatter.identities : [];
      for (const id of ids) {
        if (!id?.address || id.status === "rejected") continue;
        const a = String(id.address).toLowerCase();
        if (!map.has(a)) map.set(a, { locale, basename: f.slice(0, -3), title: String(parsed!.frontmatter.title ?? f) });
      }
    }
  }
  byAddressCache.set(memberId, { at: Date.now(), map });
  return map;
}

/** Tests only. */
export function _clearFichesByAddress(): void {
  byAddressCache.clear();
}

/** How much of a fiche rides with an exchanges result. */
const FICHE_CHARS = 6000;

/** What to append to an `email__exchanges` result: the fiche its addresses
 *  belong to, inline — who the person is and what their mail says is going
 *  on, promised and left open. Named only, the fiche went unread (the model
 *  answered from the headers, 27 September 2026); so it rides with the
 *  headers, as the relation rides with a corpus hit, and whatever of it is
 *  pending enters the footer. "" when no address has a fiche. */
export function fichesForExchanges(conversationId: string, memberId: string | null | undefined, data: any): string {
  if (!memberId || !data || !Array.isArray(data.addresses) || !data.addresses.length) return "";
  const garden = gardenFor(memberId);
  if (!garden) return "";
  const map = fichesByAddress(memberId);
  const seen = new Map<string, { locale: string; basename: string; title: string }>();
  for (const a of data.addresses) {
    const f = map.get(String(a).toLowerCase());
    if (f) seen.set(`${f.locale}/${f.basename}`, f);
  }
  const parts: string[] = [];
  let pending = false;
  for (const f of [...seen.values()].slice(0, 2)) {
    const file = path.join(garden.root, "people", f.locale, `${f.basename}.md`);
    const parsed = fs.existsSync(file) ? parseFiche(fs.readFileSync(file, "utf8")) : null;
    if (!parsed) continue;
    const w = wordsFor(f.locale);
    // The body without what the result already says (the exchanges) or
    // what says nothing of the person (the provenance).
    const body = [w.exchanges, w.provenance].reduce((b, h) => withoutSection(b, h), parsed.body).trim();
    const fdir = fragmentsDir(file);
    const frags = (fs.existsSync(fdir) ? fs.readdirSync(fdir).filter((x) => x.endsWith(".frag")).sort() : [])
      .map((x) => parseFiche(fs.readFileSync(path.join(fdir, x), "utf8")))
      .filter((x): x is NonNullable<typeof x> => !!x)
      .map((x) => `(${x.frontmatter.summary ?? ""}${x.frontmatter.status === "pending" ? ", not confirmed yet" : ""})\n${x.body.trim()}`);
    let text = [body, ...frags].filter(Boolean).join("\n\n");
    if (text.length > FICHE_CHARS) text = `${text.slice(0, FICHE_CHARS - 1)}…`;
    parts.push(`### ${f.title} — people/${f.locale}/${f.basename} (garden__get_fiche resource_id "${f.basename.replace(/-fiche$/, "")}", locale "${f.locale}")\n${text}`);
    if (parsed.frontmatter.status === "pending" || parsed.frontmatter.relation?.status === "pending" || frags.some((x) => x.includes(", not confirmed yet)"))) pending = true;
    noteFiche(conversationId, f.locale, f.basename);
  }
  if (!parts.length) return "";
  return `\n\n[The fiche these addresses belong to, from the member's garden — what the headers above mean: who the person is to them, what is going on, what was promised, what is left open. Answer from it as much as from the headers.${pending ? " What is marked not confirmed yet is Maurice's reading of the mail: use it, and say it is unconfirmed; the system adds the review footer." : ""}]\n\n${parts.join("\n\n")}`;
}
