import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { atomicWrite, autoCommit, dumpFrontmatter, fragmentsDir, gardenFor, parseFiche, type GardenRef } from "../../data-api/services/gardenFiche";
import { invalidateNotes } from "./composer/notes";
import { mailboxLabels, syncCorpus, wordsFor } from "./mailDocuments";
import { listMailAccounts } from "./mailAccounts";
import { fragmentHash, sectionOf, withSection, withoutSection } from "./mailPeople";
import { mailToolCall } from "./mailScan";

// Forgetting a mailbox — lot 6 of specs/contacts.md, 27 September 2026.
//
// Removing an account only disconnects it (routes/mailAccounts.ts): nothing
// is read any more, what was derived stays. Forgetting is the other gesture,
// asked for on purpose:
//
//   1. the store — every message seen only in that mailbox goes, with its
//      reading and triage; a message also seen elsewhere stays (the tool's
//      `forget_mailbox`);
//   2. the garden, without a model — every line whose `maurice-mail:` links
//      all point at a gone message is removed, a link to a gone message is
//      dropped from a line that has others; a note, a fragment, a relation
//      or a fiche that Maurice wrote, nobody touched, and that is left with
//      nothing to say goes; what the member touched is pruned, never
//      removed, and a line of theirs without a link is never touched. The
//      hashes move with the text, so a pruned fragment is not taken for the
//      member's correction;
//   3. the history, only when asked — every past version of every file
//      pruned the same way (scripts/garden_prune_history.py), the refs
//      rewritten, the old objects dropped, and the garden's remote
//      force-pushed. Other clones keep what they fetched. A line written
//      before the pointers were links (the first mail documents, 26
//      September 2026) cannot be traced to a mailbox and stays.
//
// Then the account itself is removed.

const LINK = /\[((?:\\.|[^\]\\])*)\]\(maurice-mail:([^)\s]+)\)/g;
const BOXES = /^(Boîtes|Mailboxes|Caselle|Postfächer|Buzones|Caixas|Mailboxen)( ?:) (.*)\.$/;

const idOf = (raw: string): string => {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
};

/** Prune one text: lines whose links all point at gone messages go; gone
 *  links leave the lines that have others; the "Mailboxes:" line loses the
 *  forgotten mailbox. `sourced` counts the lines left with a link. */
export function pruneText(text: string, gone: Set<string>, label: string | null): { text: string; changed: boolean; sourced: number } {
  let changed = false;
  let sourced = 0;
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const links = [...line.matchAll(LINK)];
    if (links.length) {
      const dead = links.filter((m) => gone.has(idOf(m[2]!)));
      if (dead.length === links.length) {
        changed = true;
        continue;
      }
      let l = line;
      if (dead.length) {
        for (const m of dead) l = l.replace(m[0], "");
        l = l.replace(/\s*;\s*;\s*/g, " ; ").replace(/—\s*;\s*/g, "— ").replace(/\s*;\s*$/g, "").replace(/\s+$/g, "");
        changed = true;
      }
      sourced++;
      out.push(l);
      continue;
    }
    const b = label ? line.match(BOXES) : null;
    if (b) {
      const entries = b[3]!.split(/,\s*/).filter((e) => !e.startsWith(`${label} (`));
      if (entries.length !== b[3]!.split(/,\s*/).length) {
        changed = true;
        if (entries.length) out.push(`${b[1]}${b[2]} ${entries.join(", ")}.`);
        continue;
      }
    }
    out.push(line);
  }
  // A heading left with nothing under it goes too.
  const lines: string[] = [];
  for (let i = 0; i < out.length; i++) {
    if (/^##\s/.test(out[i]!)) {
      let j = i + 1;
      while (j < out.length && !out[j]!.trim()) j++;
      if (j >= out.length || /^##\s/.test(out[j]!)) {
        if (changed) { i = j - 1; continue; }
      }
    }
    lines.push(out[i]!);
  }
  return { text: lines.join("\n").replace(/\n{3,}/g, "\n\n"), changed, sourced };
}

/** The body without the section under `## <heading>`. */
const write = (file: string, fm: Record<string, any>, body: string, blankAfter = true) =>
  atomicWrite(file, `---\n${dumpFrontmatter(fm)}\n---\n${blankAfter ? "\n" : ""}${body.replace(/^\n+/, "")}`);

const without = (xs: unknown, gone: Set<string>) => (Array.isArray(xs) ? xs.map(String).filter((x) => !gone.has(x)) : xs);

export interface PruneReport {
  changed: string[];
  removed: string[];
}

