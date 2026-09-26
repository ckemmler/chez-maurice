import { getModel, householdDefaultModel } from "./models";
import { newUsage, priceFor, priceUsage } from "./pricing";

// The conversation Maurice opens once a member's mailbox has been walked
// (specs/mail-import.md, settled 26 September 2026). Opened late — only
// when the header walk is done — and made of numbers, nothing else: how
// many messages, how many of them correspondence, the same over the last
// three years, what reading those would cost (a range, never a figure), how
// many nights it would take ("three or four nights", never "tomorrow
// morning"), and the question. No top senders, no unanswered threads: that
// is the report, a deliverable of its own. The "yes" itself and the spend
// are lot 3.
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
 *  whole by the member's everyday model. Both from the calibration's tokens. */
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
  /** %1 messages in all, %2 of them correspondence. */
  all: string;
  /** %1 years, %2 messages, %3 of them correspondence. */
  window: string;
  /** %1 low, %2 high (euros, formatted), %3 nights. */
  cost: string;
  /** %3 nights alone, when the household pays nothing (Ollama). */
  free: string;
  /** When the model's price is unknown: %3 nights. */
  unpriced: string;
  /** %1 low, %2 high nights, as words. */
  nights: string;
  question: string;
  nothing: string;
  years: string[];
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
    all: "I have walked the headers of your mailbox: %1 messages, %2 of them correspondence.",
    window: "Over the last %1 years: %2 messages, %3 of them correspondence.",
    cost: "Reading those would cost between %1 and %2, over %3.",
    free: "Reading those costs nothing on this household; it would take %3.",
    unpriced: "I do not have a price for the model this household reads with; it would take %3.",
    nights: "%1 or %2 nights",
    question: "Shall I read them? Yes or no.",
    nothing: "There is nothing to read over that window.",
    years: ["years", "year"],
    numbers: NUMBERS.en!,
  },
  fr: {
    title: "Ta boîte mail, en chiffres",
    all: "J'ai relevé les en-têtes de ta boîte : %1 messages, dont %2 de correspondance.",
    window: "Sur les %1 dernières années : %2 messages, dont %3 de correspondance.",
    cost: "Les lire coûterait entre %1 et %2, sur %3.",
    free: "Les lire ne coûte rien sur ce foyer ; il faudrait %3.",
    unpriced: "Je n'ai pas le prix du modèle avec lequel ce foyer lit ; il faudrait %3.",
    nights: "%1 ou %2 nuits",
    question: "Je lis ? Oui ou non.",
    nothing: "Il n'y a rien à lire sur cette période.",
    years: ["années", "année"],
    numbers: NUMBERS.fr!,
  },
  it: {
    title: "La tua casella, in cifre",
    all: "Ho raccolto le intestazioni della tua casella: %1 messaggi, di cui %2 di corrispondenza.",
    window: "Negli ultimi %1 anni: %2 messaggi, di cui %3 di corrispondenza.",
    cost: "Leggerli costerebbe tra %1 e %2, in %3.",
    free: "Leggerli non costa nulla in questa casa; ci vorrebbero %3.",
    unpriced: "Non ho il prezzo del modello con cui questa casa legge; ci vorrebbero %3.",
    nights: "%1 o %2 notti",
    question: "Li leggo? Sì o no.",
    nothing: "Non c'è nulla da leggere in questo periodo.",
    years: ["anni", "anno"],
    numbers: NUMBERS.it!,
  },
  de: {
    title: "Dein Postfach, in Zahlen",
    all: "Ich habe die Kopfzeilen deines Postfachs erfasst: %1 Nachrichten, davon %2 Korrespondenz.",
    window: "In den letzten %1 Jahren: %2 Nachrichten, davon %3 Korrespondenz.",
    cost: "Sie zu lesen würde zwischen %1 und %2 kosten, über %3.",
    free: "Sie zu lesen kostet in diesem Haushalt nichts; es bräuchte %3.",
    unpriced: "Ich habe keinen Preis für das Modell, mit dem dieser Haushalt liest; es bräuchte %3.",
    nights: "%1 oder %2 Nächte",
    question: "Soll ich sie lesen? Ja oder nein.",
    nothing: "In diesem Zeitraum gibt es nichts zu lesen.",
    years: ["Jahren", "Jahr"],
    numbers: NUMBERS.de!,
  },
  es: {
    title: "Tu buzón, en cifras",
    all: "He recorrido las cabeceras de tu buzón: %1 mensajes, %2 de ellos de correspondencia.",
    window: "En los últimos %1 años: %2 mensajes, %3 de ellos de correspondencia.",
    cost: "Leerlos costaría entre %1 y %2, en %3.",
    free: "Leerlos no cuesta nada en este hogar; harían falta %3.",
    unpriced: "No tengo el precio del modelo con el que lee este hogar; harían falta %3.",
    nights: "%1 o %2 noches",
    question: "¿Los leo? Sí o no.",
    nothing: "No hay nada que leer en ese periodo.",
    years: ["años", "año"],
    numbers: NUMBERS.es!,
  },
  pt: {
    title: "A tua caixa, em números",
    all: "Levantei os cabeçalhos da tua caixa: %1 mensagens, %2 delas de correspondência.",
    window: "Nos últimos %1 anos: %2 mensagens, %3 delas de correspondência.",
    cost: "Lê-las custaria entre %1 e %2, em %3.",
    free: "Lê-las não custa nada nesta casa; levaria %3.",
    unpriced: "Não tenho o preço do modelo com que esta casa lê; levaria %3.",
    nights: "%1 ou %2 noites",
    question: "Leio? Sim ou não.",
    nothing: "Não há nada para ler nesse período.",
    years: ["anos", "ano"],
    numbers: NUMBERS.pt!,
  },
  nl: {
    title: "Je mailbox, in cijfers",
    all: "Ik heb de koppen van je mailbox doorlopen: %1 berichten, waarvan %2 correspondentie.",
    window: "Over de laatste %1 jaar: %2 berichten, waarvan %3 correspondentie.",
    cost: "Ze lezen zou tussen %1 en %2 kosten, in %3.",
    free: "Ze lezen kost niets in dit huishouden; het zou %3 duren.",
    unpriced: "Ik heb geen prijs voor het model waarmee dit huishouden leest; het zou %3 duren.",
    nights: "%1 of %2 nachten",
    question: "Zal ik ze lezen? Ja of nee.",
    nothing: "Er is niets te lezen in die periode.",
    years: ["jaar", "jaar"],
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
  /** Null when the model is unpriced; low = high = 0 when it is free. */
  cost: CostRange | null;
}

