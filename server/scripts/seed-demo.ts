// ============================================================================
// seed-demo.ts — populate a THROWAWAY Maurice instance with the fictional
// Tanaka-Lefèvre household, for the landing-page screenshots. No personal data.
//
// Run against a scratch data dir only:
//   MAURICE_DATA_DIR=/tmp/maurice-demo bun run scripts/seed-demo.ts
//
// It creates: 4 members (+ manga avatars), 8 personas (the hats grid), Théo's
// garden notes (a "Japan 2023" journal MOC + Mei's allergies), a Kansai guide
// file, a past "budget" chat, and the Trip Planner hero conversation with its
// loaded composer context — so all four screenshot screens render from real data.
// ============================================================================
import { resolve, join } from "path";
import { readFileSync, mkdirSync, writeFileSync } from "fs";

// ── Safety guard: never touch the real ~/.maurice DB ────────────────────────
const DATA = process.env.MAURICE_DATA_DIR;
if (!DATA || /(^|[/\\])\.maurice([/\\]|$)/.test(DATA)) {
  console.error(
    "✗ Refusing to seed: set MAURICE_DATA_DIR to a throwaway dir (e.g. /tmp/maurice-demo), not ~/.maurice.",
  );
  process.exit(1);
}

// Importing db runs the schema migrations against MAURICE_DATA_DIR.
import db from "../src/db";
import { createUser } from "../src/services/users";
import { saveAvatar } from "../src/services/avatars";
import { updateHousehold } from "../src/services/users";
import { createMaurice } from "../src/services/maurices";
import { saveFile } from "../src/services/files";
import { createConversation } from "../src/services/conversations";
import { saveSpec } from "../src/services/composer/specs";

// Refuse to run twice into the same dir (avoid UNIQUE-username crashes mid-way).
const existing = (db.query(`SELECT COUNT(*) c FROM users`).get() as any).c as number;
if (existing > 0) {
  console.error(`✗ ${DATA} already has ${existing} users. Use a fresh dir (rm -rf it first).`);
  process.exit(1);
}

const REPO = resolve(import.meta.dir, "../..");
const AVATARS_SRC = join(REPO, "design/landing/screenshots/avatars");
const GARDENS = join(REPO, "web/gardens");

// ── Members ─────────────────────────────────────────────────────────────────
// icon is rendered as an SF Symbol by the app (Image(systemName:)), so it must
// be a symbol name, not an emoji.
updateHousehold({ name: "Tanaka-Lefèvre", icon: "house.fill" });

function wireAvatar(userId: string, file: string) {
  const buf = readFileSync(join(AVATARS_SRC, file));
  const { url } = saveAvatar(`data:image/png;base64,${buf.toString("base64")}`);
  db.run(`UPDATE users SET avatar_url = ? WHERE id = ?`, [url, userId]);
}

const hana = await createUser({ username: "hana", display_name: "Hana", role: "admin",
  password: "demo-admin", pin: "1234", avatar_color: "#7c2d23",
  profile_text: "Mum. Plans the trips, keeps the calendar." });
const theo = await createUser({ username: "theo", display_name: "Théo", role: "standard",
  pin: "1234", avatar_color: "#2f6f9e", profile_text: "Dad. Cooks, tinkers, drives." });
const mei = await createUser({ username: "mei", display_name: "Mei", role: "standard",
  pin: "1234", avatar_color: "#2f7d54", profile_text: "10. Loves animals and drawing." });
const kenji = await createUser({ username: "kenji", display_name: "Kenji", role: "standard",
  pin: "1234", avatar_color: "#c98a1e", profile_text: "7. Dinosaurs, LEGO, snacks." });

wireAvatar(hana.id, "hana.png");
wireAvatar(theo.id, "theo.png");
wireAvatar(mei.id, "mei.png");
wireAvatar(kenji.id, "kenji.png");
const everyone = [hana.id, theo.id, mei.id, kenji.id];
console.log("✓ 4 members + avatars");

// ── Théo's garden notes (the prior context) ─────────────────────────────────
// Written to web/gardens/<username>/notes/en/<slug>.md — the server resolves
// note context from there (path is hard-coded in composer/notes.ts).
const theoNotes = join(GARDENS, "theo", "notes", "en");
mkdirSync(theoNotes, { recursive: true });

