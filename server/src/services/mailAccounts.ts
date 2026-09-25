import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import db from "../db";
import { getAppDir } from "../../lib/appDir";
import { McpSession } from "./mcpClient";

// A member's mail accounts, entered from the app (25 September 2026).
//
// Step 1 of the `email` tool kept accounts in a TOML file and passwords in the
// Mac's Keychain: the admin's job, on one machine, useless in the container.
// Here a member adds their own mailbox — an address and an app password — and
// only they ever see or change it. There is no admin path to another member's
// accounts, the same promise the tool makes about their mail.
//
// The password is encrypted at rest with the household's key (AES-256-GCM):
// `MAURICE_SECRET_KEY` (32 bytes, base64 or hex) when set, else `secret.key`
// in the app dir, created on first use and readable by the owner alone. A copy
// of maurice.db without the key — a seed, a debugging snapshot — carries no
// usable password. The household archive carries the key (services/archive.ts):
// a household moved elsewhere keeps its mailboxes, and the archive was already
// a secret for the provider keys it holds.
//
// The `email` tool reads the accounts, password included, through a loopback
// route (routes/mailAccountsLocal.ts). Checking an account is the tool's job
// too — one IMAP implementation, in Python — so adding one here asks the
// gateway to list the member's accounts and reads back the state of the new one.

export interface MailAccountInput {
  address: string;
  password: string;
  name?: string | null;
  provider?: string | null;
  host?: string | null;
  port?: number | null;
  security?: string | null;
  username?: string | null;
}

export interface MailAccount {
  id: string;
  member_id: string;
  address: string;
  name: string | null;
  provider: string | null;
  host: string | null;
  port: number | null;
  security: string | null;
  username: string | null;
  state: "unchecked" | "ok" | "error";
  last_error: string | null;
  checked_at: string | null;
  created_at: string;
  updated_at: string;
}

export class MailAccountError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 422 = 400) {
    super(message);
  }
}

// ── the household key ───────────────────────────────────────────────────

let cachedKey: Buffer | null = null;

function parseKey(value: string): Buffer | null {
  const v = value.trim();
  const hex = /^[0-9a-f]{64}$/i.test(v) ? Buffer.from(v, "hex") : null;
  const key = hex ?? Buffer.from(v, "base64");
  return key.length === 32 ? key : null;
}

export function secretKeyPath(): string {
  return join(getAppDir(), "secret.key");
}

function householdKey(): Buffer {
  if (cachedKey) return cachedKey;
  const env = process.env.MAURICE_SECRET_KEY;
  if (env) {
    const key = parseKey(env);
    if (!key) throw new Error("MAURICE_SECRET_KEY must be 32 bytes, as 64 hex characters or base64");
    return (cachedKey = key);
  }
  const path = secretKeyPath();
  if (existsSync(path)) {
    const key = parseKey(readFileSync(path, "utf8"));
    if (!key) throw new Error(`${path} does not hold a 32-byte key`);
    return (cachedKey = key);
  }
  mkdirSync(getAppDir(), { recursive: true });
  const key = randomBytes(32);
  // `wx`: never overwrite a key another process wrote a moment ago — every
  // password encrypted with it would be lost.
  writeFileSync(path, key.toString("base64") + "\n", { mode: 0o600, flag: "wx" });
  chmodSync(path, 0o600);
  return (cachedKey = key);
}

/** Tests only: forget the cached key so a changed env or file is read again. */
export function resetKeyCache(): void {
  cachedKey = null;
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", householdKey(), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `v1:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64")}`;
}

export function decryptSecret(sealed: string): string {
  if (!sealed.startsWith("v1:")) throw new Error("unknown secret format");
  const raw = Buffer.from(sealed.slice(3), "base64");
  const decipher = createDecipheriv("aes-256-gcm", householdKey(), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}

// ── accounts ────────────────────────────────────────────────────────────

const COLUMNS = `id, member_id, address, name, provider, host, port, security, username,
  state, last_error, checked_at, created_at, updated_at`;

const ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

function clean(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s ? s : null;
}

function validate(input: MailAccountInput): MailAccountInput {
  const address = clean(input.address)?.toLowerCase();
  if (!address || !ADDRESS.test(address)) throw new MailAccountError("an email address is needed");
  const password = typeof input.password === "string" ? input.password.trim() : "";
  if (!password) throw new MailAccountError("a password is needed — an app password for most providers");
  const name = clean(input.name)?.toLowerCase() ?? null;
  if (name && !NAME.test(name)) throw new MailAccountError("a name is short, lowercase, letters, digits, - and _");
  const security = clean(input.security);
  if (security && security !== "tls" && security !== "starttls") throw new MailAccountError("security is tls or starttls");
  const port = input.port === undefined || input.port === null || input.port === ("" as unknown) ? null : Number(input.port);
  if (port !== null && !(Number.isInteger(port) && port > 0 && port < 65536)) throw new MailAccountError("port is a number");
  return {
    address,
    // App passwords are shown with spaces (Gmail) or dashes (Apple); Gmail's
    // spaces are cosmetic and a paste often keeps them. Dashes are part of
    // Apple's, so only spaces go.
    password: password.replace(/\s+/g, ""),
    name,
    provider: clean(input.provider)?.toLowerCase() ?? null,
    host: clean(input.host),
    port,
    security,
    username: clean(input.username),
  };
}

export function listMailAccounts(memberId: string): MailAccount[] {
  return db
    .query(`SELECT ${COLUMNS} FROM mail_accounts WHERE member_id = ? ORDER BY created_at, address`)
    .all(memberId) as MailAccount[];
}

export function getMailAccount(memberId: string, id: string): MailAccount | null {
  return (db
    .query(`SELECT ${COLUMNS} FROM mail_accounts WHERE id = ? AND member_id = ?`)
    .get(id, memberId) as MailAccount | null) ?? null;
}

export function createMailAccount(memberId: string, input: MailAccountInput): MailAccount {
  const v = validate(input);
  const taken = db.query(`SELECT 1 FROM mail_accounts WHERE member_id = ? AND address = ?`).get(memberId, v.address);
  if (taken) throw new MailAccountError(`${v.address} is already one of your accounts`, 409);
  const id = randomUUID();
  db.run(
    `INSERT INTO mail_accounts (id, member_id, address, name, provider, host, port, security, username, secret)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, memberId, v.address, v.name ?? null, v.provider ?? null, v.host ?? null, v.port ?? null, v.security ?? null,
     v.username ?? null, encryptSecret(v.password)],
  );
  return getMailAccount(memberId, id)!;
}

