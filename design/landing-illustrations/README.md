# Landing illustrations — the two plates

Everything drawn on the landing (`design/landing/ill/`) is cut from two images
generated on fal.ai with `openai/gpt-image-2`, 6 October 2026:

- `cafe-scene.png` — the café, Maurice behind the bar in his bowler hat. Made
  from text alone (`gen.py`: the scene, then the style block).
- `objects-sheet.png` — eight objects in the same hand, made by *editing* the
  scene (`sheet.py`), which is what keeps them in its style.

**To add a drawing**, edit from `cafe-scene.png` as the reference, never from
text alone and never from a later drawing, or the style drifts. Then: upscale
2× (`fal-ai/esrgan`), level the paper colour, cut the background out, and save
under `design/landing/ill/`.

The scripts read the fal key from the household database; nothing here holds it.
This folder is not deployed.
