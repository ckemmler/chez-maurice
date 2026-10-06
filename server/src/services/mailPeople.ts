import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { atomicWrite, dumpFrontmatter, fichePath, ficheWebPath, fragmentsDir, isOpened, parseFiche, type GardenRef } from "../../data-api/services/gardenFiche";
import { slugify } from "../../data-api/services/articleExtract";
import type { AncillaryResult } from "./ancillary";
import type { ContactCard } from "./contactAccounts";
import { LANGUAGE } from "./domainBriefs";
import { parseJsonObject } from "./domainMapping";
import {
  MAX_PER_NOTE, MIN_MESSAGES, UNTRUSTED, bare, displayName, materialBlock, pointer, shortDate, sourcedLine, wordsFor,
  type Artefact, type Group, type MaterialMessage, type Words,
} from "./mailDocuments";

// The person fiche as a hub — lot 3 of specs/contacts.md, 27 September 2026.
//
// Lot 5 of the mail import wrote one note per correspondent, keyed on one
// address. A person is more than an address: their addresses, the member's
// mailboxes they write to, their card in the member's address book, and what
// the garden holds about them. This is where the mail pass writes it now:
//
//   people/<locale>/<slug>-fiche.md                 the hub — never published
//   people/<locale>/<slug>-fiche/_fragments/NNN.frag the fragments
//
// **Who is who.** The mail is grouped on the other party's address, as
// before; an address in exactly one card of the member's address book joins
// that card's person, confirmed — unless the mail contradicts it (the
// address writes under a name that shares nothing with the card's, or sits in
// two cards), where the link is pending with the conflict said. An address in
// no card is a person of its own, pending. A link the member rejected on the
// fiche is never made again. Guessing links between addresses without a card
// is lot 7.
//
// **The hub** carries its `status` (confirmed for a person in the address book
// or a fiche the member wrote, else pending), `carddav_uid`, `identities`
// (address, mailboxes, status, source, conflict), and the **relation** — who
// this person is to the member — once, in a section of the body, dated
// (`relation.since`, `relation.until`) and hashed: a section whose text no
// longer matches `relation.written_hash` was corrected by the member, is
// confirmed, is given to every later pass as a fact, and sends the pending
// fragments of that person back to be rewritten with it.
//
// **The fragments** tell the interactions — what is going on, what was
// promised, what is left open — never the relation. One call per person, as
// before; each line is filed in the fragment of the address and the mailbox
// of the first message it cites, so every fragment says where it comes from.
// A fragment is pending until the member touches it: a body that no longer
// matches its `written_hash`, or a status set by hand, is confirmed and never
// rewritten; new messages go to a new fragment beside it. Pending fragments
// are Maurice's and are rewritten with the new messages. A fragment thrown
// away stays away: its messages are counted as covered.
//
// **Second runs** are keyed on the person (`vcard:<uid>` or the address) in
// the store's `artefacts`, with every message the fiche has covered; a fiche
// the member threw away is never written again.

export type Status = "pending" | "confirmed" | "rejected";

export interface Identity {
  address: string;
  mailboxes: string[];
  status: Status;
  /** `guess`: joined to this person on the mail's own evidence (lot 7). */
  source: "vcard" | "mail" | "guess";
  conflict?: string;
  /** The names the address wrote under, or was written to under. */
  names?: string[];
  /** Why a guessed link was made. */
  guess?: string;
}

export interface Person {
  /** `vcard:<uid>` for a person in the address book, else the address. */
  key: string;
  card: ContactCard | null;
  name: string;
  identities: Identity[];
  messages: MaterialMessage[];
  /** Message id → the address of this person it was exchanged with. */
  addressOf: Map<string, string>;
  /** The keys of the people this one absorbed (lot 7): their fiches are
   *  folded into this one's before it is written. */
  absorbed?: string[];
}

/** The first 16 hex of the SHA-256 of a text, trimmed — the garden tool's
 *  `fragment_hash` computes the same (tools/garden/server.py). */
export function fragmentHash(text: string): string {
  return createHash("sha256").update(text.trim(), "utf8").digest("hex").slice(0, 16);
}

// ── Who is who ───────────────────────────────────────────────────────────

const tokens = (s: string): Set<string> =>
  new Set(s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2));

/** Whether a display name shares a word with any of a card's names, or is
 *  their initials ("JD" for Jean Derély). A name with no word to compare
 *  (empty, an address) contradicts nothing. */
function sameName(display: string, names: string[]): boolean {
  if (!display || display.includes("@")) return true;
  const d = tokens(display);
  if (!d.size) return true;
  return names.some((n) => {
    const t = [...tokens(n)];
    const initials = t.map((x) => x[0]).join("");
    return t.some((x) => d.has(x)) || (initials.length >= 2 && d.has(initials));
  });
}

const cardNames = (c: ContactCard): string[] => [c.full_name ?? "", ...c.nickname];
const personKeyOf = (c: ContactCard, address: string): string => `vcard:${c.uid ?? c.full_name ?? address}`;

/** Group the per-address groups into people, with the address book. Only
 *  people with enough messages come back, most messages first. */
