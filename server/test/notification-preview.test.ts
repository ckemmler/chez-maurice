/**
 * The notification preview of a message: images dropped, and a long paste —
 * which the app sends as a ```pasted block — shown as its text, fences gone.
 */
import { expect, test } from "bun:test";

const { preview } = await import("../src/routes/conversations");

test("images are dropped", () => {
  expect(preview("![photo](/api/images/a.jpg)\n\nRegarde ça")).toBe("Regarde ça");
});

test("a pasted block reads as its text", () => {
  expect(preview("```pasted\nPremière ligne\nDeuxième ligne\n```\n\nTu en penses quoi ?"))
    .toBe("Première ligne Deuxième ligne Tu en penses quoi ?");
  // A longer fence, for a paste that holds ``` of its own.
  expect(preview("````pasted\n```js\nx()\n```\n````")).toBe("```js x()");
});

test("long previews are cut", () => {
  expect(preview("a".repeat(200))).toBe("a".repeat(140) + "…");
});
