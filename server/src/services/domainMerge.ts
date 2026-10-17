/**
 * Two domains that are one (17 October 2026): fold one into the other.
 *
 * A member has one domain of a given name (maurices.domainNamed refuses a
 * second). Before that rule, two could exist — the owner had two "Maurice"
 * made 28 seconds apart, each with its own brief and its share of the
 * conversations. This folds the second into the first, losing nothing:
 *
 *   - the conversations bound to it, and the messages it answered, move over;
 *     the conversations are marked as bound now, so the next brief reads them
 *     whole;
 *   - its context items join the other's (no item twice), and what the other
 *     leaves empty — tagline, icon, model, instructions — is taken from it;
 *     two different instructions are kept, one after the other;
 *   - each member's brief on it is appended to their brief on the other (or
 *     becomes it), then rewritten in the background into one;
 *   - its mail, its access list and the proposals that made it follow;
 *   - the notes seeded for it in the garden name the other domain.
 *
 * mergeDuplicateDomains runs once at start: whatever duplicates a household
 * has are folded into the oldest of each name.
 */

import fs from "node:fs";
import path from "node:path";
import { autoCommit, gardenFor } from "../../data-api/services/gardenFiche";
import db from "../db";
import { refreshBrief } from "./domainBriefs";
import { domainNameKey, getMaurice, type Maurice } from "./maurices";

interface Row {
  id: string;
  name: string;
  kind: string | null;
  icon: string | null;
  model: string | null;
  tagline: string;
  prompt: string;
  context_json: string;
  tool_families: string | null;
  created_by: string | null;
}

export interface MergeMoved {
  conversations: number;
  briefs: number;
  mail: number;
  notes: number;
}

const row = (id: string) => db.query(
  `SELECT id, name, kind, icon, model, tagline, prompt, context_json, tool_families, created_by FROM maurices WHERE id = ?`,
).get(id) as Row | null;

const isDomain = (r: Row) => (r.kind ?? "domain") === "domain";

function json<T>(text: string | null, fallback: T): T {
  try { return text == null ? fallback : (JSON.parse(text) as T) ?? fallback; } catch { return fallback; }
}

/** Both domains' context, the kept one's items first, no item twice. */
function unionContext(keep: string, drop: string): string {
  const k = json<{ items?: any[] }>(keep, { items: [] });
  const d = json<{ items?: any[] }>(drop, { items: [] });
  const key = (it: any) => `${it?.type}:${it?.id}`;
  const seen = new Set((k.items ?? []).map(key));
  const items = [...(k.items ?? []), ...(d.items ?? []).filter((it) => !seen.has(key(it)))];
  return JSON.stringify({ ...k, items });
}

/** Tool families: null is the default set; two explicit lists are joined. */
function unionFamilies(keep: string | null, drop: string | null): string | null {
  if (keep == null || drop == null) return keep;
  const all = [...new Set([...json<string[]>(keep, []), ...json<string[]>(drop, [])])];
  return JSON.stringify(all);
}

/** The seeded notes that name `dropId` as their domain name `keepId` instead. */
function renameSeededNotes(memberId: string, dropId: string, keepId: string): number {
  const garden = gardenFor(memberId);
  const notes = garden ? path.join(garden.root, "notes") : null;
  if (!garden || !notes || !fs.existsSync(notes)) return 0;
  const changed: string[] = [];
  const line = new RegExp(`^(\\s*domain:\\s*)(["']?)${dropId.replace(/[-]/g, "\\-")}\\2\\s*$`, "m");
  for (const loc of fs.readdirSync(notes)) {
    const dir = path.join(notes, loc);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".md"))) {
      const file = path.join(dir, f);
      const raw = fs.readFileSync(file, "utf8");
      const end = raw.startsWith("---\n") ? raw.indexOf("\n---", 4) : -1;
      if (end < 0) continue;
      const head = raw.slice(0, end);
      if (!line.test(head)) continue;
      fs.writeFileSync(file, head.replace(line, `$1$2${keepId}$2`) + raw.slice(end));
      changed.push(file);
    }
  }
  if (changed.length) autoCommit(garden, changed, `Merge domain ${dropId} into ${keepId}`, { only: true });
  return changed.length;
}

/**
 * Fold the domain `dropId` into the domain `keepId`, both made by `memberId`.
 * `dropId` is gone afterwards. The briefs are rewritten in the background.
 */
