# Handoff: Chez Maurice — Settings (web) with Ollama + per-user model access

## Overview

A standalone **web admin** page for the Chez Maurice household. It redesigns the
existing Settings (members + AI settings) in the editorial "Maurice" style and
adds the new work: **Ollama model support** (auto-discovery + manual add) and a
**members × models access matrix** so each person is allowed exactly the models
they should reach.

This is a **spec written from the current intended state** — not a changelog.
The HTML/JSX in this folder is a faithful reference prototype (React 18 + inline
Babel, no build step). Recreate it in your stack; don't ship the prototype as-is.

> The prototype is one page, top to bottom: top nav → **Settings** header →
> **01 Household members** → **02 AI settings** → **03 Models** → **04 Who can
> use what** (the matrix). A member's **Edit** opens a modal that includes
> per-user model access.

---

## What's new vs. the old Settings

The old screen had **one global "Default model"** and no notion of where a model
runs or who may use it. This adds:

1. **A model roster with two tiers** — `cloud` (Anthropic, metered) and `local`
   (Ollama, on your Mac mini, private, no usage cost).
2. **Ollama discovery** — the on-device list is what `GET /api/tags` returns;
   a manual "Add model" covers anything not auto-reported.
3. **Per-member access** — an allow-list of model ids per member, surfaced both
   as a household-wide **matrix** and inside each member's **Edit** dialog.
4. The global **Default model** stays, but is now "the model used when a member
   hasn't picked one — and it must be in their allowed set."

---

## Data model (`settings-data.js`)

All seed data is plain globals; port these shapes to your DB/API.

```ts
type Member = {
  id: string; name: string; handle: string;
  role: 'admin' | 'standard';     // admin manages settings + access
  pin: boolean;                   // whether a PIN is set
  color: string;                  // hex accent
  avatar: string;                 // square photo path
};

type Model = {
  id: string;                     // cloud: 'claude-sonnet-4-6'; local: Ollama tag 'qwen2.5:32b'
  name: string;                   // 'Claude Sonnet 4.6' / 'Qwen2.5 32B'
  tier: 'cloud' | 'local';
  vendor: 'Anthropic' | 'Ollama';
  ctx: number;                    // context window, in k tokens
  ram?: number;                   // local only: resident size in GB
  discovered?: boolean;           // local only: came back from /api/tags (vs. added manually)
  desc: string;
};

type Ollama = {                   // reflects the discovery card
  connected: boolean; host: string; version: string;
  totalRamGB: number;             // the Mac mini (48)
  lastScan: string;
};

type Household = {
  name: string;
  anthropicKeySet: boolean; falKeySet: boolean;
  defaultModel: string;           // a Model id
  maxTokens: number;
};

// access[memberId] = array of allowed Model ids.
type Access = Record<string, string[]>;
```

**Seeded access (the guardrail to keep):** admins & adults get every model;
**kids are limited to Haiku + all on-device models** — no metered frontier models
without an explicit tap. New members default to `['claude-haiku-4-6']`.

**Backend notes for the real thing:**
- *Discovery*: poll `GET {ollama.host}/api/tags`; map each entry to a `Model`
  with `tier:'local', discovered:true`. `ram` ≈ the tag's size; `ctx` from the
  modelfile. "Rescan" re-fetches. If the host is unreachable, `connected:false`
  → the card shows the not-connected state + manual-add only.
- *Admins always have all* — don't persist per-model rows for admins; compute it.
- *Default model* must be in a member's allowed set; if not, fall back to their
  best available (prefer a local model for kids).

---

## The four sections

### 01 · Household members  (`MembersSection`, settings-core.jsx)
A card; one row per member: avatar photo, name + `@handle`, an **ADMIN/STANDARD**
tag, PIN state (lock + "PIN set"), and **Edit** / **Remove** (admins have no
Remove). "Add member" opens the same dialog in `isNew` mode. Rows **wrap**
gracefully on narrow viewports (name/handle stack; role/PIN/actions wrap to a
second line).

### 02 · AI settings  (`AISection`, settings-core.jsx)
Household name, **Anthropic API key** + **FAL API key** (password fields,
"leave blank to keep"), **Default model** (a `<select>` over the whole roster,
on-device models suffixed "· on-device"), and **Max tokens**. "Save settings"
fires the saved-toast.

