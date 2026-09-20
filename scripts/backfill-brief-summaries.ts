#!/usr/bin/env bun
/**
 * Write the missing one-liners of existing briefs.
 *
 * The everyday prompt shows an index of the member's domains, one line each,
 * and that line is written by the night beside the brief it summarises
 * (services/domainBriefs.ts). Briefs that existed before that change carry no
 * summary, and the index falls back to their opening sentences — readable, but
 * a cut paragraph rather than a description. This fills them in once, so the
 * index is right from the first turn rather than from the first night.
 *
 * Safe to re-run: it only touches briefs whose summary is missing. Costs one
 * small model call per brief, charged to the night's spender like the briefs
 * themselves.
 *
 *   bun run scripts/backfill-brief-summaries.ts          # every member
 *   bun run scripts/backfill-brief-summaries.ts --dry    # say what it would do
 */
import db from "../server/src/db";
import { domainsOf, getBrief, memberLanguage, writeSummary } from "../server/src/services/domainBriefs";
import { listUsers } from "../server/src/services/users";

const dry = process.argv.includes("--dry");
let done = 0;
let skipped = 0;

for (const user of listUsers()) {
  for (const domain of domainsOf(user.id)) {
    const brief = getBrief(domain.id, user.id);
    if (!brief || !brief.text.trim()) continue;
    if (brief.summary && brief.summary.trim()) {
      skipped++;
      continue;
    }
    if (dry) {
      console.log(`would summarise "${domain.name}" for ${user.id}`);
      done++;
      continue;
    }
    await writeSummary(domain, user.id, brief.text, memberLanguage(user.id));
    const after = getBrief(domain.id, user.id);
    console.log(`"${domain.name}": ${after?.summary ? after.summary : "(no summary written)"}`);
    done++;
  }
}

console.log(`\n${dry ? "would write" : "wrote"} ${done}, ${skipped} already had one`);
db.close();
