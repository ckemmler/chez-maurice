import fs from "node:fs";
import path from "node:path";
import { atomicWrite, autoCommit, dumpFrontmatter, fichePath, fragmentsDir, parseFiche, type GardenRef } from "../../data-api/services/gardenFiche";
import { invalidateNotes } from "./composer/notes";
import { fragmentHash, sectionOf, splitAddress, withSection, type Status } from "./mailPeople";
import { syncCorpus, wordsFor } from "./mailDocuments";

// The member's word on a person fiche — lot 4 of specs/contacts.md,
// 27 September 2026.
//
// The mail pass writes a person's fiche and its fragments pending
// (services/mailPeople.ts). Here the member says what holds: on the fiche's
// page, or through the links of the "À vérifier" footer, one gesture per
// element —
//
//   confirm   it is right; Maurice never rewrites it
//   reject    it is wrong; a fragment goes (its messages stay covered, it is
//             never written again), an address is never linked again, the
//             relation is never proposed again, a person Maurice made goes
//   edit      the member's own words; that confirms it
//
// and "confirm all" for the whole fiche. Only the member does this: the
// routes act on the caller's own garden, and an edit made through the
// garden tool — Maurice, in a conversation — stays pending (the tool moves
// the hash along, tools/garden/server.py). A relation the member corrects is
// marked `rewrite`, so the next pass writes the pending fragments again
// knowing who the person is.

export type Target = "fiche" | "relation" | "identity" | "fragment" | "all";
export type Action = "confirm" | "reject" | "edit";

export class ReviewError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 = 400) {
    super(message);
  }
}

export interface FragmentView {
  id: string;
  summary: string;
  status: Status;
  origin: string | null;
  address: string | null;
  mailbox: string | null;
  body: string;
  /** The member edited it (its text no longer matches what was written). */
  edited: boolean;
}

export interface PersonView {
  title: string;
  locale: string;
  basename: string;
  status: Status;
  byMaurice: boolean;
  relation: { text: string | null; status: Status | null; since: string | null; until: string | null; edited: boolean };
  identities: Array<{ address: string; mailboxes: string[]; status: Status; source: string; conflict: string | null }>;
  fragments: FragmentView[];
  /** The exchanges section, as written (read-only: the pass rewrites it). */
  exchanges: string | null;
  /** Everything still pending — what the footer lists for this fiche. */
  pending: number;
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*-fiche$/;
const FRAG = /^\d{3}$/;

function locate(garden: GardenRef, locale: string, basename: string): string {
  if (!SLUG.test(basename)) throw new ReviewError("not a fiche");
  const file = fichePath(garden, "people", locale, basename.replace(/-fiche$/, ""));
  if (!fs.existsSync(file)) throw new ReviewError("no such fiche", 404);
  return file;
}

function readFrontmatter(file: string): { fm: Record<string, any>; body: string } {
  const p = parseFiche(fs.readFileSync(file, "utf8"));
  if (!p) throw new ReviewError("the fiche cannot be read", 409);
  return { fm: p.frontmatter, body: p.body };
}

const statusOf = (v: unknown): Status => (v === "confirmed" || v === "rejected" ? v : "pending");

function fragmentFiles(file: string): string[] {
  const dir = fragmentsDir(file);
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^\d{3}\.frag$/.test(f)).sort().map((f) => path.join(dir, f)) : [];
}

function readFragment(f: string): FragmentView & { fm: Record<string, any> } {
  const p = parseFiche(fs.readFileSync(f, "utf8"));
  const fm = p?.frontmatter ?? {};
  const body = p?.body ?? fs.readFileSync(f, "utf8");
  const edited = !!fm.written_hash && fragmentHash(body) !== String(fm.written_hash) && fm.edited_by !== "maurice";
  // A fragment the member wrote by hand carries no status: theirs, confirmed.
  const status: Status = fm.origin === "mail" ? (edited ? "confirmed" : statusOf(fm.status)) : "confirmed";
  return {
    id: path.basename(f, ".frag"), summary: String(fm.summary ?? ""), status, origin: fm.origin ? String(fm.origin) : null,
    address: fm.address ? String(fm.address) : null, mailbox: fm.mailbox ? String(fm.mailbox) : null, body, edited, fm,
  };
}

