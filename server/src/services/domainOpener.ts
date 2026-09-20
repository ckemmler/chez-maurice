import type { Proposal } from "./domainProposals";

// The opening message of the conversation that proposes domains — rendered
// by the server, deterministically, from the proposals themselves (P2-D,
// 20 September 2026). The first real night had the model present three
// domains and merely name the twelve others; the owner asked for every
// living proposal on the page, each with a visible measure of its weight,
// and for a plain explanation of what a domain is and what it feeds.
//
// So the model no longer writes the list. It writes three things, as JSON:
// the introduction (what it did, in its voice), the nuances it sees, and
// the invitation; the server lays out the rest — the explanation, in the
// member's language; every alive proposal with its weight (a bar of dots
// relative to the biggest), its conversations, its share of the member's
// conversations, how many were recent, and one line of summary; the lived
// ones named apart. When the model's reply cannot be read, the fixed
// sentences below stand in, so the message never depends on it.

// ── The member's language ────────────────────────────────────────────────────

export interface OpenerStrings {
  /** What a domain is and what it feeds; the rule. */
  what: string;
  alive_head: string;
  lived_head: string;
  conversations_one: string;
  conversations_other: string;
  recent: string;
  quiet_since: string;
  intro: string;
  invitation: string;
  title: string;
  nothing_lived: string;
  /** The app's button under the message, as the app labels it. */
  button: string;
}

