// ── The icon of a domain (3 October 2026) ────────────────────────────────────
//
// A domain is named in three places where a word is too much: the list, its
// page, and the pastilles a conversation wears once Maurice has drawn on it.
// Until now every domain wore the same closed book, which tells a member that
// *a* domain was read and not *which*.
//
// The icon is an SF Symbol name, because the two clients that draw it are
// Apple's and a name costs nothing to store or to send. It is picked from a
// short list rather than from the six thousand symbols that exist: a model
// asked for "an SF Symbol" invents names, and a name that does not exist draws
// as nothing. The list is what the night model chooses from
// (services/domainBriefs.ts, `ensureDomainIcon`), with the words below as the
// fallback when it fails or is capped. The member's own choice in the editor
// is not held to the list — only to the shape of a symbol name.

export interface DomainIcon {
  symbol: string;
  /** What it stands for, in the words the model reads. */
  about: string;
  /** Lower-case stems looked for in the domain's name and line when the model
   *  is not there to choose. French and English, the two the owner's
   *  households speak; the model covers the rest. */
  words: string[];
}

export const DOMAIN_ICONS: DomainIcon[] = [
  { symbol: "cross.case", about: "health, medicine, doctors, treatments", words: ["santé", "sante", "health", "médec", "medec", "medic", "soin", "malad", "thérap", "therap"] },
  { symbol: "brain.head.profile", about: "mental health, psychology, the mind", words: ["psych", "mental", "esprit", "mind", "cogniti", "neuro"] },
  { symbol: "moon.zzz", about: "sleep, rest, dreams", words: ["sommeil", "sleep", "rêve", "reve", "dream", "repos"] },
  { symbol: "figure.run", about: "sport, running, fitness, training", words: ["sport", "course", "running", "fitness", "entraîn", "entrain", "training", "marathon", "gym"] },
  { symbol: "figure.pool.swim", about: "swimming", words: ["natation", "nage", "swim", "piscine"] },
  { symbol: "bicycle", about: "cycling, the bike", words: ["vélo", "velo", "bike", "cycl", "bicy"] },
  { symbol: "figure.mind.and.body", about: "yoga, meditation, well-being", words: ["yoga", "méditat", "meditat", "bien-être", "bien-etre", "wellbeing", "well-being", "relax"] },
  { symbol: "mountain.2", about: "hiking, mountains, the outdoors", words: ["randonn", "montagne", "hiking", "hike", "mountain", "alpin", "escalade", "climb", "ski"] },
  { symbol: "fork.knife", about: "cooking, food, recipes, nutrition", words: ["cuisine", "cook", "recette", "recipe", "food", "nutrition", "aliment", "repas", "pain", "bread", "boulang"] },
  { symbol: "wineglass", about: "wine, drinks, tasting", words: ["vin ", "vins", "wine", "œnolog", "oenolog", "cocktail", "bière", "biere", "beer"] },
  { symbol: "leaf", about: "gardening, plants, nature, ecology", words: ["jardin", "garden", "plante", "plant", "potager", "nature", "écolog", "ecolog", "botan", "balcon"] },
  { symbol: "pawprint", about: "pets, animals", words: ["animal", "animaux", "chien", "chat ", "chats", "dog", "cat ", "cats", "pet "] },
  { symbol: "house", about: "home, housing, the household's running", words: ["maison", "logement", "home", "house", "foyer", "appartement", "apartment", "ménage", "menage", "déménag", "demenag"] },
  { symbol: "hammer", about: "renovation, DIY, building works", words: ["rénov", "renov", "travaux", "bricol", "chantier", "diy", "construct"] },
  { symbol: "building.2", about: "real estate, property, urban planning", words: ["immobili", "real estate", "property", "urbanis", "copropri", "loyer", "rent"] },
  { symbol: "building.columns", about: "administration, law, taxes, institutions", words: ["administr", "juridi", "droit", "legal", "law", "impôt", "impot", "tax", "fisc", "réglement", "reglement", "notaire"] },
  { symbol: "banknote", about: "money, budget, savings, investments", words: ["argent", "budget", "financ", "money", "épargne", "epargne", "saving", "invest", "banque", "bank", "bourse", "patrimoine"] },
  { symbol: "briefcase", about: "work, career, a job, clients", words: ["travail", "work", "carrière", "carriere", "career", "emploi", "job", "client", "freelance", "professionn"] },
  { symbol: "lightbulb", about: "a business or product being built, ideas, strategy", words: ["entrepr", "startup", "start-up", "business", "produit", "product", "stratég", "strateg", "idée", "idee", "idea", "commerciali", "lancement", "launch"] },
  { symbol: "megaphone", about: "marketing, communication, an audience", words: ["marketing", "communicat", "audience", "publicit", "brand", "marque"] },
  { symbol: "chevron.left.forwardslash.chevron.right", about: "software development, programming", words: ["code", "développement", "developpement", "software", "program", "logiciel", "swift", "python", "typescript", "api"] },
  { symbol: "server.rack", about: "servers, infrastructure, self-hosting, networks", words: ["serveur", "server", "infra", "réseau", "reseau", "network", "hébergement", "hebergement", "hosting", "devops", "docker"] },
  { symbol: "cpu", about: "artificial intelligence, models, hardware", words: ["intelligence artificielle", "artificial intelligence", " ia ", " ai ", "llm", "modèle", "machine learning", "hardware", "matériel"] },
  { symbol: "graduationcap", about: "studies, school, a course, learning", words: ["étude", "etude", "study", "studies", "école", "ecole", "school", "universit", "cours", "apprent", "learning", "formation", "examen"] },
  { symbol: "character.book.closed", about: "learning a language, translation", words: ["langue", "language", "japonais", "japanese", "anglais", "english", "espagnol", "spanish", "allemand", "german", "néerlandais", "dutch", "italien", "traduct", "translat"] },
  { symbol: "books.vertical", about: "reading, books, literature", words: ["lecture", "reading", "livre", "book", "littérat", "litterat", "literat", "roman"] },
  { symbol: "pencil.and.outline", about: "writing, a manuscript, a blog, notes", words: ["écriture", "ecriture", "writing", "écrire", "ecrire", "manuscrit", "blog", "rédact", "redact", "essai"] },
  { symbol: "text.quote", about: "philosophy, ideas, the humanities", words: ["philosoph", "pensée", "pensee", "éthique", "ethique", "ethic", "sociolog", "humanit"] },
  { symbol: "clock.arrow.circlepath", about: "history, genealogy, the past", words: ["histoire", "history", "généalog", "genealog", "archive", "patrimoine histor"] },
  { symbol: "atom", about: "science, physics, mathematics, research", words: ["science", "physi", "math", "chimie", "chemi", "recherche", "research", "biolog", "astronom"] },
  { symbol: "music.note", about: "music, an instrument, singing", words: ["musique", "music", "chant", "sing", "concert", "chorale", "choir"] },
  { symbol: "guitars", about: "guitar, strings, violin", words: ["guitar", "violon", "violin", "violoncel", "cello", "basse"] },
  { symbol: "pianokeys", about: "piano, keyboards", words: ["piano", "clavier", "keyboard", "synth"] },
  { symbol: "paintpalette", about: "art, drawing, painting, design", words: ["art ", "arts", "dessin", "draw", "peinture", "paint", "design", "graphi", "illustr", "aquarelle"] },
  { symbol: "camera", about: "photography, video", words: ["photo", "vidéo", "video", "caméra", "camera"] },
  { symbol: "film", about: "cinema, series, films", words: ["cinéma", "cinema", "film", "série", "serie", "movie"] },
  { symbol: "theatermasks", about: "theatre, the stage, performance", words: ["théâtre", "theatre", "theater", "scène", "scene", "spectacle", "impro"] },
  { symbol: "gamecontroller", about: "games, video games, board games", words: ["jeu", "jeux", "game", "gaming"] },
  { symbol: "airplane", about: "travel, trips, holidays", words: ["voyage", "travel", "trip", "vacances", "holiday", "séjour", "sejour", "itinéraire", "itinerar"] },
  { symbol: "car", about: "the car, driving, transport", words: ["voiture", "car ", "cars", "auto", "conduite", "driving", "transport", "mobilité", "mobility"] },
  { symbol: "sailboat", about: "sailing, the sea, boats", words: ["voile", "sail", "bateau", "boat", "mer ", "navig"] },
  { symbol: "globe.europe.africa", about: "politics, the world, current affairs, geography", words: ["politi", "actualit", "news", "monde", "world", "géopolit", "geopolit", "europe", "géograph", "geograph"] },
  { symbol: "person.2", about: "relationships, friends, a couple, people", words: ["relation", "ami", "friend", "couple", "amour", "love", "social", "rencontre"] },
  { symbol: "figure.2.and.child.holdinghands", about: "family, children, parenting", words: ["famille", "family", "enfant", "child", "kids", "parent", "bébé", "bebe", "baby", "éducation", "education"] },
  { symbol: "heart", about: "the inner life, feelings, what matters", words: ["émotion", "emotion", "sentiment", "feeling", "intime", "vie intérieure", "deuil", "grief"] },
  { symbol: "sparkles", about: "spirituality, faith, meaning", words: ["spiritu", "foi ", "faith", "religio", "prière", "priere", "sens de la vie"] },
  { symbol: "envelope", about: "correspondence, mail, paperwork to answer", words: ["courrier", "mail", "correspond", "lettre", "letter"] },
  { symbol: "cart", about: "shopping, purchases, things to buy", words: ["achat", "shopping", "course ", "courses", "purchase", "commande", "équipement", "equipement"] },
  { symbol: "tshirt", about: "clothes, style, fashion", words: ["vêtement", "vetement", "clothes", "mode ", "fashion", "style"] },
  { symbol: "calendar", about: "organisation, planning, events to prepare", words: ["organis", "planning", "planif", "agenda", "événement", "evenement", "event", "mariage", "wedding", "fête", "fete"] },
  { symbol: "trophy", about: "competition, a team, a club", words: ["compétition", "competition", "tournoi", "tournament", "club", "équipe", "equipe", "team", "football", "tennis", "basket"] },
  { symbol: "bolt", about: "energy, electricity, heating", words: ["énergie", "energie", "energy", "électri", "electri", "chauffage", "heating", "solaire", "solar"] },
  { symbol: "shield", about: "insurance, security, privacy", words: ["assurance", "insurance", "sécurité", "securite", "security", "privacy", "vie privée", "mutuelle"] },
  { symbol: "newspaper", about: "media, journalism, a watch on a subject", words: ["média", "media", "journal", "presse", "press", "veille"] },
];

