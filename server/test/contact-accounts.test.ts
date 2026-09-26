// A member's address books (27 September 2026, lot 2 of specs/contacts.md).
// What is held down here: the vCard reader keeps the names, addresses and
// phones of every dialect a server sends and leaves groups out; the CardDAV
// client finds the books the way iCloud and the RFCs answer and the way
// Mailfence does not, follows redirects with the login, and says a refused
// login as such; the password is sealed and never comes back out; a login
// that cannot read the book is not kept; a read that fails keeps the last
// cards; a member reaches only their own books; and the triage — at night
// and after a book is added — receives the addresses.

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";

const db = (await import("../src/db")).default;
const dav = await import("../src/services/carddav");
const svc = await import("../src/services/contactAccounts");
const routes = (await import("../src/routes/contactAccounts")).default;
const scan = await import("../src/services/mailScan");
const { createSession } = await import("../src/services/auth");

const ANNA = "ca-anna";
const BEN = "ca-ben";
let annaAuth = "";
let benAuth = "";

// ── vCard ────────────────────────────────────────────────────────────────

test("the vCard reader keeps names, addresses, phones and the UID, in 2.1, 3.0 and 4.0, and leaves groups out", () => {
  const text = [
    "BEGIN:VCARD", "VERSION:3.0", "UID:abc-1", "FN:Jean Derély", "N:Derély;Jean;;;",
    "NICKNAME:Jeannot,JD", "ORG:Acme;R\\&D", "item1.EMAIL;type=INTERNET;type=pref:Jean@Acme.be",
    "EMAIL;TYPE=HOME:mailto:jean.d@gmail.com", "TEL;TYPE=CELL:+32 470 00 00 00",
    "NOTE:une note assez longue pour être", " pliée sur deux lignes", "END:VCARD",
    // 4.0, no FN, the name from N; an escaped comma in a nickname.
    "BEGIN:VCARD", "VERSION:4.0", "N:Lagasse;Claire;;Dr;", "NICKNAME:Claire\\, la prof", "EMAIL:claire@x.org", "END:VCARD",
    // 2.1, quoted-printable, a soft line break.
    "BEGIN:VCARD", "VERSION:2.1", "FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Ren=C3=A9e M=", "=C3=BCller", "EMAIL;INTERNET:renee@y.ch", "END:VCARD",
    // A group, not a person.
    "BEGIN:VCARD", "VERSION:3.0", "FN:Famille", "X-ADDRESSBOOKSERVER-KIND:group", "EMAIL:famille@x.org", "END:VCARD",
  ].join("\r\n");
  const cards = dav.parseVCards(text);
  expect(cards).toHaveLength(3);
  expect(cards[0]).toEqual({
    uid: "abc-1", full_name: "Jean Derély", nickname: ["Jeannot", "JD"], org: "Acme / R\\&D",
    emails: ["jean@acme.be", "jean.d@gmail.com"], phones: ["+32 470 00 00 00"],
  });
  expect(cards[1]).toMatchObject({ full_name: "Dr Claire Lagasse", nickname: ["Claire, la prof"], emails: ["claire@x.org"] });
  expect(cards[2]).toMatchObject({ full_name: "Renée Müller", emails: ["renee@y.ch"] });
});

// ── CardDAV ──────────────────────────────────────────────────────────────

const ms = (...responses: string[]) => `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">${responses.join("")}</d:multistatus>`;
const resp = (href: string, prop: string, status = "HTTP/1.1 200 OK") => `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${prop}</d:prop><d:status>${status}</d:status></d:propstat></d:response>`;
const card = (fn: string, email: string) => `BEGIN:VCARD\r\nVERSION:3.0\r\nUID:${fn}\r\nFN:${fn}\r\nEMAIL:${email}\r\nEND:VCARD`;

interface Seen { method: string; url: string; auth: string | null; depth: string | null }

function server(routes: Record<string, (method: string, body: string) => { status: number; body?: string; location?: string }>) {
  const seen: Seen[] = [];
  const fetcher = async (url: string, init: RequestInit) => {
    const h = init.headers as Record<string, string>;
    seen.push({ method: String(init.method), url, auth: h.Authorization ?? null, depth: h.Depth ?? null });
    const route = routes[url];
    if (!route) return new Response("", { status: 404 });
    const r = route(String(init.method), String(init.body ?? ""));
    return new Response(r.body ?? "", { status: r.status, headers: r.location ? { location: r.location } : {} });
  };
  return { seen, fetcher };
}

afterAll(() => dav.setCardDavFetcher(null));

