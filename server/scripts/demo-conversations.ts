// ============================================================================
// demo-conversations.ts — the conversation history of the demo household's
// Théo, for the "morning of the proposal" (P4 of the domains' roadmap,
// 19 September 2026).
//
// PROVENANCE AND LICENCE. Every conversation below was written for this
// repository, on 19 September 2026, by Claude (Anthropic) at the request of
// the project's owner, as fiction: Théo Tanaka-Lefèvre does not exist, and
// nothing here is a real person's words, a real export, or text taken from
// any other work. The text of this file is released under CC0 1.0 Universal
// (public domain dedication, https://creativecommons.org/publicdomain/zero/1.0/):
// use it, change it, ship it, no attribution required.
//
// WHAT IT IS FOR. The domains' night (services/domainMapping.ts) proposes
// domains to a member once at least two groups of conversations recur over
// months and still live — on a small corpus, three conversations over two
// distinct months, the last within a year. This set gives Théo three such
// groups (bread, the balcony garden, learning Japanese), one that lived and
// stopped (the bike, over a year ago) so the opener has something to name as
// past, and two one-offs the mapping must leave as noise. Most of it is marked
// as imported from ChatGPT (`origin`, `imported_at`), which is the story the
// demo tells: a member brought their history in and, the next morning, Maurice
// had something to propose. The dates are relative to the day of the seed,
// so a demo seeded in any month has a living history.
//
// Seeded by scripts/seed-demo.ts; a test (test/demo-seed.test.ts) checks that
// the mapping's arithmetic finds the groups ripe.
// ============================================================================
import db from "../src/db";

export type DemoTopic = "bread" | "garden" | "japanese" | "bike" | "noise";

export interface DemoConversation {
  /** Stable id, so a re-seed of the same member is idempotent. */
  id: string;
  topic: DemoTopic;
  title: string;
  /** Whole months before the seed day (the day itself is `day`). */
  monthsAgo: number;
  day: number;
  /** `chatgpt` = imported (badged, `imported_at` set); null = lived with Maurice. */
  origin: "chatgpt" | null;
  turns: Array<["user" | "assistant", string]>;
}

