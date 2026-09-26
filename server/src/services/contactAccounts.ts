import { randomUUID } from "node:crypto";
import db from "../db";
import { CardDavError, guessProvider, readContacts, type DavLogin, type VCard } from "./carddav";
import { decryptSecret, encryptSecret } from "./mailAccounts";

// A member's address books (27 September 2026, lot 2 of specs/contacts.md).
//
// A CardDAV login a member adds from the app — iCloud, Fastmail, Mailfence,
// Nextcloud or any server that speaks it — and only they ever see or change,
// like their mail accounts: the password sealed with the household's key
// (services/mailAccounts.ts), never returned by a route. The cards are read
// whole at every read and kept in `contact_cards`, replaced, never edited:
// nothing is written back.
//
// What they are for, today: the triage. A sender in the member's contacts
// is a person before any bulk marker is looked at (tools/email/triage.py),
// so a friend's newsletter, an association or an accountant's CRM is read
// instead of dropped as bulk. Tomorrow (lot 3), the person fiches: a card's
// addresses are one person's, confirmed unless the mail contradicts it.
//
// Read every night before the triage (services/mailScan.ts), and when the
// member adds an account or asks for it.

export interface ContactAccountInput {
  username: string;
  password: string;
  url?: string | null;
  name?: string | null;
  provider?: string | null;
}

export interface ContactAccount {
  id: string;
  member_id: string;
  url: string | null;
  username: string;
  name: string | null;
  provider: string | null;
  state: "unchecked" | "ok" | "error";
  last_error: string | null;
  checked_at: string | null;
  synced_at: string | null;
  cards: number;
  created_at: string;
  updated_at: string;
}

export interface ContactCard {
  account_id: string;
  uid: string | null;
  full_name: string | null;
  nickname: string[];
  org: string | null;
  emails: string[];
  phones: string[];
}

export class ContactAccountError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 422 = 400) {
    super(message);
  }
}

const COLUMNS = `id, member_id, url, username, name, provider, state, last_error, checked_at, synced_at, cards, created_at, updated_at`;

function clean(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s ? s : null;
}

function validate(input: ContactAccountInput): Required<ContactAccountInput> {
  const username = clean(input.username);
  if (!username) throw new ContactAccountError("a username is needed — most often your email address");
  const password = typeof input.password === "string" ? input.password.trim() : "";
  if (!password) throw new ContactAccountError("a password is needed — an app password for most providers");
  let url = clean(input.url);
  if (url) {
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    try {
      const u = new URL(url);
      if (u.protocol !== "https:" && u.hostname !== "localhost" && u.hostname !== "127.0.0.1") {
        throw new ContactAccountError("the server address must use https");
      }
    } catch (err) {
      if (err instanceof ContactAccountError) throw err;
      throw new ContactAccountError("the server address is not a web address");
    }
  }
  const provider = clean(input.provider)?.toLowerCase() ?? guessProvider({ username }) ?? null;
  if (!url && provider === "google") {
    throw new ContactAccountError("Google's contacts need a sign-in with Google, which Maurice does not do yet", 422);
  }
  if (!url && !provider) throw new ContactAccountError("the address of the contacts server is needed for this provider");
  return { username, password, url, name: clean(input.name), provider };
}

export function listContactAccounts(memberId: string): ContactAccount[] {
  return db
    .query(`SELECT ${COLUMNS} FROM contact_accounts WHERE member_id = ? ORDER BY created_at, username`)
    .all(memberId) as ContactAccount[];
}

export function getContactAccount(memberId: string, id: string): ContactAccount | null {
  return (db.query(`SELECT ${COLUMNS} FROM contact_accounts WHERE id = ? AND member_id = ?`).get(id, memberId) as ContactAccount | null) ?? null;
}

