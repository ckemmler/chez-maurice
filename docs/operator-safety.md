# Running a Maurice server safely

This is for **operators** — anyone running a Maurice server that other people
connect to. It covers the trust model, your moderation duties, and the legal
obligations that come with hosting user content. It is intentionally not surfaced
in the consumer app.

## The trust model

- **Self-hosted.** A Maurice server runs on your machine; members connect with a
  server address + a token you issue. There is no public discovery and no
  open-invite links.
- **Per-member isolation is enforced.** A member's private 1:1 conversations and
  personal data are isolated. The operator (household `admin`) is administrative
  only and **cannot** read another member's private conversations — not via the
  normal app and not via the moderation tools. Reports only ever concern
  **shared rooms** (more than one human participant); they never expose a private
  1:1.
- **You control Maurice's behavior** on your server (its persona/system prompt).
  Members are told this on first connect (the connect disclosure) precisely
  because you have that power.

## Member protections (and their limits)

The official client gives members three tools:

- **Report** — in a shared room, a member can report a message or member. The
  report lands in **your** moderation queue (member↔member moderation).
- **Block** — hides another member's messages from the blocker, and stops the
  blocked member pulling them into a room. **Member↔member only.**
- **Leave** — removes the member from a room.

What protects a member from a **malicious operator** is *not* Block (you control
the message stream and the AI; a hostile server can lie). It is only: **not
connecting** (the disclosure) and **Leaving**. Don't represent Block as
protection from the operator — it isn't.

## ⚠️ Official-client-only caveat

All of the above — the connect disclosure, report, block, leave — exist **only in
the official Chez Maurice client**. The source is open (AGPL): a forked or
sideloaded client can strip these protections out. We cannot prevent this, and we
do not guarantee that a non-official client behaves safely. This matters most in
the worst case — a malicious operator handing a modified client to a vulnerable
person (e.g. a minor). Be aware of it; never imply a guarantee we can't make.

## Your duties as an operator

If you run a server others use, you are responsible for it. To meet the App
Store's user-generated-content requirements (Guideline 1.2) and basic decency:

1. **Moderate reports within 24 hours.** Review open reports in the app
   (room menu → *Review reports*, operator/admin only), and **remove** content
   and/or **eject** members as needed. Ejection removes room membership only; it
   does not delete the member's isolated private data.
2. **Publish reachable contact info.** Set your operator contact so members can
   reach you (the `households.operator_published_contact` field).
3. **Comply with the law**, including the obligations below.

## Child-safety / CSAM — legal obligations

Child sexual abuse material (CSAM) is the one area you must not treat as ordinary
moderation:

- **Confirmed CSAM creates legal reporting obligations** for you as the operator,
  which vary by jurisdiction. In Belgium, report to **Child Focus**
  (<https://www.stopchildporno.be>); in the US, the **NCMEC CyberTipline**
  (<https://report.cybertip.org>); elsewhere, your local equivalent.
- **Do not** attempt to "handle" suspected CSAM automatically, forward it, or
  build a copy of it into a workflow. Preserve what the law requires, report to
  the authority, and remove it from the room.
- `child_safety` reports are surfaced first in the operator queue, and the
  reporting member is shown the authority-reporting notice on submission.

This is operational guidance, not legal advice — consult counsel for your
jurisdiction.

## Where reports do and don't go

- In-room reports go to **you** (the operator) — for the normal, benign-operator
  case. They are stored on your server's database.
- The app's out-of-band "Report a concern / Safety" screen links **outward** to
  Apple and to child-safety authorities. It does **not** route reports to the
  Chez Maurice publisher — the publisher is not an abuse desk and cannot act on
  servers it doesn't run. `safety@chezmaurice.eu` is for questions about the app
  itself.

## Content refusals (App Store 13+ gate)

The App Store age questionnaire answers **NONE** to two non-distributable
content descriptors — *graphic sexual content / nudity* and *prolonged graphic
or sadistic realistic violence*. For that to be true, the shipping build must
refuse those categories.

- The official build appends a **non-negotiable content-safety floor** to every
  system prompt — after any persona instructions and loaded context — so it
  refuses explicit sexual activity/nudity and prolonged/sadistic gore, and
  **unconditionally** refuses any sexualization of a minor (no persona,
  instruction, or "fiction" framing can override it). It is intentionally
  narrow: non-explicit romance, mature themes, profanity, and ordinary/realistic
  fictional violence still work (matching the INFREQUENT answers).
- **This holds only for the official build.** Because the source is open (AGPL),
  a forked or self-hosted instance that strips/replaces the system prompt, or
  points at a different model, can generate anything. This is un-eliminable — we
  do not and cannot guarantee the behavior of non-official builds. The
  questionnaire answers describe the **official submitted build**, where NONE is
  true; that is the correct and honest scope.
- Verified 2026-06 against the local fallback model (Qwen): both categories are
  refused on a direct request.

See also: the in-app **Terms of Use** (`design/landing/terms.html`) and the
two-channel design in agent memory (`shared-rooms-safety-feature`).
