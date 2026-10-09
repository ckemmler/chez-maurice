# Carnet suggestions — what a conversation is worth keeping

**Status:** server and app built on 9 October 2026 (branch `worktree-carnet-suggestions`), tested by the suite, not yet run against a real model or seen on a device. §9 says what differs from the design below.

A member asks Maurice who plays Moira in *Schitt's Creek*. Nothing of that
exchange reaches their garden unless they think to ask for it. This feature
makes the conversation offer it: a Carnet mark appears in the conversation's
header, and behind it a short list — the *Schitt's Creek* entry, Catherine
O'Hara's — each one tap from being kept, with what was said about it.

## 1. Decisions (settled 9 October 2026)

1. **The gesture writes the fiche and the exchange.** Keeping a suggestion
   opens the fiche when there is none and files what the conversation said
   about the subject as a dated note on it. On an entry that already exists,
   the note is the whole gesture.
2. **People are suggested like anything else**, someone the member knows as
   well as a public figure. They are the same object already
   (`specs/contacts.md` §3: "a public figure the member investigates and a
   friend they write to are the same object"); see §4 for how each is resolved.
3. **The mark is in the conversation's header**, and the list is the
   conversation's: one row per subject however many turns mentioned it.
4. **Detection is an ancillary pass after the turn**, not a tool of the chat
   model. A tool call costs a round; the Moira question is answered in none.

## 2. What is already there

- `search_*` → `card: "candidates"` → `open_fiche` → `card: "media"`
  (`tools/garden/server.py`, `CandidatePickerCard` / `MediaFicheCard` in
  `ChatView.swift`): opening a fiche from the chat, on request only.
- `remember_fact` (`services/lifeFacts.ts`): Maurice proposes, the member
  decides, a dismissed proposal does not come back. Same shape here.
- The garden's rules: a fiche is opened by a deliberate gesture; Maurice
  never writes a card. The tap is the gesture, so a fiche kept this way is
  *opened* (no `meta.opened: false`), and the card is never touched.
- `indexConversationInBackground` in `routes/conversations.ts`: the point,
  after a reply is persisted, where fire-and-forget work already starts.
- `publishToRoom` / `publishToUser` (`services/roomBus.ts`): events that
  reach the app outside the reply's stream.

## 3. The experience

**The mark.** Carnet's pipe, in the header's trailing group (the glass
capsule on iPhone, the system toolbar on iPad and macOS), before "add
someone" and "…". Absent while the conversation has no suggestion. With
undecided suggestions it carries their count. When a turn adds one it pulses
once (no pulse under Reduce Motion; the count changing is the signal). Once
everything is decided it stays, quiet, as the way back to what was kept.

**Never** in a room (the garden is one member's), never for a guest (their
garden is in another household).

**The drawer.** A tap opens a sheet, *À garder dans ton carnet*, of the same
family as the turn's drawer:

- *À garder* — the undecided rows, most recent first. Each: cover or
  portrait, title, kind and year (or, for a person, who they are), its state
  (*Dans ton carnet · 3 notes* / *Nouveau*), and under it **the note that
  would be filed**, in full, so the member reads what is written before it
  is. One primary button: *Garder* (new) or *Ajouter la note* (existing).
  A swipe or ✕ dismisses.
- A row whose identity is unsure (*Dune*: the 1984 film, the 2021 one, the
  book) shows *3 possibilités* and unfolds into candidates; picking one makes
  it an ordinary row.
- *Gardé* — the rows already kept in this conversation, each opening the
  entry (§6).

A subject mentioned again after it was kept comes back to *À garder* only
when the pass has a new note for it.

## 4. What is a subject, and how it is resolved

The pass names **works and people**: film, series, book, album, podcast,
game, person. Not ideas, places or products (a note on a concept is a later
tranche, §8). Three per turn at most; the subject of the exchange before the
names it passes through.

Resolution is the server's, without a model, in this order:

1. **The member's garden.** Works by title (and year when given) against the
   entries index; people by the full-name rule `personContext.ts` already
   applies (two words at least, either order, aliases, never a bare first
   name) — plus the role route for someone named by what they are ("ma
   comptable"), through the people layer of the corpus. A hit is an existing
   entry: no provider is asked.
2. **The provider**, for what the garden does not hold: TMDB, Google Books,
   IGDB, MusicBrainz, Podcast Index through the garden tool's own `search_*`
   (and the host's relay where one is set). A top candidate that matches
   title and year is taken; otherwise the row keeps its candidates.
3. **People not in the garden.** The pass says whether the conversation
   treats the person as a public figure. Public: Wikidata, as `search_person`
   does. Not public (a friend, a colleague the member names): no lookup —
   a homonym on Wikidata is worse than nothing — and the row offers a plain
   person fiche under that name, `status: confirmed` since the member made
   it. In the owner's garden today the two kinds are told apart only by what
   the fiche carries (`meta.wikidata` on 9, `identities`/`relation` on the
   mail's); nothing new is needed.

## 5. Architecture

**The pass** — `services/entrySuggestions.ts`, a new ancillary invocation
`entry_suggest` (light tier). Started after the reply is persisted, beside
the corpus reconcile; never on the reply's path. Input: the member's message,
the reply, and the titles already suggested in this conversation. Output,
JSON: up to three `{kind, title, year?, creator?, public?, note}`, `note`
being one to three sentences in the member's language — what the exchange
established about the subject, nothing the reply did not say. An empty list
is the expected answer on most turns.

Skipped without a model call: a room, a guest, a child if the household says
so, a conversation Maurice opened on the mail or the domains, a reply that
ended in error.

**The store** — one table, the conversation's list and the member's memory
of refusals at once:

```
entry_suggestions
  id, member_id, conversation_id, message_id      -- the turn that raised it
  kind, key                                        -- key: garden path, else provider:id, else normalised title
  title, year, image, candidates (JSON), existing (garden path | null)
  note, state: proposed | kept | dismissed
  created_at, decided_at
```

Unique on `(conversation_id, kind, key)`: a second mention updates the row's
note instead of adding one. A `(member_id, kind, key)` dismissed in any
conversation is not proposed again; a kept one is proposed again only as
*Ajouter la note* on the existing entry.

**Routes**

- `GET /api/conversations/:id/suggestions` — the drawer's rows.
- `POST /api/suggestions/:id/keep` `{candidate?}` — `open_fiche` when there
  is no entry, then the note as a dated block on the fiche (the block
  Carnet's note sheet writes), with a link back to the conversation; one
  commit. Answers the entry's path.
- `POST /api/suggestions/:id/dismiss`.
- The conversation list rows carry `suggestions: n` (undecided), so the mark
  is right on a cold start.

**Live** — `publishToUser(memberId, {type: "suggestions", conversation_id,
count})` when the pass adds or updates a row; the app pulses the mark if that
conversation is on screen.

**App** — `CarnetSuggestionsButton` in the header group, `SuggestionsDrawer`;
state in `ChatService` per conversation. Nothing in the transcript.

**Carnet** — nothing to build for the first tranche: a kept entry is on the
shelf at its next load.

## 6. Opening what was kept

Carnet declares no URL scheme today. Until it does (`carnet://entry/
<collection>/<slug>`, to add in `carnet/project.yml`), a kept row opens the
fiche's page in the garden, signed in, the way the review links do. On the
Mac that stays the answer: reading is iOS-only.

## 7. Order of work

1. **The pass and a bench, no interface.** `server/scripts/suggest-bench.ts`
   in the manner of `corpus-floor.ts`: a few dozen of the owner's real turns,
   labelled by hand (worth an entry / not), run through the pass. The risk of
   the whole feature is noise — a mark that lights on every reply is a mark
   nobody reads — so the prompt and the model are chosen on precision here
   before anything is drawn.
2. **Store, routes, resolution**, with tests (dedup, refusals remembered,
   the garden-before-provider order, the homonym rule for people).
3. **App**: the mark, the drawer, keep and dismiss.
4. **Carnet's URL scheme** and the row that opens the entry there.

## 8. Open, deliberately left for later

- **Notes on ideas** ("à creuser : la méthode Buteyko") — a different object
  (a note, not an entry) with no provider to anchor it.
- **Articles** a web search read during the turn: the source cards already
  hold the URL; keeping one is the articles pipeline, not `open_fiche`.
- **What the pass costs a member's month** is to be read off the bench, not
  guessed; the pass is charged like the life-fact judge, to the member.
- **Whether the note is editable in the drawer** before it is kept. First
  tranche: shown, not editable; it is editable on the fiche afterwards.

## 9. As built (9 October 2026)

What the first tranche does differently from the sections above, or leaves out:

- **Routes.** `GET /api/suggestions?conversation=<id>` (rows, `pending`, `kept`),
  `POST /api/suggestions/:id/keep {candidate?}`, `POST /api/suggestions/:id/dismiss`.
  The conversation list rows carry `suggestions` and `suggestions_kept`.
- **The event** is `{type: "suggestions", conversationId, count, kept}` on the
  member's channel.
- **The mark is Carnet's pipe**, cut from its app icon into a template image
  (`app/Maurice/Assets.xcassets/CarnetPipe.imageset`): a bitmap at three
  scales, not yet a vector.
- **The note is one dated line under `## Commentaire`**, followed by
  *(Conversation avec Maurice : « title »)* — no link back to the conversation,
  since the app answers no `maurice://conversations/…` yet.
- **Someone named by what they are** ("ma comptable") is not resolved: the pass
  is asked for full names, and the garden is matched on them. The people layer
  of the corpus is not consulted.
- **A new fiche is filed on the side of the member's language** (`fr`, else
  `en`), the garden having those two.
- **A subject no provider knew** (no key, no hit) is still offered, on its title
  alone; kept, it is a fiche with a title and the note (`skip_metadata`).
- **A person's `status`** is set to `confirmed` only on a fiche that has none —
  one this gesture made. A fiche the mail made stays `pending`: a note is not
  a confirmation.
- **Deleting a conversation** drops what it still offered; decisions stay, a
  refusal holding for every conversation to come.
- **Pulse**: the mark swells once when the pending count grows; nothing
  under Reduce Motion.
- **Not built**: the bench (§7.1, set aside on the owner's decision to try it
  on new conversations instead), Carnet's URL scheme (§6), editing the note in
  the drawer.
