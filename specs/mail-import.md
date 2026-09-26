# Making a large mailbox useful — design, lots 1 to 5 built

A member arrives with years of mail. What should Maurice do with it?

Designed 25–26 September 2026 around Aline's mailbox, and settled in
conversation with Candide. Lot 1 (the job, the cursor, the header store), its
wiring to the night and to the account's creation, and lot 2 (the triage, the
report, the reconciliation, the calibration, the conversation with the
numbers) were built on 26 September, lot 3 (the approval — `job_id` on the
ledger, the member's yes) the same evening, lot 4 (the two reading passes)
right after, and lot 5 (the documents) in the night that followed. What is
left is in *Still open*.
Numbers are measured where they say so and estimated where they say that
instead.

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

## Telling the member before reading — and not about money

1. Envelope pass — free, minutes.
2. Triage on headers — free or near enough.
3. Calibrate bytes → tokens on ~100 real bodies. Do not guess it.
4. Price from `services/pricing.ts` — **for the operator**: the log, the
   ledger, later the console. Never for the member.
5. Ask the member — for consent to read, not for a purchase.

> 47 200 messages in all, 41 000 of them newsletters and notifications. Over
> the last three years I count 4 100 real exchanges. I can read them, over
> two or three nights, and tell you who matters to you and what is going on.
> Shall I read them?

**No money in front of a member** (Candide, 26 September 2026, after reading
the first real opening, which quoted "between 0.02 € and 0.87 €"): spending
is abstract to a member — tokens, euros per million — and every app spares
them the subject by setting a ceiling so high it never shows. The only
ceiling is the household's, `spend_cap_system_daily`, the operator's
business and invisible to members. **No per-job or per-night cap, no range
in the message, no "it turned out to cost more".** The range still exists
(`readingCost` in `services/mailOpener.ts`) and is written to the log when
the conversation opens; it is the operator's view of the reading, kept apart
from chat spend by `job_id` on the ledger (lot 3).

### Metering

`spend_ledger` is `(at, provider, model, cost_usd, user_id)` — `cost_usd` holds
euros, historically misnamed. It had **no job dimension**, so an import would
have drowned chat spend in the same table and made "what did I spend this
month" meaningless. *Built, 26 September 2026 (lot 3):* `job_id TEXT`,
indexed with `at`; `recordSpend(usage, spender, jobId?)`; `spentOnJob(jobId)`
for the console and for lot 4. A chat turn leaves it null; nothing existing
changed. The job is the tool's row (the `reading` job in the member's store,
below), never one of `maurice.db`'s: only its id crosses over, on every
ledger row the reading writes.

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
the process outright against the real Gmail.

