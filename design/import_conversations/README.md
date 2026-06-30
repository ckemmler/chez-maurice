# Handoff: Anthropic data export — per-member Claude.ai history → searchable, incremental sync

A new section inside the **Edit member** dialog (`EditMemberDialog`) that lets an
admin import a member's **Anthropic (Claude.ai) account data export** — the
`.zip` you download from Claude.ai's privacy settings (it contains
`conversations.json`, plus `projects/` and `design_chats/`) — so that person's
past Claude conversations become **semantically searchable by Maurice**, joining
*that member's* private index alongside the household's books.

An export is a **full snapshot at export time**, so imports are **incremental**:
each run records the date range of conversations it added and advances a
**last-sync watermark**. The fiche shows the run log + watermark and frames the
next import as a *sync from that watermark*.

React 18 + inline Babel, same stack/tokens as the Settings prototype. Recreate
it in your stack; don't ship the prototype as-is.

> Open `Maurice — Import Conversations.html`. The state switcher walks the six
> states inside the real (embedded) dialog. In product the dialog is the existing
> `position:fixed` modal — here it's inline so all states are scannable.

---

## Where it slots in

One more body block in `EditMemberDialog`, **below "Model access"**, separated by
a hairline rule, **scoped to the member whose fiche is open** — every line names
them ("import **Paola's** history"). Styled like its neighbour (SANS 12.5/500
label, MONO meta on the right). Reuses `TH`, the icon set `I` (+ a few hairline
`IX` icons in the same language) and the `Btn`/`Field`/`Avatar` primitives.

### Resolved questions
- **Named honestly for what it is.** Section title **"Anthropic data export"**;
  the empty-state line says it imports the member's Claude.ai conversation
  history from an Anthropic data export; the drop zone asks for the data-export
  `.zip` specifically; a bad file is rejected with *"This doesn't look like an
  Anthropic data export."* No invented Anthropic logos/branding — just precise
  wording.
- **Placement — collapsible disclosure.** The dialog is already tall, so this is
  a fold-out disclosure, collapsed by default with a **live status line in its
  header** ("not imported" · "synced through 31 May 2026" · "indexing 29/41" ·
  "sync incomplete"). Auto-opens while a job runs or on error.
- **Drop zone, not a plain file row** — for a deliberate ~20 MB action it reads
  less fiddly and gives the privacy note room.
