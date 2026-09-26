import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { atomicWrite, dumpFrontmatter, fichePath, ficheWebPath, fragmentsDir, isOpened, parseFiche, type GardenRef } from "../../data-api/services/gardenFiche";
import { slugify } from "../../data-api/services/articleExtract";
import type { AncillaryResult } from "./ancillary";
import type { ContactCard } from "./contactAccounts";
import { parseJsonObject } from "./domainMapping";
import {
  MAX_PER_NOTE, MIN_MESSAGES, UNTRUSTED, bare, displayName, materialBlock, shortDate, sourcedLine,
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
  source: "vcard" | "mail";
  conflict?: string;
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
export function resolvePeople(groups: Group[], cards: ContactCard[], rejected: Map<string, Set<string>> = new Map()): Person[] {
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
    p.identities.push({
      address,
      mailboxes: [...new Set(g.messages.flatMap((m) => m.mailboxes ?? []))].sort(),
      status: card && !conflict ? "confirmed" : "pending",
      source: card ? "vcard" : "mail",
      ...(conflict ? { conflict } : {}),
    });
    for (const m of g.messages) {
      if (p.addressOf.has(m.id)) continue;
      p.addressOf.set(m.id, address);
      p.messages.push(m);
    }
    people.set(key, p);
  }
  return [...people.values()]
    .map((p) => ({ ...p, messages: p.messages.sort((a, b) => (a.date ?? "").localeCompare(b.date ?? "") || a.id.localeCompare(b.id)) }))
    .filter((p) => p.messages.length >= MIN_MESSAGES)
    .sort((a, b) => b.messages.length - a.messages.length);
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
}

export function indexPeopleFiches(garden: GardenRef): FicheIndex {
  const idx: FicheIndex = { byUid: new Map(), byKey: new Map(), rejected: new Map(), taken: new Set() };
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

/** The body with that section's text replaced, or the section put first. */
export function withSection(body: string, heading: string, text: string): string {
  const lines = body.split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start < 0) return `## ${heading}\n\n${text}\n\n${body.replace(/^\n+/, "")}`.trimEnd() + "\n";
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (/^##\s/.test(lines[i]!)) { end = i; break; }
  return [...lines.slice(0, start + 1), "", text, "", ...lines.slice(end)].join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
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
  ask: (system: string, prompt: string) => Promise<AncillaryResult>;
}

export type PersonOutcome =
  | { kind: "unchanged" }
  | { kind: "deleted"; found: boolean }
  | { kind: "declined"; sources: string[] }
  | { kind: "empty"; stop: string }
  | { kind: "written"; basename: string; locale: string; title: string; covered: string[]; files: string[]; webPath: string; fragments: number; cited: number };

const SECTION_KEYS = ["going_on", "promised", "open"] as const;

/** Write, or not, one person's fiche and fragments. Throws only what `ask`
 *  throws (the cap). */
export async function writePerson(ctx: PersonContext, p: Person): Promise<PersonOutcome> {
  const { garden, w, now } = ctx;
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
  if (!ref && p.card?.uid) ref = ctx.index.byUid.get(p.card.uid) ?? null;
  if (!ref) ref = ctx.index.byKey.get(p.key) ?? null;

  const byMaurice = !ref || ref.fm.meta?.author === "maurice";
  const locale = ref?.locale ?? ctx.locale;
  const fragments = ref ? readMailFragments(ref.file) : [];
  const pending = fragments.filter((f) => !f.confirmed);

  // The relation, and whether the member corrected it.
  const relFm: Record<string, any> = (ref?.fm.relation && typeof ref.fm.relation === "object") ? { ...ref.fm.relation } : {};
  const relText = ref ? sectionOf(ref.body, w.relationship) : null;
  const relEdited = !!relText && !!relFm.written_hash && fragmentHash(relText) !== String(relFm.written_hash);
  const relSettled = relFm.status === "confirmed" || relFm.status === "rejected" || relEdited;
  const force = relEdited && relFm.status !== "confirmed";

  const covered = new Set<string>([...(a?.sources ?? []), ...fragments.flatMap((f) => f.sources)]);
  const fresh = p.messages.filter((m) => !covered.has(m.id));
  if (!fresh.length && !force) return { kind: "unchanged" };

  const redo = new Set(pending.flatMap((f) => f.sources));
  const material = p.messages.filter((m) => !covered.has(m.id) || redo.has(m.id)).slice(-MAX_PER_NOTE);
  const settledRelation = relSettled && relFm.status !== "rejected" ? relText : null;
  const r = await ctx.ask(personSystem(ctx.member, ctx.language, { known: !!p.card, relation: settledRelation }), materialBlock(material));
  const d = parseJsonObject(r.text);
  if (!d) return { kind: "empty", stop: r.stop };
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
      const sl = sourcedLine(String(line), material, locale, ctx.labels);
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
  if (!relSettled && d.relation && typeof d.relation.text === "string") newRelation = sourcedLine(d.relation.text, material, locale, ctx.labels);
  if (!buckets.size && !newRelation && !ref) return { kind: "empty", stop: r.stop };

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
    const span = dates.length ? (shortDate(dates[0]!, locale) === shortDate(dates[dates.length - 1]!, locale) ? shortDate(dates[0]!, locale) : `${shortDate(dates[0]!, locale)} → ${shortDate(dates[dates.length - 1]!, locale)}`) : "";
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
    };
  } else if (relEdited) {
    relation = { ...relFm, status: "confirmed" };
  }
  if (!ref) body = `${body.trimEnd()}\n\n## ${w.provenance}\n\n${w.disclaimer}\n`;

  // The frontmatter: the member's own fiche keeps everything it had.
  const prior: Identity[] = Array.isArray(ref?.fm.identities) ? ref!.fm.identities : [];
  const identities: Identity[] = [...prior.map((i) => ({ ...i }))];
  for (const id of p.identities) {
    const same = identities.find((i) => String(i.address).toLowerCase() === id.address);
    if (!same) identities.push(id);
    else {
      same.mailboxes = [...new Set([...(same.mailboxes ?? []), ...id.mailboxes])].sort();
      if (same.status === "pending") Object.assign(same, { status: id.status, source: id.source, conflict: id.conflict });
      if (!same.conflict) delete same.conflict;
    }
  }
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
    ? { ...(reviewed ? {} : { opened: false }), author: "maurice", origin: "mail", person_key: p.key, model: r.model, written_at: stamp }
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
 *  The member's own fiches stay, without their mail fragments. Returns the
 *  paths removed. */
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
      }
    }
  }
  return removed;
}