export const OPENER_STRINGS: Record<string, OpenerStrings> = {
  en: {
    what:
      "A domain is a part of your life I follow closely — a project, a practice, a subject you keep coming back to. For each one I keep a short brief, which you can read and correct in the app, and which I read in every conversation you have alone with me: that is what lets me know who I am talking to. Nothing exists until you say yes.",
    alive_head: "What I see living now",
    lived_head: "What lived at some point",
    conversations_one: "%d conversation",
    conversations_other: "%d conversations",
    recent: "%d recent",
    quiet_since: "quiet since %s",
    intro: "Tonight I looked over our past conversations — the ones imported from other assistants and the ones lived with you — and I saw a few parts of your life I seem to follow.",
    invitation: "Adopt, rename, cut, merge or refuse them — here, in your words, or with “Define my domains” under this message in the Maurice app.",
    title: "Your domains, as I see them",
    nothing_lived: "",
    button: "Define my domains",
  },
  fr: {
    what:
      "Un domaine, c'est un pan de ta vie que je suis de près — un projet, une pratique, un sujet sur lequel tu reviens. Pour chacun je tiens un cahier court, que tu peux lire et corriger dans l'app, et que je lis dans chaque conversation que tu as seul avec moi : c'est ce qui me permet de savoir à qui je m'adresse. Rien n'existe tant que tu n'as pas dit oui.",
    alive_head: "Ce que je vois vivre en ce moment",
    lived_head: "Ce qui a vécu à un moment",
    conversations_one: "%d conversation",
    conversations_other: "%d conversations",
    recent: "%d récentes",
    quiet_since: "calme depuis %s",
    intro: "Cette nuit, j'ai relu nos échanges passés — ceux importés d'autres assistants et ceux vécus avec toi — et j'y ai vu quelques pans de ta vie que je semble suivre.",
    invitation: "Adopte, renomme, coupe, fusionne ou refuse — ici, dans tes mots, ou avec « Définir mes domaines » sous ce message dans l'app Maurice.",
    title: "Tes domaines, tels que je les vois",
    nothing_lived: "",
    button: "Définir mes domaines",
  },
  it: {
    what:
      "Un dominio è una parte della tua vita che seguo da vicino — un progetto, una pratica, un argomento su cui torni. Per ciascuno tengo un breve quaderno, che puoi leggere e correggere nell'app e che leggo in ogni conversazione che hai da solo con me: è ciò che mi permette di sapere con chi parlo. Nulla esiste finché non dici di sì.",
    alive_head: "Ciò che vedo vivere adesso",
    lived_head: "Ciò che è vissuto a un certo punto",
    conversations_one: "%d conversazione",
    conversations_other: "%d conversazioni",
    recent: "%d recenti",
    quiet_since: "fermo dal %s",
    intro: "Stanotte ho riletto le nostre conversazioni passate — quelle importate da altri assistenti e quelle vissute con te — e ci ho visto alcune parti della tua vita che sembro seguire.",
    invitation: "Adotta, rinomina, dividi, unisci o rifiuta — qui, con le tue parole, oppure con «Definire i miei domini» sotto questo messaggio nell'app Maurice.",
    title: "I tuoi domini, come li vedo",
    nothing_lived: "",
    button: "Definire i miei domini",
  },
  de: {
    what:
      "Ein Bereich ist ein Teil deines Lebens, den ich aufmerksam verfolge — ein Projekt, eine Praxis, ein Thema, zu dem du immer wieder zurückkommst. Zu jedem führe ich ein kurzes Heft, das du in der App lesen und korrigieren kannst und das ich in jedem Gespräch lese, das du allein mit mir führst: So weiß ich, mit wem ich spreche. Nichts existiert, bevor du Ja sagst.",
    alive_head: "Was ich gerade leben sehe",
    lived_head: "Was einmal gelebt hat",
    conversations_one: "%d Gespräch",
    conversations_other: "%d Gespräche",
    recent: "%d aktuell",
    quiet_since: "ruhig seit %s",
    intro: "Heute Nacht habe ich unsere vergangenen Gespräche durchgesehen — die aus anderen Assistenten importierten und die mit dir geführten — und darin einige Teile deines Lebens gesehen, die ich offenbar verfolge.",
    invitation: "Übernimm, benenne um, teile, führe zusammen oder lehne ab — hier, in deinen Worten, oder mit „Meine Bereiche festlegen“ unter dieser Nachricht in der Maurice-App.",
    title: "Deine Bereiche, wie ich sie sehe",
    nothing_lived: "",
    button: "Meine Bereiche festlegen",
  },
  es: {
    what:
      "Un dominio es una parte de tu vida que sigo de cerca: un proyecto, una práctica, un tema al que vuelves. De cada uno guardo un cuaderno breve, que puedes leer y corregir en la app y que leo en cada conversación que tienes a solas conmigo: es lo que me permite saber con quién hablo. Nada existe hasta que digas que sí.",
    alive_head: "Lo que veo vivir ahora",
    lived_head: "Lo que vivió en algún momento",
    conversations_one: "%d conversación",
    conversations_other: "%d conversaciones",
    recent: "%d recientes",
    quiet_since: "en calma desde %s",
    intro: "Esta noche he releído nuestras conversaciones pasadas —las importadas de otros asistentes y las vividas contigo— y he visto en ellas algunas partes de tu vida que parezco seguir.",
    invitation: "Adopta, renombra, separa, fusiona o rechaza —aquí, con tus palabras, o con «Definir mis dominios» bajo este mensaje en la app Maurice.",
    title: "Tus dominios, tal como los veo",
    nothing_lived: "",
    button: "Definir mis dominios",
  },
  pt: {
    what:
      "Um domínio é uma parte da tua vida que acompanho de perto — um projeto, uma prática, um assunto a que voltas. Para cada um guardo um caderno curto, que podes ler e corrigir na app e que leio em cada conversa que tens a sós comigo: é o que me permite saber com quem falo. Nada existe enquanto não disseres que sim.",
    alive_head: "O que vejo viver agora",
    lived_head: "O que viveu a certa altura",
    conversations_one: "%d conversa",
    conversations_other: "%d conversas",
    recent: "%d recentes",
    quiet_since: "parado desde %s",
    intro: "Esta noite reli as nossas conversas passadas — as importadas de outros assistentes e as vividas contigo — e vi nelas algumas partes da tua vida que pareço acompanhar.",
    invitation: "Adota, renomeia, separa, junta ou recusa — aqui, com as tuas palavras, ou com «Definir os meus domínios» por baixo desta mensagem na app Maurice.",
    title: "Os teus domínios, tal como os vejo",
    nothing_lived: "",
    button: "Definir os meus domínios",
  },
  nl: {
    what:
      "Een domein is een deel van je leven dat ik van dichtbij volg — een project, een praktijk, een onderwerp waar je op terugkomt. Van elk houd ik een kort schrift bij, dat je in de app kunt lezen en verbeteren en dat ik lees in elk gesprek dat je alleen met mij voert: zo weet ik met wie ik praat. Niets bestaat voordat je ja zegt.",
    alive_head: "Wat ik nu zie leven",
    lived_head: "Wat ooit heeft geleefd",
    conversations_one: "%d gesprek",
    conversations_other: "%d gesprekken",
    recent: "%d recent",
    quiet_since: "stil sinds %s",
    intro: "Vannacht heb ik onze eerdere gesprekken doorgelezen — die uit andere assistenten zijn geïmporteerd en die met jou zijn gevoerd — en ik zag er een paar delen van je leven in die ik blijkbaar volg.",
    invitation: "Neem over, hernoem, splits, voeg samen of weiger — hier, in je eigen woorden, of met “Mijn domeinen bepalen” onder dit bericht in de Maurice-app.",
    title: "Je domeinen, zoals ik ze zie",
    nothing_lived: "",
    button: "Mijn domeinen bepalen",
  },
};