/** Prune what the mail pass wrote in a garden of every trace of these
 *  messages and this mailbox (step 2 above). */
export function pruneGarden(garden: GardenRef, locale: string, gone: Set<string>, address: string, label: string | null): PruneReport {
  const changed: string[] = [];
  const removed: string[] = [];
  const addr = address.toLowerCase();

  // The notes: digests and the hub.
  const notesRoot = path.join(garden.root, "notes");
  const hubs: string[] = [];
  for (const loc of fs.existsSync(notesRoot) ? fs.readdirSync(notesRoot) : []) {
    const dir = path.join(notesRoot, loc);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".md"))) {
      const file = path.join(dir, f);
      const p = parseFiche(fs.readFileSync(file, "utf8"));
      if (!p || p.frontmatter.meta?.origin !== "mail") continue;
      if (p.frontmatter.meta?.kind === "hub") { hubs.push(file); continue; }
      const r = pruneText(p.body, gone, label);
      if (!r.changed) continue;
      if (!r.sourced && p.frontmatter.meta?.opened === false) {
        fs.rmSync(file, { force: true });
        removed.push(file);
        continue;
      }
      const meta = { ...p.frontmatter.meta, sources: without(p.frontmatter.meta.sources, gone), mailboxes: without(p.frontmatter.meta.mailboxes, new Set([addr])) };
      write(file, { ...p.frontmatter, meta }, r.text);
      changed.push(file);
    }
  }

  // The people: fiches, their relation, their fragments.
  const peopleRoot = path.join(garden.root, "people");
  for (const loc of fs.existsSync(peopleRoot) ? fs.readdirSync(peopleRoot) : []) {
    const dir = path.join(peopleRoot, loc);
    if (!fs.statSync(dir).isDirectory()) continue;
    // The fiche's own language names its sections.
    const w = wordsFor(loc);
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith("-fiche.md"))) {
      const file = path.join(dir, f);
      const p = parseFiche(fs.readFileSync(file, "utf8"));
      if (!p) continue;
      const fm: Record<string, any> = { ...p.frontmatter };
      let body = p.body;
      let dirty = false;
      // Fragments.
      let fragsLeft = 0;
      const fdir = fragmentsDir(file);
      for (const x of fs.existsSync(fdir) ? fs.readdirSync(fdir).filter((y) => y.endsWith(".frag")).sort() : []) {
        const ff = path.join(fdir, x);
        const fp = parseFiche(fs.readFileSync(ff, "utf8"));
        if (!fp || fp.frontmatter.origin !== "mail") { fragsLeft++; continue; }
        const untouched = !!fp.frontmatter.written_hash && fragmentHash(fp.body) === String(fp.frontmatter.written_hash) && fp.frontmatter.status !== "confirmed";
        const r = pruneText(fp.body, gone, label);
        if (!r.changed) { fragsLeft++; continue; }
        if (!r.sourced && untouched) {
          fs.rmSync(ff, { force: true });
          removed.push(ff);
          continue;
        }
        const ffm = { ...fp.frontmatter, sources: without(fp.frontmatter.sources, gone), ...(untouched ? { written_hash: fragmentHash(r.text) } : {}) };
        write(ff, ffm, r.text.endsWith("\n") ? r.text : `${r.text}\n`, false);
        changed.push(ff);
        fragsLeft++;
      }
      // The relation.
      const rel = fm.relation && typeof fm.relation === "object" ? { ...fm.relation } : null;
      const text = sectionOf(body, w.relationship);
      if (rel && text) {
        const r = pruneText(text, gone, label);
        if (r.changed) {
          const untouched = rel.written_hash && fragmentHash(text) === String(rel.written_hash) && rel.status !== "confirmed";
          if (!r.sourced && untouched) {
            body = withoutSection(body, w.relationship);
            delete fm.relation;
          } else {
            body = withSection(body, w.relationship, r.text.trim());
            fm.relation = { ...rel, sources: without(rel.sources, gone), ...(untouched ? { written_hash: fragmentHash(r.text.trim()) } : {}) };
          }
          dirty = true;
        }
      }
      // The exchanges: headers the next pass rebuilds from the store. A list
      // that names a forgotten message goes whole, its count with it — the
      // count would be wrong, and the subjects are that mailbox's.
      const ex = sectionOf(body, w.exchanges);
      if (ex !== null && pruneText(ex, gone, label).changed) {
        body = withoutSection(body, w.exchanges);
        dirty = true;
      }
      // The addresses: this mailbox leaves their lists; a guessed or mail
      // address with nothing left goes.
      if (Array.isArray(fm.identities)) {
        const ids = fm.identities
          .map((i: any) => ({ ...i, mailboxes: (i.mailboxes ?? []).filter((m: string) => String(m).toLowerCase() !== addr) }))
          .filter((i: any) => i.mailboxes.length || i.status !== "pending" || i.source === "vcard");
        if (JSON.stringify(ids) !== JSON.stringify(fm.identities)) { fm.identities = ids; dirty = true; }
      }
      const byMaurice = fm.meta?.author === "maurice";
      if (byMaurice && fm.status !== "confirmed" && !fragsLeft && !fm.relation && (dirty || fs.existsSync(fdir))) {
        fs.rmSync(path.join(dir, f.slice(0, -3)), { recursive: true, force: true });
        fs.rmSync(file, { force: true });
        removed.push(file);
        continue;
      }
      if (dirty) {
        write(file, fm, body);
        changed.push(file);
      }
    }
  }

  // The hub lists what is still there.
  for (const hub of hubs) {
    const p = parseFiche(fs.readFileSync(hub, "utf8"));
    if (!p) continue;
    const exists = (slug: string) =>
      fs.existsSync(path.join(path.dirname(hub), `${slug}.md`)) ||
      fs.readdirSync(peopleRoot).some((loc) => fs.existsSync(path.join(peopleRoot, loc, `${slug}.md`)));
    const kept = p.body.split("\n").filter((l) => {
      const m = l.match(/^- \[\[([^|\]]+)/);
      return !m || exists(m[1]!);
    });
    if (kept.length !== p.body.split("\n").length) {
      write(hub, p.frontmatter, kept.join("\n"));
      changed.push(hub);
    }
  }
  return { changed, removed };
}

