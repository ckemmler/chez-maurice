import db from "../db";
import { ancillaryModel } from "./ancillary";
import { eurosFor } from "./mailOpener";
import { passOverhead } from "./mailReading";
import { WRITE_INVOCATION } from "./mailDocuments";

// Each mailbox on its own, and what reading it will take (28 September 2026).
//
// The settings used to say one thing for the whole store — the headers
// walked, the reading's state — under the last mailbox of the list, so a box
// added last was read as the only one. Now every mailbox says its messages,
// its reading (to sort, to read, read), and, while there is work left, an
// estimate: how many messages will be read whole, how long, and — for the
// operator only (a member is never shown money, see the mail opener) — what
// it will cost.
//
// The cost is the member's own when they have a reading behind them: the
// ledger's euros for their reading job, split by the light pass's model (per
// message sorted) and the rest (per message read: the reading itself and the
// documents written from it). Without a history, the price sheet on the
// store's calibration (the average message and preview, sampled) plus the
// passes' own instructions (`passOverhead`) — the calibration alone left out
// the instructions and the documents and priced the owner's reading at a
// fifth of its bill. The hours are the pipeline's measured pace, a property
// of the passes and their providers rather than of a mailbox.

/** Messages the light pass sorts per hour; measured 28 September 2026 (24 500 in four hours). */
export const LIGHT_PER_HOUR = 6000;
/** Messages read whole per hour; measured 26 September 2026 (1 635 in an hour). */
export const FULL_PER_HOUR = 1600;
/** The share kept by the light pass before a member has any: a third. */
const DEFAULT_KEEP = 0.33;
/** Below this many messages left, a mailbox says no estimate. */
const MIN_LEFT = 20;
/** A member's history is worth using past this much of it. */
const MIN_JUDGED = 500;
const MIN_READ = 100;
/** What a document costs per message read, in tokens, without a history:
 *  the reading's JSON in, a share of a note out. */
const DOC_IN = 400;
const DOC_OUT = 120;

export interface BoxReading {
  window: number;
  to_light: number;
  kept: number;
  skipped: number;
  to_read: number;
  read: number;
}

/** A sender who weighs in what reading this mailbox takes. */
export interface TopSender {
  sender: string;
  /** Its messages in the reading's window. */
  messages: number;
  /** Of which a rule of the member's set aside. */
  set_aside: number;
  /** The member's rule on it: days still read (0: none), null without one. */
  rule_days: number | null;
}

export interface MailboxView {
  address: string;
  messages: number;
  untriaged: number;
  reading: BoxReading;
  top_senders: TopSender[];
  /** The member said yes to reading this mailbox (set by the server). */
  approved?: boolean;
  /** Null when nothing is left to do on this mailbox. */
  estimate: {
    to_sort: number;
    to_read: number;
    hours: number;
    /** For the operator; stripped for a member. Null when no price is known. */
    euros: number | null;
    basis: "history" | "formula";
    /** The box is not sorted yet: the numbers will move once it is. */
    pending: boolean;
  } | null;
}

interface Calibration {
  sampled: number;
  tokens: number;
  preview_tokens: number;
}

/** Euros per message sorted and per message read, from the member's
 *  reading job; null without enough of it, or when the light pass's model
 *  is also the reader's (the ledger could not tell them apart). */
/** The models of the passes: the light one, the reader, the writer. */
export interface PassModels {
  light: string;
  full: string;
  write: string;
}

export function passModels(): PassModels {
  return { light: ancillaryModel("mail_read_light"), full: ancillaryModel("mail_read_full"), write: ancillaryModel(WRITE_INVOCATION) };
}

export function unitCostsFromHistory(jobId: string | null, counts: { judged?: number; read?: number } | null, models: PassModels = passModels()): { light: number; read: number } | null {
  if (!jobId || !counts || (counts.judged ?? 0) < MIN_JUDGED || (counts.read ?? 0) < MIN_READ) return null;
  const light = models.light;
  if (light === models.full || light === models.write) return null;
  const rows = db.query(`SELECT model, SUM(cost_usd) AS cost FROM spend_ledger WHERE job_id = ? GROUP BY model`).all(jobId) as Array<{ model: string; cost: number }>;
  const total = rows.reduce((s, r) => s + Number(r.cost ?? 0), 0);
  const lightCost = rows.filter((r) => r.model === light).reduce((s, r) => s + Number(r.cost ?? 0), 0);
  if (total <= 0) return null;
  return { light: lightCost / counts.judged!, read: (total - lightCost) / counts.read! };
}

/** The same without a history: the price sheet on the calibration. */
export function unitCostsFromFormula(cal: Calibration | null, models: PassModels = passModels()): { light: number; read: number } | null {
  if (!cal || cal.sampled <= 0) return null;
  const o = passOverhead();
  const preview = cal.preview_tokens > 0 ? cal.preview_tokens : 140;
  const body = cal.tokens / cal.sampled;
  const light = eurosFor(models.light, preview + o.light_in, o.light_out);
  const full = eurosFor(models.full, body + o.full_in, o.full_out);
  const doc = eurosFor(models.write, DOC_IN, DOC_OUT);
  if (light === null || full === null || doc === null) return null;
  return { light, read: full + doc };
}

