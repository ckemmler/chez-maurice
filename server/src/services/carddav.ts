import { DOMParser } from "linkedom";

// A CardDAV client, read-only (27 September 2026, lot 2 of specs/contacts.md).
//
// A member's address book, read every night so the triage knows who is a
// person and the person fiches know which addresses belong together. Only
// what that needs: find the address books from a server address and a login,
// and read every card in them. Nothing is ever written back.
//
// **Finding the address books** follows RFC 6764 and RFC 6352, in the order
// servers actually answer: the URL given, when it is an address book already;
// else its `addressbook-home-set`, directly or through its
// `current-user-principal`; else the same from `/.well-known/carddav`. Mailfence
// answers none of that, and its books sit at `/dav/<user>/private/contacts/` —
// the path the private `contacts` tool has always used.
//
// **Reading the cards**: an `addressbook-query` REPORT asking for the cards
// inline; a server that refuses it (Mailfence again) is asked with a PROPFIND
// carrying `address-data`; a server that answers with the hrefs alone gets an
// `addressbook-multiget` for them, a hundred at a time.
//
// The XML is read by local name — `d:response`, `D:response` and `response`
// alike — since servers pick their own prefixes and linkedom does not resolve
// namespaces. The names this needs do not collide between DAV: and CardDAV.

export interface DavLogin {
  url: string | null;
  username: string;
  password: string;
  provider?: string | null;
}

export interface VCard {
  href: string;
  etag: string | null;
  uid: string | null;
  full_name: string | null;
  nickname: string[];
  org: string | null;
  emails: string[];
  phones: string[];
}

export class CardDavError extends Error {
  constructor(message: string, readonly kind: "refused" | "unreachable" | "not_found" | "unsupported") {
    super(message);
  }
}

// ── Where a provider keeps its address books ─────────────────────────────

const PRESETS: Record<string, string> = {
  icloud: "https://contacts.icloud.com/",
  fastmail: "https://carddav.fastmail.com/",
  mailfence: "https://mailfence.com/",
};

const PROVIDER_BY_DOMAIN: Array<[RegExp, string]> = [
  [/^(icloud|me|mac)\.com$/, "icloud"],
  [/^fastmail\.[a-z.]+$/, "fastmail"],
  [/^mailfence\.com$/, "mailfence"],
  [/^(gmail|googlemail)\.com$/, "google"],
];

/** The provider a login names, when the member did not say: from the
 *  username's domain. */
export function guessProvider(login: { provider?: string | null; username: string }): string | null {
  if (login.provider?.trim()) return login.provider.trim().toLowerCase();
  const domain = login.username.split("@")[1]?.toLowerCase() ?? "";
  return PROVIDER_BY_DOMAIN.find(([re]) => re.test(domain))?.[1] ?? null;
}

