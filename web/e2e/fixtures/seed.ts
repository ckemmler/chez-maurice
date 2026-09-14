/**
 * Seed a throwaway household for the garden's e2e battery.
 *
 *   MAURICE_DATA_DIR=/tmp/x MAURICE_GARDENS_DIR=/tmp/x/gardens bun web/e2e/fixtures/seed.ts <state.json>
 *
 * Members: hana (admin), theo and mei (standard), visitor (guest). Théo's
 * garden carries one entry of every collection, in both locales, a MOC with
 * children, a draft, a private note, an image, and a note shared with Mei.
 * Sessions are created directly so the tests never touch the login flows.
 * Everything the tests need to know lands in <state.json>.
 *
 * Refuses to run anywhere near ~/.maurice, like the demo seed does.
 */
import { join, resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const DATA = process.env.MAURICE_DATA_DIR;
const GARDENS = process.env.MAURICE_GARDENS_DIR;
if (!DATA || !GARDENS || /(^|[/\\])\.maurice([/\\]|$)/.test(DATA) || /(^|[/\\])\.maurice([/\\]|$)/.test(GARDENS)) {
  console.error("✗ set MAURICE_DATA_DIR and MAURICE_GARDENS_DIR to throwaway dirs");
  process.exit(1);
}
const OUT = process.argv[2];
if (!OUT) { console.error("usage: seed.ts <state.json>"); process.exit(2); }

const SERVER = resolve(import.meta.dir, "../../../server");
const db = (await import(join(SERVER, "src/db.ts"))).default;
const { createUser, updateHousehold } = await import(join(SERVER, "src/services/users.ts"));
const { createSession } = await import(join(SERVER, "src/services/auth.ts"));
const { addShare, setGardenTheme } = await import(join(SERVER, "src/services/gardens.ts"));

const existing = (db.query(`SELECT COUNT(*) c FROM users`).get() as { c: number }).c;
if (existing > 0) { console.error(`✗ ${DATA} already seeded`); process.exit(1); }

updateHousehold({ name: "Maison e2e", icon: "house.fill" });
const hana = await createUser({ username: "hana", display_name: "Hana", role: "admin", password: "hana-pass-e2e", avatar_color: "#2a2622" });
const theo = await createUser({ username: "theo", display_name: "Théo", role: "standard", pin: "1234", avatar_color: "#3b6ea5" });
const mei = await createUser({ username: "mei", display_name: "Mei", role: "standard", pin: "1234", avatar_color: "#a53b6e" });
const visitor = await createUser({ username: "visitor", display_name: "Visitor", role: "guest", pin: "1234", avatar_color: "#6ea53b" });

const sessions = Object.fromEntries(
  [hana, theo, mei, visitor].map((u) => [u.username, createSession(u.id).token]),
);

// ── gardens.json: one engine per member on its own port ──────────────────
const basePort = Number(process.env.E2E_GARDEN_PORT_BASE || 4400);
const manifest: Record<string, unknown> = {};
const ports: Record<string, number> = {};
[hana, theo, mei].forEach((u, i) => {
  ports[u.username] = basePort + i;
  manifest[u.username] = {
    port: basePort + i, base: `/g/${u.username}`,
    title: `${u.display_name}'s garden`, name: u.display_name, avatar: null,
  };
});
mkdirSync(GARDENS, { recursive: true });
writeFileSync(join(GARDENS, "gardens.json"), JSON.stringify(manifest, null, 2) + "\n");
for (const u of [hana, theo, mei]) {
  mkdirSync(join(GARDENS, u.username, "notes", "en"), { recursive: true });
  mkdirSync(join(GARDENS, u.username, "notes", "fr"), { recursive: true });
  mkdirSync(join(GARDENS, u.username, "images"), { recursive: true });
}

// ── Théo's garden ─────────────────────────────────────────────────────────
const G = join(GARDENS, "theo");
function md(rel: string, fm: Record<string, unknown>, body: string) {
  const file = join(G, rel);
  mkdirSync(resolve(file, ".."), { recursive: true });
  const lines = Object.entries(fm).map(([k, v]) =>
    Array.isArray(v) ? `${k}: [${v.join(", ")}]` : `${k}: ${typeof v === "string" && /[:#]/.test(v) ? JSON.stringify(v) : v}`,
  );
  writeFileSync(file, `---\n${lines.join("\n")}\n---\n\n${body.trim()}\n`);
}
const D = "2024-08-22";

md("notes/en/kansai-journal.md", { title: "Kansai journal", date: D, flags: ["public", "moc"], locale: "en", tags: ["japan"] },
  `Two weeks in Kansai. Sub-notes:\n\n- [[nara-deer]]\n- [[kyoto-kids]]\n- [[secret-budget]]`);
md("notes/en/nara-deer.md", { title: "Nara and the deer", date: D, flags: ["public"], locale: "en", tags: ["japan"], order: 1 },
  `Half a day is plenty. The deer bow for crackers. Back to [[kansai-journal]].\n\n![deer](/api/images/nara-deer.png)`);
md("notes/en/kyoto-kids.md", { title: "Kyoto with the kids", date: D, flags: ["public"], locale: "en", tags: ["japan"], order: 2 },
  `One big sight a day. See also [[nara-deer]].`);
md("notes/en/secret-budget.md", { title: "Secret budget", date: D, flags: ["encrypted"], locale: "en", tags: ["money"] },
  `PRIVATE-MARKER-7731: what the trip really cost.`);
md("notes/en/draft-packing.md", { title: "Draft packing list", date: D, flags: [], locale: "en", tags: ["japan"] },
  `DRAFT-MARKER-4410: still being written.`);
md("notes/en/shared-with-mei.md", { title: "Shared with Mei", date: D, flags: [], locale: "en", tags: ["family"] },
  `SHARED-MARKER-9902: Mei can read this one.`);
md("notes/fr/journal-kansai.md", { title: "Journal du Kansai", date: D, flags: ["public"], locale: "fr", tags: ["japon"], translationKey: "kansai-journal" },
  `Deux semaines dans le Kansai. Voir [[nara-deer]].`);
// Note images are what Maurice writes: /api/images/<name>, served by the Bun
// server from the data dir. A 1×1 PNG is enough.
mkdirSync(join(DATA, "images"), { recursive: true });
writeFileSync(join(DATA, "images", "nara-deer.png"), Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));