export function mergeDomains(memberId: string, dropId: string, keepId: string): { into: Maurice; moved: MergeMoved } | { error: string } {
  if (dropId === keepId) return { error: "a domain cannot be merged into itself" };
  const keep = row(keepId);
  const drop = row(dropId);
  if (!keep || !drop || keep.created_by !== memberId || drop.created_by !== memberId) return { error: "not_found" };
  if (!isDomain(keep) || !isDomain(drop)) return { error: "only domains are merged" };

  const moved: MergeMoved = { conversations: 0, briefs: 0, mail: 0, notes: 0 };
  const briefOwners: string[] = [];
  db.transaction(() => {
    moved.conversations = Number(db.run(
      `UPDATE conversations SET maurice_id = ?, maurice_bound_at = datetime('now') WHERE maurice_id = ?`,
      [keepId, dropId],
    ).changes ?? 0);
    db.run(`UPDATE messages SET maurice_id = ? WHERE maurice_id = ?`, [keepId, dropId]);

    const prompt = !keep.prompt.trim() ? drop.prompt
      : drop.prompt.trim() && drop.prompt.trim() !== keep.prompt.trim() ? `${keep.prompt.trim()}\n\n${drop.prompt.trim()}`
      : keep.prompt;
    db.run(
      `UPDATE maurices SET tagline = ?, icon = ?, model = ?, prompt = ?, context_json = ?, tool_families = ?,
              updated_at = datetime('now') WHERE id = ?`,
      [
        keep.tagline.trim() ? keep.tagline : drop.tagline,
        keep.icon ?? drop.icon,
        keep.model ?? drop.model,
        prompt,
        unionContext(keep.context_json, drop.context_json),
        unionFamilies(keep.tool_families, drop.tool_families),
        keepId,
      ],
    );
    db.run(
      `INSERT OR IGNORE INTO maurice_access (maurice_id, member_id) SELECT ?, member_id FROM maurice_access WHERE maurice_id = ?`,
      [keepId, dropId],
    );

    const briefs = db.query(
      `SELECT member_id, text, sources_json FROM domain_briefs WHERE maurice_id = ?`,
    ).all(dropId) as { member_id: string; text: string; sources_json: string }[];
    for (const b of briefs) {
      const mine = db.query(
        `SELECT text, sources_json FROM domain_briefs WHERE maurice_id = ? AND member_id = ?`,
      ).get(keepId, b.member_id) as { text: string; sources_json: string } | null;
      if (!mine) {
        db.run(`UPDATE domain_briefs SET maurice_id = ? WHERE maurice_id = ? AND member_id = ?`, [keepId, dropId, b.member_id]);
      } else {
        const text = [mine.text.trim(), b.text.trim()].filter(Boolean).join("\n\n");
        // The kept brief's `read_until` stands: the moved conversations are
        // marked as bound now, which is what makes the next rewrite read them.
        const sources = [...json<any[]>(mine.sources_json, []), ...json<any[]>(b.sources_json, [])];
        db.run(
          `UPDATE domain_briefs SET text = ?, sources_json = ? WHERE maurice_id = ? AND member_id = ?`,
          [text, JSON.stringify(sources), keepId, b.member_id],
        );
        db.run(`DELETE FROM domain_briefs WHERE maurice_id = ? AND member_id = ?`, [dropId, b.member_id]);
      }
      briefOwners.push(b.member_id);
      moved.briefs++;
    }

    moved.mail = Number(db.run(
      `INSERT OR IGNORE INTO domain_mail (maurice_id, member_id, path, added_at)
         SELECT ?, member_id, path, added_at FROM domain_mail WHERE maurice_id = ?`,
      [keepId, dropId],
    ).changes ?? 0);
    db.run(`DELETE FROM domain_mail WHERE maurice_id = ?`, [dropId]);
    db.run(`UPDATE domain_proposals SET maurice_id = ? WHERE maurice_id = ?`, [keepId, dropId]);
    db.run(`DELETE FROM maurices WHERE id = ?`, [dropId]);
  })();

  moved.notes = renameSeededNotes(memberId, dropId, keepId);
  const into = getMaurice(keepId)!;
  console.log(`[domains] "${drop.name}" ${dropId} merged into ${keepId}: ${moved.conversations} conversation(s), ${moved.briefs} brief(s), ${moved.mail} mail, ${moved.notes} note(s)`);
  // One brief from two: the next rewrite reads the moved conversations whole.
  for (const m of new Set(briefOwners)) {
    refreshBrief(into, m).catch((e) => console.warn(`[domains] brief of "${into.name}" after merge: ${(e as Error).message}`));
  }
  return { into, moved };
}

/**
 * Fold every set of same-named domains a member has into the oldest of them.
 * Run once at start, so a household that had duplicates before the rule
 * stops having them. Returns how many domains were folded.
 */
export function mergeDuplicateDomains(): number {
  const rows = db.query(
    `SELECT id, name, created_by FROM maurices
      WHERE COALESCE(kind, 'domain') = 'domain' AND created_by IS NOT NULL
      ORDER BY created_at, id`,
  ).all() as { id: string; name: string; created_by: string }[];
  const first = new Map<string, string>();
  let folded = 0;
  for (const r of rows) {
    const key = `${r.created_by}\u0000${domainNameKey(r.name)}`;
    const keep = first.get(key);
    if (!keep) { first.set(key, r.id); continue; }
    const res = mergeDomains(r.created_by, r.id, keep);
    if ("error" in res) console.warn(`[domains] could not merge ${r.id} into ${keep}: ${res.error}`);
    else folded++;
  }
  return folded;
}