### 03 · Models  (`ModelsSection`, settings-models.jsx)
Two cards:
- **Ollama** — header with a status dot ("Connected" / "Not reachable"), host ·
  version · model count · last scan, a **RAM gauge labeled "largest fits N / 48
  GB"** (the honest constraint: Ollama loads ~one model at a time, so the gauge
  compares the *largest* model to total RAM, **not** a sum of all), and a
  **Rescan** button (spinner while scanning). Below: one `ModelRow` per
  discovered local model (icon, name, Ollama tag, description, `Nk ctx`, `N GB`,
  `N/4 can use`). Manually-added models get a trash affordance; discovered ones
  don't. **"Add a model manually"** reveals `AddModelForm` (Ollama tag, display
  name, RAM) → appends a `local, discovered:false` model.
- **Anthropic** — cloud card, key state + "metered usage", the three Claude
  models as `ModelRow`s (no remove).

### 04 · Who can use what — the access matrix  (`AccessMatrix`, settings-app.jsx)
The centerpiece. Rows = members; columns = models grouped under **Cloud ·
metered** and **On-device · private** (sticky-feeling group + model headers with
short name and `200k` / `42GB`). The **household-default** column shows a star.
Each cell is a `Cell` toggle:
- allowed **cloud** → filled **blue** (`TH.cloud`); allowed **on-device** →
  filled **green** (`TH.ok`); denied → faint dot.
- the **admin row is locked** (lock glyph, non-interactive — admins have all).
- clicking a standard member's cell toggles `access[member][model]`.
Matrix scrolls horizontally on narrow screens. A legend sits beneath it.

### Edit-member dialog  (`EditMemberDialog`, settings-app.jsx)
`position: fixed` modal (Esc / backdrop / ✕ to close). Fields: **Display name**,
**Handle**, **Color** (9 swatches), **PIN** ("leave blank to keep · type 'clear'
to remove"), **Profile / system prompt** (textarea), and **Model access** — the
member's allowed models as toggle **chips**, split Cloud / On-device, colored by
tier; **locked for admins**. Save persists the member and (for new members)
seeds their access. This is the redesign of the old "Edit member" screen, plus
the per-user access control.

---

## Visual system

Editorial, coherent with the Maurice iOS app. Tokens are inlined as `TH` in
`settings-core.jsx` (and mirror `design-system/tokens.css`):

- **Type** — Display/headings **DM Serif Display**; UI **Geist**; mono/meta
  **JetBrains Mono** (kickers, ids, counts, RAM, ctx). See `design-system/type.md`.
- **Surface** — warm paper: page `#ece3d4`, card `#fbf7f0`, inset `#f0e8da`,
  ink `#262320` with soft/mute/hint alphas. Hairline rules at ~10–17% ink.
- **Accents** — terracotta `#9c4a2f` (primary/admin), **green `#3d6b4f`**
  (on-device / allowed / connected), **blue `#2c5aa0`** (cloud / allowed),
  marigold `#b97a1e` (caution). The cloud/local color split is load-bearing —
  it's how the matrix reads at a glance; keep it.
- Cards: 16px radius, 0.5px border, soft shadow. Buttons: pill, `Btn` kinds
  `primary | default | ghost | danger | accent`. Saved-toast = green pill.

---

## Files

| File | Role |
|---|---|
| `Chez Maurice Settings.html` | Entry; loads fonts, React 18 + Babel, then the scripts below. |
| `settings-data.js` | **Port first** — members, model roster (cloud + Ollama w/ RAM), `OLLAMA`, `HOUSEHOLD`, `ACCESS`. |
| `settings-core.jsx` | Theme `TH`, fonts, icons `I`, primitives (`Card`, `Btn`, `Field`, `Input`, `Avatar`, `RoleTag`, `TierTag`), **MembersSection**, **AISection**. |
| `settings-models.jsx` | **ModelsSection** (Ollama card, `ModelRow`, `AddModelForm`, `RamBar`). |
| `settings-app.jsx` | **AccessMatrix**, **EditMemberDialog**, and the `App` that lays out all four sections + owns state. |
| `avatars/*.png` | Sample member photos (square 240×240). |
| `design-system/` | Shared tokens + type reference. |

**Suggested build order:** (1) port `settings-data.js` shapes to your API,
incl. the real Ollama `/api/tags` discovery + access persistence; (2) primitives
+ theme; (3) Members + AI sections; (4) Models section wired to live discovery /
rescan / manual-add; (5) the access matrix; (6) the Edit-member dialog reusing
the same access toggles.

## Interactions to preserve
- **Rescan** re-fetches Ollama models (prototype just refreshes `lastScan`).
- **Add model manually** appends a `local` model; **remove** only on
  manually-added local models.
- **Matrix cell** toggles a member's access; admin cells are locked.
- **Edit → Model access** chips mirror that member's matrix row.
- **Save** anywhere → the green "Settings saved" toast.
- Responsive: member rows wrap; `.two-col` grids collapse to 1 column ≤720px;
  the matrix scrolls horizontally.