const BY_SYMBOL = new Map(DOMAIN_ICONS.map((i) => [i.symbol, i]));

/** Whether a symbol is one the night may choose. */
export function isListedIcon(symbol: string): boolean {
  return BY_SYMBOL.has(symbol);
}

/** The list as the model reads it: one line per symbol. */
export function iconMenu(): string {
  return DOMAIN_ICONS.map((i) => `${i.symbol} — ${i.about}`).join("\n");
}

/** The symbol in a model's answer, when it is one of the list. Tolerant of the
 *  quotes, back-ticks and trailing explanation a model wraps a name in. */
export function parseIconAnswer(answer: string): string | null {
  for (const token of answer.toLowerCase().split(/[^a-z0-9.]+/)) {
    const symbol = token.replace(/^\.+|\.+$/g, "");
    if (BY_SYMBOL.has(symbol)) return symbol;
  }
  return null;
}

/**
 * The icon the words alone suggest, or null. The name counts for more than
 * the line under it, and in a name what comes first: "Santé et bien-être" is
 * health before it is well-being. In the line under it the longest stem wins,
 * and a symbol another domain of the member's already wears is passed over
 * when something else fits.
 */
export function keywordIcon(name: string, about = "", taken: string[] = []): string | null {
  const title = flat(name);
  const rest = flat(about);
  let best: { symbol: string; score: number } | null = null;
  for (const icon of DOMAIN_ICONS) {
    let score = 0;
    for (const word of icon.words) {
      // A stem is looked for at the start of a word: "ami" is not in
      // "famille", nor "art" in "partir". A trailing space in a stem asks for
      // the whole word.
      const w = " " + word.toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, " ").trimStart();
      const at = title.indexOf(w);
      if (at >= 0) score = Math.max(score, 1000 - at + w.length / 100);
      else if (rest.includes(w)) score = Math.max(score, w.length);
    }
    if (!score) continue;
    if (taken.includes(icon.symbol)) score -= 50;
    if (!best || score > best.score) best = { symbol: icon.symbol, score };
  }
  return best?.symbol ?? null;
}

/** Lower case, everything that is not a letter or a digit a space, a space at
 *  both ends. */
function flat(s: string): string {
  return ` ${s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
}
