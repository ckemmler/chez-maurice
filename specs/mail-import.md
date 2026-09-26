# Making a large mailbox useful — design, lot 1 built

A member arrives with years of mail. What should Maurice do with it?

Designed 25–26 September 2026 around Aline's mailbox, and settled in
conversation with Candide. Lot 1 (the job, the cursor, the header store) was
built on 26 September; everything from lot 2 on is design. Numbers are
measured where they say so and estimated where they say that instead.

---

## The distinction everything rests on

"Exploiting a mailbox" hides two different jobs:

1. **Finding a message.** *The mail with the quote in it.*
2. **Knowing things.** *Who matters, what recurs, what was promised to whom.*

Gmail already does the first extremely well — free, incremental, always
current, and already exposed by the `email` tool (`X-GM-RAW` on Gmail, IMAP
SEARCH elsewhere). Rebuilding it locally buys nothing.

**This design is about the second job only. Knowing, not finding.**

---

## What the import produces — and what it does not

**It produces documents.** Fiches and thread digests, written as drafts in the
member's own garden.

**It does not produce life facts.** Settled 26 September: facts accumulate only
through conversation, at the pace of being talked to. An import that dumped
hundreds of one-line claims into a review queue would produce a chore, not
knowledge — and the whole drip-feed, ranking and "show me more" machinery
sketched for it on the 25th is deleted along with the idea. Facts are a
conversational mechanism and stay one. See *Facts in a room* below for the one
change Candide does want there, which is unrelated to the import.

This is what makes the rest simple. There is no approval queue, no quota, no
pacing: **the garden is private by default** —

```ts
export const isDraft = (d) => !hasFlag(d, "public");
```

— so a draft fiche in one's own garden is not a claim Maurice makes to anyone.
It is a working document the member edits or deletes. The draft *is* the
approval mechanism. (An earlier version of this spec said the garden was
"publishable by construction". That was a misreading, and the reason a whole
section of machinery existed.)

---

## The pipeline, end to end

1. **Every header, over the whole mailbox.** Free, minutes. Store the *parsed
   fields* — from, to, cc, subject, date, message-id, list-id, references — not
   the raw headers: a header block with its `Received` chain is 2–4 kB, so
   100 k messages would be 300 MB where the fields are 30 MB.
2. **Triage on headers alone.** Free. `List-Id` / `List-Unsubscribe` /
   `Precedence: bulk` on one side, a sender in the contacts or one the member
   has answered on the other. This is what takes 47 000 down to ~12 400.
3. **A light model on the survivors only** — the first ~600 characters of each,
   not all 47 000 and not 200 characters (200 is often still the greeting).
   Survivors of step 2 only: the difference is 0.30 € against 1.15 €.
   *The primitive already exists*: `BODY.PEEK[TEXT]<0.n>` rides on the header
   FETCH, so those 600 characters cost no extra round trip — this is the
   preview merged on 25 September.
4. **A larger model reads what survives** and writes the documents: a fiche per
   person who matters, and a digest per subject.
5. **Nothing of the bodies is kept.** Only the documents and the parsed headers.

Wrapped around all of it: the quote before spending, the member's approval, the
03:00 pass, the cursor that resumes. Those are the next sections.

## The layers, and which one costs

| layer | API cost | real cost |
|---|---|---|
| envelopes (headers only) | **0 €** | minutes, ~30 MB for 100 k messages |
| bulk / correspondence triage | **0 €** header-only | minutes |
| ~~FTS5 over bodies~~ | — | **dropped, see below** |
| embeddings | 0 € on Ollama, **paid** without | hours of CPU |
| **distillation into documents** | **the only real euro cost** | ∝ messages actually read |

