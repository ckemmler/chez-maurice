# Type — Maurice

Three faces, three jobs.

## Stack

| Role | Family | Notes |
|---|---|---|
| Display & wordmark | **DM Serif Display** | Single weight (Regular + Italic). High-contrast, didone-ish; the brand voice. |
| UI & body | **Geist** | 300 / 400 / 500 / 600. Quiet, optical. |
| Meta & code | **JetBrains Mono** | 400. Timestamps, eyebrows, code blocks. |

## Google Fonts link

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=Geist:wght@300;400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
```

## Variable swap

The serif is bound to `--font-serif` so it can be swapped at runtime without
touching markup. Set it on `:root` (or any ancestor):

```css
:root { --font-serif: "Newsreader"; }  /* or any of the alternates below */
```

## Vetted alternate serifs

If DM Serif Display ever feels too fashion-magazine, these were the runners-up
from the type exploration. All share the same role and pair with Geist/JetBrains.

| Family | Temperature | When |
|---|---|---|
| **Instrument Serif** | Editorial, light | Most fragile / most literary |
| **Newsreader** | Editorial, warm | Variable axes; screen-friendly cousin of Instrument |
| **EB Garamond** | Classical, humanist | "Family library" feel |
| **Source Serif 4** | Neutral, modern | Software-brand confident |
| **Libre Caslon Display** | Classic, English | Trustworthy masthead |
| **Young Serif** | Chunky, modern | Single-weight, low-contrast; for short marks |
| **PT Serif** | Friendly, sturdy | "Approachable household tool" |

## Scale

UI side stays small and quiet; display side carries the brand.

| Token | Size | Use |
|---|---|---|
| `--fs-meta`    | 10px   | Mono eyebrows, timestamps |
| `--fs-label`   | 11px   | Sans labels |
| `--fs-body`    | 14.5px | Default body (regular density) |
| `--fs-sm`      | 14px   | Italic speaker labels |
| `--fs-md`      | 18px   | Sidebar wordmark |
| `--fs-lg`      | 22px   | Conversation header title |
| `--fs-xl`      | 32px   | Empty-state greeting |
| `--fs-3xl`     | 68px   | Hero wordmark |

## Pairing rules

- The italic of the serif is the **voice** — used for the "Maurice" speaker
  label, empty-state greetings, and pull quotes. Never set body in serif italic.
- Eyebrows above any title are **mono, all-caps, 10px, 0.06–0.18em tracked**.
- Body is **Geist 400**; weight 500 only for `<strong>` and active states.
- Tabular numerals via `font-variant-numeric: tabular-nums` for any UI numbers
  that update live (usage meters, timestamps).
