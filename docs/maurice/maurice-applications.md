---
title: Applications, plugins, and the case of the mail
date: '2026-09-25'
flags: []
locale: en
description: 'How a personal application like mail triage attaches to the Maurice
  story: what is generic, what is Candide''s, and the open design questions —
  client-side inference, onboarding, and what sovereignty actually means for email.'
tags:
- maurice
- documentation
- product
- strategy
- mail
icon: puzzle
parent: maurice-docs
---

# Applications, plugins, and the case of the mail

**Status: a parked thread, 17 September 2026.** The mail tool works and is in
daily use — see [[maurice-tools]] for the mechanism. What follows is the product
thinking around it, written down so it can be picked up later. Nothing here is
decided. The priority is the demo fleet; this waits.

**25 September 2026: the split is made, the other way round.** Rather than
extract the example from `mail`, a new public tool, `email`, was written beside
it: read-only access to a member's own mailboxes, any provider, an account
being an address and a password. `mail` stays private and unchanged — it is the
application (Candide's method); `email` is the access anyone can share. The
triage can later be rebuilt on top of it. See [[maurice-tools]]. One correction
to what follows: Gmail's reduced scopes (read-only, modify-without-send) exist
only for the Gmail API, and are as restricted as full access; over IMAP a
credential always opens everything, so the honest claim is "the tool has no
way to send", not "the credential cannot".

## The question

Maurice is a generic tool with many possible applications. Its author applies
several of them to his own life, usually in an experimental register. Maurice
has to be protected from that — the product cannot read as a pile of personal
experiments — without giving up the ability to talk about these capabilities, or
to share the code.

Mail triage forces the question, because it is the first of these applications
that is unambiguously *good*: it ran against a real 3509-message mailbox and
emptied it, and it makes the sovereignty argument better than anything else in
the system. It is exactly the kind of thing one would not hand to a foreign
provider.

## "Plugin" hides two different questions

The word conflates a **maturity** status — experimental, not yet supported — and
an **architectural** one — extension rather than core. Mail does not sit in the
same place on the two axes.

Architecturally it is an extension and has no business in the core. In maturity
it is no longer experimental: 4697 write operations against a real mailbox, ten
refusals, all of them correct. Filing it alongside the health or tracks
experiments would lend it an uncertainty it no longer carries — and would weaken
the very argument it is meant to carry.

That is the risk of the word: if mail is the best demonstration of sovereignty,
announcing it as peripheral tells the reader they may ignore it.

## The genuinely generic part is not about email

One thing deserves extracting before any talk of plugins, because it has nothing
to do with mail. A tool that touches the intimate was built to a pattern:

- a **closed vocabulary** as the containment boundary — the worst a hostile
  message achieves by persuading the model is to misfile itself;
- a **proposal before any write**;
- **deterministic rules before the model**;
- an **audit log** of everything that writes, dry runs included;
- a **failure that announces itself** — "the model is down" must not look like
  "the model hesitated". That ambiguity hid a broken import for a whole run.

This holds for files, photos, documents, tasks. Mail is the first instance, not
the exception. Which gives a sturdier formulation than "Maurice sorts your
mail": *Maurice knows how to delegate to tools that cannot run amok — and mail
is the one that proves it, because it is the only text a stranger has delivered
to you for free.*

The pattern belongs to Maurice. The mail instance is the extension.

## What is Candide's, and has to be faced

The code is already clean here — nothing is hardcoded, it all lives in the TOML.
But the TOML holds far more than parameters.

- The four states (`01 Répondre`, `02 En attente`, `03 À lire`, `04 Auto`) are
  not configuration, they are a **method** — a GTD variant. It assumes one wants
  a system at all. Many people do not, or already have another.
- The ten labels are one life: Copropriété, École, Enfants, Business. Someone
  else has ageing parents, a boat, an association.
- The horizons (120 days, 180 for `to_reply`) encode a particular relationship
  to time.
- `mail.example.toml` is currently the real configuration, addresses included.
  Separating the teaching example from what runs here is the first chore, and it
  gates sharing the code at all.

## The real obstacle for a non-technical user is not the TOML

It is that **someone has to decide the vocabulary**, and that work is hard.

Look at what actually happened on 16 September: the assistant read the sender
histogram, saw 107 New York Times and 102 GitHub, derived the rules from it, and
rewrote the action descriptions — which moved eleven identical messages from
three folders to one, with no code change.

That work is precisely what Maurice should do in conversation. He already has
the means: `stats` gives him the histogram without opening a single message. The
sequence would be:

1. Look at the mailbox and say what is there — who writes, how much, how often.
2. **Discover the existing folders** rather than impose a layout. Someone who
   already has an organisation needs to see it recognised, not replaced.
3. Propose a vocabulary, and the deterministic rules that go with it.
4. Write the descriptions — prose, which a language model is good at, and the
   main quality lever.
5. Show a first proposal as a demonstration: nothing has moved, here is what I
   would do.

Approval happens in conversation. The TOML becomes an implementation detail
nobody opens.

## Sovereignty, stated precisely

For most data, "sovereign" means the copy is hosted in Europe. For mail it is
more binding: **one does not hand over a copy, one hands over the keys**. An
IMAP password opens the whole correspondence, past and future, and depending on
the provider it also permits acting.

This does not condemn anything — it is true of any hosting — but it shifts the
burden of proof, and it turns two design decisions into commercial arguments:

- the tool **can neither send, nor delete, nor move to an arbitrary folder**.
  That is the answer to "what can it do with my keys", not a limitation pending
  something better;
- everything that writes is logged.

Where to be vigilant: prefer credentials with reduced scope where the provider
allows it — Gmail permits read-only or modify-without-send. Being able to say
"our credentials cannot send mail in your name" beats "we undertake not to".

**A path to close by construction.** There is an optional escalation to
Anthropic in the code. It is off by default, opt-in, and every escalated message
says so on its line — well designed for personal use. On an instance sold as
sovereign that is no longer enough: a misplaced environment variable would send
message bodies outside the perimeter. It should be *impossible* there, not
merely disabled — a provider allowlist fixed at deployment rather than a config
key.

## The target, and what it changes

The core target is the **paying user on Scaleway infrastructure**, not the
hobbyist on local Ollama. That user is already reassured on sovereignty by the
hosting, so the inference need not be local, and it becomes fast.

This simplifies a great deal: no Bridge, no loopback, no self-signed
certificate — direct IMAP over TLS on 993. **That path already exists in the
code**; it is the shape of the disabled iCloud account. The target case is the
simpler of the two, the one with no exceptions.

Missing: a provider for the Scaleway endpoint. The server already has the
convention (`OPENAI_STYLE_BASE_URL` / `OPENAI_STYLE_LABEL`, a shared
`/chat/completions` client); the mail tool knows only `ollama` and `anthropic`.
That is the smallest next step, roughly an hour, and it unlocks the measurement
nobody has yet: does a more capable model reduce the inconsistencies?

**Proton becomes the hobbyist case.** Someone who chose Proton has already
accepted friction, Bridge included; they will run locally, Ollama and all, and
manage. Worth stating in the documentation that this is not a degraded
configuration but the other end of the same tool — nothing leaves the machine at
all. Some will prefer it. It simply stops being what gets optimised.

**Rules keep their value, for a different reason.** Fast inference erases the
speed argument (46% of the mailbox with no model call, two hours becoming one).
What remains is **reproducibility**: seven identical eBox notices came back
filed under two different states, four identical LinkedIn digests under two
more. Near-identical prompts do not give identical answers even at temperature
zero, and a faster model will not fix that. A user who sees twin messages land
in two folders stops trusting the whole thing, and is right to. The rules are
not an optimisation; they are what makes the sorting predictable.

## Client-side inference — the idea worth returning to

Run the classification **in the app** (macOS, via Apple Intelligence), with the
server staying on Scaleway for IMAP and storage.

The strongest point is not privacy, it is **structured output**: Apple's
Foundation Models framework guarantees the shape of the answer by construction.
That is exactly our problem — we ask for a value from a closed vocabulary, get
free text, hunt for JSON with a regex, and reject what falls outside the enum.
All that defensive code would disappear. And the task — classify on two axes
against described categories — is what a small model does well, since it needs
neither world knowledge nor reasoning, only reading.

It also permits a claim nobody else makes: *message content is never submitted
to a model running anywhere but the user's own device.*

**With one precision to keep honest:** the server sees the bodies in clear,
since it speaks IMAP. Moving inference to the client protects against the
**model provider**, not the host. Real and significant, but phrased as "your
mail never leaves your device" it is false, and someone will open the hood.
"No model reads them off your device" is accurate and enough.

**The hard problem is availability.** The app must be running. Today's promise
is a 3 a.m. pass with a proposal waiting at breakfast; a closed laptop breaks
it, and on iOS the app is suspended and will never classify 1719 messages. The
catch-up run took two hours of continuous compute — no client app does that.

**The architecture this forces, and it is a good one:** split the work by what
actually needs a model. The server applies the deterministic rules — 46% of the
volume, no inference, works with the app closed. The residue goes into a queue.
The app, when opened, drains what is waiting and returns the decisions. The
server writes.

Three virtues: sorting never stops entirely; the volume reaching the app is half
of what one assumes, and in steady state it is twenty messages a day rather than
two thousand; and the queue keeps the system honest — "34 messages are waiting
for your device" is a sentence one can display, unlike silence.

The initial catch-up stays the hard case: either accept it as several sessions
with a progress bar, or allow it through the server model once, explicitly, the
user choosing knowingly. The second is probably better — a one-off informed
choice rather than a hidden default.

**To verify before committing anything:** the context window. The enriched
descriptions are what made the quality on 16 September, and they are bulky. If
they do not fit in the on-device model, the rest is theory. Short experiment: a
test app, a realistic prompt, an answer within the hour. Also to confirm: that
the path used stays strictly on-device and never falls back to Private Cloud
Compute. If such a fallback exists, even rarely, the European sovereignty
argument collapses at the worst possible place — on the mail, without the user
knowing. That one is blocking.

**And it is wider than mail.** The pattern — server prepares, client infers when
present, server consolidates — holds for everything sensitive Maurice will
touch. That may be the real generic piece to extract, more than the closed
vocabulary.

## If the thread is picked up again

In order: separate the example from the configuration (quick, gates sharing the
code); the OpenAI-compatible provider (an hour, unlocks the Scaleway
measurement); conversational onboarding (what turns the tool into a product);
credentials — OAuth, app-specific passwords — last, because it is the longest
but without it the demo stays at home.