export function resolvePeople(groups: Group[], cards: ContactCard[], rejected: Map<string, Set<string>> = new Map(), index?: FicheIndex): Person[] {
  const byAddress = new Map<string, ContactCard[]>();
  for (const c of cards) {
    for (const e of c.emails) {
      const k = e.toLowerCase();
      byAddress.set(k, [...(byAddress.get(k) ?? []), c]);
    }
  }
  const people = new Map<string, Person>();
  for (const g of groups) {
    const address = g.key;
    // Every name the address wrote under — a contradiction in any of them counts.
    const names = [...new Set(g.messages.filter((m) => bare(m.from ?? m.from_address) === address).map((m) => displayName(m.from)).filter((n) => n && !n.includes("@")))];
    const candidates = (byAddress.get(address) ?? []).filter((c) => !rejected.get(address)?.has(personKeyOf(c, address)));
    let card: ContactCard | null = null;
    let conflict: string | undefined;
    if (candidates.length) {
      card = candidates.find((c) => names.some((n) => tokens(n).size > 0 && sameName(n, cardNames(c)))) ?? candidates[0]!;
      const odd = names.find((n) => !sameName(n, cardNames(card!)));
      if (candidates.length > 1) conflict = `in ${candidates.length} cards of the address book`;
      else if (odd) conflict = `writes as « ${odd} »`;
    }
    const key = card ? personKeyOf(card, address) : address;
    const p: Person = people.get(key) ?? { key, card, name: card?.full_name || g.name || address, identities: [], messages: [], addressOf: new Map() };
    const seenAs = names.length ? names : g.name && !g.name.includes("@") ? [g.name] : [];
    p.identities.push({
      address,
      mailboxes: [...new Set(g.messages.flatMap((m) => m.mailboxes ?? []))].sort(),
      status: card && !conflict ? "confirmed" : "pending",
      source: card ? "vcard" : "mail",
      ...(conflict ? { conflict } : {}),
      ...(seenAs.length ? { names: seenAs.slice(0, 4) } : {}),
    });
    for (const m of g.messages) {
      if (p.addressOf.has(m.id)) continue;
      p.addressOf.set(m.id, address);
      p.messages.push(m);
    }
    people.set(key, p);
  }
  return mergeGuessed([...people.values()], cards, rejected, index)
    .map((p) => ({ ...p, messages: p.messages.sort((a, b) => (a.date ?? "").localeCompare(b.date ?? "") || a.id.localeCompare(b.id)) }))
    .filter((p) => p.messages.length >= MIN_MESSAGES)
    .sort((a, b) => b.messages.length - a.messages.length);
}

// ── Guessed links (lot 7) ────────────────────────────────────────────────
//
// Two people are one when the mail says so twice: the same full name (two
// words at least, in any order, accents and case aside) AND one more strong
// signal — every address of both spells that name (`paola.magi@`,
// `magipaola@`, `brosse@` for Jonathan Brosse), or the two wrote in the same
// thread, or both are cards of the member's address book under that name
// (a duplicated card). The body of a message is not kept, so a signature or
// a phone number cannot be the second signal. The name alone joins nothing,
// and a link the member rejected is never made again. The joined addresses
// are pending, `source: guess`, with the reason; one ✗ on the fiche splits
// an address back out (splitAddress below).

const nameKey = (n: string): string => [...tokens(n)].sort().join(" ");

function personNames(p: Person): Set<string> {
  const out = new Set<string>();
  for (const n of [p.card?.full_name ?? "", ...(p.card?.nickname ?? []), ...p.identities.flatMap((i) => i.names ?? [])]) {
    const k = nameKey(n);
    if (k.split(" ").length >= 2) out.add(k);
  }
  return out;
}

/** Whether an address's local part spells a name: its words are words of
 *  the name (`paola.magi`, `brosse`), or it is the name's words run together
 *  in some order (`magipaola`). */
export function spellsName(address: string, key: string): boolean {
  const local = (address.split("@")[0] ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const parts = local.split(/[^a-z]+/).filter((x) => x.length >= 2);
  const name = key.split(" ");
  if (parts.length && parts.every((x) => name.includes(x))) return true;
  const joined = local.replace(/[^a-z]/g, "");
  // An initial and another word of the name: `pmagi`, `jbrosse`, `magip`.
  if (name.some((x) => name.some((y) => y !== x && (joined === x[0] + y || joined === y + x[0])))) return true;
  const perms = (xs: string[]): string[][] => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => perms([...xs.slice(0, i), ...xs.slice(i + 1)]).map((r) => [x, ...r])));
  return name.length <= 4 && perms(name).some((ps) => ps.join("") === joined);
}

function mergeGuessed(people: Person[], cards: ContactCard[], rejected: Map<string, Set<string>>, index?: FicheIndex): Person[] {
  const names = people.map(personNames);
  const threads = people.map((p) => new Set(p.messages.map((m) => m.thread).filter(Boolean) as string[]));
  const parent = people.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const why = new Map<number, string>();
  for (let i = 0; i < people.length; i++) {
    for (let j = i + 1; j < people.length; j++) {
      const shared = [...names[i]!].find((k) => names[j]!.has(k));
      if (!shared) continue;
      const a = people[i]!, b = people[j]!;
      const spell = [...a.identities, ...b.identities].every((id) => spellsName(id.address, shared));
      const thread = [...threads[i]!].some((t) => threads[j]!.has(t));
      const cardsAlike = !!a.card && !!b.card && nameKey(a.card.full_name ?? "") === shared && nameKey(b.card.full_name ?? "") === shared;
      if (!spell && !thread && !cardsAlike) continue;
      parent[find(j)] = find(i);
      why.set(j, `same name « ${shared} » and ${spell ? "every address spells it" : thread ? "a thread in common" : "two cards of the address book under it"}`);
      why.set(i, why.get(i) ?? why.get(j)!);
    }
  }
  const clusters = new Map<number, number[]>();
  people.forEach((_, i) => clusters.set(find(i), [...(clusters.get(find(i)) ?? []), i]));
  const out: Person[] = [];
  for (const members of clusters.values()) {
    if (members.length === 1) { out.push(people[members[0]!]!); continue; }
    // The one the others fold into: a fiche the member wrote, then a person
    // of the address book, then one with a fiche already, then the most mail.
    const rank = (p: Person) => {
      const ref = index?.byKey.get(p.key) ?? (p.card?.uid ? index?.byUid.get(p.card.uid) : undefined);
      return [ref && ref.fm.meta?.author !== "maurice" ? 1 : 0, p.card ? 1 : 0, ref ? 1 : 0, p.messages.length];
    };
    const sorted = [...members].sort((x, y) => {
      const a = rank(people[x]!), b = rank(people[y]!);
      for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return b[k]! - a[k]!;
      return 0;
    });
    const target = people[sorted[0]!]!;
    const merged: Person = { ...target, identities: [...target.identities], messages: [...target.messages], addressOf: new Map(target.addressOf), absorbed: [] };
    for (const i of sorted.slice(1)) {
      const other = people[i]!;
      // A link the member rejected stays apart.
      if (other.identities.some((id) => rejected.get(id.address)?.has(target.key))) { out.push(other); continue; }
      merged.absorbed!.push(other.key);
      for (const id of other.identities) {
        const cardSame = id.source === "vcard" && target.card && other.card?.uid === target.card.uid;
        merged.identities.push(cardSame ? id : { ...id, status: "pending", source: "guess", guess: why.get(i) ?? "same name" });
      }
      for (const m of other.messages) {
        if (merged.addressOf.has(m.id)) continue;
        merged.addressOf.set(m.id, other.addressOf.get(m.id)!);
        merged.messages.push(m);
      }
    }
    out.push(merged);
  }
  return out;
}