function note(slug: string, title: string, body: string, flags: string[] = []) {
  const fm = [
    "---",
    `title: ${title}`,
    "date: 2024-08-22",
    `flags: [${flags.join(", ")}]`,
    "locale: en",
    "tags: [japan, family, travel]",
    "---",
    "",
  ].join("\n");
  writeFileSync(join(theoNotes, `${slug}.md`), fm + body.trim() + "\n");
}

note("japan-2023-trip-journal", "Japan 2023 — trip journal",
`Our two weeks in Kansai, August 2023 — what worked, what didn't, and everything
to remember before we go back. Index of the sub-notes:

- [[what-the-kids-loved]]
- [[nara-and-the-deer]]
- [[kyoto-with-the-kids]]
- [[getting-around-kansai]]
- [[where-we-stayed]]

Headline lesson: pace it for the children, not the guidebook. Mornings out,
afternoons quiet. We tried to cram and everyone melted by day three.`, ["moc"]);

note("what-the-kids-loved", "What the kids loved (and didn't)",
`The hits: feeding the deer in Nara (Mei talked about it for months), the
conveyor-belt sushi, the river boats, and the little LEGO-ish toy floors of the
department stores for Kenji.

The misses: long temple days, anything that needed queuing in the midday heat,
and big dense crowds — **Kenji got overwhelmed at Fushimi Inari** and we had to
bail early. He's much happier with space around him and an early start.`);

note("nara-and-the-deer", "Nara & the deer",
`Half a day is plenty. The deer in Nara Park are used to people and will bow for
crackers (shika-senbei) — **Mei adored this** and would happily have spent the
whole day there. Go early, before the coaches arrive and the deer get pushy.
Todai-ji is right there if the kids still have energy; we skipped the inside and
just did the grounds.`);

note("kyoto-with-the-kids", "Kyoto with the kids",
`Kyoto is wonderful but temple-dense — ration them. One "big" sight a day, in the
morning, then something low-key. Arashiyama (bamboo + the river + the monkey
park hike) was a better kid day than another shrine. Avoid Fushimi Inari at
midday; if we go back we'll do the very first slot or skip it. Rainy-day backup:
the railway museum, which both kids loved.`);

note("getting-around-kansai",  "Getting around Kansai",
`ICOCA cards for everyone (even the kids) — tap on, tap off, no thinking. Trains
are stroller-tolerant but rush hour is brutal with two children; travel off-peak.
Most days were one or two short hops, never a marathon. Taxis are easy and not
crazy for short family hops when someone's had enough.`);

note("where-we-stayed", "Where we stayed",
`The ryokan night was magical but the kids found the futons-on-tatami novelty
wore off fast; one night was right. The rest of the time a plain hotel with two
beds and a konbini downstairs was worth more than any view. Near a station,
always — saved us every single day.`);

note("mei-food-allergies", "Mei's food allergies",
`**Mei is allergic to egg** (tamago). Watch for: tamagoyaki, anything with mayo
(Japanese mayo is egg-heavy — okonomiyaki, takoyaki sauces), custards, and some
ramen toppings. "Tamago nuki de" = "without egg." She's fine with soy, fish,
wheat. Carry her antihistamine and a translation card. Conveyor sushi is easy —
plenty of egg-free plates and she can see what she's taking.`);
console.log("✓ 7 garden notes for Théo");