export function openerStrings(locale: string): OpenerStrings {
  return OPENER_STRINGS[locale] ?? OPENER_STRINGS.en!;
}

function fmt(s: string, ...args: Array<string | number>): string {
  let i = 0;
  return s.replace(/%[ds]/g, () => String(args[i++] ?? ""));
}

// ── Weight ───────────────────────────────────────────────────────────────────

export const WEIGHT_DOTS = 5;

/** A proposal's weight on a five-dot bar, relative to the biggest one of the
 *  lot: the square root keeps a domain of 40 conversations visible beside
 *  one of 700 (one dot, not none). Always at least one. */
export function weightOf(size: number, maxSize: number): number {
  if (size <= 0 || maxSize <= 0) return 1;
  return Math.max(1, Math.min(WEIGHT_DOTS, Math.round(WEIGHT_DOTS * Math.sqrt(size / maxSize))));
}

export function dots(weight: number): string {
  const w = Math.max(0, Math.min(WEIGHT_DOTS, weight));
  return "●".repeat(w) + "○".repeat(WEIGHT_DOTS - w);
}

/** Share of the member's conversations, as a whole percentage (at least 1
 *  when there is anything at all). */
export function shareOf(size: number, total: number): number {
  if (size <= 0 || total <= 0) return 0;
  return Math.max(1, Math.round((100 * size) / total));
}

/** The first sentence of a summary, cut to `max` characters. */
export function oneLine(summary: string, max = 150): string {
  const flat = summary.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const m = flat.match(/^.*?[.!?](?=\s|$)/);
  let line = (m ? m[0] : flat).trim();
  if (line.length > max) line = line.slice(0, max - 1).replace(/[\s,;:]+\S*$/, "") + "…";
  return line;
}

// ── What the model writes ────────────────────────────────────────────────────

export interface OpenerParts {
  intro: string;
  nuances: string;
  invitation: string;
}

export function openerSystem(name: string, language: string, buttonLabel = "Define my domains"): string {
  return [
    `You are Maurice, ${name}'s personal assistant. Tonight you looked over their past conversations — the ones imported from other assistants and the ones lived with you — and saw a few parts of their life you seem to follow. You are opening a conversation to propose them as *domains*: a domain is a part of their life you follow closely, with a short brief you keep on it that they can read and correct in the app. Nothing exists until they say yes.`,
    `The app lays the list of domains out itself, with each one's weight; you do not list them. You write three short things, in ${language}, addressing ${name} as "you" (the familiar form where the language has one — "tu" in French), in your own voice: warm, plain, no flattery, no filler, no emoji, no markdown, no title. Return one JSON object and nothing else: {"intro": "…", "nuances": "…", "invitation": "…"}.\n- "intro": one to three sentences — what you did tonight and what you saw, without naming the domains.\n- "nuances": the nuances you see, in one short paragraph — a group that might be two things, two that might be one, one that may not be a domain, what is dated; name the domains concerned. Empty string if you see none.\n- "invitation": one or two sentences inviting them to adopt, rename, cut, merge or refuse — here in their words, or with the button "${buttonLabel}" under this message in the app (that is its exact label; keep it). Ask nothing you could not act on here.`,
  ].join("\n\n");
}

