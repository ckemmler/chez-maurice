// The icon of a domain (services/domainIcons.ts, 3 October 2026): the short
// list the night chooses from, the answer read out of whatever the model wraps
// it in, the words that decide when the model is not there — and the column,
// which the member's editor writes and the rest of a PATCH leaves alone.

import { beforeAll, expect, test } from "bun:test";

const { default: db } = await import("../src/db");
const { DOMAIN_ICONS, iconMenu, isListedIcon, keywordIcon, parseIconAnswer } = await import("../src/services/domainIcons");
const { createMaurice, getMaurice, parseIcon, updateMaurice } = await import("../src/services/maurices");

const ANNA = "icons-anna";

beforeAll(() => {
  db.run(`INSERT OR IGNORE INTO households (id, name) VALUES ('default', 'Home')`);
  db.run(`INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES (?, ?, 'Anna', 'standard')`, [ANNA, ANNA]);
});

test("the list holds symbol names, each once", () => {
  const symbols = DOMAIN_ICONS.map((i) => i.symbol);
  expect(new Set(symbols).size).toBe(symbols.length);
  for (const s of symbols) expect(parseIcon(s)).toBe(s);
  expect(iconMenu().split("\n")).toHaveLength(symbols.length);
});

test("the model's answer is read out of its wrapping, and only off the list", () => {
  expect(parseIconAnswer("cross.case")).toBe("cross.case");
  expect(parseIconAnswer("`figure.run`\n")).toBe("figure.run");
  expect(parseIconAnswer('The best fit is "building.columns".')).toBe("building.columns");
  expect(parseIconAnswer("stethoscope.fancy")).toBeNull();
  expect(parseIconAnswer("")).toBeNull();
  expect(isListedIcon("house")).toBe(true);
});

test("the words of the name decide when the model does not", () => {
  expect(keywordIcon("Santé et bien-être")).toBe("cross.case");
  expect(keywordIcon("Natation")).toBe("figure.pool.swim");
  expect(keywordIcon("Immobilier et réglementation à Bruxelles")).toBe("building.2");
  expect(keywordIcon("Pratique du violon")).toBe("guitars");
  // A stem starts a word: "ami" is not in "famille".
  expect(keywordIcon("Famille")).toBe("figure.2.and.child.holdinghands");
  // The name outweighs the line under it.
  expect(keywordIcon("Le vélo", "les voyages de l'été")).toBe("bicycle");
  expect(keywordIcon("Divers", "mes voyages")).toBe("airplane");
  expect(keywordIcon("Zzyzx")).toBeNull();
});

test("a symbol already worn by another domain gives way when something else fits", () => {
  expect(keywordIcon("Santé", "course à pied")).toBe("cross.case");
  expect(keywordIcon("Santé", "course à pied", ["cross.case"])).toBe("cross.case"); // the name still outweighs
  expect(keywordIcon("Divers", "santé et natation", ["figure.pool.swim"])).toBe("cross.case");
});

test("the member's icon is stored, kept by a PATCH that does not name it, cleared by null", () => {
  const made = createMaurice(ANNA, { name: "Le potager", icon: "leaf" }) as any;
  expect(made.icon).toBe("leaf");
  expect((updateMaurice(made.id, ANNA, { name: "Le potager", tagline: "tomates" }) as any).icon).toBe("leaf");
  // Not the shape of a symbol name: refused, the stored one stays.
  expect((updateMaurice(made.id, ANNA, { name: "Le potager", icon: "<script>" }) as any).icon).toBe("leaf");
  expect((updateMaurice(made.id, ANNA, { name: "Le potager", icon: "carrot" }) as any).icon).toBe("carrot");
  expect((updateMaurice(made.id, ANNA, { name: "Le potager", icon: null }) as any).icon).toBeNull();
  expect(getMaurice(made.id)!.icon).toBeNull();
});
