import type { Locale } from "./config";

export const ui: Record<Locale, Record<string, string>> = {
  en: {
    // Nav
    "nav.blog": "Blog",
    "nav.essays": "Essays",
    "nav.resources": "Resources",
    "nav.about": "About",
    "nav.research": "Research",
    "nav.history": "History",

    // Site
    "site.title": "Candide's Notebook",
    "site.footer.madeWith": "Made with",
    "site.footer.copyright": "© Candide Kemmler",

    // Home
    "home.welcome": "Welcome!",
    "home.intro.1": "I'm",
    "home.intro.name": "Candide Kemmler",
    "home.intro.2": "From time to time, I write about",
    "home.intro.whatIRead": "what I read",
    "home.intro.3": "in books and online.",
    "home.intro.4": "Occasionally, I post to the",
    "home.intro.blog": "blog",

    // Resources Hub
    "resources.title": "Resources",
    "resources.description": "A curated collection of books, articles, movies, series, and people that have shaped my thinking.",
    "resources.books": "Books",
    "resources.books.desc": "Notes and highlights from my reading",
    "resources.articles": "Articles",
    "resources.articles.desc": "Annotated articles and online reads",
    "resources.podcasts": "Podcasts",
    "resources.podcasts.desc": "Podcast episodes worth revisiting",
    "resources.movies": "Movies",
    "resources.movies.desc": "Films that left an impression",
    "resources.series": "Series",
    "resources.series.desc": "TV series I've been watching",
    "resources.people": "People",
    "resources.people.desc": "Thinkers, writers, and creators I follow",

    // Books
    "books.title": "Books",
    "books.description": "Notes and highlights from my reading.",
    "books.currentlyReading": "Currently Reading",
    "books.read": "Read",
    "books.abandoned": "Abandoned",
    "books.noBooksYet": "No books logged yet.",
    "books.by": "by",
    "books.backToBooks": "← Back to books",

    // Articles
    "articles.title": "Articles",
    "articles.description": "Annotated articles and comments on things I've read.",
    "articles.recent": "Recent",
    "articles.bySource": "By Source",
    "articles.noArticlesYet": "No articles logged yet.",
    "articles.backToArticles": "← Back to articles",
    "articles.original": "Original ↗",
    "articles.read": "Read",

    // Blog
    "blog.title": "Blog",
    "blog.description": "Informal reflections, notes, and updates.",
    "blog.noPostsYet": "No posts yet.",
    "blog.backToBlog": "← Back to blog",

    // Essays
    "essays.title": "Essays",
    "essays.description": "Longer-form pieces organized by theme.",
    "essays.noEssaysYet": "No essays yet.",
    "essays.backToEssays": "← Back to essays",
    "essays.updated": "updated",

    // Notes
    "nav.notes": "Notes",
    "notes.title": "Notes",
    "notes.description": "Interconnected notes organized by topic.",
    "notes.categories": "Categories",
    "notes.recent": "Recent",
    "notes.noNotesYet": "No notes yet.",
    "notes.backToNotes": "← Back to notes",

    // Podcasts
    "podcasts.title": "Podcasts",
    "podcasts.description": "Podcast episodes worth revisiting.",
    "podcasts.noPodcastsYet": "No podcasts logged yet.",
    "podcasts.backToPodcasts": "← Back to podcasts",
    "podcasts.listen": "Listen ↗",
    "podcasts.episodes": "Episodes",
    "podcasts.with": "with",

    // Movies
    "movies.title": "Movies",
    "movies.description": "Films that left an impression.",
    "movies.noMoviesYet": "No movies logged yet.",
    "movies.directedBy": "Directed by",
    "movies.backToMovies": "← Back to movies",

    // Series
    "series.title": "Series",
    "series.description": "TV series I've been watching.",
    "series.noSeriesYet": "No series logged yet.",
    "series.seasons": "seasons",
    "series.on": "on",
    "series.backToSeries": "← Back to series",
    "series.episodes": "Episodes",

    // People
    "people.title": "People",
    "people.description": "Thinkers, writers, and creators I follow.",
    "people.noPeopleYet": "No people logged yet.",
    "people.backToPeople": "← Back to people",
    "people.visit": "Visit ↗",

    // Fiches
    "fiches.title": "Fiches",
    "fiches.description": "Personal notes on resources.",
    "fiches.noFichesYet": "No fiches yet.",
    "fiches.backToFiches": "← Back to fiches",
    "fiches.viewFiche": "View fiche",

    // About
    "about.title": "About",
    "about.description": "About this site and its author",

    // Milestones
    "milestones.title": "Site History",
    "milestones.description": "Navigate to previous versions of this site",

    // Content
    "content.notTranslated": "This content has not been translated yet.",

    // Search
    "search.placeholder": "Search...",
    "search.noResults": "No results",

    // Language switcher
    "lang.switch": "FR",
    "lang.label": "Français",
  },
  fr: {
    // Nav
    "nav.blog": "Blog",
    "nav.essays": "Essais",
    "nav.resources": "Trouvailles",
    "nav.about": "À propos",
    "nav.research": "Recherche",
    "nav.history": "Historique",

    // Site
    "site.title": "Carnet de Candide",
    "site.footer.madeWith": "Fait avec",
    "site.footer.copyright": "© Candide Kemmler",

    // Home
    "home.welcome": "Bienvenue !",
    "home.intro.1": "Je suis",
    "home.intro.name": "Candide Kemmler",
    "home.intro.2": "De temps en temps, j'écris sur",
    "home.intro.whatIRead": "ce que je lis",
    "home.intro.3": "dans les livres et en ligne.",
    "home.intro.4": "Parfois, je publie sur le",
    "home.intro.blog": "blog",

    // Resources Hub
    "resources.title": "Trouvailles",
    "resources.description": "Une collection de livres, articles, films, séries et personnes qui ont nourri ma réflexion.",
    "resources.books": "Livres",
    "resources.books.desc": "Notes et passages marquants de mes lectures",
    "resources.articles": "Articles",
    "resources.articles.desc": "Articles annotés et lectures en ligne",
    "resources.podcasts": "Podcasts",
    "resources.podcasts.desc": "Épisodes de podcasts à réécouter",
    "resources.movies": "Films",
    "resources.movies.desc": "Films qui m'ont marqué",
    "resources.series": "Séries",
    "resources.series.desc": "Séries que je regarde",
    "resources.people": "Personnes",
    "resources.people.desc": "Penseurs, auteurs et créateurs que je suis",

    // Books
    "books.title": "Livres",
    "books.description": "Notes et passages marquants de mes lectures.",
    "books.currentlyReading": "En cours de lecture",
    "books.read": "Lus",
    "books.abandoned": "Abandonnés",
    "books.noBooksYet": "Aucun livre enregistré.",
    "books.by": "de",
    "books.backToBooks": "← Retour aux livres",

    // Articles
    "articles.title": "Articles",
    "articles.description": "Articles annotés et commentaires sur mes lectures.",
    "articles.recent": "Récents",
    "articles.bySource": "Par source",
    "articles.noArticlesYet": "Aucun article enregistré.",
    "articles.backToArticles": "← Retour aux articles",
    "articles.original": "Original ↗",
    "articles.read": "Lu",

    // Blog
    "blog.title": "Blog",
    "blog.description": "Réflexions, notes et mises à jour.",
    "blog.noPostsYet": "Aucun article pour le moment.",
    "blog.backToBlog": "← Retour au blog",

    // Essays
    "essays.title": "Essais",
    "essays.description": "Textes longs organisés par thème.",
    "essays.noEssaysYet": "Aucun essai pour le moment.",
    "essays.backToEssays": "← Retour aux essais",
    "essays.updated": "mis à jour",

    // Notes
    "nav.notes": "Notes",
    "notes.title": "Notes",
    "notes.description": "Notes interconnectées organisées par sujet.",
    "notes.categories": "Catégories",
    "notes.recent": "Récentes",
    "notes.noNotesYet": "Aucune note pour le moment.",
    "notes.backToNotes": "← Retour aux notes",

    // Podcasts
    "podcasts.title": "Podcasts",
    "podcasts.description": "Épisodes de podcasts à réécouter.",
    "podcasts.noPodcastsYet": "Aucun podcast enregistré.",
    "podcasts.backToPodcasts": "← Retour aux podcasts",
    "podcasts.listen": "Écouter ↗",
    "podcasts.episodes": "Épisodes",
    "podcasts.with": "avec",

    // Movies
    "movies.title": "Films",
    "movies.description": "Films qui m'ont marqué.",
    "movies.noMoviesYet": "Aucun film enregistré.",
    "movies.directedBy": "Réalisé par",
    "movies.backToMovies": "← Retour aux films",

    // Series
    "series.title": "Séries",
    "series.description": "Séries que je regarde.",
    "series.noSeriesYet": "Aucune série enregistrée.",
    "series.seasons": "saisons",
    "series.on": "sur",
    "series.backToSeries": "← Retour aux séries",
    "series.episodes": "Épisodes",

    // People
    "people.title": "Personnes",
    "people.description": "Penseurs, auteurs et créateurs que je suis.",
    "people.noPeopleYet": "Aucune personne enregistrée.",
    "people.backToPeople": "← Retour aux personnes",
    "people.visit": "Visiter ↗",

    // Fiches
    "fiches.title": "Fiches",
    "fiches.description": "Notes personnelles sur les ressources.",
    "fiches.noFichesYet": "Aucune fiche pour le moment.",
    "fiches.backToFiches": "← Retour aux fiches",
    "fiches.viewFiche": "Voir la fiche",

    // About
    "about.title": "À propos",
    "about.description": "À propos de ce site et de son auteur",

    // Milestones
    "milestones.title": "Historique du site",
    "milestones.description": "Naviguer vers les versions précédentes de ce site",

    // Content
    "content.notTranslated": "Ce contenu n'a pas encore été traduit.",

    // Search
    "search.placeholder": "Rechercher...",
    "search.noResults": "Aucun résultat",

    // Language switcher
    "lang.switch": "EN",
    "lang.label": "English",
  },
};
