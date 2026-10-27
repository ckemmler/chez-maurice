/**
 * The push that follows an account event (services/accountEvents.ts).
 *
 * Sent from here for every row not yet pushed, whoever wrote it: the export
 * script runs as another process and cannot reach the push channels. The
 * server looks once a minute. A row older than a day is marked without a
 * push — a server that was down for a week does not wake everyone with stale
 * news; the line in the app is still there.
 */

import db from "../db";
import { pushToUser } from "./push";
import { memberLocale } from "./domainBriefs";
import type { AccountEventKind } from "./accountEvents";

const TEXT: Record<"en" | "fr", Record<AccountEventKind, { title: string; body: string }>> = {
  en: {
    device_by_code: {
      title: "A new device is in your account",
      body: "It came in with a code made by your household's admin. If it was not you, tell them.",
    },
    household_export: {
      title: "The household was exported",
      body: "Your household's admin took a copy of the whole household, your notes and conversations included.",
    },
  },
  fr: {
    device_by_code: {
      title: "Un nouvel appareil est entré dans votre compte",
      body: "Avec un code créé par l'admin de votre foyer. Si ce n'était pas vous, dites-le-lui.",
    },
    household_export: {
      title: "Le foyer a été exporté",
      body: "L'admin de votre foyer a pris une copie du foyer entier, vos notes et vos conversations comprises.",
    },
  },
};

export async function pushPendingAccountEvents(send: typeof pushToUser = pushToUser): Promise<number> {
  const rows = db
    .query(`SELECT id, user_id, kind, created_at >= datetime('now', '-1 day') AS fresh
              FROM account_events WHERE pushed_at IS NULL ORDER BY id LIMIT 200`)
    .all() as { id: number; user_id: string; kind: AccountEventKind; fresh: number }[];
  let sent = 0;
  for (const r of rows) {
    // Marked first: a push that throws must not be retried every minute.
    db.run(`UPDATE account_events SET pushed_at = datetime('now') WHERE id = ?`, [r.id]);
    if (!r.fresh) continue;
    const lang = memberLocale(r.user_id).startsWith("fr") ? "fr" : "en";
    try {
      await send(r.user_id, TEXT[lang][r.kind]);
      sent++;
    } catch (e) {
      console.error(`[account-events] push failed for ${r.user_id}: ${(e as Error).message}`);
    }
  }
  return sent;
}