/** The URL to start from: the member's, else the provider's. */
export function startUrl(login: DavLogin): string {
  if (login.url?.trim()) {
    const u = login.url.trim();
    return new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`).toString();
  }
  const provider = guessProvider(login);
  // Google's CardDAV takes OAuth only; an app password is refused.
  if (provider === "google") throw new CardDavError("Google's contacts need a sign-in with Google, which Maurice does not do yet", "unsupported");
  const preset = provider ? PRESETS[provider] : undefined;
  if (!preset) throw new CardDavError("the address of the contacts server is needed", "not_found");
  return preset;
}

// ── HTTP ─────────────────────────────────────────────────────────────────

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

let fetcher: Fetcher = (url, init) => fetch(url, init);

/** Tests only: replace the network. */
export function setCardDavFetcher(f: Fetcher | null): void {
  fetcher = f ?? ((url, init) => fetch(url, init));
}

const TIMEOUT_MS = 30_000;

/** One DAV request, following redirects by hand so the method, the body and
 *  the login survive them (`fetch` would turn some into a GET, or drop the
 *  authorisation on another host). */
async function dav(login: DavLogin, method: string, url: string, body: string | null, depth: "0" | "1"): Promise<{ status: number; url: string; text: string }> {
  const auth = `Basic ${Buffer.from(`${login.username}:${login.password}`).toString("base64")}`;
  let current = url;
  for (let hop = 0; hop < 6; hop++) {
    let res: Response;
    try {
      res = await fetcher(current, {
        method,
        headers: { Authorization: auth, Depth: depth, "Content-Type": "application/xml; charset=utf-8", "User-Agent": "Maurice" },
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new CardDavError(`the contacts server could not be reached: ${(err as Error).message}`, "unreachable");
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      current = new URL(res.headers.get("location")!, current).toString();
      continue;
    }
    if (res.status === 401 || res.status === 403) throw new CardDavError("the contacts server refused the login", "refused");
    return { status: res.status, url: current, text: await res.text() };
  }
  throw new CardDavError("the contacts server redirected too many times", "unreachable");
}

// ── XML, by local name ───────────────────────────────────────────────────

const local = (el: any): string => String(el.tagName ?? "").split(":").pop()!.toLowerCase();

function descendants(el: any, name: string): any[] {
  return [...el.querySelectorAll("*")].filter((e: any) => local(e) === name);
}

function first(el: any, name: string): any | null {
  return descendants(el, name)[0] ?? null;
}

interface DavResponse {
  href: string;
  /** Only the properties of a propstat whose status is 200. */
  props: any[];
}

function multistatus(text: string): DavResponse[] {
  const doc = new DOMParser().parseFromString(text, "text/xml");
  return descendants(doc, "response").map((r: any) => {
    const href = decodeURIComponentSafe((first(r, "href")?.textContent ?? "").trim());
    const props = descendants(r, "propstat")
      .filter((ps: any) => /\s200\s/.test(` ${first(ps, "status")?.textContent ?? "HTTP/1.1 200 OK"} `))
      .map((ps: any) => first(ps, "prop"))
      .filter(Boolean);
    return { href, props };
  });
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURI(s);
  } catch {
    return s;
  }
}

function prop(r: DavResponse, name: string): any | null {
  for (const p of r.props) {
    const el = first(p, name);
    if (el) return el;
  }
  return null;
}

/** The href inside a property (`current-user-principal`, `addressbook-home-set`). */
function hrefIn(r: DavResponse, name: string): string | null {
  const el = prop(r, name);
  const h = el ? first(el, "href")?.textContent?.trim() : null;
  return h || null;
}

const isAddressBook = (r: DavResponse): boolean => {
  const rt = prop(r, "resourcetype");
  return !!rt && descendants(rt, "addressbook").length > 0;
};

// ── Discovery ────────────────────────────────────────────────────────────

const PROPFIND_DISCOVER = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav">
  <d:prop><d:resourcetype/><d:current-user-principal/><c:addressbook-home-set/><d:displayname/></d:prop>
</d:propfind>`;

const PROPFIND_BOOKS = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:displayname/></d:prop></d:propfind>`;

/** The address books of a login, as absolute URLs. */
export async function discoverAddressBooks(login: DavLogin): Promise<string[]> {
  const start = startUrl(login);
  const origin = new URL(start).origin;
  const tried = new Set<string>();
  const candidates = [start, `${origin}/.well-known/carddav`];
  for (const candidate of candidates) {
    if (tried.has(candidate)) continue;
    tried.add(candidate);
    const found = await booksFrom(login, candidate);
    if (found.length) return found;
  }
  // Mailfence: no principal, no home set; the books are where they have
  // always been.
  if (/mailfence\.com$/i.test(new URL(start).hostname)) {
    const user = (login.username.split("@")[0] ?? "").trim();
    const url = `${origin}/dav/${encodeURIComponent(user)}/private/contacts/`;
    const r = await dav(login, "PROPFIND", url, PROPFIND_BOOKS, "0");
    if (r.status === 207 && multistatus(r.text).some(isAddressBook)) return [url];
  }
  throw new CardDavError(`no address book was found at ${start}`, "not_found");
}

async function booksFrom(login: DavLogin, url: string): Promise<string[]> {
  const r = await dav(login, "PROPFIND", url, PROPFIND_DISCOVER, "0");
  if (r.status !== 207) return [];
  const here = multistatus(r.text)[0];
  if (!here) return [];
  if (isAddressBook(here)) return [r.url];
  let home = hrefIn(here, "addressbook-home-set");
  if (!home) {
    const principal = hrefIn(here, "current-user-principal");
    if (!principal) return [];
    const p = await dav(login, "PROPFIND", new URL(principal, r.url).toString(), PROPFIND_DISCOVER, "0");
    if (p.status !== 207) return [];
    const pr = multistatus(p.text)[0];
    home = pr ? hrefIn(pr, "addressbook-home-set") : null;
    if (!home) return [];
    home = new URL(home, p.url).toString();
  } else {
    home = new URL(home, r.url).toString();
  }
  const h = await dav(login, "PROPFIND", home, PROPFIND_BOOKS, "1");
  if (h.status !== 207) return [];
  return multistatus(h.text).filter(isAddressBook).map((b) => new URL(b.href, h.url).toString());
}

// ── Reading the cards ────────────────────────────────────────────────────

const REPORT_QUERY = `<?xml version="1.0" encoding="utf-8"?>
<c:addressbook-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav">
  <d:prop><d:getetag/><c:address-data/></d:prop>
</c:addressbook-query>`;

const PROPFIND_DATA = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav">
  <d:prop><d:getetag/><c:address-data/></d:prop>
</d:propfind>`;

const multiget = (hrefs: string[]) => `<?xml version="1.0" encoding="utf-8"?>
<c:addressbook-multiget xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav">
  <d:prop><d:getetag/><c:address-data/></d:prop>
  ${hrefs.map((h) => `<d:href>${h.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</d:href>`).join("\n  ")}
</c:addressbook-multiget>`;

/** Every card of one address book. */
export async function readAddressBook(login: DavLogin, book: string): Promise<VCard[]> {
  let r = await dav(login, "REPORT", book, REPORT_QUERY, "1");
  if (r.status !== 207) r = await dav(login, "PROPFIND", book, PROPFIND_DATA, "1");
  if (r.status !== 207) throw new CardDavError(`the address book answered ${r.status}`, "unsupported");
  const bookPath = new URL(book).pathname.replace(/\/+$/, "");
  const rows = multistatus(r.text).filter((x) => new URL(x.href, book).pathname.replace(/\/+$/, "") !== bookPath);
  const cards: VCard[] = [];
  const missing: string[] = [];
  for (const row of rows) {
    const data = prop(row, "address-data")?.textContent ?? "";
    const etag = prop(row, "getetag")?.textContent?.trim() || null;
    if (data.trim()) cards.push(...parseVCards(data).map((c) => ({ ...c, href: row.href, etag })));
    else if (!isAddressBook(row)) missing.push(row.href);
  }
  for (let i = 0; i < missing.length; i += 100) {
    const m = await dav(login, "REPORT", book, multiget(missing.slice(i, i + 100)), "1");
    if (m.status !== 207) break;
    for (const row of multistatus(m.text)) {
      const data = prop(row, "address-data")?.textContent ?? "";
      const etag = prop(row, "getetag")?.textContent?.trim() || null;
      if (data.trim()) cards.push(...parseVCards(data).map((c) => ({ ...c, href: row.href, etag })));
    }
  }
  return cards;
}

/** Every card the login reaches, across its address books. */
export async function readContacts(login: DavLogin): Promise<{ books: string[]; cards: VCard[] }> {
  const books = await discoverAddressBooks(login);
  const cards: VCard[] = [];
  for (const b of books) cards.push(...(await readAddressBook(login, b)));
  return { books, cards };
}

// ── vCard (2.1, 3.0, 4.0), the fields a person needs ─────────────────────

/** Split a content line at its first colon outside a quoted parameter. */
function splitLine(line: string): { name: string; params: string[]; value: string } | null {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === ":" && !quoted) {
      const head = line.slice(0, i).split(";");
      const name = head[0]!.split(".").pop()!.trim().toUpperCase(); // `item1.EMAIL` → EMAIL
      return { name, params: head.slice(1).map((p) => p.trim().toUpperCase()), value: line.slice(i + 1) };
    }
  }
  return null;
}

const unescape = (v: string): string => v.replace(/\\([nN,;:\\])/g, (_, c) => (c === "n" || c === "N" ? "\n" : c));

/** Split a structured or listed value on unescaped separators. */
function splitUnescaped(v: string, sep: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < v.length; i++) {
    const ch = v[i]!;
    if (ch === "\\" && i + 1 < v.length) {
      cur += ch + v[i + 1];
      i++;
    } else if (ch === sep) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => unescape(s).trim());
}