**The wiring.** *Built, 26 September 2026* (`server/src/services/mailScan.ts`,
the routes in `routes/mailAccounts.ts`, the card in the app's Settings → Mail).
Settled with Candide the same day: the free header pass runs **unasked** — it
costs nothing, reads no body, writes only the member's own file. It starts as
soon as a mail account is created (after the login check in
`POST /api/mail-accounts`, fire-and-forget through the member's gateway
session), goes on at the 03:00 rendezvous (the corpus's shape: start, then
poll `scan_status` until `running` is false; `mail-nightly.json`,
`MAURICE_MAIL_NIGHTLY=off`), and on demand (`scan_mailbox`, or the button
under *Settings → Mail*, which reads `GET /api/mail-accounts/scan` and
restarts with `POST …/scan`). While it runs, only that card speaks.

**Lot 2 — the triage and the free report.** *Built, 26 September 2026*
(`tools/email/triage.py`, `reconcile.py`, `calibrate.py`; MCP tools
`triage_mailbox`, `mailbox_report`, `reconcile_mailbox`, `calibrate_reading`,
`estimate_reading`; CLI `triage`, `report`, `reconcile`, `calibrate`,
`estimate`). Bulk vs correspondence from headers alone, kept in a `triage`
table with the reason and recomputable: `List-Id`, `List-Unsubscribe`,
`Precedence: bulk|list|junk` and a no-reply address make **bulk**; a sender
the member has written to (in the To/Cc of a message whose From is the
member), one of their contacts, or the member themself make
**correspondence**, and the person wins over the mark; what has neither is
**other**. The contacts are a list the caller passes, empty for now (below).
The report — who writes, what fills the box (by messages and by bytes),
which threads are alive (three messages, one in the last ninety days, the
subject unsealed for those alone), who never got an answer — is
`mailbox_report`, a deliverable apart from the first message. The
**reconciliation** relists every walked folder's UIDs (`UID SEARCH` in
windows, no FETCH — seconds on 164 000 messages), drops the locations of UIDs
gone and of folders that left LIST, resets a renumbered folder for the next
walk, and marks a message left without a location `gone_at` (its row stays;
seen again, the mark goes); it is a job of kind `reconcile`, never at the
same time as a walk on the same store, and a stop mid-listing removes
nothing. The **calibration** samples a hundred bodies of the reading window
(`BODY.PEEK[TEXT]<0.16000>` on the header FETCH, nothing kept, nothing marked
read), counts them with `tiktoken` — *a proxy* for Mistral's tokenizer,
within ten to twenty percent, said in the output — and keeps one row of
ratios; **the estimate** turns the counts and the ratio into two token
figures (the light pass on the first 600 characters, a full reading of every
body) and a number of nights from a stated capacity (1 500 messages a night,
an assumption until lot 4 measures it). The tool never prices: the server
does, from `pricing.ts`. On the owner's Gmail on the day: 164 194 messages —
134 488 bulk, 19 825 correspondence, 9 881 other; 2 131 in the last three
years, 466 of them to read; 18.9 tokens per kB on the wire, 139 tokens in a
preview.

**The conversation Maurice opens** (settled 26 September 2026, reshaped the
same evening; `services/mailOpener.ts`). Opened **late** — only when the walk
is done — and short: what the box holds (messages in all, how many of them
newsletters and notifications), how many real exchanges the last three years
hold, what reading them gives ("who matters to you and what is going on")
and the nights in words ("three or four nights", never "tomorrow morning"),
and the question "shall I read them? yes or no". **No money** (above). No top
senders, no unanswered threads. Rendered by the server in the member's
language, no model. Once per member, and **past the opening guard**
(`force`): a mailbox walked is worth the exception, and the numbers wait for
nobody's fifteen days. The night runs the chain after a walk that is done:
reconcile (weekly, per member), triage, calibrate, estimate, open — recorded
in `mail-nightly.json`, the cost range in the log. The "yes" itself is lot 3.

