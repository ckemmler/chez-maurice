import { ficheWebPath, gardenFor, type GardenRef } from "../../data-api/services/gardenFiche";
import { personView, type PersonView } from "./personReview";


// The "À vérifier" footer — lot 4 of specs/contacts.md, 27 September 2026.
//
// Maurice may use what is not confirmed yet in a person fiche — a relation,
// an address, a fragment written from mail — but the member must know which
// parts of an answer rest on it. The model is told (a mark on what it reads),
// and it may say so in its prose; the warning does not depend on it: the
// server notes every person fiche that entered the turn — through the garden
// tools, the corpus search, the context composer — and appends, without a
// model, a footer listing what in them is still pending, each line linking
// to the element on the fiche's page. What entered the turn, not what the
// answer used: one warning too many rather than one missing.
//
// A turn's fiches are kept by conversation id: one turn runs per
// conversation at a time (services/turns.ts), and the route takes them at
// the end of the turn.

interface Seen {
  locale: string;
  basename: string;
}

const turns = new Map<string, Map<string, Seen>>();

/** A turn begins: forget what the last one saw. */
export function startReview(conversationId: string): void {
  turns.set(conversationId, new Map());
}

function note(conversationId: string, locale: string, basename: string): void {
  const m = turns.get(conversationId);
  if (!m || !/^[a-z]{2}$/.test(locale) || !/^[a-z0-9-]+-fiche$/.test(basename)) return;
  m.set(`${locale}/${basename}`, { locale, basename });
}

/** A person fiche entered the turn some other way (a relation attached to
 *  a corpus hit, services/personContext.ts). */
export function noteFiche(conversationId: string, locale: string, basename: string): void {
  note(conversationId, locale, basename);
}

const PEOPLE_FILE = /\/people\/([a-z]{2})\/([a-z0-9-]+-fiche)(?:\.md|\/_fragments\/\d{3}\.frag)$/;

/** A garden path — a corpus hit's `file_path`, a composer fiche id — that
 *  is a person fiche or one of its fragments. */
export function personOfPath(p: string): Seen | null {
  const m = String(p).match(PEOPLE_FILE) ?? `/${p}`.match(/\/people\/([a-z]{2})\/([a-z0-9-]+-fiche)$/);
  return m ? { locale: m[1]!, basename: m[2]! } : null;
}

function viewOf(garden: GardenRef, s: Seen): PersonView | null {
  try {
    return personView(garden, s.locale, s.basename);
  } catch {
    return null;
  }
}

/** What the model is told beside a result that touches pending material. */
function markFor(views: PersonView[]): string {
  const parts = views.filter((v) => v.pending).map((v) => {
    const bits = [
      v.status === "pending" && v.byMaurice ? "the person" : "",
      v.relation.status === "pending" ? "the relation" : "",
      ...v.identities.filter((i) => i.status === "pending").map((i) => `the address ${i.address}${i.conflict ? ` (${i.conflict})` : ""}`),
      ...v.fragments.filter((f) => f.status === "pending").map((f) => `fragment ${f.id}`),
    ].filter(Boolean);
    return `${v.title}: ${bits.join(", ")}`;
  });
  if (!parts.length) return "";
  return `\n\n[Not confirmed by the member yet — written by Maurice from their mail: ${parts.join("; ")}. You may use it; when you do, say it is unconfirmed. A footer listing these for review is added to your reply by the system: do not write one yourself.]`;
}

/** A tool result came back: note the person fiches it touched, and return
 *  the mark to append to what the model reads ("" when nothing pending). */
export function noteTool(conversationId: string, memberId: string | null | undefined, name: string, input: any, rows: any[] | null): string {
  if (!memberId || !turns.has(conversationId)) return "";
  const garden = gardenFor(memberId);
  if (!garden) return "";
  const seen: Seen[] = [];
  const locale = typeof input?.locale === "string" ? input.locale : "en";
  if (name === "garden__get_fiche" && input?.resource_collection === "people" && input?.resource_id) {
    seen.push({ locale, basename: `${String(input.resource_id).replace(/-fiche$/, "")}-fiche` });
  } else if ((name === "garden__list_fragments" || name === "garden__get_fragment") && input?.collection === "people" && input?.parent_id) {
    seen.push({ locale, basename: `${String(input.parent_id).replace(/-fiche$/, "")}-fiche` });
  } else if (name === "corpus__search" && rows) {
    for (const r of rows) {
      const s = r?.file_path ? personOfPath(String(r.file_path)) : null;
      if (s) seen.push(s);
    }
  }
  const views: PersonView[] = [];
  for (const s of seen) {
    const v = viewOf(garden, s);
    if (!v) continue;
    note(conversationId, s.locale, s.basename);
    views.push(v);
  }
  return markFor(views);
}

/** The composer loaded these items: note the person fiches among them, and
 *  return the mark for the system prompt ("" when nothing pending). */
