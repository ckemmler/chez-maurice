import { getModel, householdDefaultModel } from "./models";
import { newUsage, priceFor, priceUsage } from "./pricing";

// The conversation Maurice opens once a member's mailbox has been walked
// (specs/mail-import.md, settled 26 September 2026, reshaped the same
// evening). Opened late — only when the header walk is done — and short:
// what the box holds (messages, and how many are newsletters and
// notifications), how many real exchanges the last three years hold, what
// reading them would give and how many nights it would take ("three or four
// nights", never "tomorrow morning"), and the question. No top senders, no
// unanswered threads: that is the report, a deliverable of its own.
//
// **No money.** Candide's direction, 26 September 2026: spending is abstract
// to a member and every app spares them the subject; the only ceiling is
// the household's, the operator's business. So the cost range computed
// below is never in the message — it goes to the log and, later, the
// console; the member's "yes" is consent to read, not a purchase. The yes
// itself is lot 3.
//
// Rendered by the server, deterministically, in the member's language, as
// the domain opener is — no model writes it, so it never depends on one.

/** What `email__estimate_reading` answers, the part the message needs. */
export interface ReadingEstimate {
  years: number;
  messages: number;
  window: { messages: number; bulk: number; correspondence: number; other: number };
  to_read: number;
  tokens: { light: number; full: number } | null;
  nights: { low: number; high: number };
  /** All-time counts by kind (the triage's), when the caller has them. */
  all?: { bulk: number; correspondence: number; other: number };
}

export interface CostRange {
  low: number;
  high: number;
  /** The models the two bounds were priced on. */
  light_model: string;
  full_model: string;
}

// ── The price ────────────────────────────────────────────────────────────

/** The light pass reads the first characters of each message and answers
 *  in a few words; mistral-small is the spec's choice for it. */
export const LIGHT_MODEL = "mistral-small-3.2-24b-instruct-2506";
const LIGHT_OUTPUT_TOKENS_PER_MESSAGE = 40;
/** A full reading writes: a share of what it read, as output. */
const FULL_OUTPUT_SHARE = 0.1;

/** Euros for `tokens` in and `out` out on a model, from the price sheet.
 *  Null when the sheet does not know the model — never zero, which would
 *  read as free. An Ollama model is free by construction. */
function eurosFor(model: string, tokensIn: number, tokensOut: number): number | null {
  const provider = getModel(model)?.provider ?? "";
  if (provider !== "ollama" && !priceFor(model)) return null;
  // priceUsage holds the sheet, the EUR rate and Ollama's zero: one place.
  const u = newUsage(provider, model);
  u.input = tokensIn;
  u.output = tokensOut;
  return priceUsage(u).cost;
}

/** Low: the light pass alone. High: the light pass, then every body read
 *  whole by the member's everyday model. Both from the calibration's tokens.
 *  For the operator — the log, the console — never for the member. */
export function readingCost(est: ReadingEstimate, fullModel: string = householdDefaultModel()): CostRange | null {
  if (!est.tokens) return null;
  const light = eurosFor(LIGHT_MODEL, est.tokens.light, est.to_read * LIGHT_OUTPUT_TOKENS_PER_MESSAGE);
  const full = eurosFor(fullModel, est.tokens.full, Math.round(est.tokens.full * FULL_OUTPUT_SHARE));
  if (light === null || full === null) return null;
  return { low: light, high: light + full, light_model: LIGHT_MODEL, full_model: fullModel };
}

// ── The member's language ────────────────────────────────────────────────

export interface MailOpenerStrings {
  title: string;
  /** %1 messages in all, %2 of them newsletters and notifications. */
  all: string;
  /** %1 years, %2 real exchanges. */
  window: string;
  /** What reading gives, over %1 nights. */
  offer: string;
  /** %1 low, %2 high nights, as words. */
  nights: string;
  question: string;
  /** %1 years: nothing to read. */
  nothing: string;
  numbers: string[];
}