test("iCloud's way: a redirect from the well-known address, the principal, the home set, the books, the cards inline", async () => {
  const s = server({
    "https://contacts.icloud.com/": () => ({ status: 207, body: ms(resp("/", "<d:resourcetype><d:collection/></d:resourcetype>")) }),
    "https://contacts.icloud.com/.well-known/carddav": () => ({ status: 301, location: "https://p42-contacts.icloud.com/" }),
    "https://p42-contacts.icloud.com/": () => ({ status: 207, body: ms(resp("/", "<d:current-user-principal><d:href>/123/principal/</d:href></d:current-user-principal>")) }),
    "https://p42-contacts.icloud.com/123/principal/": () => ({ status: 207, body: ms(resp("/123/principal/", "<card:addressbook-home-set><d:href>https://p42-contacts.icloud.com/123/carddavhome/</d:href></card:addressbook-home-set>")) }),
    "https://p42-contacts.icloud.com/123/carddavhome/": () => ({
      status: 207,
      body: ms(
        resp("/123/carddavhome/", "<d:resourcetype><d:collection/></d:resourcetype>"),
        resp("/123/carddavhome/card/", "<d:resourcetype><d:collection/><card:addressbook/></d:resourcetype>"),
        resp("/123/carddavhome/inbox/", "<d:resourcetype><d:collection/></d:resourcetype>"),
      ),
    }),
    "https://p42-contacts.icloud.com/123/carddavhome/card/": (method) =>
      method === "REPORT"
        ? { status: 207, body: ms(resp("/123/carddavhome/card/a.vcf", `<d:getetag>"1"</d:getetag><card:address-data>${card("Jean", "jean@x.org")}</card:address-data>`), resp("/123/carddavhome/card/b.vcf", `<d:getetag>"2"</d:getetag><card:address-data>${card("Claire", "claire@x.org")}</card:address-data>`)) }
        : { status: 405 },
  });
  dav.setCardDavFetcher(s.fetcher);
  const r = await dav.readContacts({ url: null, username: "anna@icloud.com", password: "app-pw" });
  expect(r.books).toEqual(["https://p42-contacts.icloud.com/123/carddavhome/card/"]);
  expect(r.cards.map((c) => [c.full_name, c.emails[0], c.href, c.etag])).toEqual([
    ["Jean", "jean@x.org", "/123/carddavhome/card/a.vcf", '"1"'],
    ["Claire", "claire@x.org", "/123/carddavhome/card/b.vcf", '"2"'],
  ]);
  // The login went with every request, across the redirect to another host.
  const basic = `Basic ${Buffer.from("anna@icloud.com:app-pw").toString("base64")}`;
  expect(s.seen.every((x) => x.auth === basic)).toBe(true);
  expect(s.seen.find((x) => x.url.endsWith("/card/"))).toMatchObject({ method: "REPORT", depth: "1" });
});

test("Mailfence's way: no principal, the books at /dav/<user>/private/contacts/, the cards by PROPFIND, the hrefs alone fetched by multiget", async () => {
  const book = "https://mailfence.com/dav/anna/private/contacts/";
  const s = server({
    "https://mailfence.com/": () => ({ status: 207, body: ms(resp("/", "<d:resourcetype><d:collection/></d:resourcetype>")) }),
    [book]: (method, body) => {
      if (method === "REPORT" && body.includes("addressbook-multiget")) {
        return { status: 207, body: ms(resp("/dav/anna/private/contacts/c.vcf", `<card:address-data>${card("Chloé", "chloe@x.org")}</card:address-data>`)) };
      }
      if (method === "REPORT") return { status: 501 };
      if (body.includes("address-data")) {
        return {
          status: 207,
          body: ms(
            resp("/dav/anna/private/contacts/", "<d:resourcetype><d:collection/><card:addressbook/></d:resourcetype>"),
            resp("/dav/anna/private/contacts/a.vcf", `<card:address-data>${card("Jean", "jean@x.org")}</card:address-data>`),
            resp("/dav/anna/private/contacts/c.vcf", "<d:getetag>\"3\"</d:getetag>"),
          ),
        };
      }
      return { status: 207, body: ms(resp("/dav/anna/private/contacts/", "<d:resourcetype><d:collection/><card:addressbook/></d:resourcetype>")) };
    },
  });
  dav.setCardDavFetcher(s.fetcher);
  const r = await dav.readContacts({ url: null, username: "anna@mailfence.com", password: "pw" });
  expect(r.books).toEqual([book]);
  expect(r.cards.map((c) => c.full_name)).toEqual(["Jean", "Chloé"]);
});