/** A new password for an account; the previous sealed one, to put back if the
 *  new one does not work. */
export function replacePassword(memberId: string, id: string, password: string): string {
  const row = db.query(`SELECT secret FROM mail_accounts WHERE id = ? AND member_id = ?`).get(id, memberId) as { secret: string } | null;
  if (!row) throw new MailAccountError("no such account", 404);
  const plain = typeof password === "string" ? password.replace(/\s+/g, "") : "";
  if (!plain) throw new MailAccountError("a password is needed");
  db.run(
    `UPDATE mail_accounts SET secret = ?, state = 'unchecked', last_error = NULL, updated_at = datetime('now')
     WHERE id = ? AND member_id = ?`,
    [encryptSecret(plain), id, memberId],
  );
  return row.secret;
}

export function restoreSecret(memberId: string, id: string, sealed: string): void {
  db.run(`UPDATE mail_accounts SET secret = ?, updated_at = datetime('now') WHERE id = ? AND member_id = ?`, [sealed, id, memberId]);
}

export function deleteMailAccount(memberId: string, id: string): boolean {
  return db.run(`DELETE FROM mail_accounts WHERE id = ? AND member_id = ?`, [id, memberId]).changes > 0;
}

export function recordCheck(memberId: string, id: string, state: "ok" | "error", error: string | null): void {
  db.run(
    `UPDATE mail_accounts SET state = ?, last_error = ?, checked_at = datetime('now') WHERE id = ? AND member_id = ?`,
    [state, error, id, memberId],
  );
}

/** What the `email` tool needs to connect: every field, the password in
 *  clear. Only the loopback route calls this. An account whose secret no
 *  longer opens (the key changed) comes back without one and says so. */
export function accountsForTool(memberId: string): Array<Record<string, unknown>> {
  const rows = db
    .query(`SELECT id, address, name, provider, host, port, security, username, secret FROM mail_accounts
            WHERE member_id = ? ORDER BY created_at, address`)
    .all(memberId) as Array<MailAccount & { secret: string }>;
  return rows.map(({ secret, ...row }) => {
    const out: Record<string, unknown> = { ...row };
    for (const k of Object.keys(out)) if (out[k] === null) delete out[k];
    try {
      out.password = decryptSecret(secret);
    } catch {
      out.password_error = "the stored password cannot be read with this household's key; enter it again";
    }
    return out;
  });
}

// ── the check, through the tool ─────────────────────────────────────────

export interface CheckResult {
  state: "ok" | "error";
  error: string | null;
}

export type Checker = (memberId: string, address: string) => Promise<CheckResult>;

/** Ask the `email` tool to log in, as the member, and read back this address. */
const gatewayChecker: Checker = async (memberId, address) => {
  let text: string;
  try {
    const session = await McpSession.open(memberId);
    const result = await session.callTool("email__list_accounts", {});
    text = result.text;
  } catch (err) {
    return { state: "error", error: `the mail tool could not be reached: ${(err as Error).message}` };
  }
  let payload: any;
  try {
    payload = JSON.parse(text);
  } catch {
    return { state: "error", error: text.slice(0, 300) };
  }
  if (payload?.error) return { state: "error", error: String(payload.error) };
  const entry = (payload?.accounts ?? []).find((a: any) => String(a.address).toLowerCase() === address);
  if (!entry) return { state: "error", error: "the mail tool does not see this account" };
  if (entry.state === "ok") return { state: "ok", error: null };
  return { state: "error", error: String(entry.error ?? entry.state) };
};

let checker: Checker = gatewayChecker;

/** Tests only: replace the IMAP round trip. */
export function setChecker(fn: Checker | null): void {
  checker = fn ?? gatewayChecker;
}

export async function checkMailAccount(memberId: string, id: string): Promise<MailAccount> {
  const account = getMailAccount(memberId, id);
  if (!account) throw new MailAccountError("no such account", 404);
  const result = await checker(memberId, account.address);
  recordCheck(memberId, id, result.state, result.error);
  return getMailAccount(memberId, id)!;
}
