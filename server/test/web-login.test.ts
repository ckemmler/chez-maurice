// Where the app's garden button lands a member (6 October 2026). The garden
// is one site per locale, English at its root: a member whose notes are all
// French landed on an empty garden. `/login` now sends them to their own
// language's side; a deep link (`to`) is followed as before.

import { beforeAll, expect, test } from "bun:test";

const db = (await import("../src/db")).default;
const { createApiToken } = await import("../src/middleware/auth");
const webLogin = (await import("../src/routes/web-login")).default;

let token = "";

beforeAll(async () => {
  db.run(`INSERT OR IGNORE INTO households (id, name) VALUES ('default', 'Home')`);
  db.run(`INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES ('wl-lea', 'wl-lea', 'Léa', 'standard')`);
  token = (await createApiToken("wl-lea", "web-login test")).rawToken;
});

function setLocale(locale: string | null) {
  db.run(
    `INSERT INTO user_preferences (user_id, locale) VALUES ('wl-lea', ?) ON CONFLICT(user_id) DO UPDATE SET locale = excluded.locale`,
    [locale],
  );
}

async function land(query = ""): Promise<string | null> {
  const res = await webLogin.request(`/?token=${token}${query}`);
  expect(res.status).toBe(302);
  return res.headers.get("location");
}

test("a member who reads in French lands on the French side of their garden", async () => {
  setLocale("fr");
  expect(await land()).toBe("/g/wl-lea/fr/");
  expect(await land("&theme=manuscript")).toBe("/g/wl-lea/fr/?theme=manuscript");
  setLocale("fr-BE");
  expect(await land()).toBe("/g/wl-lea/fr/");
});

test("English, no choice, or a language the garden has no side for: the root", async () => {
  setLocale("en");
  expect(await land()).toBe("/g/wl-lea/");
  setLocale(null);
  expect(await land("&theme=manuscript")).toBe("/g/wl-lea/?theme=manuscript");
  setLocale("de");
  expect(await land()).toBe("/g/wl-lea/");
});

test("a deep link is followed as it is, whatever the language", async () => {
  setLocale("fr");
  expect(await land("&to=%2Fg%2Fwl-lea%2Fnotes%2Fhello")).toBe("/g/wl-lea/notes/hello");
  // Never off the server.
  expect(await land("&to=%2F%2Fevil.example")).toBe("/g/wl-lea/fr/");
});

test("a link that is not a member's token is refused", async () => {
  expect((await webLogin.request(`/?token=nope`)).status).toBe(400);
  expect((await webLogin.request(`/?token=maur_nope`)).status).toBe(401);
});
