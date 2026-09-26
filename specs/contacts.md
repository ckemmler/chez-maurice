# People and mailboxes — design, lot 1 built

Settled with Candide on 26 September 2026, after the first full mail import
(Gmail and Proton, `specs/mail-import.md`, lots 1 to 5). Two refinements of
what that import produces:

1. **Every piece of mail-derived content says which mailbox it came from**, and
   a mailbox can be disconnected, or forgotten with everything derived from it.
2. **A person is a hub.** Their addresses, the member's mailboxes they write
   to, their vCard, and the fragments the garden holds about them, in one
   private fiche — each piece with a status (pending, confirmed, rejected) that
   Maurice respects when he uses it.

Nothing here reopens `mail-import.md`: the headers, the triage, the readings
and their approval stay as built. What changes is lot 5 (the documents) and
what feeds lot 2 (the contacts).

---

## What exists, and what is missing

- **The store already knows the mailbox.** One store per member for all their
  accounts; a message present in two mailboxes (a forward, a copy to oneself)
  is one row. `locations (address, folder, uidvalidity, uid, message)` says
  where each message was seen — the account address is the mailbox.
- **Everything after it forgets.** `reading_material` does not pass the
  mailbox; `artefacts` are keyed `(kind, key)` with a list of message ids; the
  pointer after each line — *(22 Sept 2026, Jean Derély, « … »)* — is text,
  with neither the id nor the mailbox.
- **Removing an account deletes its `mail_accounts` row and nothing else**
  (`services/mailAccounts.ts`): messages, readings and notes stay.
- **There is no status**, only `meta.opened: false` — read, not vetted.
- **People are keyed on one address**, so one person on two addresses is two
  fiches, and a fiche fed by two mailboxes does not say which said what.
- **The contacts** are the private `contacts` tool (Mailfence CardDAV, one
  account in environment variables, read-only); the triage receives an empty
  list.
- **The garden already has people.** `people/<locale>/<slug>-fiche.md` —
  32 of them in Candide's garden, a dozen carrying `carddav_uid` — with
  fragments under `<slug>-fiche/_fragments/NNN.frag` (the garden tool's
  fragment handlers accept a fiche as parent).

---

## 1. The mailbox, everywhere

**A mailbox is its account address** — what `locations` already uses; the
`mail_accounts.id` changes when an account is removed and added again. A
message belongs to a *set* of mailboxes.

- `reading_material` gives each message its `mailboxes` (from `locations`, the
  message not gone).
- **The pointer becomes a link.** The server writes
  `[(22 Sept 2026, Jean Derély, « Toujours à Bruxelles ? » · Gmail)](maurice-mail:<id>)`.
  The label is the account's `name` when set, else a name for its provider,
  else the address. One change, three uses: every line says its mailbox; the
  one-click source (a gap of lot 5) has its target; and the provenance
  travels with the line when the member edits the note or the line moves into
  a fragment.
- Thread digests keep being notes under "My mail", with the same links.

## 2. Disconnect, and forget

**Removing an account disconnects it** (settled): no more walks or readings of
that mailbox; what was derived stays. **"Forget this mailbox"** is a separate
action, with a confirmation:

1. **The store.** The messages seen *only* in that mailbox go, with their
   readings, triage and locations, and the mailbox's cursors. A message also
   seen in another mailbox stays: the member still has it there.
2. **The notes, without a model.** Every line whose linked sources are all
   gone is removed. A pending fragment or digest left with nothing is deleted;
   anything the member confirmed or touched is pruned, never deleted, and a
   line of theirs without a link is never removed.
3. **The history** (settled): kept by default. An unchecked option, "also
   erase it from the history", **prunes every past version the way the
   current one is pruned**: the history is rewritten file by file, and in
   each version of each file the lines whose linked sources all point at
   forgotten messages are removed — the member's own edits stay, the
   mailbox's lines go everywhere. Possible only because every line carries
   its link. Then a force-push, with a warning of what that means (other
   clones keep what they fetched; a write in flight can conflict). A line
   the member rewrote without keeping its link is no longer tied to the
   mailbox and stays. Unchecked is the default because most forgets are
   tidying.

## 3. The person fiche

**A person is their `people` fiche** (settled). A fiche is the private verso
and is never published; the *card* is the recto, the member's prose, the only
thing that can be (`cards-are-candides-voice`: Maurice never writes a card).
A public figure the member investigates and a friend they write to are the
same object; everything the mail brings stays on the verso.

