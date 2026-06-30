# Landing-page screenshots

Drop a PNG with the exact filename below into this folder and it **replaces the
matching CSS mockup** on the landing page — no HTML editing. If a file is absent,
the page falls back to the hand-built mockup, so the page always looks finished.

Each slot uses `object-fit: cover` (anchored top-center), so exact pixel sizes
don't matter — just get the **aspect ratio** roughly right to avoid cropping, and
export at ~2× for crisp retina display.

| File | Slot | Shape / aspect | Suggested export | Capture |
|------|------|----------------|------------------|---------|
| `hero-chat.png` | Hero phone screen | Portrait, ~9 : 19.9 (iPhone) | ~660 × 1424 | A real iPhone screenshot of a chat (e.g. the Storyteller). The hardware notch is drawn by CSS over the top — include your own status bar, it sits under the notch. |
| `composer.png` | Spotlight 1 — the composer / context budget | Portrait-ish, ~4 : 3 → 1 : 1 | ~1000 wide | The composer showing notes/books/files loaded into a conversation + the token budget. |
| `hats.png` | Spotlight 2 — specialized Maurices | Squarish, ~5 : 4 | ~1000 wide | The hats / personas grid. |
| `members.png` | Spotlight 3 — household member picker | Squarish, ~5 : 4 | ~1000 wide | The "Who's here?" member picker. |

## Notes
- **No cropping surprises:** preview with `open ../index.html` and tweak the
  screenshot's framing until it sits well; the slot crops from the top.
- **The "mockup" tag** (top-right dashed label on the three cards) hides
  automatically once a real screenshot loads.
- **More slots later?** Copy any of the four `<img class="shot-img" …>` /
  `<img class="phone-shot" …>` lines in `index.html` — the `onload`/`onerror`
  pair is what gives the graceful fallback.