// ── The history ──────────────────────────────────────────────────────────

const HISTORY_SCRIPT = path.resolve(import.meta.dir, "../../scripts/garden_prune_history.py");

/** Prune every past version (step 3). Returns null when done, else why not. */
export function pruneHistory(garden: GardenRef, gone: Set<string>): string | null {
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: garden.root, encoding: "utf8" });
  if (top.status !== 0) return "the garden is not a git repository";
  const root = top.stdout.trim();
  if (spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).stdout.trim()) return "the garden has uncommitted changes";
  const idsFile = path.join(root, ".git", "forgotten-mail-ids");
  fs.writeFileSync(idsFile, [...gone].join("\n"));
  const r = spawnSync("python3", [HISTORY_SCRIPT, root, idsFile], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  fs.rmSync(idsFile, { force: true });
  if (r.status !== 0) return `the history could not be rewritten: ${(r.stderr || r.stdout).trim().slice(-400)}`;
  return null;
}

// ── The whole gesture ────────────────────────────────────────────────────

export interface ForgetResult {
  address: string;
  gone: number;
  kept: number;
  changed: number;
  removed: number;
  history: "kept" | "rewritten" | string;
}

export async function forgetMailbox(memberId: string, address: string, opts: { history?: boolean; locale?: string } = {}): Promise<ForgetResult> {
  const garden = gardenFor(memberId);
  if (!garden) throw new Error("the member has no garden");
  const label = mailboxLabels(listMailAccounts(memberId)).get(address.toLowerCase()) ?? null;
  const r = await mailToolCall(memberId, "forget_mailbox", { address });
  if (r?.error || r?.raw) throw new Error(String(r.error ?? r.raw));
  const gone = new Set<string>((r.gone ?? []).map(String));
  const locale = opts.locale ?? "fr";
  const pruned = gone.size ? pruneGarden(garden, locale, gone, address, label) : { changed: [], removed: [] };
  const files = [...pruned.changed, ...pruned.removed];
  if (files.length) {
    autoCommit(garden, files, `Mail: ${address} forgotten — ${pruned.changed.length} pruned, ${pruned.removed.length} removed`);
    invalidateNotes(memberId);
    syncCorpus(memberId, files);
  }
  let history: ForgetResult["history"] = "kept";
  if (opts.history && gone.size) history = pruneHistory(garden, gone) ?? "rewritten";
  console.log(`[mail] forget ${address} for ${memberId}: ${gone.size} message(s) gone, ${r.kept ?? 0} kept, ${pruned.changed.length} file(s) pruned, ${pruned.removed.length} removed; history ${history}`);
  return { address: address.toLowerCase(), gone: gone.size, kept: Number(r.kept ?? 0), changed: pruned.changed.length, removed: pruned.removed.length, history };
}