**Bodies are never stored.** Sealing the mailbox password under the household
key and then leaving 400 MB of mail bodies in clear beside it would be
encrypting the lock and leaving the door open — and for a hosted household
(Aline's, on Scaleway) the disk is not even the member's. So: no body store, no
FTS5. The cost is losing local exact search, which is the job we already said
not to rebuild.

**The header store is still sensitive, and is sealed accordingly.** The subject
line lives in the header, and `Audience du 14 mars — garde alternée` is a
subject: 30 MB rather than 400, but the table of contents of Aline's file.
Settled 26 September:

- **The subject is sealed** under the household key (AES-256-GCM, the mechanism
  `services/mailAccounts.ts` already uses for passwords).
- **The structural fields stay in clear and indexed** — from, to, cc, date,
  message-id, list-id, references. Everything relational and statistical (who
  writes, how often, which threads, who was never answered) reads only those,
  so it stays fast.
- **Volume encryption on the hosted side, as well as this, not instead.** It
  protects a decommissioned disk; the provider holds that key, so it does not
  protect against the provider.

What this costs: no SQL predicate and no FTS index on subjects, so a later
"who wrote to me about X" is a decrypt-and-scan rather than an index lookup —
about a second over 100 k rows, which is acceptable at this size. The triage
does not notice at all: it sees each message once, in sequence, as it arrives.

What it does **not** buy, and the spec should not pretend otherwise: protection
against someone holding the running server. The threat model of the existing
mechanism is stated in its own comment — *a copy of `maurice.db` without the
key carries no usable password* — i.e. a backup, a snapshot, a support dump. A
system that works while the member sleeps must be able to read their data while
they sleep; the 03:00 pass has nobody in front of it, so the key must be
reachable by the server alone. That is the price of nightly automation, not a
flaw to engineer away. And `from` / `to` in clear already say a great deal: that
Aline corresponds with a juvenile-law solicitor is most of the story, subjects
or no subjects.

**A household without Ollama pays for embeddings too.** The corpus config
anticipates this (`qwen3-embedding-8b` on Scaleway). It is a line in the quote
and it is easy to forget.

### Where the money actually goes

Measured prices per million input tokens: mistral-small **0.15 €**,
gemma-4-26b 0.25 €, deepseek-flash 0.40 €, mistral-medium ≈ 0.35 €.

Worked on 12 400 correspondence messages:

- everything through mistral-medium, whole bodies → **≈ 8.60 €**
- triage through mistral-small, headers + first ~150 tokens → **≈ 0.30 €**
- then full reading of the ~800 the triage kept → **≈ 0.60 €**

Roughly nine times cheaper — but note *why*. The cheap model is only a factor
of two. **The factor of thirteen is not sending whole bodies to anything.**
Choosing a cheaper model without shrinking what it reads gets almost none of
this.

### How much history

**Envelopes over everything, reading over the recent.** The envelope pass is
free, so it covers the whole mailbox: some things are only visible in the long
run ("this friendship is twenty-two years old"). The paid reading starts at
about three years and extends on request — the cursor makes a deeper run the
same job with an older starting point, nothing to rewrite.

---

## The job

An import is an object, not a script. It must survive a restart, a sleeping
machine, a dropped connection, a Gmail throttle, and the member saying stop.

```
jobs(
  id, member_id, kind,
  state,                -- estimating | awaiting_approval | running
                        -- | paused | done | failed
  budget_eur, spent_eur,
  cursor,               -- JSON, per (account, folder)
  counts,               -- JSON: seen / read / skipped / failed
  bytes_fetched, seconds_spent,
  last_error, created_at, updated_at
)
```

**The cursor** is `{uidvalidity, highest_uid_done}` per (account, folder) —
on Gmail too, over the UIDs of "All Mail": IMAP cannot resume "after this
X-GM-MSGID". The X-GM-MSGID is the message's *identity*, stable across moves
and relabels as a UID is not, and identity and cursor are two different
things.

**Identity never depends on the folder** (settled 26 September, with the
member's coming reorganisation of their folders in mind). In order: X-GM-MSGID
on Gmail; EMAILID (RFC 8474) where the server announces OBJECTID; else a
fingerprint of the normalised Message-ID + From + Date; and without a
Message-ID, one of Date + From + To + Subject. A folder, with its uidvalidity
and uid, is a *location* attached to the message, in its own table: a message
moved or a folder renamed is read again without a duplicate — it gains a
location. A changed UIDVALIDITY resets that folder's cursor and purges its
old-generation locations in the same transaction.

**Idempotence instead of exactly-once.** The unit key is the stable message
identity and every write is `INSERT OR REPLACE`, so replaying a batch after a
crash is harmless. Checkpoint every ~500 messages and restart from the last
one. No journal, no distributed transaction.

**`UIDVALIDITY` must be handled explicitly.** If it changes the folder was
renumbered and its cursor is void — rescan it. Skip this and mail is silently
dropped, which is the bug nobody ever sees.

**Where it all lives** (settled 26 September): in the `email` tool, in one
SQLite file per member — `<app dir>/mail/<member id>.db` — holding `jobs`,
`cursors`, `messages` and `locations`. The tool is the only writer of that
file and never writes `maurice.db`. The server drives it as it drives the
corpus: one call starts the walk in the background, another reads its status.
The subject is sealed in Python with exactly the mechanism of
`services/mailAccounts.ts` (same key, AES-256-GCM, `v1:` + base64 of IV ‖ tag
‖ body), which brought `cryptography` into the tools' requirements.

**Found on the first real walk:** `UID SEARCH UID 1:*` on a twenty-year Gmail
archive answers more than the megabyte imaplib accepts as one line. The walk
searches in windows of ten thousand UIDs up to the folder's UIDNEXT instead.
Measured over 164 194 messages: about 170 a second over the tunnel, 3 kB of
headers each on the wire, about 1 kB per row stored — 100 000 messages is
roughly 100 MB, three times the 30 MB estimated above, most of it
`References` and the sealed subject.

**The job row is a lease.** Its `updated_at` moves at every batch; a
`running` job with a fresh heartbeat is another walker on the same file (the
CLI beside the gateway) and is joined, one ten minutes old is dead and is
marked `paused`. No pid, no lock file: the store is the only shared thing.

### Where it runs, and why the import is just the first night

The server already holds a nightly rendezvous at 03:00 local
(`services/corpusNightly.ts`): it records its last run so a restart at 03:30
does not redo a run from 03:05, it prints what it cost, and it already works on
hosted households. It lives in the server rather than cron because the
container has no cron and a second process writing the same sqlite files would
be a second writer. Mail joins that list; nothing new to schedule.

There is no separate "import mode". The nightly pass always asks the same
question — *where was I?* — and the first night has years of backlog where
later nights have thirty messages. One code path, exercised daily.

A first pass will likely span several nights. That is what the cursor is for,
but it must be *said*: "three or four nights", not "tomorrow morning".

---

## Telling the member before spending

1. Envelope pass — free, minutes.
2. Triage on headers — free or near enough.
3. Calibrate bytes → tokens on ~100 real bodies. Do not guess it.
4. Price from `services/pricing.ts`.
5. Present a **range**, never a point, with a **hard ceiling** on the job.
   Crossing it stops and asks again. Never "it turned out to cost more".

> 47 200 messages, 12 400 of them real correspondence, 4 100 in the last three
> years. Reading those: **between 0.60 € and 1.10 €**, about two nights.
> Go ahead?

### Metering

`spend_ledger` is `(at, provider, model, cost_usd, user_id)` — `cost_usd` holds
euros, historically misnamed. It has **no job dimension**, so an import would
drown chat spend in the same table and make "what did I spend this month"
meaningless. **Add `job_id` or `kind` before the first import.**

Meter what is not money too: seconds, bytes, messages. On a free local path the
euro cost is zero and the cost to the person is not; presenting a six-hour job
as "free" is a lie of omission.

---

## What lands in the garden

**A claim and a pointer, never a copy.** No mail body is written into a garden
artefact. What is written is a statement with a reference to the message; the
message stays in the mailbox and the pointer resolves through the `email` tool.

### Fiches — the mechanism already designed for this

A correspondent is a fiche. Not a new kind of note: fiches are the garden's
working surface behind every person, and they are drafts until flagged
`public`. Note that the existing `people/` fiches are intellectual portraits of
public figures (`anil-seth-fiche.md`, with a Wikidata id and a body of work); a
correspondent fiche is a relationship, not an œuvre — since when, how often,
which threads are alive, what was promised.

**Every fiche the automatic process touches says so.** A disclaimer, carried in
the frontmatter and rendered on the page: part of this content was written by a
machine reading mail. It is not optional and it does not expire — a member who
comes back to a fiche in two years must not have to remember which parts they
wrote. Ideally it marks *which* sections are generated, not just the document.

This is the same instinct as the rule that Maurice never writes a resource
card's prose: what carries someone's name must be theirs. A fiche may be
generated; it may not pretend not to be.

### Thread digests — a subject

Kept as a first-class object (confirmed 26 September), not folded into the
person fiches. In Aline's file almost everything passes through the father, so
his fiche is nearly the file's chronology already — but a subject can cross
several people (the school, the child psychiatrist, the lawyer), and one fiche
per person scatters what only makes sense together.

Forty messages over two years fold into one note: a dated timeline, the
decisions, the open questions. This is where the real value is — something the
member could not write themselves because it is scattered.

**Every line carries its source and is verifiable in one click.** No synthesis
without a pointer. See the next section for why this is a requirement rather
than a refinement.

### Domains

`lifeFacts.ts` says it already: *"a fact is a line; anything longer is a brief
in disguise, and belongs in a domain."* A large mailbox probably *reveals*
domains the member did not know they had — likely the most surprising output of
the whole exercise.

---

## When the mail is a custody file

Aline's case, and the reason the design cannot be judged on cost alone. An
eleven-year-old son; most of the correspondence concerns disputes with the
father and the juvenile justice system.

**Cost stops being the question.** Perhaps two thousand messages over three
years — cents. The quote machinery above stays correct and stops being
interesting. **What matters is being right.**

**The most valuable artefact and the most dangerous one are the same object.** A
dated timeline of what was said, promised, missed and decided is exactly what a
lawyer asks for and exactly what Aline cannot reconstitute alone. It is also
where a model error costs most: a wrong date, a promise misattributed, "he
refused" where the record says "he did not answer". In a legal file those are
not imprecisions. Hence per-line sourcing, above, as a hard requirement.

**A fiche about the father is the most delicate object in the system** — a third
party, in an adversarial relationship, described by a machine, on a disk in
Paris. **Settled 26 September: it is generated like any other, carrying the
disclaimer.** Draft-by-default and the `encrypted` flag cover the storage; what
makes it defensible is the per-line sourcing, because a claim about a third
party in a legal file must be traceable to the message that founds it. A
disclaimer that excuses prose nobody can check is not a safeguard.

---

## The machine does the record, the person does the meaning

Candide's framing, 26 September, and it resolves a worry this spec had been
answering badly.

The worry was a pile of documents nobody reads. The answer is that it does not
matter whether they are read. **The fiches are not a report to consume, they are
the ground.** They pay off not when they are written but when Aline is talking
and Maurice has something to draw on. The machine makes the *record*; the person
makes the *meaning*, and the meaning is made in conversation, not in reading.

Two consequences:

- **A fiche must be reachable from inside a conversation.** Everything written
  to the garden is embedded into the corpus by the write hook already — but that
  stops being a bonus and becomes the central mechanism.
- **Propose in the heat, decide in the cold.** Candide is right that attention
  peaks mid-conversation; judgement does not. Mid-exchange with a lawyer the
  member is attentive *and* engaged, hurried, perhaps shaken — a poor moment to
  settle what Maurice will know forever. So the proposal must never demand an
  answer on the spot. It is written, it waits, and the decision can be taken
  later and calmly from the facts screen. Both surfaces exist; the point is not
  to turn the prompt into an interruption that wants a click.

## Facts in a room — a separate change Candide wants

Unrelated to the import, recorded here because it came up with it.

Today a life fact cannot be proposed in a multi-user conversation **at all**.
`rememberFactTool()` is only added to the roster when `carriesDomainIndex` is
true, which is only when `countParticipants(conversationId) === 1`. The
exclusion is deliberate: kept facts and domain briefs go in the prompt, and in a
room another participant would read them.

The wish is for facts to accumulate in rooms too, with the keep / dismiss /
correct prompt visible **only to the member concerned**. What that needs:

- **Decouple two permissions now bundled in `carriesDomainIndex`**: *may write a
  fact* (safe in a room — it is attributed to `ctx.memberId`, the member who
  spoke the turn) from *may read my facts and briefs* (not safe in a room).
  Only the first should be granted there.
- **The review surface already satisfies the nuance.** `/api/life-facts` is
  scoped to the caller throughout — "a fact of someone else's is not found
  rather than refused" — and every mutation checks `fact.member_id !== memberId`.
  Nothing to change.
- **The leak to close is the shared turn stream, not the table.** In a room the
  prose and the tool trail are read by every participant, so a fact written
  about member A would be visible to B before A has decided. The tool call must
  not surface in a room's trail, and the system prompt must forbid announcing
  it aloud.

---

## Build order

Nothing below spends a euro until lot 3, and each lot is worth having on its
own.

**Lot 1 — the job and the envelopes.** *Built, 26 September 2026*
(`tools/email/scan.py`, `store.py`, `identity.py`, `sealing.py`; MCP tools
`scan_mailbox`, `scan_status`, `scan_stop`; CLI `scan`). The `jobs` table, the
cursor, the checkpoint, `UIDVALIDITY` handling, and a per-member store of
parsed headers with the subject sealed. Batched `UID FETCH` of headers,
resumable. No model, no cost. Done when a mailbox can be walked end to end,
interrupted at any point, and resumed without loss or duplication — tested
with an exception mid-write and a connection lost mid-FETCH, and by killing
the process outright against the real Gmail. Not wired to the 03:00
rendezvous: whether the free header pass may run unasked, so that Maurice's
first message to a member carries real numbers, or needs a first "yes", is
still to be asked.

**Lot 2 — the triage and the free report.** Bulk vs correspondence from headers
alone, and the deliverable that needs no approval: who writes, what fills the
box, which threads are alive, who was never answered. This is also what
produces the quote — counts, size distribution, and a bytes→tokens calibration
over ~100 sampled bodies.

**Lot 3 — the quote and the approval.** `job_id` on `spend_ledger` first (see
*Metering*), then the range, the hard ceiling, and the member's yes.

**Lot 4 — the two reading passes.** The light model over the first ~600
characters of the survivors, then the larger one over what it keeps.

**Lot 5 — the documents.** Fiches and digests written as drafts, with the
disclaimer and per-line sourcing.

Lot 1 and lot 2 answer most of what makes a mailbox opaque, and they are free.
If the project stopped after lot 2 it would still have been worth doing.

## Still open

- **What happens on a second run.** A fiche or digest already deleted must not
  be silently rewritten the next night. Keying the refusal on the *source* — no
  more artefacts from message X, or from person Y after three refusals — is
  coarse but stable and needs no judgement. Nothing keyed on wording will work:
  a model never phrases the same thing twice.
- **What the disclaimer looks like** in frontmatter and on the rendered page,
  and whether it can honestly mark sections rather than documents.

## Not in scope

Writing, sending, moving or deleting mail. Sharing anything derived from mail
with another member. Replacing Gmail's search. Life facts produced by an
import.