// ── The fiches already in the garden ─────────────────────────────────────

export interface FicheRef {
  file: string;
  /** The file's basename without `.md` — `<slug>-fiche`. */
  basename: string;
  locale: string;
  fm: Record<string, any>;
  body: string;
}

export interface FicheIndex {
  byUid: Map<string, FicheRef>;
  byKey: Map<string, FicheRef>;
  /** Address → the person keys the member said it does not belong to. */
  rejected: Map<string, Set<string>>;
  /** Basenames taken, per locale, so two new people never share one. */
  taken: Set<string>;
  all: FicheRef[];
}

export function indexPeopleFiches(garden: GardenRef): FicheIndex {
  const idx: FicheIndex = { byUid: new Map(), byKey: new Map(), rejected: new Map(), taken: new Set(), all: [] };
  const root = path.join(garden.root, "people");
  if (!fs.existsSync(root)) return idx;
  for (const locale of fs.readdirSync(root)) {
    const dir = path.join(root, locale);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith("-fiche.md")) continue;
      const file = path.join(dir, f);
      const parsed = parseFiche(fs.readFileSync(file, "utf8"));
      if (!parsed) continue;
      const ref: FicheRef = { file, basename: f.slice(0, -3), locale, fm: parsed.frontmatter, body: parsed.body };
      idx.taken.add(`${locale}/${ref.basename}`);
      idx.all.push(ref);
      const uid = ref.fm.carddav_uid ? String(ref.fm.carddav_uid) : null;
      if (uid && !idx.byUid.has(uid)) idx.byUid.set(uid, ref);
      const key = ref.fm.meta?.person_key ? String(ref.fm.meta.person_key) : uid ? `vcard:${uid}` : null;
      if (key) {
        idx.byKey.set(key, ref);
        for (const id of Array.isArray(ref.fm.identities) ? ref.fm.identities : []) {
          if (id?.status === "rejected" && id.address) {
            const a = String(id.address).toLowerCase();
            idx.rejected.set(a, new Set([...(idx.rejected.get(a) ?? []), key]));
          }
        }
      }
    }
  }
  return idx;
}

// ── The body's relation section ──────────────────────────────────────────