export function noteComposer(conversationId: string, memberId: string, items: Array<{ type: string; id: string | number }>): string {
  if (!turns.has(conversationId)) return "";
  const garden = gardenFor(memberId);
  if (!garden) return "";
  const views: PersonView[] = [];
  for (const i of items) {
    if (i.type !== "fiche") continue;
    const s = personOfPath(String(i.id));
    const v = s ? viewOf(garden, s) : null;
    if (!s || !v) continue;
    note(conversationId, s.locale, s.basename);
    views.push(v);
  }
  return markFor(views);
}

// ── The footer ───────────────────────────────────────────────────────────

const WORDS: Record<string, { head: string; person: string; relation: string; address: string; fragment: string; many: (n: number) => string }> = {
  fr: { head: "À vérifier — pas encore confirmé par toi", person: "la personne", relation: "la relation", address: "l'adresse", fragment: "fragment", many: (n) => `${n} éléments à vérifier` },
  en: { head: "To check — not confirmed by you yet", person: "the person", relation: "the relation", address: "the address", fragment: "fragment", many: (n) => `${n} items to check` },
  it: { head: "Da verificare — non ancora confermato da te", person: "la persona", relation: "la relazione", address: "l'indirizzo", fragment: "frammento", many: (n) => `${n} elementi da verificare` },
  de: { head: "Zu prüfen — noch nicht von dir bestätigt", person: "die Person", relation: "die Beziehung", address: "die Adresse", fragment: "Fragment", many: (n) => `${n} Punkte zu prüfen` },
  es: { head: "Por verificar — aún no confirmado por ti", person: "la persona", relation: "la relación", address: "la dirección", fragment: "fragmento", many: (n) => `${n} elementos por verificar` },
  pt: { head: "A verificar — ainda não confirmado por ti", person: "a pessoa", relation: "a relação", address: "o endereço", fragment: "fragmento", many: (n) => `${n} elementos a verificar` },
  nl: { head: "Na te kijken — nog niet door jou bevestigd", person: "de persoon", relation: "de relatie", address: "het adres", fragment: "fragment", many: (n) => `${n} punten na te kijken` },
};

const clip = (s: string, n = 90) => {
  const t = s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\s+/g, " ").replace(/ — .*$/, "").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** The footer for what the turn saw, as markdown, or null when nothing
 *  pending. `origin` makes the links absolute (the app opens nothing else). */
/** What the review block carries for the app: per fiche, what is pending,
 *  and the footer's own text, so a client that draws the block can leave
 *  the text out of the reply it shows. */
export interface ReviewBlock {
  card: "review";
  footer: string;
  fiches: Array<{
    title: string;
    locale: string;
    basename: string;
    url: string;
    items: Array<{ kind: "person" | "relation" | "identity" | "fragment"; id: string | null; label: string; anchor: string }>;
  }>;
}

/** The footer, as text, for the reply, and as a block, for the app (27
 *  September 2026: the in-app review of a person fiche). Taken once per
 *  turn; null when nothing entered it unconfirmed. */
export function takeReview(conversationId: string, memberId: string, origin: string, locale: string): { text: string; block: ReviewBlock } | null {
  const seen = turns.get(conversationId);
  turns.delete(conversationId);
  if (!seen?.size) return null;
  const garden = gardenFor(memberId);
  if (!garden) return null;
  const w = WORDS[locale] ?? WORDS.en!;
  const lines: string[] = [];
  const fiches: ReviewBlock["fiches"] = [];
  for (const s of seen.values()) {
    const v = viewOf(garden, s);
    if (!v?.pending) continue;
    const url = `${origin}${ficheWebPath(garden, "people", s.locale, s.basename.replace(/-fiche$/, ""))}`;
    const items: ReviewBlock["fiches"][number]["items"] = [];
    if (v.status === "pending" && v.byMaurice) items.push({ kind: "person", id: null, label: w.person, anchor: "person" });
    if (v.relation.status === "pending") items.push({ kind: "relation", id: null, label: `${w.relation}${v.relation.text ? ` : « ${clip(v.relation.text)} »` : ""}`, anchor: "relation" });
    v.identities.forEach((i, n) => { if (i.status === "pending") items.push({ kind: "identity", id: i.address, label: `${w.address} ${i.address}${i.conflict ? ` (${i.conflict})` : ""}`, anchor: `identity-${n + 1}` }); });
    for (const f of v.fragments) if (f.status === "pending") items.push({ kind: "fragment", id: f.id, label: `${w.fragment} ${f.summary || f.id}`, anchor: `fragment-${f.id}` });
    if (!items.length) continue;
    if (items.length > 3) lines.push(`- [${v.title}](${url}#review) — ${w.many(items.length)}`);
    else for (const it of items) lines.push(`- [${v.title}](${url}#${it.anchor}) · ${it.label}`);
    fiches.push({ title: v.title, locale: s.locale, basename: s.basename, url, items });
  }
  if (!lines.length) return null;
  const text = `\n\n---\n\n**${w.head}**\n\n${lines.join("\n")}`;
  return { text, block: { card: "review", footer: text, fiches } };
}

/** The footer as text alone. */
export function takeFooter(conversationId: string, memberId: string, origin: string, locale: string): string | null {
  return takeReview(conversationId, memberId, origin, locale)?.text ?? null;
}

export const _test = { turns };