/** The fiche as the page and the footer see it. */
export function personView(garden: GardenRef, locale: string, basename: string): PersonView {
  const file = locate(garden, locale, basename);
  const { fm, body } = readFrontmatter(file);
  const w = wordsFor(locale);
  const text = sectionOf(body, w.relationship);
  const rel = fm.relation && typeof fm.relation === "object" ? fm.relation : null;
  const relEdited = !!rel?.written_hash && !!text && fragmentHash(text) !== String(rel.written_hash);
  const relation = {
    text,
    status: rel ? (relEdited ? "confirmed" : statusOf(rel.status)) as Status : null,
    since: rel?.since ? String(rel.since) : null,
    until: rel?.until ? String(rel.until) : null,
    edited: relEdited,
  };
  const identities = (Array.isArray(fm.identities) ? fm.identities : []).map((i: any) => ({
    address: String(i.address ?? ""), mailboxes: Array.isArray(i.mailboxes) ? i.mailboxes.map(String) : [],
    status: statusOf(i.status), source: String(i.source ?? "mail"), conflict: i.conflict ? String(i.conflict) : null,
  }));
  const fragments = fragmentFiles(file).map((f) => { const { fm: _fm, ...v } = readFragment(f); return v; });
  // A fiche the member wrote, with no status of its own, is theirs: confirmed.
  const status: Status = fm.status ? statusOf(fm.status) : fm.meta?.author === "maurice" ? "pending" : "confirmed";
  const pending = (status === "pending" ? 1 : 0) + (relation.status === "pending" ? 1 : 0)
    + identities.filter((i) => i.status === "pending").length + fragments.filter((f) => f.status === "pending").length;
  return {
    title: String(fm.title ?? basename), locale, basename, status, byMaurice: fm.meta?.author === "maurice",
    relation, identities, fragments, exchanges: sectionOf(body, w.exchanges), pending,
  };
}

function writeFiche(file: string, fm: Record<string, any>, body: string): void {
  atomicWrite(file, `---\n${dumpFrontmatter(fm)}\n---\n\n${body.replace(/^\n+/, "")}`);
}

function writeFragment(f: string, fm: Record<string, any>, body: string): void {
  atomicWrite(f, `---\n${dumpFrontmatter(fm)}\n---\n${body}`);
}

/** Apply one gesture. Returns the fiche as it now stands (null when the
 *  fiche itself went). Commits in the garden. */