- **Row chip — yes, build it.** `ImportChip` is a compact MONO chip ("syncing
  71%" / "synced") for the member row in `MembersSection`, mirroring the dialog
  status so an admin sees a long sync is alive without opening the fiche. Shown
  in context in the demo's right column.

---

## State machine

`empty → selected → (uploading → parsing → indexing) → success`, with
`imported` (returning) as the resting state and `error` reachable from any
running phase. The selected/running/success copy adapts to **mode**: the
first-ever import covers the full archive; later runs are a **sync** from the
watermark.

| State | Header meta | Shows |
|---|---|---|
| **1 · Empty** | `not imported` | Worded as the **first** Anthropic-export import (the whole archive); drop zone for the data-export `.zip`; optional **"Also import projects & design chats"** (default **off**). |
| **2 · Selected** | `ready to sync` / `1 file ready` | File row (name · size · "new conversations since 31 May 2026" or "≈1,000 conversations"); a **sync-scope line** ("Imports only conversations **after 31 May 2026** — earlier history stays indexed, duplicates skipped" / "First import — full archive"); projects toggle; **marigold privacy caution + consent checkbox** gating the primary; the primary reads **"Sync newer conversations"** (or "Import full archive"). |
| **3 · Running** | `indexing N/M` | Phase **stepper** (Upload → Parse → Index); progress — indeterminate while parsing, determinate once total known ("Indexing 29 of 41 new conversations"); reassurance it **keeps running if the dialog closes**; Cancel. |
| **4 · Success** | `synced · just now` | Green **"Search is ready"** with "Synced through 14 Jun 2026 · 41 new conversations · 503 messages added"; the **import-history list** with the new run highlighted on top; secondary **Sync again**. The watermark has advanced. |
| **5 · Imported** (returning) | `synced through 31 May 2026` | A prominent **sync-watermark card** ("Last synced through 31 May 2026"); the **import-history run log** (newest first — `from → to`, conv/msg counts, run timestamp, status, MONO throughout); primary **"Sync newer conversations"**; quiet **Remove**. |
| **6 · Error** | `sync incomplete` / `unrecognized file` | Two flavours (a demo toggle flips them): **Partial** — marigold; "indexed 18 of 41 before it stopped, history + watermark unchanged," the partial run **logged in the history** as `partial`, **Retry sync**. **Unrecognized file** — terracotta; "This doesn't look like an Anthropic data export," **Choose another file**. |

**Incremental + non-destructive.** The from-date of the next run = the current
watermark; re-importing dedupes. A failed/interrupted run is recorded as
**partial/failed** and **must not corrupt the prior watermark or history** — copy
and flow both say so.

### Colour semantics (coherent with the matrix)
Green `TH.ok` = synced / searchable / watermark / progress · marigold
`TH.caution` = the privacy consent gate **and** a partial run · terracotta
`TH.accent` = primary action and hard errors (bad file). Blue stays the cloud
colour, untouched here.

---

## Backend seams (name them, don't design them)

Each import is a **history record**:
```ts
type ImportRun = {
  id: string;
  range_from: string;   // lower bound = the watermark at run start (or archive start for the first run)
  range_to: string;     // upper bound = export's latest conversation date
  conversations: number;
  messages: number;
  ran_at: string;       // run timestamp
  status: 'done' | 'partial' | 'failed';
};
// watermark = the latest *successful* record's range_to.
```

- **Upload** — `POST` the export `.zip` for `{memberId}`; returns a `jobId`. Large
  (~20 MB); stream it. `withProjects` rides along.
- **Job** — unzip → parse `conversations.json` (+ optional `projects/`,
  `design_chats/`) → chunk + embed into the **member-scoped private index**. The
  job is handed the **current watermark as its lower bound** and dedupes against
  what's already indexed. Minutes, not seconds — a background job.
- **Progress** — poll/stream `{ phase, done, total }` by `jobId`. Drives the
  in-dialog progress and the row chip; survives the dialog closing.
- **History + watermark read** — per member, the list of `ImportRun`s
  (newest first) + the derived watermark, for the returning state and the chip.
- **Write on completion** — the job appends a new `ImportRun`; the watermark is
  recomputed from the latest successful record. Index to a staging area and swap
  on success so an interrupted run records `partial` **without** advancing the
  watermark or touching prior history. Validate the archive shape up front and
  reject non-exports before any indexing. Cancel + Remove are their own endpoints.

---

## Files

| File | Role |
|---|---|
| `Maurice — Import Conversations.html` | Entry; fonts, React 18 + Babel, then the scripts below. |
| `import-conversations.jsx` | **The deliverable** — `ImportConversations` (the section + its state machine, `HistoryList`, `Watermark`, `Stepper`), `ImportChip` (row chip), `IX` (extra icons), and the `HISTORY` / watermark fixtures. |
| `dialog.jsx` | `EditMemberDialog`, trimmed from `settings-app.jsx`, with the section wired in below Model access (+ an `embedded` mode the demo uses). |
| `import-demo.jsx` | The reference shell: state switcher, the embedded dialog, the row-chip-in-context demo, decision notes. |
| `settings-core.jsx`, `settings-data.js`, `avatars/*` | Copied unchanged from the Settings prototype (theme `TH`, primitives, icons `I`, seed data). |

**Build order:** (1) the `ImportRun` record + the upload endpoint + job; (2) the
history/watermark read; (3) `ImportConversations` wired to a progress
poll/stream and the run log; (4) the `MembersSection` row chip off the same
status.