md("pages/en/about.md", { title: "About Théo", locale: "en", flags: ["public"], translationKey: "about" }, `ABOUT-MARKER: a page, not a note.`);
md("books/fr/les-soeurs-makioka.md", { title: "Les sœurs Makioka", author: "Jun'ichirō Tanizaki", date_read: D, status: "read", flags: ["public"], locale: "fr", translationKey: "the-makioka-sisters" }, `LIVRE-MARKER.`);
md("pages/fr/a-propos.md", { title: "À propos de Théo", locale: "fr", flags: ["public"], translationKey: "about" }, `Une page, pas une note.`);
md("blog/en/first-post.md", { title: "First post", date: D, flags: ["public"], locale: "en", tags: ["meta"] }, `BLOG-MARKER: hello.`);
md("essays/en/on-pacing.md", { title: "On pacing a trip", date: D, section: "travel", flags: ["public"], locale: "en" }, `ESSAY-MARKER: slow down.`);
md("books/en/the-makioka-sisters.md", { title: "The Makioka Sisters", author: "Jun'ichirō Tanizaki", date_read: D, status: "read", rating: 5, flags: ["public"], locale: "en", tags: ["japan"] }, `BOOK-MARKER: a family in Osaka.`);
md("books/en/the-makioka-sisters-fiche.md", { title: "The Makioka Sisters — fiche", resource_collection: "books", resource_id: "the-makioka-sisters", date: D, locale: "en" }, `FICHE-MARKER: notes on the novel.`);
md("articles/en/kansai-with-kids.md", { title: "Kansai with kids", source: "Example Times", url: "https://example.com/kansai", date_read: D, status: "read", flags: ["public"], locale: "en" }, `ARTICLE-MARKER.`);
md("people/en/jun-ichiro-tanizaki.md", { name: "Jun'ichirō Tanizaki", role: "novelist", flags: ["public"], locale: "en" }, `PERSON-MARKER.`);
md("podcasts/en/kansai-radio.md", { title: "Kansai radio", date_listened: D, flags: ["public"], locale: "en" }, `PODCAST-MARKER.`);
md("movies/en/tampopo.md", { title: "Tampopo", director: "Juzo Itami", year: 1985, date_watched: D, rating: 5, flags: ["public"], locale: "en" }, `MOVIE-MARKER.`);
md("series/en/midnight-diner.md", { title: "Midnight Diner", date_watched: D, status: "watched", flags: ["public"], locale: "en" }, `SERIES-MARKER.`);
md("games/en/animal-crossing.md", { title: "Animal Crossing", date_played: D, flags: ["public"], locale: "en" }, `GAME-MARKER.`);
md("series/en/unpublished-series.md", { title: "An unpublished series", date_watched: D, status: "watched", flags: [], locale: "en" }, `DRAFT-SERIES-MARKER.`);
md("books/en/unpublished-book.md", { title: "An unpublished book", author: "Nobody", date_read: D, status: "read", flags: [], locale: "en" }, `DRAFT-BOOK-MARKER.`);

addShare(theo.id, "shared-with-mei", mei.id);

// The look Théo picked in the app (garden_settings.web_theme).
setGardenTheme(theo.id, "botanical");

// A garden is a git repository; the toolbar commits what it changes.
for (const args of [["init", "-q"], ["config", "user.name", "e2e"], ["config", "user.email", "e2e@example.com"], ["add", "-A"], ["commit", "-q", "-m", "seed"]]) {
  spawnSync("git", args, { cwd: G, stdio: "ignore" });
}

// Mei's garden: one note, so /g/mei renders.
writeFileSync(join(GARDENS, "mei", "notes", "en", "hello.md"),
  `---\ntitle: Hello from Mei\ndate: ${D}\nflags: [public]\nlocale: en\n---\n\nMEI-MARKER.\n`);

writeFileSync(OUT, JSON.stringify({
  dataDir: DATA, gardensDir: GARDENS, ports,
  users: { hana: hana.id, theo: theo.id, mei: mei.id, visitor: visitor.id },
  sessions,
}, null, 2));
console.log(`✓ seeded ${DATA}; state in ${OUT}`);