test("a refused login says so; Google is refused before any request; no URL and no known provider asks for one", async () => {
  const s = server({ "https://dav.example.org/": () => ({ status: 401 }) });
  dav.setCardDavFetcher(s.fetcher);
  await expect(dav.readContacts({ url: "dav.example.org", username: "anna", password: "bad" })).rejects.toThrow("refused the login");
  await expect(dav.readContacts({ url: null, username: "anna@gmail.com", password: "x" })).rejects.toThrow("sign-in with Google");
  await expect(dav.readContacts({ url: null, username: "anna@example.org", password: "x" })).rejects.toThrow("address of the contacts server");
});

// ── The accounts ─────────────────────────────────────────────────────────

let bookAccepts = (password: string) => password === "good";
let bookCards: Array<{ full_name: string; emails: string[] }> = [];
let bookDown = false;
let triaged: any[] = [];

beforeAll(() => {
  db.run(`INSERT OR IGNORE INTO households (id, name) VALUES ('default', 'Home')`);
  for (const [id, name] of [[ANNA, "Anna"], [BEN, "Ben"]] as const) {
    db.run(`INSERT OR IGNORE INTO users (id, username, display_name, role) VALUES (?, ?, ?, 'standard')`, [id, id, name]);
  }
  annaAuth = `Bearer ${createSession(ANNA).token}`;
  benAuth = `Bearer ${createSession(BEN).token}`;
  svc.setContactReader(async (login) => {
    if (bookDown) throw new dav.CardDavError("the contacts server could not be reached: timeout", "unreachable");
    if (!bookAccepts(login.password)) throw new dav.CardDavError("the contacts server refused the login", "refused");
    return {
      books: ["https://x/book/"],
      cards: bookCards.map((c, i) => ({ href: `/book/${i}.vcf`, etag: null, uid: `u${i}`, nickname: [], org: null, phones: [], ...c })),
    };
  });
  scan.setMailScanDeps({
    call: async (_m: string, tool: string, args: any) => {
      if (tool === "triage_mailbox") triaged.push(args);
      return { counts: { bulk: 1, correspondence: 2, other: 0 } };
    },
  });
});

afterAll(() => {
  svc.setContactReader(null);
  scan.setMailScanDeps(null);
});

beforeEach(() => {
  db.run(`DELETE FROM contact_accounts`);
  db.run(`DELETE FROM mail_accounts WHERE member_id IN (?, ?)`, [ANNA, BEN]);
  bookAccepts = (p) => p === "good";
  bookCards = [{ full_name: "Jean", emails: ["jean@x.org", "Jean.D@gmail.com"] }, { full_name: "Claire", emails: ["claire@x.org", "jean@x.org"] }];
  bookDown = false;
  triaged = [];
});

function req(auth: string, path: string, init: RequestInit = {}) {
  return routes.request(path, { ...init, headers: { Authorization: auth, "Content-Type": "application/json", ...(init.headers ?? {}) } });
}

test("adding a book reads it before answering; the password is sealed and never comes back; the cards are kept", async () => {
  const res = await req(annaAuth, "/", { method: "POST", body: JSON.stringify({ username: "anna@icloud.com", password: "go od" }) });
  expect(res.status).toBe(201);
  const body = await res.json() as any;
  expect(body).toMatchObject({ username: "anna@icloud.com", provider: "icloud", url: null, state: "ok", cards: 2 });
  expect(JSON.stringify(body)).not.toContain("good");
  const row = db.query(`SELECT secret FROM contact_accounts WHERE id = ?`).get(body.id) as any;
  expect(row.secret.startsWith("v1:")).toBe(true);
  expect(row.secret).not.toContain("good");
  const list = await (await req(annaAuth, "/")).json() as any;
  expect(JSON.stringify(list)).not.toContain("secret");
  // Every address once, lowercased.
  expect(svc.contactAddresses(ANNA)).toEqual(["claire@x.org", "jean.d@gmail.com", "jean@x.org"]);
  expect(svc.contactCards(ANNA).map((c) => c.full_name)).toEqual(["Claire", "Jean"]);
});