```
people/<locale>/<slug>-fiche.md                 the hub
people/<locale>/<slug>-fiche/_fragments/NNN.frag the fragments
```

**The hub** carries, in its frontmatter:

- `status` — the person: `pending` when born from mail alone, `confirmed`
  when matched to a vCard entry or confirmed by the member, `rejected` (not a
  person worth a fiche; never proposed again).
- `carddav_uid` — as today.
- `identities` — one entry per address: `{address, mailboxes, status, source:
  vcard | mail | guess, conflict?}`.
- `relation` and its status — **who this person is to the member**, once
  (see below).

**Its body** opens with the relation — *"Adriano's music theory teacher"* —
then a short synthesis; the fragments follow.

**The relation is dated** — a start and, when there is one, an end:
*"colleague at Acme, 2021 → March 2026"*. A writing pass that reads a
departure (a last-day mail, a new signature) proposes the end, pending; once
confirmed it is a fact every later pass and every answer reads.

**When a fiche is born** (settled): when there is material — two read
messages, as today, or later a mention elsewhere in the garden. A vCard entry
alone creates nothing; it identifies, and groups a person's addresses the day
they have a fiche. The existing fiches are matched first, on `carddav_uid`.

**Identities** (settled): **the vCard is authoritative, except on conflict**.
An address in the member's vCard is confirmed for that person, unless the mail
contradicts it — the address writes under another name, or it sits in two
vCard entries (a couple's, an office's) — where the link goes back to pending
with the conflict said. A rejected link is recorded and never proposed again.

**Guessed links merge, pending** (settled). Without a vCard to join them,
two addresses are joined when **at least two strong signals** agree — the
same full name and the same signature or phone, or an explicit "my new
address is" — and the address joins the person's fiche as a pending link,
its fragments with it. Weak signals (the same first name, the same domain)
do nothing. Rejecting the link moves that address's fragments back to a
fiche of their own — nothing to rewrite, since every fragment carries its
address. A mistake costs one ✗.

## 4. Fragments

**The mail fiche of lot 5 becomes fragments** (settled): one fragment per
*(address, mailbox)* and per writing pass, under the person's fiche. No
standalone mail fiche any more; "My mail" lists the thread digests and the
people the mail fed.

A fragment's frontmatter extends the garden tool's `summary` with `origin:
mail`, `mailbox`, `address`, `sources` (message ids), `model`, `written_at`,
`status`, and `written_hash` — the hash of the body as Maurice wrote it.

**Fragments tell interactions, never the relation**: what was said, promised,
decided, what is open. The relation lives once, in the hub.

## 5. Statuses

Three levels, each `pending | confirmed | rejected`: **the identity link**
(the one that matters most — a wrong link contaminates everything after it),
**the fragment**, **the person**.

- **Touching confirms** (settled). A body whose hash no longer matches
  `written_hash` was edited by the member — on the fiche's page or in a text
  editor — and is confirmed; so is a relation the member wrote. **What the
  member touched, Maurice never touches again.** New messages from that
  person arrive as new, pending fragments.
- **Only the member confirms** (settled). Maurice can correct a fiche in a
  conversation when asked (*"she is Adriano's teacher, not mine"*), but an
  edit made through Maurice never confirms: it keeps the member's wording,
  updates `written_hash`, records `edited_by: maurice`, and stays pending.
  The footer then shows it — *"corrected at your request, to confirm"* —
  with a ✓ that confirms in one click. A model's edit, asked for or taken
  on its own initiative, never turns into a confirmation.
- **The relation is a fact for every later pass** (settled). Every writing
  pass for a person receives the confirmed relation as established and does
  not redefine it.
- **Correcting the relation rewrites the pending fragments** of that person
  with the correction (settled): they are Maurice's until confirmed. Confirmed
  or touched fragments are never rewritten. One small writing pass, for that
  person alone.
- **A rejected fragment** is deleted and recorded as a deleted artefact, as a
  thrown-away note is today, so it is not written again.
- **The gestures** (settled), on the fiche's page: per fragment, relation
  or person **✓ confirm, ✗ reject, ✎ correct in place** (saving confirms);
  per identity link ✓ and ✗; "confirm all" at the head of the fiche. And by
  conversation, as above.
- No queue, no quota. This keeps the principle of
  `mail-import.md`: the draft is the approval mechanism. Pending is a normal
  state, not a debt.

## 6. Maurice uses pending data, and says so