export function review(
  memberId: string,
  garden: GardenRef,
  locale: string,
  basename: string,
  req: { target: Target; action: Action; id?: string; text?: string },
): PersonView | null {
  const file = locate(garden, locale, basename);
  const { fm, body } = readFrontmatter(file);
  const w = wordsFor(locale);
  const touched: string[] = [file];
  const { target, action } = req;
  if (!["confirm", "reject", "edit"].includes(action)) throw new ReviewError("action is confirm, reject or edit");
  if (action === "edit" && (typeof req.text !== "string" || !req.text.trim())) throw new ReviewError("an edit needs text");
  let what = "";

  if (target === "fiche") {
    if (action === "edit") throw new ReviewError("a fiche is edited element by element");
    if (action === "reject") {
      if (fm.meta?.author !== "maurice") throw new ReviewError("a fiche you wrote is yours to delete, not to reject", 409);
      // Not a person worth a fiche: it goes, and the next pass finds it
      // gone and never writes it again.
      fs.rmSync(path.join(path.dirname(file), basename), { recursive: true, force: true });
      fs.rmSync(file, { force: true });
      finish(memberId, garden, [file, ...fragmentFiles(file)], `People: ${basename} rejected`);
      return null;
    }
    fm.status = "confirmed";
    what = "confirmed";
  } else if (target === "relation") {
    const rel: Record<string, any> = fm.relation && typeof fm.relation === "object" ? { ...fm.relation } : {};
    let nextBody = body;
    if (action === "edit") {
      nextBody = withSection(body, w.relationship, req.text!.trim());
      // The member's words: confirmed, and the pending fragments go back to
      // the writer with them at the next pass.
      Object.assign(rel, { status: "confirmed", rewrite: true });
    } else {
      rel.status = action === "confirm" ? "confirmed" : "rejected";
    }
    fm.relation = rel;
    writeFiche(file, fm, nextBody);
    finish(memberId, garden, touched, `People: ${basename}, relation ${action}ed`);
    return personView(garden, locale, basename);
  } else if (target === "identity") {
    const ids: any[] = Array.isArray(fm.identities) ? fm.identities : [];
    const i = ids.find((x) => String(x.address).toLowerCase() === String(req.id ?? "").toLowerCase());
    if (!i) throw new ReviewError("no such address on this fiche", 404);
    if (action === "edit") throw new ReviewError("an address is confirmed or rejected");
    i.status = action === "confirm" ? "confirmed" : "rejected";
    what = `${i.address} ${i.status}`;
    // Rejected: that address is somebody else — its mail fragments leave
    // for a fiche of their own (lot 7), and the link stays rejected here.
    if (i.status === "rejected") {
      writeFiche(file, fm, body);
      touched.push(...splitAddress(garden, file, locale, String(i.address), Array.isArray(i.names) ? i.names.map(String) : [], { heading: w.provenance, text: w.disclaimer }));
      finish(memberId, garden, touched, `People: ${basename}, ${what}, split out`);
      return personView(garden, locale, basename);
    }
  } else if (target === "fragment") {
    if (!FRAG.test(String(req.id ?? ""))) throw new ReviewError("a fragment is named by its number");
    const f = path.join(fragmentsDir(file), `${req.id}.frag`);
    if (!fs.existsSync(f)) throw new ReviewError("no such fragment", 404);
    const frag = readFragment(f);
    touched.push(f);
    if (action === "reject") {
      fs.rmSync(f, { force: true });
    } else if (action === "edit") {
      // The hash stays what was written: the text no longer matches it,
      // which is what says the member wrote it.
      writeFragment(f, { ...frag.fm, status: "confirmed", edited_by: "member" }, `${req.text!.trim()}\n`);
    } else {
      writeFragment(f, { ...frag.fm, status: "confirmed" }, frag.body);
    }
    finish(memberId, garden, touched, `People: ${basename}, fragment ${req.id} ${action}ed`);
    return personView(garden, locale, basename);
  } else if (target === "all") {
    if (action !== "confirm") throw new ReviewError("all can only be confirmed");
    fm.status = "confirmed";
    if (fm.relation && typeof fm.relation === "object" && statusOf(fm.relation.status) === "pending") fm.relation = { ...fm.relation, status: "confirmed" };
    for (const i of Array.isArray(fm.identities) ? fm.identities : []) if (statusOf(i.status) === "pending") i.status = "confirmed";
    for (const f of fragmentFiles(file)) {
      const frag = readFragment(f);
      if (frag.status === "pending") {
        writeFragment(f, { ...frag.fm, status: "confirmed" }, frag.body);
        touched.push(f);
      }
    }
    what = "all confirmed";
  } else {
    throw new ReviewError("target is fiche, relation, identity, fragment or all");
  }
  writeFiche(file, fm, body);
  finish(memberId, garden, touched, `People: ${basename}, ${what}`);
  return personView(garden, locale, basename);
}

function finish(memberId: string, garden: GardenRef, paths: string[], message: string): void {
  try {
    autoCommit(garden, paths, message);
  } catch (err) {
    console.warn(`[people] commit failed: ${(err as Error).message}`);
  }
  invalidateNotes(memberId);
  syncCorpus(memberId, paths);
}
