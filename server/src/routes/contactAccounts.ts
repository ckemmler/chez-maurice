import { Hono } from "hono";
import { requireAuth } from "../middleware/auth";
import {
  ContactAccountError,
  createContactAccount,
  deleteContactAccount,
  listContactAccounts,
  replaceContactPassword,
  restoreContactSecret,
  syncContactAccount,
  type ContactAccount,
} from "../services/contactAccounts";
import { retriageInBackground } from "../services/mailScan";

// The signed-in member's own address books (services/contactAccounts.ts),
// the mail accounts' twin (routes/mailAccounts.ts): every route acts on the
// caller's accounts only, another member's is not found rather than refused,
// and the password goes in and never comes back out.
//
// Adding an account, or changing its password, reads the address book before
// answering: a login that does not open it is not kept, and the server's
// reason is returned now rather than discovered in a month. Once it is read,
// the member's mail is sorted again with the new addresses, in the
// background — free, headers only — so what the contacts rescue from "bulk"
// is read at the next reading.

const accounts = new Hono();

accounts.use("/*", requireAuth);

const view = (a: ContactAccount) => ({
  id: a.id,
  url: a.url,
  username: a.username,
  name: a.name,
  provider: a.provider,
  state: a.state,
  last_error: a.last_error,
  checked_at: a.checked_at,
  synced_at: a.synced_at,
  cards: a.cards,
  created_at: a.created_at,
});

function fail(c: any, err: unknown) {
  if (err instanceof ContactAccountError) return c.json({ error: err.message }, err.status);
  throw err;
}

accounts.get("/", (c) => c.json({ accounts: listContactAccounts(c.get("userId")).map(view) }));

/** Add an address book: `{ username, password }`, plus `url` for a server
 *  the username's domain does not name (Nextcloud, a company's). 201 once it
 *  was read; 422 with the server's reason when not, and nothing is kept. */
accounts.post("/", async (c) => {
  const uid = c.get("userId");
  const body = await c.req.json().catch(() => ({}));
  let created: ContactAccount;
  try {
    created = createContactAccount(uid, body);
  } catch (err) {
    return fail(c, err);
  }
  const read = await syncContactAccount(uid, created.id);
  if (read.state !== "ok") {
    deleteContactAccount(uid, created.id);
    return c.json({ error: read.last_error ?? "the address book could not be read", detail: read.last_error }, 422);
  }
  retriageInBackground(uid);
  return c.json(view(read), 201);
});

/** A new password. Read the same way; one that does not work leaves the
 *  previous one in place. */
accounts.put("/:id/password", async (c) => {
  const uid = c.get("userId");
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  let previous: string;
  try {
    previous = replaceContactPassword(uid, id, body?.password);
  } catch (err) {
    return fail(c, err);
  }
  const read = await syncContactAccount(uid, id);
  if (read.state !== "ok") {
    restoreContactSecret(uid, id, previous);
    await syncContactAccount(uid, id);
    return c.json({ error: read.last_error ?? "the address book could not be read", detail: read.last_error }, 422);
  }
  retriageInBackground(uid);
  return c.json(view(read));
});

/** Read it again now rather than tonight. */
accounts.post("/:id/sync", async (c) => {
  const uid = c.get("userId");
  try {
    const read = await syncContactAccount(uid, c.req.param("id"));
    if (read.state === "ok") retriageInBackground(uid);
    return c.json(view(read));
  } catch (err) {
    return fail(c, err);
  }
});

/** Forget the account, its password and its cards. */
accounts.delete("/:id", (c) => {
  return deleteContactAccount(c.get("userId"), c.req.param("id")) ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
});

export default accounts;