test("a login that cannot read the book is not kept; Google is refused; no server for an unknown domain is asked for", async () => {
  const bad = await req(annaAuth, "/", { method: "POST", body: JSON.stringify({ username: "anna@icloud.com", password: "nope" }) });
  expect(bad.status).toBe(422);
  expect((await bad.json() as any).error).toContain("refused the login");
  expect(svc.listContactAccounts(ANNA)).toHaveLength(0);
  const google = await req(annaAuth, "/", { method: "POST", body: JSON.stringify({ username: "anna@gmail.com", password: "good" }) });
  expect(google.status).toBe(422);
  expect((await google.json() as any).error).toContain("sign-in with Google");
  const unknown = await req(annaAuth, "/", { method: "POST", body: JSON.stringify({ username: "anna@example.org", password: "good" }) });
  expect(unknown.status).toBe(400);
  const plain = await req(annaAuth, "/", { method: "POST", body: JSON.stringify({ username: "anna", password: "good", url: "http://dav.example.org" }) });
  expect(plain.status).toBe(400);
  const nextcloud = await req(annaAuth, "/", { method: "POST", body: JSON.stringify({ username: "anna", password: "good", url: "cloud.example.org/remote.php/dav" }) });
  expect(nextcloud.status).toBe(201);
  expect((await nextcloud.json() as any).url).toBe("https://cloud.example.org/remote.php/dav");
});

test("a read that fails keeps the last cards and says why; a bad new password leaves the old one", async () => {
  const created = await (await req(annaAuth, "/", { method: "POST", body: JSON.stringify({ username: "anna@icloud.com", password: "good" }) })).json() as any;
  bookDown = true;
  const down = await (await req(annaAuth, `/${created.id}/sync`, { method: "POST" })).json() as any;
  expect(down).toMatchObject({ state: "error", cards: 2 });
  expect(down.last_error).toContain("could not be reached");
  expect(svc.contactAddresses(ANNA)).toHaveLength(3);
  bookDown = false;
  const wrong = await req(annaAuth, `/${created.id}/password`, { method: "PUT", body: JSON.stringify({ password: "nope" }) });
  expect(wrong.status).toBe(422);
  const again = await (await req(annaAuth, `/${created.id}/sync`, { method: "POST" })).json() as any;
  expect(again.state).toBe("ok"); // the old password is back
});

test("a member reaches only their own books; deleting one forgets its cards", async () => {
  const created = await (await req(annaAuth, "/", { method: "POST", body: JSON.stringify({ username: "anna@icloud.com", password: "good" }) })).json() as any;
  expect(((await (await req(benAuth, "/")).json()) as any).accounts).toEqual([]);
  expect((await req(benAuth, `/${created.id}/sync`, { method: "POST" })).status).toBe(404);
  expect((await req(benAuth, `/${created.id}`, { method: "DELETE" })).status).toBe(404);
  expect((await req(annaAuth, `/${created.id}`, { method: "DELETE" })).status).toBe(200);
  expect(svc.contactAddresses(ANNA)).toEqual([]);
  expect((db.query(`SELECT count(*) AS n FROM contact_cards WHERE member_id = ?`).get(ANNA) as any).n).toBe(0);
});

test("a book added by a member with mail sorts their mail again with the addresses; the night reads the books before the triage", async () => {
  db.run(`INSERT INTO mail_accounts (id, member_id, address, secret) VALUES ('ca-mail', ?, 'anna@icloud.com', 'v1:x')`, [ANNA]);
  await req(annaAuth, "/", { method: "POST", body: JSON.stringify({ username: "anna@icloud.com", password: "good" }) });
  await Bun.sleep(10);
  expect(triaged).toEqual([{ contacts: ["claire@x.org", "jean.d@gmail.com", "jean@x.org"] }]);
  // Without mail, nothing to sort.
  await req(benAuth, "/", { method: "POST", body: JSON.stringify({ username: "ben@icloud.com", password: "good" }) });
  await Bun.sleep(10);
  expect(triaged).toHaveLength(1);
  // The night: the book read again (a new card), then the triage with it.
  bookCards.push({ full_name: "Erlend", emails: ["e@y.org"] });
  triaged = [];
  const calls: string[] = [];
  const outcome = await scan.runMailNightly({
    call: async (_m: string, tool: string, args: any) => {
      calls.push(tool);
      if (tool === "scan_mailbox") return { status: "started" };
      if (tool === "scan_status") return { running: false, job: { id: "j", state: "done", counts: {} }, totals: { messages: 1, locations: 1 } };
      if (tool === "triage_mailbox") { triaged.push(args); return { counts: {} }; }
      if (tool === "reconcile_mailbox") return { status: "started" };
      if (tool === "estimate_reading") return { to_read: 0, window: {}, tokens: {}, nights: {} };
      return {};
    },
    members: () => [{ id: ANNA }],
    open: async () => ({ ok: true as const, conversation: { id: "c" } as any, message: {} as any }),
    locale: () => "fr",
    pollMs: 1,
    contacts: async (id: string) => { await svc.syncContacts(id); return svc.contactAddresses(id); },
  } as any);
  expect(outcome).toBe("walked");
  expect(triaged).toEqual([{ contacts: ["claire@x.org", "e@y.org", "jean.d@gmail.com", "jean@x.org"] }]);
});