**Lot 3 — the approval.** *Built, 26 September 2026, on decisions of the
same day.* `job_id` on `spend_ledger` first (see *Metering*), then the
member's yes — a **consent** to read, nothing about money, no ceiling per
job: the household's cap is the only one and it is invisible. The yes is
given **in the conversation Maurice opened**, by one native tool granted by
that conversation and nowhere else, on the exact model of `domains__adopt`
(`server/src/services/mailApproval.ts`): `mail__approve_reading`, `action`
`approve` | `decline`, in the roster only when the turn's conversation is
the member's mail one — the link is `mail_conversations` in `maurice.db`
(member → conversation, written when the night opens it, backfilled from
`mail-nightly.json` at boot, and mirroring the reading's state so the prompt
knows it without a gateway call). The prompt section says the domains'
rule — never on a hint, an "ok" to something else, or the model's own
judgement; an explicit yes only — and, after a no, never to ask again (the
member may still say yes later, here or in the app). The tool calls the
`email` tool as the member: `approve_reading` / `decline_reading` (service,
MCP, CLI `approve-reading` / `decline-reading`) create or re-mark **one**
`reading` job per member (`tools/email/reading.py`; states `approved` |
`declined` added to `JOB_STATES`; `budget_eur` NULL; the window in `cursor`
as `{"years": N}`), which `scan_status` reports under `reading`. Those two
MCP tools are the server's alone (`isServerOnlyTool`, like the corpus's
admin tools): never in a model's roster. The second door is the card under
*Settings → Mail* — "Reading: not asked yet / waiting for your answer /
approved on … / declined", one button to approve or withdraw — on
`POST /api/mail-accounts/reading {action}`, after which Maurice says in the
conversation, in his voice and rendered by the server in the member's
language, what was done ("Understood: I will read them, from the next night
on, and come back here with what I understood"). **What the yes triggers:
nothing that costs.** It leaves the job `approved` for lot 4; Maurice
answers that the reading happens at night, starting the next one, and that
he will come back with what he understood.

**Lot 4 — the two reading passes.** *Built, 26 September 2026, late
evening.* Settled with Candide first: **the server reads, the tool
provides** — the tool has no model and no ledger, the server has both and
already runs the night; and **the full reading leaves one sealed reading
per message** in the store (`readings`, a JSON under the household key like
the subject: derived from the body, never the body), so lot 5 aggregates
without reading the bodies again. Four more server-only words on the
`email` tool (`tools/email/reading.py`): `reading_next` (`stage` `light`:
the next messages of the window not yet judged, newest first, with headers,
the subject unsealed in transit, and the first 600 characters; `full`: the
kept ones not yet read, with the first 16 kB of text — `BODY.PEEK` in one
FETCH per folder, nothing stored, nothing marked read), `reading_record`
(the verdicts, and the readings sealed before the disk; the job's counts
move), `reading_control` (`running` / `paused` / `done` / `failed`, the
reason, and the run's measure kept in `capacity`) and `reading_progress`.
The server (`services/mailReading.ts`, `runMailReading`): the **light
pass** on `mail_read_light` — mistral-small, a new invocation with that
preference, pinned at boot like the night's — in batches of twenty,
answering `{verdicts: [{id, keep, reason}]}`, a missing verdict kept rather
than lost; the **full pass** on `mail_read_full` — a new invocation whose
computed default is the household's everyday model, the one the range was
priced on — one call per kept message, answering one structured reading
(summary, kind, people, said, promised, decided, asked, dates, open,
thread) in the member's language, stamped with the model and whether the
text was cut. Every call is checked against the household's cap before it
is made (a refusal pauses the job, it does not fail it) and recorded after
it **as the member, under the job's id**. A run ends `done` when the window
has nothing left, `paused` when a limit, the four-hour night or the cap
stopped it with work left; the next run carries on from the store. A job
`done` is run again when the window holds new mail: the daily case. The
night runs it after the numbers, for every member whose word is yes
(`mail_conversations.reading`, no gateway call to know); the operator runs
it by hand with `POST /api/admin/mail/reading/run {member_id | username,
limit?, wait?}` and reads `GET /api/admin/mail/reading/:member_id`. **The
capacity is measured**: each run of a hundred messages or more leaves
`messages` and `seconds` in `capacity`, and the estimate's nights use the
last runs' messages per hour over a four-hour night instead of the 1 500
assumption (`nights.measured` says which).

**Lot 5 — the documents.** *Built, 26–27 September 2026, on decisions of
the night.* Settled with Candide: the fiches and digests are **notes** in
`notes/<locale>/`, tagged `mail` and `correspondent` or `thread`, under a
hub note "My mail" (a MOC) — the domain seeding's mechanics, `meta.opened:
false`, `meta.author: maurice`, `meta.origin: mail`, the source key and
the message ids in `meta`, a "where it comes from" section that carries
the **disclaimer** on the page ("Part of this note was written by a machine
reading your mail. Every line points to the message it comes from."), the
model, the date, and the list of messages read; **thresholds**: a person
with two read messages or more has a fiche, a thread with two or more a
digest, the rest lives in the fiches; **the pointer**: the model ends every
line with the indices of its sources, the server turns them into a
readable pointer after the line — *(22 Sept 2026, Jean Derély, « Toujours
à Bruxelles ? »)* — and lists the ids in the frontmatter, **a line with no
source is dropped**; `email__get_by_id` (member-facing) reads a message by
that id, so Maurice can check a note against its source in a conversation;
the click in the app is later. **Before the documents, the bodies**: the
full pass now cuts the quoted part of a reply (`strip_quoted`: every `>`
line, and everything from the line that introduces the quoted or forwarded
message, in the house's languages, when some text of the message's own
precedes it) and reads a 48 kB slice instead of 16; `reading_reset` forgets
the readings whose text was cut so the next pass reads them again; the
full-pass prompt no longer lets the model assume the member's gender.
`services/mailDocuments.ts` (`writeMailDocuments`): `reading_material`
(server-only) gives every reading unsealed with its thread root (the
report's grouping); people are grouped on the other party's address
(the sender, or the first recipient who is not the member), threads on the
root; one call per note on `mail_write` (a new invocation preferring the
night's models, as the domain notes); `renderPerson` / `renderThread` keep
only sourced lines; the hub lists every fiche and digest still on disk.
**Second runs** (the "still open" of yesterday, settled): `artefacts` in
the store, keyed on the source — a note thrown away is found missing
once, marked `deleted_at`, and never written again; a note still there is
rewritten only when new messages joined its sources; the hub is refreshed
whenever something was written. On the ledger as the member under the
reading job's id. The night writes after a reading that read something;
by hand, `POST /api/admin/mail/documents/run {member_id | username,
wait?}`. Then **Maurice comes back** in the mail conversation, rendered
without a model in the member's language: how many fiches and digests, the
hub's path, the titles.

Lot 1 and lot 2 answer most of what makes a mailbox opaque, and they are free.
If the project stopped after lot 2 it would still have been worth doing.

## Still open

- **Where the contacts come from.** The triage takes a list of addresses and
  nobody passes one yet: the `contacts` tool is private (vCard, in
  `maurice-tools`) and the public `email` tool cannot import it. A single,
  reconciled list of a member's contacts is a design of its own (Candide,
  26 September 2026); until then only "replied" and "sent" make a person.
- **The tokenizer is a proxy** (`tiktoken`, `o200k_base`), not Mistral's; the
  range absorbs the difference, and the calibration says so.
- **A night's capacity is measured, not assumed, once a run of a hundred
  messages or more has happened** (lot 4): the last five such runs' messages
  per hour, over a four-hour night, kept in `capacity` beside the
  calibration, **never derived from a spend cap** — the household's cap says
  when to stop, not how much a night can do. Until then the estimate says
  1 500 and `measured: false`.
- **A reading the model cannot shape is left to read**, twice per batch and
  then for another night; nothing retries it within a run, and nothing yet
  says how many nights a message may be left before it is skipped for good.
- **A second run is keyed on the source** (settled, lot 5): the person's
  address or the thread's root in `artefacts`; a deleted note is never
  rewritten. What is not done: a refusal after "three refusals" of a person,
  and a member's way to say *no more about this person* other than deleting
  the fiche once (which works, since a deleted fiche stays deleted).
- **The disclaimer marks the document, not its sections**: one line at the
  head of "where it comes from", on every note the pass writes, plus
  `meta.author` and `meta.origin` in the frontmatter. Marking sections would
  only mean something once the member edits a note and keeps Maurice's
  part; nothing tracks that yet.
- **The one-click source in the app** does not exist: the pointer is
  readable, the id is in the frontmatter, and `email__get_by_id` resolves it
  in a conversation.
- **Who is who.** People are keyed on an address: the same person on two
  addresses is two fiches until a contact list exists (above).

## Not in scope

Writing, sending, moving or deleting mail. Sharing anything derived from mail
with another member. Replacing Gmail's search. Life facts produced by an
import.