const NUMBERS: Record<string, string[]> = {
  en: ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"],
  fr: ["zéro", "une", "deux", "trois", "quatre", "cinq", "six", "sept", "huit", "neuf", "dix"],
  it: ["zero", "una", "due", "tre", "quattro", "cinque", "sei", "sette", "otto", "nove", "dieci"],
  de: ["null", "eine", "zwei", "drei", "vier", "fünf", "sechs", "sieben", "acht", "neun", "zehn"],
  es: ["cero", "una", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve", "diez"],
  pt: ["zero", "uma", "duas", "três", "quatro", "cinco", "seis", "sete", "oito", "nove", "dez"],
  nl: ["nul", "één", "twee", "drie", "vier", "vijf", "zes", "zeven", "acht", "negen", "tien"],
};

export const MAIL_OPENER_STRINGS: Record<string, MailOpenerStrings> = {
  en: {
    title: "Your mailbox, in numbers",
    all: "I have walked the headers of your mailbox: %1 messages in all, %2 of them newsletters and notifications.",
    window: "Over the last %1 years I count %2 real exchanges.",
    offer: "I can read them, over %1, and tell you who matters to you and what is going on.",
    nights: "%1 or %2 nights",
    question: "Shall I read them? Yes or no.",
    nothing: "Over the last %1 years I find no real exchange to read.",
    numbers: NUMBERS.en!,
  },
  fr: {
    title: "Ta boîte mail, en chiffres",
    all: "J'ai relevé les en-têtes de ta boîte : %1 messages en tout, dont %2 lettres d'information et notifications.",
    window: "Sur les %1 dernières années, j'y compte %2 vrais échanges.",
    offer: "Je peux les lire, sur %1, et te dire qui compte pour toi et ce qui est en cours.",
    nights: "%1 ou %2 nuits",
    question: "Je lis ? Oui ou non.",
    nothing: "Sur les %1 dernières années, je n'y trouve aucun vrai échange à lire.",
    numbers: NUMBERS.fr!,
  },
  it: {
    title: "La tua casella, in cifre",
    all: "Ho raccolto le intestazioni della tua casella: %1 messaggi in tutto, di cui %2 newsletter e notifiche.",
    window: "Negli ultimi %1 anni ci conto %2 scambi veri.",
    offer: "Posso leggerli, in %1, e dirti chi conta per te e cosa è in corso.",
    nights: "%1 o %2 notti",
    question: "Li leggo? Sì o no.",
    nothing: "Negli ultimi %1 anni non ci trovo nessuno scambio vero da leggere.",
    numbers: NUMBERS.it!,
  },
  de: {
    title: "Dein Postfach, in Zahlen",
    all: "Ich habe die Kopfzeilen deines Postfachs erfasst: %1 Nachrichten insgesamt, davon %2 Newsletter und Benachrichtigungen.",
    window: "In den letzten %1 Jahren zähle ich %2 echte Wechsel.",
    offer: "Ich kann sie lesen, über %1, und dir sagen, wer für dich zählt und was gerade läuft.",
    nights: "%1 oder %2 Nächte",
    question: "Soll ich sie lesen? Ja oder nein.",
    nothing: "In den letzten %1 Jahren finde ich keinen echten Wechsel zum Lesen.",
    numbers: NUMBERS.de!,
  },
  es: {
    title: "Tu buzón, en cifras",
    all: "He recorrido las cabeceras de tu buzón: %1 mensajes en total, %2 de ellos boletines y notificaciones.",
    window: "En los últimos %1 años cuento %2 intercambios reales.",
    offer: "Puedo leerlos, en %1, y decirte quién cuenta para ti y qué está en marcha.",
    nights: "%1 o %2 noches",
    question: "¿Los leo? Sí o no.",
    nothing: "En los últimos %1 años no encuentro ningún intercambio real que leer.",
    numbers: NUMBERS.es!,
  },
  pt: {
    title: "A tua caixa, em números",
    all: "Levantei os cabeçalhos da tua caixa: %1 mensagens ao todo, %2 delas newsletters e notificações.",
    window: "Nos últimos %1 anos conto %2 trocas reais.",
    offer: "Posso lê-las, em %1, e dizer-te quem conta para ti e o que está em curso.",
    nights: "%1 ou %2 noites",
    question: "Leio? Sim ou não.",
    nothing: "Nos últimos %1 anos não encontro nenhuma troca real para ler.",
    numbers: NUMBERS.pt!,
  },
  nl: {
    title: "Je mailbox, in cijfers",
    all: "Ik heb de koppen van je mailbox doorlopen: %1 berichten in totaal, waarvan %2 nieuwsbrieven en meldingen.",
    window: "Over de laatste %1 jaar tel ik %2 echte uitwisselingen.",
    offer: "Ik kan ze lezen, in %1, en je zeggen wie voor jou telt en wat er speelt.",
    nights: "%1 of %2 nachten",
    question: "Zal ik ze lezen? Ja of nee.",
    nothing: "Over de laatste %1 jaar vind ik geen echte uitwisseling om te lezen.",
    numbers: NUMBERS.nl!,
  },
};

export function mailOpenerStrings(locale: string): MailOpenerStrings {
  return MAIL_OPENER_STRINGS[locale] ?? MAIL_OPENER_STRINGS.en!;
}

function fmt(s: string, ...args: Array<string | number>): string {
  return s.replace(/%(\d)/g, (_, i) => String(args[Number(i) - 1] ?? ""));
}

const LOCALE_TAG: Record<string, string> = { en: "en-GB", fr: "fr-FR", it: "it-IT", de: "de-DE", es: "es-ES", pt: "pt-PT", nl: "nl-NL" };

export function formatCount(n: number, locale: string): string {
  return new Intl.NumberFormat(LOCALE_TAG[locale] ?? "en-GB").format(Math.round(n));
}

/** Euros, two decimals; a cent at least, so a range never reads "0 €". */
export function formatEuros(v: number, locale: string): string {
  const cents = Math.max(0.01, Math.ceil(v * 100) / 100);
  return new Intl.NumberFormat(LOCALE_TAG[locale] ?? "en-GB", { style: "currency", currency: "EUR" }).format(cents);
}

/** "three or four nights": words up to ten, digits beyond. */
export function nightsPhrase(low: number, high: number, t: MailOpenerStrings): string {
  const word = (n: number) => (n >= 0 && n < t.numbers.length ? t.numbers[n]! : String(n));
  return fmt(t.nights, word(low), word(high));
}

// ── The rendering ────────────────────────────────────────────────────────

export interface MailOpeningInput {
  locale: string;
  estimate: ReadingEstimate;
}

/**
 * The opening message: what the box holds, the real exchanges of the
 * window, what reading them gives and how many nights, the question. Four
 * short paragraphs — no money, and nothing about anyone.
 */
export function renderMailOpening(input: MailOpeningInput): string {
  const t = mailOpenerStrings(input.locale);
  const e = input.estimate;
  const n = (v: number) => formatCount(v, input.locale);
  const bulk = e.all?.bulk ?? null;
  const blocks: string[] = [];
  blocks.push(bulk === null ? fmt(t.all, n(e.messages), n(0)).replace(/,[^.]*$/, ".") : fmt(t.all, n(e.messages), n(bulk)));
  if (!e.to_read) {
    blocks.push(fmt(t.nothing, n(e.years)));
    return blocks.join("\n\n");
  }
  blocks.push(fmt(t.window, n(e.years), n(e.to_read)));
  blocks.push(fmt(t.offer, nightsPhrase(e.nights.low, e.nights.high, t)));
  blocks.push(t.question);
  return blocks.join("\n\n");
}

/** One line for the log and the console: the operator's view of what a
 *  reading would cost. Never shown to the member. */
export function describeCost(cost: CostRange | null): string {
  if (!cost) return "cost: unpriced model";
  return `cost: ${cost.low.toFixed(3)}–${cost.high.toFixed(3)} € (${cost.light_model} → ${cost.full_model})`;
}

export function mailOpeningTitle(locale: string): string {
  return mailOpenerStrings(locale).title;
}