Maurice may use what is pending. **The warning is deterministic** (settled):
everything pending that enters the turn is marked, the server collects the
marks over the turn and appends, rendered without a model, an **"À vérifier"
footer** — one line per pending item (the fragment's summary and its
mailbox, the identity link, the relation), each linking to the fiche,
anchored on the element. The model sees the same marks on what it reads and
is told to hedge in its prose, but the warning does not depend on it. The
footer lists what entered the turn, not what the answer *used*: one warning
too many rather than one missing. Built on the same principle as the
`tool_data` card channel.

- **Every path in** (settled): the garden tools (a fiche, its fragments),
  **the corpus search** (fragments are indexed; this is the path by which a
  fragment most often arrives unasked), and the composer (a fiche the member
  put in context has not had each fragment vetted).
- **Grouped by fiche beyond three items**: *"Mme X — 7 items to check"*,
  one link.
- **The link** (settled): the fiche's private page in the signed-in web
  garden, `/g/<member>/<locale>/fiches/people/<slug>#<element>`, which
  exists today and is members-only. The day the app has a native fiche
  view, it takes these links over (universal links); the links written in
  past conversations never change.

## 6 bis. The person beside a corpus hit

A year-old note about a feature says a colleague works at the client's; he
left since. The note is the member's own word — confirmed, and right when it
was written — so no status warns about it. What the note needs is the
person's dated relation beside it.

**The server attaches it, without a model** (settled): when a corpus hit
mentions a person who has a fiche — a `[[link]]` to it, or the fiche's full
name or one of its aliases; a first name alone is never enough — one line
rides with the hit: *"Jean Dupont — colleague at Acme, 2021 → March 2026
(confirmed)"*. A pending relation attached that way enters the footer too.

## 7. Where the contacts come from

**A CardDAV account per member in Settings** (settled), like the mail
accounts: the secret sealed under the household's key, read every night
before the triage, public — every member has it. Covers Mailfence, iCloud,
Fastmail, Nextcloud; Google with an app password. The addresses feed the
triage (`classify` already ranks a contact before the bulk markers); the
entries feed the identities. The device's address book (the app reading iOS
or macOS Contacts) is later, a project of its own.

**Contacts before the triage, better but not required.** The triage reads a
contact before the bulk markers, so a contact writing through a mailing tool
(a newsletter, an association, an accountant's CRM, a noreply address) is
rescued instead of left unread. And the writing groups a person's addresses
before it writes — no two fiches to merge later, no "not a person" refusal
for someone in the member's vCard. Afterwards costs a free triage, a paid
reading of what it rescues, and rewrites.

## 8. Candide's import, again

Settled: **erase the documents only** — the mail notes, "My mail", the
`artefacts` rows. Keep the headers, the triage and the readings: they are
what cost, and nothing here makes them wrong. Once the contacts and the fiche
model are in: triage again with the contacts, read what it rescues, write the
new documents.

---

## Lots

1. **The mailbox everywhere.** *Built 26 September 2026.* `mailboxes` in
   `reading_material`, the pointer as a `maurice-mail:` link with the
   mailbox's label, the digests with it, the count per mailbox in "where it
   comes from", `meta.mailboxes`. Nothing opens the link yet.
2. **Contact accounts.** CardDAV per member (route, sealed secret, Settings
   pane), the nightly read, the addresses into the triage.
3. **Person fiches.** The hub, identities, relation, fragments per
   *(address, mailbox)*, statuses, `written_hash`, the relation given to the
   writer, the rewrite on correction. Erase Candide's documents, triage, read
   what is rescued, write.
4. **The footer and the page.** Pending marks on every path in (garden
   tools, corpus, composer), the per-turn collection, the rendered block;
   the fiche's page rendering fragments, statuses and mailboxes, with the
   gestures; corrections by conversation (pending, ✓ in the footer).
5. **The person beside a hit.** Dated relations; matching a hit to a fiche
   by link, full name or alias; the attached line.
6. **Forget a mailbox.** The purge, the pruning, the history option (every
   past version pruned).
7. **Stitching.** Guessed links merged on two strong signals, the split on
   rejection, fragments from the rest of the garden.

## Still open

- **Aliases**: where a person's names come from (the vCard's `FN` and
  `NICKNAME`, the display names seen in `From`, the member's corrections),
  and how many a fiche keeps before matching gets noisy.
- **Universal links**: the `apple-app-site-association` file and the native
  fiche view are a project of the app's, after lot 4.
- **Fragments from the rest of the garden** (lot 7): what makes a note, a
  thread digest or a conversation contribute a fragment to a person, rather
  than a link.