function quotedPrintable(v: string): string {
  const bytes: number[] = [];
  const s = v.replace(/=\r?\n/g, "");
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "=" && /^[0-9A-F]{2}$/i.test(s.slice(i + 1, i + 3))) {
      bytes.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(...Buffer.from(s[i]!, "utf8"));
  }
  return Buffer.from(bytes).toString("utf8");
}

/** The cards in a vCard text, without href or etag. Groups (a list of
 *  members, not a person) are left out. */
export function parseVCards(text: string): Array<Omit<VCard, "href" | "etag">> {
  // Unfold: a line starting with a space or a tab continues the one before
  // (vCard 2.1 quoted-printable soft breaks end in `=` and are joined later).
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n[ \t]/g, "").split("\n");
  const cards: Array<Omit<VCard, "href" | "etag">> = [];
  let cur: (Omit<VCard, "href" | "etag"> & { group: boolean; n: string | null }) | null = null;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!;
    if (!line.trim()) continue;
    const parsed = splitLine(line);
    if (!parsed) continue;
    const { name, params } = parsed;
    let { value } = parsed;
    if (name === "BEGIN" && value.trim().toUpperCase() === "VCARD") {
      cur = { uid: null, full_name: null, nickname: [], org: null, emails: [], phones: [], group: false, n: null };
      continue;
    }
    if (!cur) continue;
    if (name === "END" && value.trim().toUpperCase() === "VCARD") {
      const { group, n, ...card } = cur;
      if (!card.full_name && n) card.full_name = n;
      if (!group && (card.full_name || card.emails.length)) cards.push(card);
      cur = null;
      continue;
    }
    if (params.some((p) => p === "ENCODING=QUOTED-PRINTABLE" || p === "QUOTED-PRINTABLE")) {
      while (value.endsWith("=") && i + 1 < lines.length) value = value.slice(0, -1) + "=\n" + lines[++i];
      value = quotedPrintable(value);
    }
    switch (name) {
      case "FN":
        cur.full_name = unescape(value).trim() || cur.full_name;
        break;
      case "N": {
        // family;given;additional;prefix;suffix — used only when FN is missing.
        const [family = "", given = "", additional = "", prefix = "", suffix = ""] = splitUnescaped(value, ";");
        const n = [prefix, given, additional, family, suffix].filter(Boolean).join(" ").trim();
        if (n) cur.n = n;
        break;
      }
      case "NICKNAME":
        cur.nickname.push(...splitUnescaped(value, ",").filter(Boolean));
        break;
      case "ORG": {
        const org = splitUnescaped(value, ";").filter(Boolean).join(" / ");
        if (org) cur.org = org;
        break;
      }
      case "EMAIL": {
        const email = unescape(value).trim().replace(/^mailto:/i, "").toLowerCase();
        if (email && !cur.emails.includes(email)) cur.emails.push(email);
        break;
      }
      case "TEL": {
        const tel = unescape(value).trim().replace(/^tel:/i, "");
        if (tel && !cur.phones.includes(tel)) cur.phones.push(tel);
        break;
      }
      case "UID":
        cur.uid = unescape(value).trim() || null;
        break;
      case "KIND":
      case "X-ADDRESSBOOKSERVER-KIND":
        if (value.trim().toLowerCase() === "group") cur.group = true;
        break;
    }
  }
  return cards;
}
