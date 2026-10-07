"""A scanned attachment, read by a model that reads images.

A PDF made by a scanner has no text: each page is a picture. A photo of a
letter is one too. Until 7 October 2026 the tool could only say so. It now
asks the server for a turn on the model the admin chose for
``attachment_vision`` — one page a turn, a few at once — and gives back what
the pages say.

* **The member pays, under their own caps.** The turn is made in their name
  (``member_id``): the server weighs their cap before each page and writes
  its cost under them. A refusal stops the reading where it is.
* **Read once.** The transcription is kept beside the member's mail store,
  sealed under the household key like a reading, by the hash of the file: a
  long scan is read in turns (``offset``), and the same seventeen pages are
  not paid for at each one. Nothing unfinished is kept.
* **Nothing else leaves.** Only the pages of the one attachment the member
  asked to read are sent, to the household's own provider; the tool has no
  key and no SDK (``tools/shared/model_config.py``).
* What comes back is the sender's content like any attachment: the caller
  wraps it in the untrusted markers.

Pictures are normalised with Pillow — a scanner writes JPEG, CCITT fax or
JPEG 2000, a phone HEIC or a 12-megapixel JPEG — to a JPEG of at most
``MAX_SIDE`` pixels, which is enough to read print and bounds what a page
costs.
"""

from __future__ import annotations

import base64
import hashlib
import io
import json
import logging
import re
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Callable

from . import sealing
from .store import mail_dir

log = logging.getLogger("maurice.email")

INVOCATION = "attachment_vision"

MAX_PAGES = 40
MAX_SIDE = 2000
#: Pages read at once. A page takes 5 to 60 seconds whatever the others do
#: (measured on Scaleway, 7 October 2026): the wait is the slowest wave's.
CONCURRENCY = 8
NO_TEXT = "[no text]"

PROMPT = (
    "Transcribe the text of this scanned page exactly as it is written, in its own language, as plain text. "
    "Keep the reading order; write a table row on one line, its cells separated by ' | '. "
    "Do not translate, summarise, comment or describe the page. "
    f"If the page has no text, answer exactly: {NO_TEXT}"
)

_SAFE = re.compile(r"[^A-Za-z0-9_-]")

Complete = Callable[..., dict]


def _complete() -> Complete:
    from tools.shared.model_config import complete_full  # late: only a scan needs the server

    return complete_full


# ── pictures ─────────────────────────────────────────────────────────────


def _jpeg(image: Any) -> bytes:
    """A Pillow image as a JPEG a model can be sent: RGB or grey, no larger
    than it needs to be."""
    if image.mode not in ("RGB", "L"):
        image = image.convert("RGB")
    if max(image.size) > MAX_SIDE:
        image.thumbnail((MAX_SIDE, MAX_SIDE))
    out = io.BytesIO()
    image.save(out, format="JPEG", quality=80)
    return out.getvalue()


def image_pages(data: bytes) -> list[bytes | None]:
    """A photo as the one page it is."""
    from PIL import Image  # late: only a picture needs it

    return [_jpeg(Image.open(io.BytesIO(data)))]


def pdf_pages(data: bytes) -> list[bytes | None]:
    """One picture a page: the largest image on it, which on a scan is the
    page. None for a page with no picture, or one that cannot be decoded."""
    from pypdf import PdfReader

    logging.getLogger("pypdf").setLevel(logging.ERROR)
    pages: list[bytes | None] = []
    for page in PdfReader(io.BytesIO(data)).pages:
        best = None
        try:
            for found in page.images:
                picture = found.image
                if picture is not None and (best is None or picture.size[0] * picture.size[1] > best.size[0] * best.size[1]):
                    best = picture
            pages.append(_jpeg(best) if best is not None else None)
        except Exception as exc:  # one bad page is one page
            log.warning("[email] a scanned page could not be decoded: %s", type(exc).__name__)
            pages.append(None)
    return pages


# ── the reading ──────────────────────────────────────────────────────────