export function openerPrompt(alive: Proposal[], lived: Proposal[], name: string, sampleTitles: (p: Proposal) => string[]): string {
  const card = (p: Proposal) =>
    `- ${p.name} — ${p.conversation_ids.length} conversations, ${p.stats.first?.slice(0, 7)} → ${p.stats.last?.slice(0, 7)}, ${p.stats.recent_90 ?? 0} in the last 90 days.${p.stats.split_hint ? ` Might be several things: ${p.stats.split_hint}` : ""}\n  ${p.summary}${sampleTitles(p).length ? `\n  Sample: ${sampleTitles(p).join("; ")}` : ""}`;
  return [
    `The domains alive now, that the app will present to ${name} (biggest first):\n${alive.map(card).join("\n")}`,
    lived.length
      ? `Others that lived at some point, named apart by the app:\n${lived.map((p) => `- ${p.name} (${p.conversation_ids.length} conversations, quiet since ${p.stats.last?.slice(0, 7)})`).join("\n")}`
      : `Nothing else lived.`,
    `Write your three parts for ${name}, as JSON.`,
  ].join("\n\n");
}

/** Read the model's reply loosely: a JSON object somewhere in the text, or
 *  nothing (then the fixed sentences stand in). */
export function parseOpener(text: string): Partial<OpenerParts> {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return {};
  try {
    const d = JSON.parse(m[0]);
    const s = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");
    return { intro: s(d.intro), nuances: s(d.nuances), invitation: s(d.invitation) };
  } catch {
    return {};
  }
}

// ── The rendering ────────────────────────────────────────────────────────────

export interface OpeningInput {
  locale: string;
  /** Alive proposals, in the order to show them. */
  alive: Proposal[];
  /** Lived proposals, named apart. */
  lived: Proposal[];
  /** The member's conversations in all, for the share. */
  total: number;
  parts?: Partial<OpenerParts>;
}

/** One proposal's line: the weight, the name, the numbers, one line of summary. */
export function proposalLine(p: Proposal, maxSize: number, total: number, t: OpenerStrings): string {
  const n = p.conversation_ids.length;
  const bits = [fmt(n === 1 ? t.conversations_one : t.conversations_other, n)];
  const share = shareOf(n, total);
  if (share) bits.push(`${share} %`);
  const recent = p.stats.recent_90 ?? 0;
  if (recent) bits.push(fmt(t.recent, recent));
  const line = oneLine(p.summary);
  return `- ${dots(weightOf(n, maxSize))} **${p.name}** · ${bits.join(" · ")}${line ? ` — ${line}` : ""}`;
}

/**
 * The opening message: the model's introduction (or the fixed one), what a
 * domain is, every alive proposal with its weight, the lived ones named
 * apart, the model's nuances when it has any, the invitation. Markdown that
 * reads on a phone: one list item per proposal, no table.
 */
export function renderOpening(input: OpeningInput): string {
  const t = openerStrings(input.locale);
  const parts = input.parts ?? {};
  const maxSize = Math.max(1, ...input.alive.map((p) => p.conversation_ids.length), ...input.lived.map((p) => p.conversation_ids.length));
  const blocks: string[] = [];
  blocks.push(parts.intro || t.intro);
  blocks.push(t.what);
  if (input.alive.length) {
    blocks.push(`**${t.alive_head}**\n\n${input.alive.map((p) => proposalLine(p, maxSize, input.total, t)).join("\n")}`);
  }
  if (input.lived.length) {
    const named = input.lived.map((p) => {
      const n = p.conversation_ids.length;
      const since = p.stats.last?.slice(0, 7);
      return `${p.name} (${fmt(n === 1 ? t.conversations_one : t.conversations_other, n)}${since ? `, ${fmt(t.quiet_since, since)}` : ""})`;
    });
    blocks.push(`**${t.lived_head}** : ${named.join(" · ")}.`);
  }
  if (parts.nuances) blocks.push(parts.nuances);
  blocks.push(parts.invitation || t.invitation);
  return blocks.join("\n\n");
}

export function openingTitle(locale: string): string {
  return openerStrings(locale).title;
}