/** Every mailbox with its estimate. `payload` is what `scan_status` answered. */
export function mailboxViews(payload: any, models: PassModels = passModels()): MailboxView[] {
  const boxes = (Array.isArray(payload?.mailboxes) ? payload.mailboxes : []) as Array<{ address: string; messages: number; untriaged: number; reading: BoxReading; top_senders?: Array<{ sender: string; messages: number; set_aside: number }> }>;
  const job = payload?.reading ?? null;
  const counts = job?.counts ?? null;
  const judged = boxes.reduce((s, b) => s + b.reading.kept + b.reading.skipped, 0);
  const keptAll = boxes.reduce((s, b) => s + b.reading.kept, 0);
  const keep = judged >= 200 ? keptAll / judged : DEFAULT_KEEP;
  const history = unitCostsFromHistory(job?.id ?? null, counts, models);
  const units = history ?? unitCostsFromFormula(payload?.calibration ?? null, models);
  return boxes.map((b) => {
    const r = b.reading;
    // Not sorted yet: its window is unknown, the whole box stands for it.
    const toSort = r.to_light + (b.untriaged > 0 ? Math.round(b.untriaged * (r.window && b.messages ? r.window / b.messages : 0.5)) : 0);
    const toRead = r.to_read + Math.round(toSort * keep);
    // A handful left (a message that failed, a straggler) is not worth a warning.
    const left = toSort + toRead >= MIN_LEFT;
    return {
      address: b.address,
      messages: b.messages,
      untriaged: b.untriaged,
      reading: r,
      top_senders: (b.top_senders ?? []).map((t) => ({ sender: t.sender, messages: t.messages, set_aside: t.set_aside ?? 0, rule_days: null })),
      estimate: left
        ? {
            to_sort: toSort,
            to_read: toRead,
            hours: Math.round((toSort / LIGHT_PER_HOUR + toRead / FULL_PER_HOUR) * 10) / 10,
            euros: units ? Math.round((toSort * units.light + toRead * units.read) * 100) / 100 : null,
            basis: history ? "history" : "formula",
            pending: b.untriaged > 0,
          }
        : null,
    };
  });
}

/** A member is shown the volume and the time, never the money. */
export function withoutMoney(boxes: MailboxView[]): MailboxView[] {
  return boxes.map((b) => (b.estimate ? { ...b, estimate: { ...b.estimate, euros: null } } : b));
}

// ── A mailbox added after the yes ────────────────────────────────────────────

const NOTICE: Record<string, { text: string; hours: string; underHour: string }> = {
  en: { text: "You added **%s**: %s messages collected, of which about %s exchanges to read (%s). I do not read it without your word: say yes here, or tap “Read this mailbox” under Settings → Mail.", hours: "about %s h", underHour: "under an hour" },
  fr: { text: "Tu as ajouté **%s** : %s messages relevés, dont environ %s échanges à lire (%s). Je ne la lis pas sans ton accord : dis-moi oui ici, ou touche « Lire cette boîte » dans Réglages › Boîtes mail.", hours: "environ %s h", underHour: "moins d'une heure" },
  it: { text: "Hai aggiunto **%s**: %s messaggi rilevati, di cui circa %s scambi da leggere (%s). Non la leggo senza il tuo accordo: dimmi di sì qui, o tocca «Leggi questa casella» in Impostazioni › Caselle di posta.", hours: "circa %s h", underHour: "meno di un'ora" },
  de: { text: "Du hast **%s** hinzugefügt: %s Nachrichten erfasst, davon etwa %s Austausche zu lesen (%s). Ich lese es nicht ohne dein Einverständnis: Sag hier Ja oder tippe unter Einstellungen › Postfächer auf „Dieses Postfach lesen“.", hours: "etwa %s h", underHour: "unter einer Stunde" },
  es: { text: "Has añadido **%s**: %s mensajes registrados, de ellos unos %s intercambios por leer (%s). No lo leo sin tu permiso: dime que sí aquí, o toca «Leer este buzón» en Ajustes › Buzones.", hours: "unas %s h", underHour: "menos de una hora" },
  pt: { text: "Adicionaste **%s**: %s mensagens registadas, das quais cerca de %s trocas por ler (%s). Não a leio sem o teu acordo: diz-me que sim aqui, ou toca em «Ler esta caixa» em Definições › Caixas de correio.", hours: "cerca de %s h", underHour: "menos de uma hora" },
  nl: { text: "Je hebt **%s** toegevoegd: %s berichten verzameld, waarvan ongeveer %s uitwisselingen te lezen (%s). Ik lees hem niet zonder je akkoord: zeg hier ja, of tik op „Deze mailbox lezen” onder Instellingen › Mailboxen.", hours: "ongeveer %s u", underHour: "minder dan een uur" },
};

function fill(s: string, ...args: string[]): string {
  let i = 0;
  return s.replace(/%s/g, () => args[i++] ?? "");
}

/** What Maurice says of a mailbox added after the yes: its numbers, the
 *  time, never the money, and that it waits for its own yes. */
export function newMailboxNotice(locale: string, address: string, box: MailboxView): string {
  const t = NOTICE[locale] ?? NOTICE.en!;
  const n = (x: number) => x.toLocaleString(locale);
  const e = box.estimate!;
  const hours = e.hours < 1 ? t.underHour : fill(t.hours, String(Math.round(e.hours)));
  return fill(t.text, address, n(box.messages), n(e.to_read), hours);
}
