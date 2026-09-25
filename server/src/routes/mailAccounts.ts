import { Hono } from "hono";
import { requireAuth } from "../middleware/auth";
import {
  MailAccountError,
  checkMailAccount,
  createMailAccount,
  deleteMailAccount,
  listMailAccounts,
  replacePassword,
  restoreSecret,
  type MailAccount,
} from "../services/mailAccounts";

// The signed-in member's own mail accounts (services/mailAccounts.ts). Every
// route acts on the caller's accounts only; another member's account is not
// found rather than refused. The password goes in and never comes back out.
//
// Adding an account, or changing its password, logs in before answering: a
// password that does not open the mailbox is not kept, and the reason the
// server gave is returned — "Authentication Failed" is what a wrong or revoked
// app password looks like, and the member should see it now, not in a
// conversation next week.

const accounts = new Hono();

accounts.use("/*", requireAuth);

const view = (a: MailAccount) => ({
  id: a.id,
  address: a.address,
  name: a.name,
  provider: a.provider,
  host: a.host,
  port: a.port,
  security: a.security,
  username: a.username,
  state: a.state,
  last_error: a.last_error,
  checked_at: a.checked_at,
  created_at: a.created_at,
});

function fail(c: any, err: unknown) {
  if (err instanceof MailAccountError) return c.json({ error: err.message }, err.status);
  throw err;
}

accounts.get("/", (c) => c.json({ accounts: listMailAccounts(c.get("userId")).map(view) }));

/** Add a mailbox: `{ address, password }`, plus `provider` for a Google
 *  Workspace domain, or `host` (`port`, `security`, `username`) for a server
 *  the address's domain does not name. 201 once the login worked; 422 with
 *  the server's reason when it did not, and nothing is kept. */
accounts.post("/", async (c) => {
  const uid = c.get("userId");
  const body = await c.req.json().catch(() => ({}));
  let created: MailAccount;
  try {
    created = createMailAccount(uid, body);
  } catch (err) {
    return fail(c, err);
  }
  const checked = await checkMailAccount(uid, created.id);
  if (checked.state !== "ok") {
    deleteMailAccount(uid, created.id);
    return c.json({ error: checked.last_error ?? "the mailbox refused the login", detail: checked.last_error }, 422);
  }
  return c.json(view(checked), 201);
});

/** A new password — after the old app password was revoked. Checked the same
 *  way; a password that does not work leaves the previous one in place. */
accounts.put("/:id/password", async (c) => {
  const uid = c.get("userId");
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  let previous: string;
  try {
    previous = replacePassword(uid, id, body?.password);
  } catch (err) {
    return fail(c, err);
  }
  const checked = await checkMailAccount(uid, id);
  if (checked.state !== "ok") {
    restoreSecret(uid, id, previous);
    await checkMailAccount(uid, id);
    return c.json({ error: checked.last_error ?? "the mailbox refused the login", detail: checked.last_error }, 422);
  }
  return c.json(view(checked));
});

/** Log in again and record the result — "is it still working?" */
accounts.post("/:id/check", async (c) => {
  try {
    return c.json(view(await checkMailAccount(c.get("userId"), c.req.param("id"))));
  } catch (err) {
    return fail(c, err);
  }
});

/** Forget the account and its password. Maurice stops reading that mailbox
 *  on the next call; revoking the app password at the provider is the
 *  member's own belt and braces. */
accounts.delete("/:id", (c) => {
  return deleteMailAccount(c.get("userId"), c.req.param("id")) ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
});

export default accounts;