def transcribe(pages: list[bytes | None], *, member_id: str, complete: Complete | None = None) -> tuple[str, str, bool]:
    """(text, model, whole): what the pages say, under a ``[page n]`` line
    each, the model that read them, and whether every page that could be read
    was — False when the server refused part-way (a cap, no model) or the
    document is longer than ``MAX_PAGES``."""
    complete = complete or _complete()
    todo = [(n, picture) for n, picture in enumerate(pages[:MAX_PAGES], 1) if picture]
    model = ""
    refusal: str | None = None

    def read(item: tuple[int, bytes]) -> tuple[int, str | None]:
        nonlocal model, refusal
        number, picture = item
        if refusal:
            return number, None
        try:
            answer = complete(
                INVOCATION, PROMPT, max_tokens=4000, temperature=0, timeout=180.0,
                images=[{"media_type": "image/jpeg", "data": base64.b64encode(picture).decode()}],
                member_id=member_id,
            )
        except Exception as exc:
            refusal = refusal or str(exc)
            return number, None
        model = answer.get("model") or model
        text = (answer.get("text") or "").strip()
        return number, "" if text == NO_TEXT else text

    with ThreadPoolExecutor(max_workers=CONCURRENCY) as pool:
        read_pages = dict(pool.map(read, todo))

    parts = []
    for number in range(1, len(pages[:MAX_PAGES]) + 1):
        text = read_pages.get(number)
        if text:
            parts.append(f"[page {number}]\n{text}")
    out = "\n\n".join(parts)
    whole = refusal is None and len(pages) <= MAX_PAGES
    if refusal:
        done = sum(1 for t in read_pages.values() if t is not None)
        note = f"[the reading stopped after {done} of {len(todo)} page(s): {_reason(refusal)}]"
        out = f"{out}\n\n{note}" if out else note
    elif len(pages) > MAX_PAGES:
        out += f"\n\n[only the first {MAX_PAGES} of {len(pages)} pages were read]"
    elif not out:
        out = "[no text was found in this scan]"
    return out, model, whole


def _reason(refusal: str) -> str:
    """The server's own words, without the plumbing around them."""
    match = re.search(r'"error"\s*:\s*"([^"]+)"', refusal)
    return (match.group(1) if match else refusal)[:200]


# ── read once ────────────────────────────────────────────────────────────


def cache_path(member_id: str, data: bytes) -> Path:
    return mail_dir() / "scans" / _SAFE.sub("_", member_id) / f"{hashlib.sha256(data).hexdigest()}.sealed"


def read_scan(data: bytes, content_type: str, *, member_id: str, complete: Complete | None = None) -> tuple[str, str] | None:
    """(text, how) for a scanned PDF or a photo, from the member's kept
    transcription if there is one. None when the file has no picture to
    read — an empty PDF is not a scan — and the caller keeps what it had."""
    path = cache_path(member_id, data)
    if path.exists():
        try:
            kept = json.loads(sealing.unseal(path.read_text()))
            return kept["text"], f"{content_type} (scan, read by {kept['model']})"
        except Exception as exc:  # a file from another key, or cut short: read again
            log.warning("[email] a kept transcription could not be opened: %s", type(exc).__name__)
    try:
        pages = pdf_pages(data) if content_type == "application/pdf" else image_pages(data)
    except ImportError:
        return "[reading a scan needs the pillow package, which is not installed here]", content_type
    except Exception as exc:
        return f"[the pictures of this file could not be read: {type(exc).__name__}]", content_type
    if not any(pages):
        return None
    text, model, whole = transcribe(pages, member_id=member_id, complete=complete)
    if whole and model:
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(sealing.seal(json.dumps({"model": model, "text": text})))
        except Exception as exc:  # not kept is read again, not a failure
            log.warning("[email] a transcription could not be kept: %s", type(exc).__name__)
    return text, f"{content_type} (scan, read by {model})" if model else content_type