/** The text under `## <heading>`, up to the next `## `; null when absent. */
export function sectionOf(body: string, heading: string): string | null {
  const lines = body.split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (/^##\s/.test(lines[i]!)) { end = i; break; }
  return lines.slice(start + 1, end).join("\n").trim();
}

/** The section put right after another one (or replaced where it is). */
export function placeAfter(body: string, heading: string, text: string, after: string): string {
  if (sectionOf(body, heading) !== null) return withSection(body, heading, text);
  const lines = body.replace(/\s+$/, "").split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${after}`);
  if (start < 0) return withSection(body, heading, text);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (/^##\s/.test(lines[i]!)) { end = i; break; }
  const out = [...lines.slice(0, end), "", `## ${heading}`, "", text, "", ...lines.slice(end)];
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/** The body with that section's text replaced, or the section put first. */
export function withSection(body: string, heading: string, text: string): string {
  const lines = body.split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start < 0) return `## ${heading}\n\n${text}\n\n${body.replace(/^\n+/, "")}`.trimEnd() + "\n";
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (/^##\s/.test(lines[i]!)) { end = i; break; }
  return [...lines.slice(0, start + 1), "", text, "", ...lines.slice(end)].join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/** The body without that section, heading and text. */
export function withoutSection(body: string, heading: string): string {
  const lines = body.split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start < 0) return body;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (/^##\s/.test(lines[i]!)) { end = i; break; }
  return [...lines.slice(0, start), ...lines.slice(end)].join("\n").replace(/^\n+/, "");
}

/** The body with that section's text replaced where it stands, else put
 *  before the `## <before>` section, else at the end — for a section that
 *  must not open the body, where the relation stands. */
export function placeSection(body: string, heading: string, text: string, before: string): string {
  if (sectionOf(body, heading) !== null) return withSection(body, heading, text);
  const lines = body.replace(/\s+$/, "").split("\n");
  const at = lines.findIndex((l) => l.trim() === `## ${before}`);
  const block = [`## ${heading}`, "", text, ""];
  const out = at < 0 ? [...lines, "", ...block] : [...lines.slice(0, at), ...block, ...lines.slice(at)];
  return out.join("\n").replace(/^\n+/, "").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

// ── The exchanges ────────────────────────────────────────────────────────
//
// What the fiche says of the mail itself, beside what it means: how many
// messages, since when, the last one, and the newest few, each linked to
// its message. Read from the header store (the email tool's `exchanges`,
// every message from, to or copied to the person's addresses — not only the
// ones read), written without a model, and set again on every pass, so the
// fiche answers "when did we last write" up to the last night walk. A night
// with no new mail writes the same text, and the file is not touched.

export interface Exchanges {
  total: number;
  first: string | null;
  last: string | null;
  messages: Array<{ id: string; date: string | null; from: string | null; subject: string | null; mailboxes?: string[] }>;
}

/** How many of the newest the fiche lists. */
export const EXCHANGES_SHOWN = 12;

export function exchangesSection(ex: Exchanges, w: Words, locale: string, labels: Map<string, string>): string | null {
  if (!ex.total || !ex.messages?.length) return null;
  const lines = ex.messages.slice(0, EXCHANGES_SHOWN).map((m) =>
    `- ${pointer({ id: m.id, message_id: null, from: m.from, from_address: null, to: [], cc: [], date: m.date, subject: m.subject, thread: null, reading: {}, mailboxes: m.mailboxes ?? [] }, locale, labels)}`);
  return `${w.exchangesCount(ex.total, shortDate(ex.first, locale), shortDate(ex.last, locale))}\n\n${lines.join("\n")}`;
}

// ── The fragments on disk ────────────────────────────────────────────────

interface MailFragment {
  file: string;
  fm: Record<string, any>;
  body: string;
  bucket: string;
  sources: string[];
  /** The member touched it — or confirmed it by hand. */
  confirmed: boolean;
}

function readMailFragments(ficheFile: string): MailFragment[] {
  const dir = fragmentsDir(ficheFile);
  if (!fs.existsSync(dir)) return [];
  const out: MailFragment[] = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".frag")).sort()) {
    const file = path.join(dir, f);
    const parsed = parseFiche(fs.readFileSync(file, "utf8"));
    if (!parsed || parsed.frontmatter.origin !== "mail") continue;
    const fm = parsed.frontmatter;
    const touched = !!fm.written_hash && fragmentHash(parsed.body) !== String(fm.written_hash);
    out.push({
      file, fm, body: parsed.body,
      bucket: `${fm.address ?? ""}|${fm.mailbox ?? ""}`,
      sources: Array.isArray(fm.sources) ? fm.sources.map(String) : [],
      confirmed: touched || fm.status === "confirmed",
    });
  }
  return out;
}

function nextFragmentFile(ficheFile: string, taken: Set<string>): string {
  const dir = fragmentsDir(ficheFile);
  const nums = (fs.existsSync(dir) ? fs.readdirSync(dir) : [])
    .filter((f) => f.endsWith(".frag")).map((f) => Number(path.basename(f, ".frag")))
    .concat([...taken].map((f) => Number(path.basename(f, ".frag"))))
    .filter((n) => Number.isInteger(n));
  const file = path.join(dir, `${String((nums.length ? Math.max(...nums) : 0) + 1).padStart(3, "0")}.frag`);
  taken.add(file);
  return file;
}

/** The fiche's addresses with what the mail says now: a status the member
 *  gave (confirmed, rejected) is kept; a pending one follows the evidence. */
function mergeIdentities(priorRaw: unknown, current: Identity[]): Identity[] {
  const prior: Identity[] = Array.isArray(priorRaw) ? (priorRaw as Identity[]) : [];
  const identities: Identity[] = prior.map((i) => ({ ...i }));
  for (const id of current) {
    const same = identities.find((i) => String(i.address).toLowerCase() === id.address);
    if (!same) identities.push({ ...id });
    else {
      same.mailboxes = [...new Set([...(same.mailboxes ?? []), ...id.mailboxes])].sort();
      if (id.names?.length) same.names = [...new Set([...(same.names ?? []), ...id.names])].slice(0, 4);
      if (same.status === "pending") Object.assign(same, { status: id.status, source: id.source, conflict: id.conflict, guess: id.guess });
      if (!same.conflict) delete same.conflict;
      if (!same.guess) delete same.guess;
    }
  }
  return identities;
}

// ── Folding the fiches of people found to be one (lot 7) ─────────────────

/** Before a merged person is written: the fiche it is written into (its
 *  own, else the member's fiche on that name, else one of the absorbed
 *  people's), the absorbed people's mail fragments moved into it, their
 *  fiches removed when Maurice made them. Returns the files touched and the
 *  store keys to forget. */
export function consolidate(garden: GardenRef, index: FicheIndex, artefactOf: (key: string) => Artefact | null, p: Person): { files: string[]; forget: string[] } {
  const files: string[] = [];
  const forget: string[] = [];
  const locate = (key: string, uid?: string | null): FicheRef | null => {
    const a = artefactOf(key);
    if (a && !a.deleted_at && a.slug) {
      const file = path.join(garden.root, "people", a.locale, `${a.slug}.md`);
      if (fs.existsSync(file)) {
        const parsed = parseFiche(fs.readFileSync(file, "utf8"));
        if (parsed) return { file, basename: a.slug, locale: a.locale, fm: parsed.frontmatter, body: parsed.body };
      }
    }
    return index.byKey.get(key) ?? (uid ? index.byUid.get(uid) ?? null : null);
  };
  let target = locate(p.key, p.card?.uid);
  const moveFragments = (from: FicheRef, to: FicheRef) => {
    const taken = new Set<string>();
    for (const f of readMailFragments(from.file)) {
      const dest = nextFragmentFile(to.file, taken);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(f.file, dest);
      files.push(f.file, dest);
    }
  };
  const removeFiche = (ref: FicheRef) => {
    for (const [uid, r] of index.byUid) if (r.file === ref.file) index.byUid.delete(uid);
    for (const [k, r] of index.byKey) if (r.file === ref.file) index.byKey.delete(k);
    const dir = path.join(path.dirname(ref.file), ref.basename);
    for (const x of fs.existsSync(path.join(dir, "_fragments")) ? fs.readdirSync(path.join(dir, "_fragments")) : []) files.push(path.join(dir, "_fragments", x));
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(ref.file, { force: true });
    files.push(ref.file);
  };
  // The member's own fiche on this name, with a card of that name: the
  // person is theirs already. A fiche Maurice made for them folds into it —
  // its fragments, and its relation when the member's fiche has none.
  const names = personNames(p);
  const spelt = p.identities.every((id) => [...names].some((k) => spellsName(id.address, k)));
  const theirs = index.all.find((r) => r.file !== target?.file && r.fm.meta?.author !== "maurice" && r.fm.carddav_uid
    && names.has(nameKey(String(r.fm.title ?? ""))) && (spelt || !!p.card) && fs.existsSync(r.file));
  if (theirs && (!target || target.fm.meta?.author === "maurice")) {
    let body = theirs.body;
    const fm: Record<string, any> = { ...theirs.fm, meta: { ...(theirs.fm.meta ?? {}), person_key: p.key } };
    if (target) {
      moveFragments(target, theirs);
      const heading = Object.keys(target.fm.relation ?? {}).length ? findHeading(target.body) : null;
      if (heading && !theirs.fm.relation) {
        body = withSection(body, heading, sectionOf(target.body, heading) ?? "");
        fm.relation = target.fm.relation;
      }
      if (Array.isArray(target.fm.identities)) fm.identities = mergeIdentities(fm.identities, target.fm.identities);
      removeFiche(target);
      forget.push(p.key);
      index.byKey.delete(p.key);
    }
    atomicWrite(theirs.file, `---\n${dumpFrontmatter(fm)}\n---\n\n${body.replace(/^\n+/, "")}`);
    files.push(theirs.file);
    target = { ...theirs, fm, body };
  }
  for (const key of p.absorbed ?? []) {
    const ref = locate(key);
    forget.push(key);
    if (!ref || ref.file === target?.file) continue;
    if (!target) {
      // The first absorbed fiche becomes the person's.
      target = ref;
      target.fm = { ...ref.fm, meta: { ...(ref.fm.meta ?? {}), person_key: p.key }, ...(p.card?.uid && !ref.fm.carddav_uid ? { carddav_uid: p.card.uid } : {}) };
      atomicWrite(target.file, `---\n${dumpFrontmatter(target.fm)}\n---\n\n${target.body.replace(/^\n+/, "")}`);
      files.push(target.file);
      continue;
    }
    moveFragments(ref, target);
    if (ref.fm.meta?.author === "maurice") {
      removeFiche(ref);
      index.byKey.delete(key);
    }
  }
  if (target) index.byKey.set(p.key, target);
  return { files, forget };
}

/** The heading of a relation section the pass wrote: the first `## ` of
 *  the body (the relation always opens it). */
function findHeading(body: string): string | null {
  const m = body.match(/^## (.+)$/m);
  return m ? m[1]!.trim() : null;
}

/** The member rejected an address on a fiche: that address is somebody
 *  else. Its mail fragments move to a fiche of its own — pending, keyed on
 *  the address — so the next pass carries on there; the rejected link stays
 *  on the first fiche so it is never made again. Returns the files touched. */
export function splitAddress(garden: GardenRef, ficheFile: string, locale: string, address: string, names: string[], disclaimer: { heading: string; text: string }): string[] {
  const frags = readMailFragments(ficheFile).filter((f) => String(f.fm.address ?? "").toLowerCase() === address.toLowerCase());
  // Nothing written from it: the next pass will make its fiche if it earns one.
  if (!frags.length) return [];
  const title = names.find((n) => n && !n.includes("@")) || address;
  const base = slugify(title) || slugify(address.split("@")[0] ?? "") || "personne";
  let slug = base;
  for (let i = 2; fs.existsSync(fichePath(garden, "people", locale, slug)); i++) slug = `${base}-${i}`;
  const file = fichePath(garden, "people", locale, slug);
  const fm = {
    title, resource_collection: "people", resource_id: slug, date: new Date().toISOString().slice(0, 10), tags: ["mail"], locale,
    status: "pending",
    identities: [{ address, mailboxes: [...new Set(frags.map((f) => String(f.fm.mailbox ?? "")).filter(Boolean))].sort(), status: "pending", source: "mail", ...(names.length ? { names } : {}) }],
    meta: { opened: false, author: "maurice", origin: "mail", person_key: address.toLowerCase() },
  };
  atomicWrite(file, `---\n${dumpFrontmatter(fm as any)}\n---\n\n## ${disclaimer.heading}\n\n${disclaimer.text}\n`);
  const out = [file];
  const taken = new Set<string>();
  for (const f of frags) {
    const dest = nextFragmentFile(file, taken);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(f.file, dest);
    out.push(f.file, dest);
  }
  return out;
}

// ── The prompt ───────────────────────────────────────────────────────────

export function personSystem(member: string, language: string, opts: { known: boolean; relation: string | null }): string {
  const gate = opts.known
    ? `This person is in ${member}'s address book: they are a person. Answer {"is_person": false, "why": "..."} only if they are ${member} themselves on another address of theirs. `
    : `First decide whether the correspondent is a person at all: a company, a shop, a platform, a team or a service writing notices, receipts, security advisories or offers is not, and neither is ${member} themselves on another address of theirs — an alias, a forward, a copy sent to oneself, mail signed by ${member} — answer {"is_person": false, "why": "..."} and nothing else. `;
  const relation = opts.relation
    ? `${member} has said who this person is to them: « ${opts.relation} ». That is established; do not redefine it, and do not write a relation. `
    : `Say who this person is to ${member} in one or two sentences, dated — since when, and until when if the mail shows it ended (a departure, a last day, a new position elsewhere). Be careful whose relation it is: someone who writes to ${member} about a child, a partner or a colleague of theirs (the child's music teacher, the partner's doctor) is that person's, not ${member}'s own — say whose. `;
  return (
    `You write, for ${member}, what their mail with one person says — the interactions, not a portrait: what is going on now, what was promised and by whom, what is left open. ` +
    gate + relation +
    `Write in ${language}, plainly, addressing ${member} in the second person and in the familiar register the language has (in French, tu, never vous); do not assume ${member}'s gender, use their name. Be concrete and short. Do not invent and do not soften: "did not answer" is not "refused". ` +
    `EVERY line ends with the numbers of the messages it comes from, in brackets, like [3] or [1][4]; a line you cannot source, do not write. ` +
    `${UNTRUSTED} ` +
    `Answer with JSON only: {"is_person": true, "title": "the person's name as ${member} would say it", ` +
    (opts.relation ? "" : `"relation": {"text": "one or two sentences [n]", "since": "YYYY-MM or null", "until": "YYYY-MM or null"}, `) +
    `"going_on": ["... [n]"], "promised": ["who promised what, by when [n]"], "open": ["... [n]"]}. Empty lists are fine.`
  );
}

// ── A confirmed relation, revisited ──────────────────────────────────────
//
// A relation the member confirmed is never rewritten: their word prevails.
// But it was confirmed on what had been read then — on the owner's first
// mailbox, a colleague was "someone who sends New Year wishes" — and a
// mailbox read later can change who the person is. So the relation keeps
// what it rests on (`basis`: how many of the person's messages it saw, and
// from which mailboxes); when the person has grown — REVISIT_MIN more
// messages, or messages from a mailbox the basis did not have — Maurice
// writes a revised relation beside the confirmed one, under its own heading,
// for the member to accept or refuse (services/personReview.ts). Nothing is
// replaced without them; asked once per growth, not every night.

/** More messages than the basis before a confirmed relation is revisited. */
export const REVISIT_MIN = 5;

export interface RelationBasis {
  messages: number;
  mailboxes: string[];
}

/** What a relation rests on: recorded since 28 September 2026; for an older
 *  one, the person's messages up to the newest one it cites — what there
 *  was when it was written. A relation citing nothing that is still in the
 *  material rests on everything there is (nothing to revisit). */
export function relationBasis(rel: Record<string, any>, messages: MaterialMessage[]): RelationBasis {
  if (rel.basis && typeof rel.basis.messages === "number") {
    return { messages: rel.basis.messages, mailboxes: Array.isArray(rel.basis.mailboxes) ? rel.basis.mailboxes.map(String) : [] };
  }
  const cited = new Set((Array.isArray(rel.sources) ? rel.sources : []).map(String));
  const upTo = messages.filter((m) => cited.has(m.id)).map((m) => m.date ?? "").sort().at(-1);
  const seen = upTo ? messages.filter((m) => (m.date ?? "") <= upTo) : messages;
  return { messages: seen.length, mailboxes: [...new Set(seen.flatMap((m) => m.mailboxes ?? []))] };
}

export function basisNow(messages: MaterialMessage[]): RelationBasis {
  return { messages: messages.length, mailboxes: [...new Set(messages.flatMap((m) => m.mailboxes ?? []))].sort() };
}

/** Whether the person has grown enough past the relation's basis. */
export function relationGrown(rel: Record<string, any>, messages: MaterialMessage[]): boolean {
  const b = relationBasis(rel, messages);
  const now = basisNow(messages);
  return now.messages - b.messages >= REVISIT_MIN || now.mailboxes.some((x) => !b.mailboxes.includes(x));
}

export function revisitSystem(member: string, language: string, confirmed: string): string {
  return (
    `You keep, for ${member}, who a person is to them. ${member} confirmed this relation: « ${confirmed} ». ` +
    `More of their mail with this person has been read since. If the messages below show that the relation is now materially different or broader — another role, another context: a colleague, not only someone who sends greetings — write the revised relation in one or two sentences, dated (since when, until when if it ended), keeping what still holds of the confirmed one. If the confirmed relation still says it well, answer null. ` +
    `Write in ${language}, addressing ${member} in the second person and in the familiar register (in French, tu); do not assume ${member}'s gender. EVERY sentence ends with the numbers of the messages it comes from, in brackets, like [3] or [1][4]. ${UNTRUSTED} ` +
    `Answer with JSON only: {"relation": {"text": "one or two sentences [n]", "since": "YYYY-MM or null", "until": "YYYY-MM or null"}} or {"relation": null}.`
  );
}

// ── One person ───────────────────────────────────────────────────────────

export interface PersonContext {
  garden: GardenRef;
  locale: string;
  language: string;
  member: string;
  w: Words;
  labels: Map<string, string>;
  now: Date;
  index: FicheIndex;
  artefact: Artefact | null;
  /** What the header store says was exchanged with them; null when it
   *  could not be read, and the fiche's section is then left as it is. */
  exchanges?: Exchanges | null;
  /** The language of this person's messages, when they share one the
   *  documents can be written in (6 October 2026): a new fiche is written in
   *  it, and filed under the member's `locale` all the same — that is where
   *  their garden is. Absent, the member's language. */
  noteLanguage?: string | null;
  ask: (system: string, prompt: string) => Promise<AncillaryResult>;
}

export type PersonOutcome =
  | { kind: "unchanged"; files?: string[] }
  | { kind: "deleted"; found: boolean }
  | { kind: "declined"; sources: string[] }
  | { kind: "empty"; stop: string; files?: string[] }
  | { kind: "written"; basename: string; locale: string; title: string; covered: string[]; files: string[]; webPath: string; fragments: number; cited: number };

const SECTION_KEYS = ["going_on", "promised", "open"] as const;

/** Write, or not, one person's fiche and fragments. Throws only what `ask`
 *  throws (the cap). */
export async function writePerson(ctx: PersonContext, p: Person): Promise<PersonOutcome> {
  const { garden, now } = ctx;
  const a = ctx.artefact;
  // Thrown away, or declined as not a person: never again.
  if (a?.deleted_at) return { kind: "deleted", found: false };

  // Where the fiche is: the one written before, else the member's own for
  // this card, else one written under this key the store forgot.
  let ref: FicheRef | null = null;
  if (a) {
    const file = path.join(garden.root, "people", a.locale, `${a.slug}.md`);
    if (!fs.existsSync(file)) return { kind: "deleted", found: true };
    const parsed = parseFiche(fs.readFileSync(file, "utf8"));
    if (parsed) ref = { file, basename: a.slug, locale: a.locale, fm: parsed.frontmatter, body: parsed.body };
  }
  if (!ref) ref = ctx.index.byKey.get(p.key) ?? null;
  if (!ref && p.card?.uid) ref = ctx.index.byUid.get(p.card.uid) ?? null;
  // A fiche folded away since the index was read is not one to write into.
  if (ref && !fs.existsSync(ref.file)) ref = null;

  const byMaurice = !ref || ref.fm.meta?.author === "maurice";
  const locale = ref?.locale ?? ctx.locale;
  // The language of the text: a fiche keeps the one it was first written in
  // — its headings are how its sections are found again — and a new one
  // takes its messages' when they share one, else the member's.
  const kept = typeof ref?.fm.meta?.language === "string" ? String(ref.fm.meta.language) : null;
  const lang = ref ? (kept && LANGUAGE[kept] ? kept : LANGUAGE[ref.locale] ? ref.locale : ctx.locale) : (ctx.noteLanguage && LANGUAGE[ctx.noteLanguage] ? ctx.noteLanguage : ctx.locale);
  const w = lang === ctx.locale ? ctx.w : wordsFor(lang);
  const language = lang === ctx.locale ? ctx.language : LANGUAGE[lang]!;
  const fragments = ref ? readMailFragments(ref.file) : [];
  const pending = fragments.filter((f) => !f.confirmed);

  // The relation, and whether the member corrected it.
  const relFm: Record<string, any> = (ref?.fm.relation && typeof ref.fm.relation === "object") ? { ...ref.fm.relation } : {};
  const relText = ref ? sectionOf(ref.body, w.relationship) : null;
  const relEdited = !!relText && !!relFm.written_hash && fragmentHash(relText) !== String(relFm.written_hash);
  const relSettled = relFm.status === "confirmed" || relFm.status === "rejected" || relEdited;
  // Corrected in a text editor (the text moved, the status did not), or on
  // the fiche's page (services/personReview.ts marks it `rewrite`).
  const force = (relEdited && relFm.status !== "confirmed") || relFm.rewrite === true;

  // The addresses follow the evidence whatever the model does below.
  const touchedIds: string[] = [];
  if (ref) {
    const ids = mergeIdentities(ref.fm.identities, p.identities);
    if (JSON.stringify(ids) !== JSON.stringify(ref.fm.identities ?? [])) {
      ref.fm = { ...ref.fm, identities: ids };
      atomicWrite(ref.file, `---\n${dumpFrontmatter(ref.fm)}\n---\n\n${ref.body.replace(/^\n+/, "")}`);
      touchedIds.push(ref.file);
    }
  }
  const exchanges = ctx.exchanges ? exchangesSection(ctx.exchanges, w, lang, ctx.labels) : null;

  // A confirmed relation the person has outgrown: a revision proposed
  // beside it, never in its place. Asked once per growth — the basis moves
  // on whatever the model answers.
  if (ref && relFm.status === "confirmed" && !relFm.proposed && relText && relationGrown(relFm, p.messages)) {
    const material = p.messages.slice(-MAX_PER_NOTE);
    const confirmed = relText.replace(/\s*[—;]?\s*\[[^\]]*\]\(maurice-mail:[^)]*\)/g, "").replace(/\s+/g, " ").trim();
    const rr = await ctx.ask(revisitSystem(ctx.member, language, confirmed), materialBlock(material));
    const dd = parseJsonObject(rr.text);
    const proposal = dd?.relation && typeof dd.relation.text === "string" ? sourcedLine(dd.relation.text, material, lang, ctx.labels) : null;
    const ymd = (v: unknown) => (typeof v === "string" && /^\d{4}(-\d{2})?$/.test(v) ? v : null);
    relFm.basis = basisNow(p.messages);
    if (proposal) {
      ref.body = placeAfter(ref.body, w.relationProposed, proposal.text, w.relationship);
      relFm.proposed = {
        sources: proposal.ids, since: ymd(dd.relation.since), until: ymd(dd.relation.until),
        written_hash: fragmentHash(proposal.text), model: rr.model, written_at: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
      };
    }
    ref.fm = { ...ref.fm, relation: relFm };
    atomicWrite(ref.file, `---\n${dumpFrontmatter(ref.fm)}\n---\n\n${ref.body.replace(/^\n+/, "")}`);
    if (!touchedIds.includes(ref.file)) touchedIds.push(ref.file);
  }

  const covered = new Set<string>([...(a?.sources ?? []), ...fragments.flatMap((f) => f.sources)]);
  const fresh = p.messages.filter((m) => !covered.has(m.id));
  if (!fresh.length && !force) {
    // Nothing new to read, but the exchanges move on their own: mail the
    // reading passed over still counts, and a fiche written before the
    // section existed gets it.
    if (ref && exchanges && sectionOf(ref.body, w.exchanges) !== exchanges) {
      ref.body = placeSection(ref.body, w.exchanges, exchanges, w.provenance);
      atomicWrite(ref.file, `---\n${dumpFrontmatter(ref.fm)}\n---\n\n${ref.body.replace(/^\n+/, "")}`);
      if (!touchedIds.includes(ref.file)) touchedIds.push(ref.file);
    }
    return { kind: "unchanged", files: touchedIds };
  }

  const redo = new Set(pending.flatMap((f) => f.sources));
  const material = p.messages.filter((m) => !covered.has(m.id) || redo.has(m.id)).slice(-MAX_PER_NOTE);
  const settledRelation = relSettled && relFm.status !== "rejected" ? relText : null;
  const r = await ctx.ask(personSystem(ctx.member, language, { known: !!p.card, relation: settledRelation }), materialBlock(material));
  const d = parseJsonObject(r.text);
  if (!d) return { kind: "empty", stop: r.stop, files: touchedIds };
  // Not a person — or, for someone in the address book, the member
  // themselves on another address: no fiche, and not asked again.
  if (d.is_person === false) return { kind: "declined", sources: material.map((m) => m.id) };

  // Every line into the fragment of the address and mailbox it comes from.
  const primary = (m: MaterialMessage) => [...(m.mailboxes ?? [])].sort()[0] ?? "";
  const byId = new Map(material.map((m) => [m.id, m]));
  const buckets = new Map<string, { address: string; mailbox: string; sections: Record<string, string[]>; ids: Set<string> }>();
  let cited = 0;
  for (const k of SECTION_KEYS) {
    for (const line of Array.isArray(d[k]) ? d[k] : []) {
      const sl = sourcedLine(String(line), material, lang, ctx.labels);
      if (!sl) continue;
      const first = byId.get(sl.ids[0]!)!;
      const address = p.addressOf.get(first.id) ?? "";
      const mailbox = primary(first);
      const key = `${address}|${mailbox}`;
      const b = buckets.get(key) ?? { address, mailbox, sections: {}, ids: new Set<string>() };
      (b.sections[k] ??= []).push(`- ${sl.text}`);
      sl.ids.forEach((i) => b.ids.add(i));
      buckets.set(key, b);
      cited++;
    }
  }
  let newRelation: { text: string; ids: string[] } | null = null;
  if (!relSettled && d.relation && typeof d.relation.text === "string") newRelation = sourcedLine(d.relation.text, material, lang, ctx.labels);
  if (!buckets.size && !newRelation && !ref) return { kind: "empty", stop: r.stop, files: touchedIds };

  // The fiche.
  const title = ref?.fm.title ? String(ref.fm.title) : (p.card?.full_name || (typeof d.title === "string" && d.title.trim()) || p.name);
  let file: string;
  let basename: string;
  if (ref) {
    file = ref.file;
    basename = ref.basename;
  } else {
    const base = slugify(title) || "personne";
    let slug = base;
    for (let i = 2; ctx.index.taken.has(`${locale}/${slug}-fiche`) || fs.existsSync(fichePath(garden, "people", locale, slug)); i++) slug = `${base}-${i}`;
    ctx.index.taken.add(`${locale}/${slug}-fiche`);
    file = fichePath(garden, "people", locale, slug);
    basename = `${slug}-fiche`;
  }
  const files: string[] = [file];

  // The fragments: a pending one of the same address and mailbox is
  // rewritten in place; the rest of the pending ones, whose messages were
  // just read again, go.
  const takenFiles = new Set<string>();
  const reused = new Set<string>();
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  for (const [key, b] of buckets) {
    const old = pending.find((f) => f.bucket === key && !reused.has(f.file));
    const target = old?.file ?? nextFragmentFile(file, takenFiles);
    if (old) reused.add(old.file);
    const body = SECTION_KEYS.filter((k) => b.sections[k]?.length)
      .map((k) => `## ${k === "going_on" ? w.goingOn : k === "promised" ? w.promised : w.open}\n\n${b.sections[k]!.join("\n")}`)
      .join("\n\n") + "\n";
    const dates = [...b.ids].map((i) => byId.get(i)?.date ?? "").filter(Boolean).sort();
    const span = dates.length ? (shortDate(dates[0]!, lang) === shortDate(dates[dates.length - 1]!, lang) ? shortDate(dates[0]!, lang) : `${shortDate(dates[0]!, lang)} → ${shortDate(dates[dates.length - 1]!, lang)}`) : "";
    const label = ctx.labels.get(b.mailbox) ?? b.mailbox;
    const fm = {
      summary: [w.fromMail, b.address, label, span].filter(Boolean).join(" · "),
      origin: "mail",
      status: "pending",
      address: b.address,
      mailbox: b.mailbox,
      sources: [...b.ids].sort(),
      model: r.model,
      written_at: stamp,
      written_hash: fragmentHash(body),
    };
    atomicWrite(target, `---\n${dumpFrontmatter(fm)}\n---\n${body}`);
    files.push(target);
  }
  for (const f of pending) {
    if (reused.has(f.file)) continue;
    fs.rmSync(f.file, { force: true });
    files.push(f.file);
  }
  // A fragment the member touched is theirs now: say so in its frontmatter.
  for (const f of fragments) {
    if (f.confirmed && f.fm.status !== "confirmed") {
      atomicWrite(f.file, `---\n${dumpFrontmatter({ ...f.fm, status: "confirmed" })}\n---\n${f.body}`);
      files.push(f.file);
    }
  }

  // The body: the relation section written or kept; a new fiche says what
  // it is.
  let body = ref?.body ?? "";
  let relation = relFm;
  if (newRelation) {
    body = withSection(body, w.relationship, newRelation.text);
    relation = {
      status: "pending",
      since: typeof d.relation.since === "string" && /^\d{4}(-\d{2})?$/.test(d.relation.since) ? d.relation.since : null,
      until: typeof d.relation.until === "string" && /^\d{4}(-\d{2})?$/.test(d.relation.until) ? d.relation.until : null,
      sources: newRelation.ids,
      written_hash: fragmentHash(newRelation.text),
      basis: basisNow(p.messages),
    };
  } else if (relEdited) {
    relation = { ...relFm, status: "confirmed" };
  }
  if ("rewrite" in relation) {
    const { rewrite: _done, ...rest } = relation;
    relation = rest;
  }
  if (!ref) body = `${body.trimEnd()}\n\n## ${w.provenance}\n\n${w.disclaimer}\n`;
  if (exchanges) body = placeSection(body, w.exchanges, exchanges, w.provenance);

  // The frontmatter: the member's own fiche keeps everything it had.
  const identities = mergeIdentities(ref?.fm.identities, p.identities);
  const fm: Record<string, any> = ref ? { ...ref.fm } : {
    title,
    resource_collection: "people",
    resource_id: basename.replace(/-fiche$/, ""),
    date: now.toISOString().slice(0, 10),
    tags: ["mail"],
    locale,
  };
  fm.status = ref?.fm.status ?? (p.card || !byMaurice ? "confirmed" : "pending");
  if (p.card?.uid && !fm.carddav_uid) fm.carddav_uid = p.card.uid;
  fm.identities = identities;
  if (Object.keys(relation).length) fm.relation = relation;
  const reviewed = ref ? isOpened(ref.fm) : false;
  fm.meta = byMaurice
    ? { ...(reviewed ? {} : { opened: false }), author: "maurice", origin: "mail", person_key: p.key, model: r.model, written_at: stamp, ...(lang !== locale ? { language: lang } : {}) }
    : { ...(ref?.fm.meta ?? {}), person_key: p.key };
  atomicWrite(file, `---\n${dumpFrontmatter(fm)}\n---\n\n${body.replace(/^\n+/, "")}`);

  return {
    kind: "written", basename, locale, title,
    covered: [...new Set([...covered, ...p.messages.map((m) => m.id)])].sort(),
    files, webPath: ficheWebPath(garden, "people", locale, basename.replace(/-fiche$/, "")),
    fragments: buckets.size, cited,
  };
}