// ── A document in Théo's files: the Kansai family guide ──────────────────────
const guideSections: string[] = [
  "# Kansai with kids — our family guide\n\nA living doc we keep between trips: a relaxed, child-paced way through Kyoto, Nara and Osaka. Bias toward space, early starts, and short days.",
];
const days = [
  ["Day 1 — Land soft", "Arrive, get ICOCA cards, dinner at the conveyor sushi near the hotel (easy for Mei — egg-free plates are clearly visible). Early night; jetlag with kids is a marathon, not a sprint."],
  ["Day 2 — Nara & the deer", "First train out to Nara before the coaches. Deer crackers, a slow wander of the park, Todai-ji grounds. Back by early afternoon for pool / downtime. This is Mei's day — build the trip around it."],
  ["Day 3 — Arashiyama", "Bamboo grove early, then the riverside and the monkey-park hike (Kenji loves the climb and the view). Picnic lunch. Keep it to one big thing; the afternoon is free."],
  ["Day 4 — Osaka, gently", "Aquarium (Kaiyukan) in the morning — huge hit at this age. Dotonbori for the lights at dusk, but eat early before the crush. Avoid the midday crowds; Kenji wilts in dense crowds."],
  ["Day 5 — Slack day", "Deliberately empty. Railway museum if it rains, a park if it shines, department-store toy floor as a reliable backstop. Pack slowly. Last konbini run for the flight."],
];
for (const [h, b] of days) {
  guideSections.push(`## ${h}\n\n${b}\n\n**Food notes:** keep "tamago nuki de" (no egg) handy for Mei. Konbini onigiri are a safe, cheap lunch. Hydrate the kids constantly in August — the heat is the real itinerary-killer. Plan a sit-down, air-conditioned break each afternoon; it resets everyone. A small treat (matcha soft-serve, a toy-floor visit) bought in advance as the "if you're patient" carrot works wonders on a long morning.\n\n**Logistics:** off-peak trains only, one or two hops max, taxi without guilt when someone's done. Mornings out, afternoons quiet. Repeat. Keep a 90-minute buffer in every plan; with kids the day always slips, and a rushed parent is the fastest way to a meltdown.`);
}
// Neighbourhood notes — detail that bulks the guide into a real reference doc.
const hoods: [string, string][] = [
  ["Arashiyama", "Bamboo grove at opening time or skip it — by 9:30 it's a river of selfie sticks. The Iwatayama monkey park is the real kid win: a 20-minute uphill walk (bribe with the summit vending machine) to monkeys roaming free and a view over the city. Add the little train (Sagano Romantic) if energy holds. Riverside bento lunch beats any restaurant queue."],
  ["Nara", "Half a day, early. Deer crackers from the first stall, then let Mei set the pace — this is her highlight, don't rush it. Todai-ji's Great Buddha is genuinely awe-inducing for kids; the rest of the grounds you can wander or skip. Heat is brutal by 11; be heading back by then."],
  ["Gion & Higashiyama", "Pretty but crowded and stroller-hostile (steep lanes, steps). One slow late-afternoon stroll when it cools, ice cream in hand, is plenty. Don't make it a 'sights' day — it's a 'wander and people-watch' day. Kiyomizu-dera at opening or not at all."],
  ["Osaka — Namba & Dōtonbori", "Loud, neon, fun — but a crush after dark. Go for an early dinner (street food: egg-free options exist but ask, the sauces are mayo-heavy), see the lights at dusk, then leave before the peak. The Kaiyukan aquarium is a top-three activity for this age — whale sharks, a touch pool, half a sheltered indoor day."],
  ["Kyoto Station & rainy-day backups", "The station itself is an attraction — the rooftop, the ramen floor, the sheer scale. Reliable bad-weather plan: the Kyoto Railway Museum (a full hour of joy for both kids) and the aquarium next door. Department-store toy floors are the universal reset button."],
];
for (const [h, b] of hoods) guideSections.push(`## Neighbourhood — ${h}\n\n${b}`);
guideSections.push("## Food, the kid-and-allergy edit\n\nSafe anchors: conveyor-belt sushi (Mei can see every plate; plenty egg-free), konbini onigiri and fruit, plain udon/soba (ask for no egg), gyoza, yakitori (skip the tare if unsure), fruit-stand everything. Watch for egg: tamagoyaki, okonomiyaki and takoyaki (sauce + sometimes batter), Japanese mayo on anything, custards and many pastries, some ramen toppings. Phrase card: 『卵アレルギーです。卵抜きでお願いします』(egg allergy, no egg please). Kenji will eat any noodle, any rice, and an alarming volume of konbini chicken. Keep snacks on you at all times; a hungry 7-year-old in a queue is the whole-day risk.");
guideSections.push("## Practicalities\n\nTransport: ICOCA for all four, off-peak only, one or two hops a day. Money: cash still matters at small places; konbini ATMs work. Weather: August is hot and humid — cooling towels, hats, water, and an afternoon indoors are not optional. Health: pack Mei's antihistamine and a written allergy card; note the nearest clinic to the hotel. Connectivity: an eSIM per adult phone. The golden rule, earned in 2023: do less. One headline sight a day, in the morning, then let the day breathe. A happy child is worth more than a third temple.");
guideSections.push("## Saved links & to-check\n\n- Iwatayama monkey park — opening hours in August, last entry\n- Kaiyukan — timed tickets, are they needed in summer?\n- Railway museum — closed days\n- Ryokan with a family room near Arashiyama — one night only\n- Reconfirm egg-free options at the conveyor-sushi chain near the hotel\n- JR vs ICOCA maths for the airport legs\n- Where to rent a stroller vs bring ours");
const guideText = guideSections.join("\n\n");
const guideFile = saveFile(theo.id, null, "Kansai with kids — family guide.md", Buffer.from(guideText, "utf8"));
console.log(`✓ guide file (${guideFile.token_estimate} tok)`);