export function createContactAccount(memberId: string, input: ContactAccountInput): ContactAccount {
  const v = validate(input);
  const taken = db
    .query(`SELECT 1 FROM contact_accounts WHERE member_id = ? AND lower(username) = lower(?) AND coalesce(url, '') = coalesce(?, '')`)
    .get(memberId, v.username, v.url);
  if (taken) throw new ContactAccountError(`${v.username} is already one of your address books`, 409);
  const id = randomUUID();
  db.run(
    `INSERT INTO contact_accounts (id, member_id, url, username, name, provider, secret) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, memberId, v.url, v.username, v.name, v.provider, encryptSecret(v.password.replace(/\s+/g, ""))],
  );
  return getContactAccount(memberId, id)!;
}

/** A new password; the previous sealed one, to put back if it does not work. */
export function replaceContactPassword(memberId: string, id: string, password: string): string {
  const row = db.query(`SELECT secret FROM contact_accounts WHERE id = ? AND member_id = ?`).get(id, memberId) as { secret: string } | null;
  if (!row) throw new ContactAccountError("no such address book", 404);
  const plain = typeof password === "string" ? password.replace(/\s+/g, "") : "";
  if (!plain) throw new ContactAccountError("a password is needed");
  db.run(
    `UPDATE contact_accounts SET secret = ?, state = 'unchecked', last_error = NULL, updated_at = datetime('now') WHERE id = ? AND member_id = ?`,
    [encryptSecret(plain), id, memberId],
  );
  return row.secret;
}

export function restoreContactSecret(memberId: string, id: string, sealed: string): void {
  db.run(`UPDATE contact_accounts SET secret = ?, updated_at = datetime('now') WHERE id = ? AND member_id = ?`, [sealed, id, memberId]);
}

/** Forget the account, its password and its cards. */
export function deleteContactAccount(memberId: string, id: string): boolean {
  return db.run(`DELETE FROM contact_accounts WHERE id = ? AND member_id = ?`, [id, memberId]).changes > 0;
}

// ── Reading an address book ──────────────────────────────────────────────

export type ContactReader = (login: DavLogin) => Promise<{ books: string[]; cards: VCard[] }>;

let reader: ContactReader = readContacts;

/** Tests only: replace the CardDAV round trip. */
export function setContactReader(fn: ContactReader | null): void {
  reader = fn ?? readContacts;
}

function loginOf(memberId: string, id: string): DavLogin {
  const row = db
    .query(`SELECT url, username, provider, secret FROM contact_accounts WHERE id = ? AND member_id = ?`)
    .get(id, memberId) as { url: string | null; username: string; provider: string | null; secret: string } | null;
  if (!row) throw new ContactAccountError("no such address book", 404);
  let password: string;
  try {
    password = decryptSecret(row.secret);
  } catch {
    throw new ContactAccountError("the stored password cannot be read with this household's key; enter it again", 422);
  }
  return { url: row.url, username: row.username, password, provider: row.provider };
}

/** Read one account's cards and replace what was kept. A read that fails
 *  records the reason and keeps the cards of the last good one: a server
 *  down for a night does not empty the member's contacts. */
export async function syncContactAccount(memberId: string, id: string): Promise<ContactAccount> {
  let login: DavLogin;
  try {
    login = loginOf(memberId, id);
  } catch (err) {
    if (err instanceof ContactAccountError && err.status === 422) {
      db.run(`UPDATE contact_accounts SET state = 'error', last_error = ?, checked_at = datetime('now') WHERE id = ? AND member_id = ?`, [err.message, id, memberId]);
      return getContactAccount(memberId, id)!;
    }
    throw err;
  }
  let cards: VCard[];
  try {
    cards = (await reader(login)).cards;
  } catch (err) {
    const message = err instanceof CardDavError ? err.message : `the contacts could not be read: ${(err as Error).message}`;
    db.run(`UPDATE contact_accounts SET state = 'error', last_error = ?, checked_at = datetime('now') WHERE id = ? AND member_id = ?`, [message, id, memberId]);
    return getContactAccount(memberId, id)!;
  }
  const insert = db.prepare(
    `INSERT INTO contact_cards (account_id, member_id, href, etag, uid, full_name, nickname, org, emails, phones) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  db.transaction(() => {
    db.run(`DELETE FROM contact_cards WHERE account_id = ?`, [id]);
    for (const c of cards) {
      insert.run(id, memberId, c.href, c.etag, c.uid, c.full_name, JSON.stringify(c.nickname), c.org, JSON.stringify(c.emails), JSON.stringify(c.phones));
    }
    db.run(
      `UPDATE contact_accounts SET state = 'ok', last_error = NULL, checked_at = datetime('now'), synced_at = datetime('now'), cards = ? WHERE id = ? AND member_id = ?`,
      [cards.length, id, memberId],
    );
  })();
  return getContactAccount(memberId, id)!;
}

/** Read every account of a member. Never throws; each account records its
 *  own outcome. */
export async function syncContacts(memberId: string): Promise<ContactAccount[]> {
  const out: ContactAccount[] = [];
  for (const a of listContactAccounts(memberId)) {
    try {
      out.push(await syncContactAccount(memberId, a.id));
    } catch (err) {
      console.warn(`[contacts] ${memberId}: ${a.id} failed: ${(err as Error).message}`);
    }
  }
  return out;
}

// ── What the rest reads ──────────────────────────────────────────────────

export function contactCards(memberId: string): ContactCard[] {
  const rows = db
    .query(`SELECT account_id, uid, full_name, nickname, org, emails, phones FROM contact_cards WHERE member_id = ? ORDER BY full_name, id`)
    .all(memberId) as any[];
  const list = (v: string) => {
    try {
      const a = JSON.parse(v);
      return Array.isArray(a) ? a.map(String) : [];
    } catch {
      return [];
    }
  };
  return rows.map((r) => ({ ...r, nickname: list(r.nickname), emails: list(r.emails), phones: list(r.phones) }));
}

/** Every address in the member's contacts, lowercased, once — what the
 *  triage counts as a person. */
export function contactAddresses(memberId: string): string[] {
  return [...new Set(contactCards(memberId).flatMap((c) => c.emails.map((e) => e.toLowerCase())))].sort();
}