export const DEMO_CONVERSATIONS: DemoConversation[] = [
  // ── Bread ──────────────────────────────────────────────────────────────────
  {
    id: "demo-theo-bread-1", topic: "bread", title: "Sourdough starter won't rise", monthsAgo: 5, day: 6, origin: "chatgpt",
    turns: [
      ["user", "I started a sourdough starter a week ago with rye flour and water, feeding it every morning. It bubbled a lot on day two and three, then went completely flat and smells like nail polish remover. Did I kill it?"],
      ["assistant", "You almost certainly didn't kill it — what you're describing is the normal week-one slump. The early bubbling comes from bacteria that show up first and die off; the yeast that actually raises bread takes longer to establish, and the acetone smell means the starter is hungry and acidic while that changeover happens.\n\nThree things to do: keep feeding it once a day at room temperature, but discard more before each feed — keep about a tablespoon and add 50 g flour and 50 g water, so the acidity resets; keep it somewhere around 24–26 °C, a switched-off oven with the light on works; and give it another five to seven days before judging. When it reliably doubles within six to eight hours of a feed and smells yeasty and a bit fruity rather than sharp, it's ready.\n\nIf it grows a pink or orange streak or fuzzy mould, that's the one case to throw it out and start again."],
      ["user", "Okay. Should I keep using rye or switch to plain white flour? I only have a small bag of rye left."],
      ["assistant", "Rye is the easiest flour to get a starter going because it carries more wild yeast and minerals, so it was a good choice to begin. Once it's active you can switch to white bread flour without any drama: do it gradually, half rye and half white for two feeds, then all white. A white-flour starter is a little slower and milder, which most people prefer for everyday loaves. Keep the last of the rye for the transition rather than using it up now."],
    ],
  },
  {
    id: "demo-theo-bread-2", topic: "bread", title: "Hydration and shaping a wet dough", monthsAgo: 4, day: 12, origin: "chatgpt",
    turns: [
      ["user", "My starter works now and I baked two loaves. They taste good but they spread out flat in the oven instead of rising up. I'm using 500 g flour, 400 g water, 100 g starter, 10 g salt. Is that too much water?"],
      ["assistant", "That's about 80 % hydration, which is a lot for a beginner and for most supermarket bread flour. Flat loaves at that hydration usually mean the dough couldn't hold its shape rather than that the yeast failed — a good sign, since the crumb tastes right.\n\nDrop to 350 g water (70 %) for the next few bakes. At that level the dough is still soft but you can actually build tension when shaping. Two other things help more than people expect: a proper shaping step, pulling the dough toward you on the counter to tighten the surface, and a cold proof — shape, put it seam-side up in a floured bowl or banneton, and leave it in the fridge overnight. Cold dough holds its shape when it hits the oven and scores much more cleanly.\n\nOnce loaves stand tall at 70 %, creep the water back up 10 g at a time if you like an open crumb."],
      ["user", "How do I know when the bulk rise is done? I've read 'until doubled' but mine never looks doubled."],
      ["assistant", "'Doubled' is a poor guide for sourdough; 50–75 % growth is usually right. Look at the dough instead of the clock: the surface goes domed and slightly glossy, you see a few bubbles on top and along the sides of the container, and if you tilt the bowl the dough jiggles as one piece rather than sagging. A straight-sided container with a rubber band at the starting level makes the growth easy to read. In a kitchen at 22 °C with an active starter, expect four to six hours."],
    ],
  },
  {
    id: "demo-theo-bread-3", topic: "bread", title: "Baking in a Dutch oven: crust too thick", monthsAgo: 2, day: 3, origin: "chatgpt",
    turns: [
      ["user", "I bought a cast-iron pot and my loaves now rise well, but the crust comes out very thick and hard, almost too hard for the kids. I bake at 250 °C, lid on for 30 minutes, lid off for 25."],
      ["assistant", "The lid-on phase is what you want — steam keeps the crust soft while the loaf expands. The thick crust comes from the second phase being long and hot. Try 250 °C lid on for 20 minutes, then drop to 220 °C and bake lid off for 15–20 minutes, pulling the loaf when it's deep golden rather than dark brown. The internal temperature should read about 96–98 °C.\n\nIf you want the crust softer still for the children: brush the loaf with a little melted butter as it comes out, or wrap it in a clean tea towel while it cools, which traps moisture and softens the crust as it rests. Slicing only once it's fully cool also helps — a warm loaf loses steam through the cut and its crust hardens."],
      ["user", "And if I want a softer loaf overall, like a sandwich bread, is sourdough the wrong tool?"],
      ["assistant", "Not at all — enrich it. A sourdough sandwich loaf with 30 g butter, 20 g honey and a splash of milk in the dough, baked in a tin at 200 °C without a lid, gives you a tender crumb and a thin crust that stays soft for days. The starter still does the leavening; the fat and sugar soften everything. It's a good weeknight loaf once the timing is familiar."],
    ],
  },
  {
    id: "demo-theo-bread-4", topic: "bread", title: "First rye loaf came out gummy", monthsAgo: 1, day: 9, origin: "chatgpt",
    turns: [
      ["user", "I tried a 50 % rye sourdough this weekend. It looked great but the inside is dense and gummy, almost wet, even though I baked it for 50 minutes. What went wrong?"],
      ["assistant", "Rye behaves nothing like wheat: it has almost no gluten and a lot of enzymes and pentosans that hold water, so a rye loaf stays gummy if it's cut too soon or baked like a wheat loaf. The usual causes, in order of likelihood: slicing it the same day (rye needs 24 hours, ideally 48, wrapped in a towel, for the crumb to set); underbaking, since rye needs a lower temperature for longer — try 230 °C for 15 minutes then 200 °C for 45 more; and an under-ripe starter, because rye needs plenty of acidity to keep those enzymes in check.\n\nFor next time: bake it in a tin, since a 50 % rye dough won't hold a free-form shape; use a well-ripened starter; and leave it alone for a full day before cutting. It's a different bread, and it rewards patience more than technique."],
    ],
  },

  // ── The balcony garden ─────────────────────────────────────────────────────
  {
    id: "demo-theo-garden-1", topic: "garden", title: "What can grow on a north-facing balcony?", monthsAgo: 6, day: 14, origin: "chatgpt",
    turns: [
      ["user", "We have a small balcony, about 2 m by 1.2 m, facing north, with direct sun only for an hour or two in the late afternoon in summer. The kids want to grow vegetables. Is anything realistic, or should I just do herbs?"],
      ["assistant", "Two hours of sun rules out tomatoes and peppers, which need six or more, but there's a good list of things that are happy in bright shade.\n\nLeafy greens do best: lettuce, rocket, lamb's lettuce, spinach and chard actually prefer less sun and bolt less. Radishes are the quickest win for children — three to four weeks from seed to something to pull up. Peas in a deep pot with a string trellis do fine and the kids can eat them off the plant. For herbs, mint, parsley, chives and coriander all take shade; basil and rosemary won't be happy.\n\nUse the largest containers you can carry up — a 30 cm depth is the useful minimum — with peat-free multipurpose compost, and put the pots against the outer railing where the light is best. Start with radishes and lettuce in April; they'll be eating something by May."],
      ["user", "Good. Are there any flowers that would work alongside, so it looks less like a vegetable patch?"],
      ["assistant", "Nasturtiums are the obvious companion: they tolerate shade, trail nicely over a railing, the flowers and leaves are edible, and they lure aphids away from the greens. Violas and pansies go in early and flower for months. Fuchsias in a hanging basket are made for a north wall. All of them are cheap as seed or plugs, so nothing is lost if the children lose interest."],
    ],
  },
  {
    id: "demo-theo-garden-2", topic: "garden", title: "Yellow leaves on the lettuce and peas", monthsAgo: 4, day: 21, origin: "chatgpt",
    turns: [
      ["user", "The balcony is going: radishes eaten, lettuce coming. But the lower leaves on the lettuce are going yellow and the pea plants look pale and thin. They're in 30 cm pots with multipurpose compost. Am I overwatering?"],
      ["assistant", "Pale, thin growth with yellowing lower leaves in pots after two months is usually hunger rather than water — multipurpose compost carries about six weeks of feed and the rain and watering wash the rest out. Peas fix some nitrogen but not enough in a pot; lettuce is a heavy feeder.\n\nStart a liquid feed once a week, a general-purpose one at half strength or a seaweed feed, and pinch off the yellow leaves. For water, the test is the finger: dry two knuckles down, water until it runs from the bottom, then leave it. Pots on a north balcony dry more slowly than you'd think, so once every two or three days is often plenty in spring.\n\nIf the pea stems are also thin and stretched toward the light, that's the shade telling you — they'll still crop, just less. Tie them up so they don't flop."],
      ["user", "Should I be worried about the little green insects on the pea tips?"],
      ["assistant", "Aphids. Harmless in small numbers: rub them off with your fingers or blast them with water from a spray bottle every couple of days. The nasturtiums will draw some off, and if you leave a few, ladybirds and hoverflies find them even six floors up. Avoid sprays on anything the children will eat straight off the plant."],
    ],
  },
  {
    id: "demo-theo-garden-3", topic: "garden", title: "Keeping the pots alive during two weeks away", monthsAgo: 3, day: 2, origin: "chatgpt",
    turns: [
      ["user", "We're away for two weeks in August and there's nobody to water the balcony. What's the cheapest way to keep six pots alive? I'd rather not buy an irrigation kit for a few plants."],
      ["assistant", "For two weeks with no visitor you have three cheap options, and they combine well.\n\nMove every pot into the shadiest corner and group them tightly together, which cuts evaporation a lot. Soak them thoroughly the morning you leave, then mulch the surface with a couple of centimetres of compost, bark or even shredded newspaper. Then give each pot a slow reservoir: an upturned wine bottle filled with water pushed into the compost drains over four to seven days, and a wick — a strip of cotton from a bucket of water to the pot — keeps going as long as the bucket lasts. Two-litre bottles with a pinhole in the cap do the same thing.\n\nRealistically, lettuce may bolt and peas will be over by then anyway; the herbs and nasturtiums will survive. Harvest what you can before you go."],
    ],
  },
  {
    id: "demo-theo-garden-4", topic: "garden", title: "What to sow on the balcony for autumn", monthsAgo: 1, day: 17, origin: null,
    turns: [
      ["user", "The balcony survived the holiday better than expected. Summer's ending — is there anything worth sowing now, or do I clear the pots until spring?"],
      ["assistant", "Don't clear them yet; late summer is the second sowing window for a shady balcony. Lamb's lettuce, winter spinach, rocket and mizuna all go in now and crop through autumn; in a mild city winter they'll keep going under a bit of fleece. Chives and parsley from spring will carry on. Garlic cloves pushed into a deep pot in October give you green garlic in spring.\n\nWhen the summer crops finish, empty those pots, keep half the old compost mixed with fresh for next year, and let the children plant spring bulbs — crocus and dwarf narcissus — in the freed pots. It gives the balcony something to do in March and gives them a reason to look."],
      ["user", "We still have nasturtium seeds from this year. Keep them?"],
      ["assistant", "Yes — collect the dried, wrinkled seeds now, keep them in a paper envelope somewhere cool, and sow them next April. They store well for two or three years, and the children will recognise the plant they grew."],
    ],
  },

  // ── Learning Japanese ──────────────────────────────────────────────────────
  {
    id: "demo-theo-japanese-1", topic: "japanese", title: "Starting Japanese: hiragana first?", monthsAgo: 7, day: 8, origin: "chatgpt",
    turns: [
      ["user", "I want to learn some Japanese before our next trip, about 20 minutes a day. Should I start with the writing systems or just learn phrases in romaji? I know zero."],
      ["assistant", "Learn hiragana first, and do it fast — it's 46 characters and most people have them in a week at 20 minutes a day. Everything after that gets easier: textbooks, menus and signs use it, and romaji quietly teaches you wrong pronunciation habits that are hard to undo.\n\nA plan for the first month: week one, hiragana with a flashcard app and writing each character by hand a few times; week two, katakana, which covers the foreign words you'll see everywhere on menus; weeks three and four, a beginner textbook's first chapters — greetings, introducing yourself, numbers, 'where is…'. Say everything out loud.\n\nFor a trip, the payoff is disproportionate: reading a station name or a price is a real change in how the day feels, and a few polite phrases in the right register open a lot of doors."],
      ["user", "Any tips for the characters that look alike? I keep confusing さ and ち, and ぬ and め."],
      ["assistant", "Group the look-alikes deliberately and learn them as pairs rather than avoiding them. さ (sa) and ち (chi) are mirror images: the sa's hook goes left, chi's goes right — think of 'chi' curling to the right like a 'c'. ぬ (nu) and め (me): nu has the little loop at the end, like a noodle (nu-dle); me doesn't. Silly hooks like that stick. Write each pair side by side five times, then test yourself only on the pairs for a couple of days."],
    ],
  },
  {
    id: "demo-theo-japanese-2", topic: "japanese", title: "Particles は and が", monthsAgo: 5, day: 19, origin: "chatgpt",
    turns: [
      ["user", "I'm a few chapters into the textbook and I still don't understand when to use は and when to use が. The explanations say 'topic' vs 'subject' and that means nothing to me. Can you explain it with examples?"],
      ["assistant", "Try this instead of topic/subject: は points at what you're talking *about*, and が points at what the *answer* is.\n\n'わたしは がくせいです' — as for me, I'm a student. The は sets the frame: we're talking about me. 'だれが がくせいですか' — *who* is the student? The question word takes が because the unknown is the point. And the answer, 'たろうが がくせいです', keeps が: Taro is the one.\n\nA useful rule of thumb for a beginner: new or emphasised information takes が; something already known or being contrasted takes は. 'ねこは すきです。いぬは すきじゃないです' — cats I like, dogs I don't: the は marks the contrast. When in doubt in conversation, は is the safer default for the thing you're talking about, and が after question words and for 'there is/are' (あります/います)."],
      ["user", "So in 'あそこに ねこが います', it's が because I'm pointing out that a cat exists?"],
      ["assistant", "Exactly. You're presenting the cat as new information — 'look, there's a cat over there' — so が. If the cat were already the topic, say the neighbour's cat you've been discussing, you'd say 'ねこは あそこに います': the cat, it's over there. Same words, different weight."],
    ],
  },
  {
    id: "demo-theo-japanese-3", topic: "japanese", title: "Counters: why so many ways to count", monthsAgo: 3, day: 11, origin: "chatgpt",
    turns: [
      ["user", "Counting in Japanese is driving me mad. There's one set of numbers, then a completely different set for counting objects, then special words for flat things, long things, people, animals… Which ones do I actually need for a two-week trip with kids?"],
      ["assistant", "You need far fewer than the textbook implies. For a trip, learn exactly three.\n\nThe general counter ひとつ, ふたつ, みっつ… up to とお (ten) counts anything you can't name a counter for — ordering food, buying things: 'これを ふたつ ください' gets you two of whatever you're pointing at. People: ひとり, ふたり, then さんにん, よにん — you'll say 'よにんです' (four of us) at every restaurant. And the plain numbers いち, に, さん… for prices, times and platform numbers.\n\nEverything else — まい for flat things, ほん for long things, ひき for small animals — is real but you can get through two weeks without any of it, and shopkeepers will understand ひとつ/ふたつ with a gesture every time. Add them later if you keep going."],
      ["user", "How do I say the children's ages? They'll get asked."],
      ["assistant", "Ages use さい: 'じゅっさい' for ten and 'ななさい' for seven. 'むすめは じゅっさいで、むすこは ななさいです' — my daughter is ten and my son is seven. Note the irregular ones: 1 is いっさい, 8 is はっさい, 10 is じゅっさい (or じっさい), 20 is はたち."],
    ],
  },
  {
    id: "demo-theo-japanese-4", topic: "japanese", title: "Reading a menu: the katakana are the easy part", monthsAgo: 2, day: 27, origin: "chatgpt",
    turns: [
      ["user", "I can read hiragana and katakana now but menus are mostly kanji and I'm lost. Which kanji are worth learning just for eating out? Also I need to spot egg because of an allergy in the family."],
      ["assistant", "A short menu vocabulary of about twenty kanji goes a long way. The essentials: 卵 / 玉子 (egg — both forms appear, and 玉子 is common on menus), 肉 (meat), 牛 (beef), 豚 (pork), 鶏 (chicken), 魚 (fish), 野菜 (vegetables), 米 / ご飯 (rice), 麺 (noodles), 塩 (salt), 味噌 (miso), 醤油 (soy sauce), 辛 (spicy), 甘 (sweet), 定食 (set meal), 大 / 小 (large / small), 円 (yen).\n\nFor the allergy, learn the two egg forms cold, plus マヨネーズ (mayonnaise, in katakana) since Japanese mayo is egg-based and turns up on okonomiyaki, takoyaki and many salads. Say '卵アレルギーです' (tamago arerugii desu — egg allergy) and '卵抜きで お願いします' (tamago nuki de onegaishimasu — without egg, please). Write both on a card; staff are used to it and take it seriously.\n\nKatakana menus — pizza, curry, coffee — you can already read, which is why cafés and family restaurants feel easy while the izakaya doesn't."],
    ],
  },
  {
    id: "demo-theo-japanese-5", topic: "japanese", title: "Polite forms before we fly", monthsAgo: 0, day: 6, origin: null,
    turns: [
      ["user", "Two weeks to go. I can hold a very basic conversation now but I'm worried about being rude. What level of politeness should I be aiming for as a tourist, and what are the phrases I'll use every day?"],
      ["assistant", "Aim for plain polite — the ます / です forms your textbook uses — everywhere. It is never wrong for a visitor; keigo (honorific speech) is expected of staff toward you, not of you toward them, and trying it half-learned sounds odder than not trying.\n\nThe daily set: すみません (excuse me / sorry / to call a waiter — the single most useful word), お願いします (please, when asking for something), ありがとうございます (thank you), これを ください (this one, please), いくらですか (how much), トイレは どこですか (where is the toilet), 英語の メニューは ありますか (is there an English menu), だいじょうぶです (it's fine / no thanks, when a shop offers a bag), and ごちそうさまでした on leaving a restaurant, which staff notice and appreciate.\n\nTwo habits that matter more than grammar: a small bow with thank-yous, and handing money or cards with both hands or on the tray provided. With those, your basic Japanese will land as polite everywhere you go."],
      ["user", "What about the kids — should they say anything?"],
      ["assistant", "Teach them こんにちは (hello), ありがとう (thanks, plain form is fine from a child) and いただきます before eating. Children saying these get an enormously warm reaction, and it gives them something to do with the shyness."],
    ],
  },

  // ── The bike (lived, over a year ago) ─────────────────────────────────────
  {
    id: "demo-theo-bike-1", topic: "bike", title: "Disc brakes squeal every time I stop", monthsAgo: 15, day: 4, origin: "chatgpt",
    turns: [
      ["user", "My commuter bike has hydraulic disc brakes and they squeal loudly every time I brake, especially in the wet. They still stop fine. Is that something I can fix myself?"],
      ["assistant", "Usually yes. Squeal on discs is almost always contamination or misalignment, in that order.\n\nFirst clean: spray the rotors with isopropyl alcohol and wipe with a clean rag, and check the pads — if they're glazed and shiny, roughen them lightly with sandpaper on a flat surface. If there's oil on them from chain lube or a leaking caliper, they're finished; pads are cheap. Second, alignment: loosen the two caliper bolts, squeeze the brake lever hard and hold it, then retighten the bolts while holding — this centres the caliper on the rotor. Third, bed the pads in: ten or fifteen firm stops from a moderate speed, without locking up, so the pad transfers an even layer onto the rotor.\n\nSome noise in heavy rain is normal for discs; constant squeal in the dry is what the above fixes."],
    ],
  },
  {
    id: "demo-theo-bike-2", topic: "bike", title: "Fixing a puncture without a stand", monthsAgo: 14, day: 22, origin: "chatgpt",
    turns: [
      ["user", "Got a flat on the rear wheel this morning. I have a spare tube and levers but I've never done it and the rear wheel with the gears looks intimidating. Walk me through it?"],
      ["assistant", "It's easier than it looks. Shift to the smallest rear cog first — it gives the chain the most slack and makes the wheel drop out cleanly. Turn the bike upside down on its saddle and bars, open the quick release or undo the thru-axle, pull the derailleur back with one hand and lift the wheel out with the other.\n\nDeflate fully, push one bead of the tyre toward the centre all the way round, then hook two levers under the bead about a hand apart and pull one side of the tyre off the rim. Pull the tube out, and run your fingers carefully around the inside of the tyre to find the thorn or glass that caused it — skipping this is how you get a second flat ten minutes later. Put a little air in the new tube so it holds its shape, tuck the valve in, work the tube into the tyre, then push the bead back over the rim with your thumbs, finishing opposite the valve. Inflate to the pressure on the tyre sidewall.\n\nBack in: hold the derailleur back, drop the wheel onto the small cog, close the axle, spin it to check it runs straight and the brake doesn't rub."],
    ],
  },
  {
    id: "demo-theo-bike-3", topic: "bike", title: "Chain skipping under load — worn out?", monthsAgo: 13, day: 10, origin: "chatgpt",
    turns: [
      ["user", "When I stand up on the pedals going uphill, the chain sometimes jumps or skips a tooth. I've done about 4,000 km on this chain. Is it the chain or the gears?"],
      ["assistant", "At 4,000 km on a commuter, it's the chain, and probably the cassette with it. A chain stretches as its pins and rollers wear; past about 0.75 % elongation it no longer sits properly in the teeth, and the skipping under load is the first symptom. A chain-checker tool costs a few euros and gives a yes/no answer in ten seconds.\n\nIf it reads worn, replace the chain. Then the test: if the new chain skips on the cogs you use most, the cassette has worn to match the old chain and needs replacing too — that's the usual outcome at this mileage. Replacing the chain every 2,000–2,500 km from now on makes a cassette last three or four chains instead of one.\n\nWhile you're there, look at the chainring teeth: if they're hooked like shark fins, it's next."],
    ],
  },

  // ── Two one-offs the mapping should leave alone ────────────────────────────
  {
    id: "demo-theo-noise-1", topic: "noise", title: "Oven temperature conversion", monthsAgo: 3, day: 25, origin: "chatgpt",
    turns: [
      ["user", "A recipe says 350 °F. What's that in Celsius, and in a fan oven?"],
      ["assistant", "350 °F is about 175 °C in a conventional oven; in a fan (convection) oven, take off roughly 20 degrees, so 155–160 °C. Most recipes mean conventional unless they say otherwise."],
    ],
  },
  {
    id: "demo-theo-noise-2", topic: "noise", title: "A word for the smell of rain", monthsAgo: 8, day: 30, origin: "chatgpt",
    turns: [
      ["user", "Is there an actual word for the smell after it rains on dry ground? My daughter asked and I said I'd find out."],
      ["assistant", "Yes: petrichor. It was coined in the 1960s from Greek petra (stone) and ichor (the fluid in the veins of the gods in myth). The smell itself comes from oils that plants release into dry soil, plus a compound called geosmin made by soil bacteria, which the rain lifts into the air. Humans are extraordinarily sensitive to geosmin — we can smell it at a few parts per trillion."],
    ],
  },
];