// ── Erasing ──────────────────────────────────────────────────────────────

/** Every file the mail pass wrote in a garden — its notes, the fiches it
 *  created, the mail fragments it put on the member's own fiches — removed.
 *  The member's own fiches stay, without their mail fragments and the
 *  exchanges section. Returns the paths removed or changed. */
export function eraseMailFiles(garden: GardenRef): string[] {
  const removed: string[] = [];
  const notes = path.join(garden.root, "notes");
  for (const locale of fs.existsSync(notes) ? fs.readdirSync(notes) : []) {
    const dir = path.join(notes, locale);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".md"))) {
      const file = path.join(dir, f);
      const p = parseFiche(fs.readFileSync(file, "utf8"));
      if (p?.frontmatter.meta?.origin === "mail") {
        fs.rmSync(file, { force: true });
        removed.push(file);
      }
    }
  }
  const people = path.join(garden.root, "people");
  for (const locale of fs.existsSync(people) ? fs.readdirSync(people) : []) {
    const dir = path.join(people, locale);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith("-fiche.md"))) {
      const file = path.join(dir, f);
      const p = parseFiche(fs.readFileSync(file, "utf8"));
      if (!p) continue;
      if (p.frontmatter.meta?.origin === "mail" && p.frontmatter.meta?.author === "maurice") {
        const frags = fragmentsDir(file);
        if (fs.existsSync(frags)) for (const x of fs.readdirSync(frags)) removed.push(path.join(frags, x));
        fs.rmSync(path.join(dir, f.slice(0, -3)), { recursive: true, force: true });
        fs.rmSync(file, { force: true });
        removed.push(file);
      } else {
        for (const frag of readMailFragments(file)) {
          fs.rmSync(frag.file, { force: true });
          removed.push(frag.file);
        }
        // The exchanges the pass wrote into the member's own fiche go too;
        // the file itself stays.
        const heading = wordsFor(locale).exchanges;
        if (sectionOf(p.body, heading) !== null) {
          atomicWrite(file, `---\n${dumpFrontmatter(p.frontmatter)}\n---\n\n${withoutSection(p.body, heading).replace(/^\n+/, "")}`);
          removed.push(file);
        }
      }
    }
  }
  return removed;
}