// A second saved document — a clipped-articles compilation (more chips + weight).
const tips = [
  "# Japan with young kids — saved tips\n\nClippings and notes we've collected from other families. Raw, unsorted, but gold.",
  "## Heat & pacing\n\nAugust in Kansai is 33–36°C and humid. Every experienced family says the same thing: one outing per day, finished by noon; pool or air-con in the afternoon; out again only after 5pm. Frozen water bottles from konbini double as ice packs and drinking water. Cooling towels and battery fans are worth the suitcase space.",
  "## Transport with a stroller\n\nMost stations have lifts but they're sometimes a long way round — allow extra time. Avoid 8–9am and 5–7pm trains entirely with kids. Taxis are metered, honest, and a sanity-saver for the last leg of a long day. Reserved Shinkansen seats: book the seats by the rear wall (extra luggage space, and you can stash a sleeping kid).",
  "## Food strategy\n\nKonbini are a parent's best friend: onigiri, fruit, yoghurt, plain bread, clearly-labelled everything. Conveyor sushi removes the ordering-anxiety for allergies — you see the plate. Department-store 'depachika' food halls have endless safe options. Carry snacks always. Learn the allergy phrases and keep a printed card; staff are careful and kind when they understand.",
  "## Activities that land at 7–10\n\nAquariums (Osaka Kaiyukan), the Nara deer, the Arashiyama monkeys, railway museums, hands-on science museums, river boats, and — never underestimate — the toy floors and arcades of big department stores on a rained-out afternoon. Temples and shrines: ration hard. One, in the morning, with a snack reward.",
  "## Health & admin\n\nTravel insurance that covers the kids. A written list of allergies and medications in Japanese. Photo of passports on each phone. Nearest pediatric clinic to each hotel noted in advance. An eSIM so maps and translation always work. A small first-aid kit: plasters, antihistamine, rehydration sachets, thermometer.",
];
const tipsFile = saveFile(theo.id, null, "Japan with young kids — saved tips.md", Buffer.from(tips.join("\n\n"), "utf8"));
console.log(`✓ tips file (${tipsFile.token_estimate} tok)`);

// ── Personas (the hats grid) ────────────────────────────────────────────────
function persona(name: string, hat: string, palette: string, tagline: string, prompt: string, context: any[] = []) {
  const r = createMaurice(theo.id, { name, hat, palette, tagline, prompt, context, users: everyone });
  if ("errors" in r) { console.error(`✗ persona ${name}:`, r.errors); process.exit(1); }
  return r;
}

// The hero persona — bakes in the Japan journal (recurses the MOC's children)
// plus Mei's allergies. This is the "baked-in, locked" context on the card.
const tripPlanner = persona(
  "Trip Planner", "explorer", "cobalt",
  "Relaxed family trips, paced for the kids",
  "You plan calm, child-paced family travel. Favour space, early starts and short days over cramming sights. Always account for the children's stamina and any dietary needs in the loaded notes.",
  [
    { type: "note", id: "japan-2023-trip-journal", recurse: true },
    { type: "note", id: "mei-food-allergies" },
  ],
);
persona("Homework Tutor", "grad", "terracotta", "Patient help, never the answer", "You are a patient tutor for a 10-year-old. Explain, ask guiding questions, never just give the answer.");
persona("The Storyteller", "wizard", "plum", "Bedtime stories on demand", "You tell gentle, original bedtime stories for young children. Warm, a little magical, never scary.");
persona("Sous-Chef", "chef", "sage", "What's for dinner tonight", "You suggest simple family dinners from what's on hand. Mind allergies in the loaded notes.");
persona("Coach", "captain", "marigold", "Little nudges, big habits", "You are an encouraging family coach for small healthy habits and weekend activities.");
persona("Gardener", "flatCap", "clay", "The balcony, kept alive", "You give practical, seasonal advice for a small family balcony garden.");
persona("Movie Night", "party", "blush", "Something everyone can watch", "You pick family films everyone can agree on, by age and mood.");
persona("Detective", "detective", "ink", "Mysteries for game night", "You run light, kid-friendly mystery games for family game night.");
console.log("✓ 8 personas");