/** `YYYY-MM-DD HH:MM:SS`, the server's naive-UTC format, `monthsAgo` months
 *  before `today` on day `day` (clamped to the month), at `hour`. */
export function demoDate(today: Date, monthsAgo: number, day: number, hour: number, minute = 0): string {
  const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - monthsAgo, 1, hour, minute, 0));
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  // Never in the future: a conversation "this month" on a day past today
  // lands on today instead.
  if (d.getTime() > today.getTime()) d.setTime(today.getTime() - 60 * 60 * 1000);
  return d.toISOString().slice(0, 19).replace("T", " ");
}

export interface SeededDemo {
  ids: string[];
  byTopic: Map<DemoTopic, string[]>;
  imported: number;
}

/** Write Théo's history for `memberId`. Idempotent per member: a conversation
 *  already there is left alone. Nothing is indexed here — the corpus does that
 *  on its nightly reconcile, or when the admin asks for it. */
export function seedDemoConversations(memberId: string, today = new Date()): SeededDemo {
  const out: SeededDemo = { ids: [], byTopic: new Map(), imported: 0 };
  const now = today.toISOString().slice(0, 19).replace("T", " ");
  for (const c of DEMO_CONVERSATIONS) {
    const id = `${c.id}-${memberId.slice(0, 8)}`;
    out.ids.push(id);
    out.byTopic.set(c.topic, [...(out.byTopic.get(c.topic) ?? []), id]);
    if (db.query(`SELECT 1 FROM conversations WHERE id = ?`).get(id)) continue;
    const created = demoDate(today, c.monthsAgo, c.day, 9);
    const updated = demoDate(today, c.monthsAgo, c.day, 9, 2 * c.turns.length);
    db.run(
      `INSERT INTO conversations (id, user_id, title, created_at, updated_at, origin, opened_by, imported_at)
       VALUES (?, ?, ?, ?, ?, ?, 'member', ?)`,
      [id, memberId, c.title, created, updated, c.origin, c.origin ? now : null],
    );
    db.run(`INSERT OR IGNORE INTO conversation_participants (conversation_id, member_id, role) VALUES (?, ?, 'owner')`, [id, memberId]);
    c.turns.forEach(([role, content], i) => {
      db.run(
        `INSERT INTO messages (id, conversation_id, role, content, model, created_at, author_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          crypto.randomUUID(),
          id,
          role,
          content,
          role === "assistant" ? (c.origin ? "gpt" : "claude-sonnet-4-20250514") : null,
          demoDate(today, c.monthsAgo, c.day, 9, 2 * i),
          role === "user" ? memberId : null,
        ],
      );
    });
    if (c.origin) out.imported++;
  }
  return out;
}