/**
 * The opening message: the mailbox in all, the window, the cost and the
 * nights, the question. Four short paragraphs, every one of them a number
 * or the question — and nothing about anyone.
 */
export function renderMailOpening(input: MailOpeningInput): string {
  const t = mailOpenerStrings(input.locale);
  const e = input.estimate;
  const n = (v: number) => formatCount(v, input.locale);
  const allCorrespondence = e.all ? e.all.correspondence : null;
  const blocks: string[] = [];
  blocks.push(allCorrespondence === null ? fmt(t.all, n(e.messages), "—").replace(", — ", " ") : fmt(t.all, n(e.messages), n(allCorrespondence)));
  blocks.push(fmt(t.window, n(e.years), n(e.window.messages), n(e.window.correspondence)));
  if (!e.to_read) {
    blocks.push(t.nothing);
    return blocks.join("\n\n");
  }
  const nights = nightsPhrase(e.nights.low, e.nights.high, t);
  if (input.cost === null) blocks.push(fmt(t.unpriced, "", "", nights));
  else if (input.cost.high <= 0) blocks.push(fmt(t.free, "", "", nights));
  else blocks.push(fmt(t.cost, formatEuros(input.cost.low, input.locale), formatEuros(input.cost.high, input.locale), nights));
  blocks.push(t.question);
  return blocks.join("\n\n");
}

export function mailOpeningTitle(locale: string): string {
  return mailOpenerStrings(locale).title;
}
