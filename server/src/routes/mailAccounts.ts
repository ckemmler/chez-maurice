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
import { mailScanStatus, startMailScan, startMailScanInBackground } from "../services/mailScan";
import { decideReading, mailConversationOf, sayReadingDecided, type ReadingAction } from "../services/mailApproval";

// The signed-in member's own mail accounts (services/mailAccounts.ts). Every
// route acts on the caller's accounts only; another member's account is not
// found rather than refused. The password goes in and never comes back out.
//
// Adding an account, or changing its password, logs in before answering: a
// password that does not open the mailbox is not kept, and the reason the
// server gave is returned — "Authentication Failed" is what a wrong or revoked
// app password looks like, and the member should see it now, not in a
// conversation next week.
//
// Once the login worked, the header walk starts on its own (services/
// mailScan.ts): free, no body read, the member's own file only. Settings →
// Mail reads where it is at GET /scan and restarts it at POST /scan.
//
// The member's word on the reading (lot 3, services/mailApproval.ts) has
// its second door here: POST /reading with `action` approves or declines
// without the conversation, and Maurice says in that conversation what was
// done. A consent, nothing about money; the household's cap is the only
// ceiling and it is not this route's business.

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
  startMailScanInBackground(uid);
  return c.json(view(checked), 201);
});

/** Where the header walk is: its state, the counts of the current or last
 *  job, what the store holds — `state: "none"` for a member without mail. */
accounts.get("/scan", async (c) => c.json(await mailScanStatus(c.get("userId"))));

/** Start the walk again — after a pause, or to pick up new mail now rather
 *  than tonight. A walk already going is joined, not doubled. */
accounts.post("/scan", async (c) => c.json(await startMailScan(c.get("userId"))));

/** The member's word on the reading, from the card: `{ action: "approve" |
 *  "decline" }`. Records it in their store through the tool, mirrors it,
 *  says it in the mail conversation in Maurice's voice, and answers with
 *  the walk's view (its `reading` now current). 422 when the tool refuses. */
accounts.post("/reading", async (c) => {
  const uid = c.get("userId");
  const body = await c.req.json().catch(() => ({}));
  const action = body?.action;
  if (action !== "approve" && action !== "decline") return c.json({ error: "action must be approve or decline" }, 400);
  try {
    const d = await decideReading(uid, action as ReadingAction);
    // Said once: a second identical word changes nothing and says nothing.
    const said = d.already ? null : sayReadingDecided(uid, action as ReadingAction);
    const view = await mailScanStatus(uid);
    return c.json({ ...view, decision: { ...d, said, conversation_id: mailConversationOf(uid)?.conversation_id ?? null } });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 422);
  }
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