// ── A past "budget" conversation (a context source for the hero chat) ────────
function addMessage(convId: string, role: string, content: string, opts: { mauriceId?: string; model?: string; minsAgo?: number } = {}) {
  db.run(
    `INSERT INTO messages (id, conversation_id, role, content, model, maurice_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now', ?))`,
    [crypto.randomUUID(), convId, role, content, opts.model ?? null, opts.mauriceId ?? null, `-${opts.minsAgo ?? 0} minutes`],
  );
}

const budget = createConversation(theo.id, null);
db.run(`UPDATE conversations SET title = ? WHERE id = ?`, ["Summer trip — rough budget", budget.id]);
addMessage(budget.id, "user", "Rough budget for 5 days in Kansai — 2 adults, 2 kids (10 and 7)? Flights from Brussels already booked.", { minsAgo: 4320 });
addMessage(budget.id, "assistant",
`A relaxed 5-day Kansai trip for your family, on top of the flights, lands roughly:

- Lodging (4 nights, family room + 1 ryokan night): €700–950
- ICOCA travel for four, off-peak, short hops: €70–110
- Food (konbini lunches, casual dinners, one treat meal): €350–500
- Activities (Nara, aquarium, monkey park, railway museum): €120–180
- Buffer (taxis, souvenirs, the inevitable): €200

**Ballpark: €1,450–1,950** for the five days. The ryokan night and the treat dinner are the two easy dials if you want to trim.`,
  { minsAgo: 4319, model: "claude-sonnet-4-20250514" });
console.log("✓ budget chat");

// ── The hero conversation — Trip Planner, with loaded context ────────────────
const hero = createConversation(theo.id, tripPlanner.id);
db.run(`UPDATE conversations SET title = ? WHERE id = ?`, ["Five days in Kyoto with the kids", hero.id]);
addMessage(hero.id, "user",
  "We've got 5 days around Kyoto with the kids in August — plan something relaxed, not all temples 🙏",
  { minsAgo: 12 });
addMessage(hero.id, "assistant",
`Here's a gentle 5-day loop — mornings out, afternoons quiet, the way that worked last time.

**Day 1** — Land soft: ICOCA cards, conveyor sushi for dinner (easy egg-free plates for Mei).
**Day 2** — **Nara, first train out.** The deer before the coaches arrive — Mei's been asking about them since last time. Back by lunch for downtime.
**Day 3** — Arashiyama: bamboo, the river, and the monkey-park hike Kenji will love. One big thing, then free.
**Day 4** — Osaka aquarium in the morning; Dōtonbori for the lights at *dusk*, eating early — I kept you out of the midday crush because **Kenji gets overwhelmed in big crowds**.
**Day 5** — Deliberately empty: park, railway museum if it rains, slow packing.

I skipped Fushimi Inari at peak (that's where it went sideways in 2023) and flagged egg-free lunches each day for Mei. Want me to drop this onto dates and add train times?`,
  { mauriceId: tripPlanner.id, model: "claude-sonnet-4-20250514", minsAgo: 11 });

// Loaded composer context for the hero chat: the guide file + the budget chat.
// (The persona already bakes in the journal + allergies — those show as locked.)
const spec = saveSpec(theo.id, hero.id, [
  { type: "file", id: guideFile.id },
  { type: "file", id: tipsFile.id },
  { type: "conversation", id: budget.id },
]);
if ("errors" in spec) { console.error("✗ spec:", spec.errors); process.exit(1); }
console.log(`✓ hero conversation + loaded context (${(spec as any).total} tok loaded)`);

// ── Summary ─────────────────────────────────────────────────────────────────
console.log("\n────────────────────────────────────────────");
console.log("Demo household seeded:", DATA);
console.log("Members (PIN 1234):", everyone.length, "· admin pw: demo-admin");
console.log("Hero chat:", hero.id, "(log in as Théo)");
console.log("Personas:", db.query(`SELECT COUNT(*) c FROM maurices`).get());
console.log("────────────────────────────────────────────");
