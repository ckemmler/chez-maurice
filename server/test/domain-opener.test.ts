/**
 * The opening message rendered by the server (services/domainOpener.ts,
 * P2-D): the weight of a proposal on five dots, its share, one line of its
 * summary, the model's three parts read loosely, and the layout — the
 * introduction, what a domain is and what it feeds, every alive proposal
 * with its numbers, the lived ones named apart, the nuances, the invitation
 * — in the member's language, with the fixed sentences when the model gave
 * nothing usable. No database, no model.
 */
import { expect, test } from "bun:test";

const opener = await import("../src/services/domainOpener");
type Proposal = import("../src/services/domainProposals").Proposal;

function proposal(name: string, n: number, opts: { verdict?: "alive" | "lived"; recent?: number; last?: string; summary?: string } = {}): Proposal {
  return {
    id: `p-${name}`,
    member_id: "m",
    name,
    summary: opts.summary ?? `${name} is a thing you come back to. Lately it moved on to something else. And more.`,
    conversation_ids: Array.from({ length: n }, (_, i) => `c-${name}-${i}`),
    state: "proposed",
    presented: true,
    conversation_id: null,
    maurice_id: null,
    stats: { size: n, verdict: opts.verdict ?? "alive", recent_90: opts.recent ?? 0, last: opts.last ?? "2026-09-10 10:00:00", first: "2026-01-01 10:00:00" },
    created_at: "2026-09-20 03:00:00",
    updated_at: "2026-09-20 03:00:00",
  };
}

test("weight: five dots for the biggest, at least one for anything, a square root between", () => {
  expect(opener.weightOf(723, 723)).toBe(5);
  expect(opener.weightOf(149, 723)).toBe(2);
  expect(opener.weightOf(95, 723)).toBe(2);
  expect(opener.weightOf(41, 723)).toBe(1);
  expect(opener.weightOf(1, 723)).toBe(1);
  expect(opener.weightOf(0, 723)).toBe(1);
  expect(opener.dots(5)).toBe("●●●●●");
  expect(opener.dots(2)).toBe("●●○○○");
  expect(opener.dots(0)).toBe("○○○○○");
});

test("share: a whole percentage, never zero for something", () => {
  expect(opener.shareOf(723, 5046)).toBe(14);
  expect(opener.shareOf(3, 5046)).toBe(1);
  expect(opener.shareOf(0, 5046)).toBe(0);
  expect(opener.shareOf(3, 0)).toBe(0);
});

test("one line: the first sentence, cut cleanly when long", () => {
  expect(opener.oneLine("You practise and ask about technique. Lately the bow arm.")).toBe("You practise and ask about technique.");
  expect(opener.oneLine("  Several   spaces\nand a line break, no period")).toBe("Several spaces and a line break, no period");
  const long = "A ".repeat(40) + "word ".repeat(40) + ". Next.";
  const cut = opener.oneLine(long, 60);
  expect(cut.length).toBeLessThanOrEqual(60);
  expect(cut.endsWith("…")).toBe(true);
  expect(opener.oneLine("")).toBe("");
});

test("the model's parts are read loosely, and nothing when they are not JSON", () => {
  expect(opener.parseOpener('Sure — {"intro": "Hi  there", "nuances": "", "invitation": "Say."}')).toEqual({ intro: "Hi there", nuances: "", invitation: "Say." });
  expect(opener.parseOpener("Bonjour Anna, voici trois domaines…")).toEqual({});
  expect(opener.parseOpener('{"intro": 3}')).toEqual({ intro: "", nuances: "", invitation: "" });
});

test("the rendering, in French: every alive proposal with its weight and numbers, the lived ones apart, the fixed sentences", () => {
  const alive = [proposal("Mon infrastructure IA", 723, { recent: 12 }), proposal("Santé", 95, { recent: 8 }), proposal("Le violon", 41, { recent: 2, summary: "Tu pratiques et tu poses des questions de technique." })];
  const lived = [proposal("La voile", 12, { verdict: "lived", last: "2025-08-03 10:00:00" })];
  const text = opener.renderOpening({ locale: "fr", alive, lived, total: 5046 });
  const lines = text.split("\n");
  expect(lines[0]).toBe("Cette nuit, j'ai relu nos échanges passés — ceux importés d'autres assistants et ceux vécus avec toi — et j'y ai vu quelques pans de ta vie que je semble suivre.");
  expect(text).toContain("Un domaine, c'est un pan de ta vie que je suis de près");
  expect(text).toContain("c'est ce qui me permet de savoir à qui je m'adresse");
  expect(text).toContain("Rien n'existe tant que tu n'as pas dit oui.");
  expect(text).toContain("**Ce que je vois vivre en ce moment**");
  expect(text).toContain("- ●●●●● **Mon infrastructure IA** · 723 conversations · 14 % · 12 récentes — Mon infrastructure IA is a thing you come back to.");
  expect(text).toContain("- ●●○○○ **Santé** · 95 conversations · 2 % · 8 récentes");
  expect(text).toContain("- ●○○○○ **Le violon** · 41 conversations · 1 % · 2 récentes — Tu pratiques et tu poses des questions de technique.");
  expect(text).toContain("**Ce qui a vécu à un moment** : La voile (12 conversations, calme depuis 2025-08).");
  expect(text.trim().endsWith("ou avec « Définir mes domaines » sous ce message dans l'app Maurice.")).toBe(true);
  // Alive before lived, the explanation before the list, no nuances block when the model gave none.
  expect(text.indexOf("Un domaine, c'est")).toBeLessThan(text.indexOf("**Ce que je vois vivre"));
  expect(text.indexOf("**Ce que je vois vivre")).toBeLessThan(text.indexOf("**Ce qui a vécu"));
  expect(text.split("\n\n")).toHaveLength(6);
});

test("the rendering with the model's parts, and without anything lived; every language renders", () => {
  const alive = [proposal("Bread", 4, { recent: 2 }), proposal("Cats", 1, { recent: 1 })];
  const text = opener.renderOpening({
    locale: "en",
    alive,
    lived: [],
    total: 18,
    parts: { intro: "Tonight I read.", nuances: "Bread and cats might be one thing.", invitation: "Tell me." },
  });
  const blocks = text.split("\n\n");
  expect(blocks[0]).toBe("Tonight I read.");
  expect(blocks[1]).toContain("A domain is a part of your life");
  expect(blocks[2]).toBe("**What I see living now**");
  expect(blocks[3]).toBe("- ●●●●● **Bread** · 4 conversations · 22 % · 2 recent — Bread is a thing you come back to.\n- ●●●○○ **Cats** · 1 conversation · 6 % · 1 recent — Cats is a thing you come back to.");
  expect(blocks[4]).toBe("Bread and cats might be one thing.");
  expect(blocks[5]).toBe("Tell me.");
  expect(text).not.toContain("What lived");
  // A part the model left empty falls back to the fixed sentence.
  const noInv = opener.renderOpening({ locale: "en", alive, lived: [], total: 18, parts: { intro: "Hi.", nuances: "", invitation: "" } });
  expect(noInv.trim().endsWith("under this message in the Maurice app.")).toBe(true);
  for (const locale of ["en", "fr", "it", "de", "es", "pt", "nl"]) {
    const t = opener.renderOpening({ locale, alive, lived: [proposal("Old", 2, { verdict: "lived" })], total: 18 });
    expect(t).toContain("**Bread**");
    expect(t).toContain("Old (2 ");
    expect(opener.openingTitle(locale).length).toBeGreaterThan(5);
  }
  // An unknown locale reads as English.
  expect(opener.openingTitle("xx")).toBe("Your domains, as I see them");
});
