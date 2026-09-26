"""Bytes → tokens, measured — lot 2 of ``specs/mail-import.md``.

Before anything is spent, the member is told a range. A range built on "a
token is four bytes" would be a guess, and the spec forbids it: a mailbox of
HTML newsletters, of forwarded PDFs and of two-line replies do not tokenise
alike. So a hundred real bodies are sampled — correspondence of the reading
window, one location each — the first 16 kB of each text fetched
(``BODY.PEEK[TEXT]<0.n>``, on the header FETCH the tool already makes,
nothing marked read), turned into plain text as ``get_message`` would, and
counted. **Nothing of them is stored**: the sample leaves behind one row of
ratios and the ids of nothing.

The counter is ``tiktoken`` (``o200k_base``), a proxy: the reading passes
run on Mistral, whose tokenizer differs by some ten to twenty percent. The
result says so, and the range the server prices from it is wide enough to
hold that.

The estimate that follows (``estimate``) turns the store's counts and the
ratio into two token figures — the light pass on the first 600 characters of
each message, and a full reading of every body — and a number of nights,
from a stated capacity per night. Euros are the server's business
(``services/pricing.ts``); the tool never prices.
"""

from __future__ import annotations

import logging
import math
import random
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from .imap import AccountUnavailable, MailboxError, Session
from .message import body_text, parse_message
from .store import MailStore, now_iso

log = logging.getLogger("maurice.email")

SAMPLE = 100
SLICE_BYTES = 16_000
PREVIEW_CHARS = 600
# What the light pass reads beside the preview: from, to, date, subject.
HEADER_TOKENS = 60
# Messages a night's reading is taken to get through. Not a measurement:
# the reading passes are lot 4, and this is what "three or four nights"
# rests on until they exist. Said in the output.
NIGHT_MESSAGES = 1500
# What a night is, once the capacity is measured in messages per hour.
NIGHT_HOURS = 4
TOKENIZER = "tiktoken/o200k_base (a proxy for Mistral's, within ten to twenty percent)"
READ_KINDS = ("correspondence", "other")

_encoder: Any = None


def count_tokens(text: str) -> int:
    global _encoder
    if _encoder is None:
        import tiktoken  # heavy; imported on first use only

        _encoder = tiktoken.get_encoding("o200k_base")
    return len(_encoder.encode(text, disallowed_special=()))


def window_start(years: int, now: datetime | None = None) -> str:
    now = now or datetime.now(timezone.utc)
    return (now - timedelta(days=365 * years)).strftime("%Y-%m-%d")


def calibrate(
    store: MailStore,
    sessions: dict[str, Session],
    *,
    years: int = 3,
    sample: int = SAMPLE,
    counter: Callable[[str], int] = count_tokens,
    rng: random.Random | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Sample bodies, count, keep the ratio — and nothing else."""
    since = window_start(years, now)
    picked = store.sample_locations(READ_KINDS, since, sample, rng=rng)
    by_place: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for loc in picked:
        by_place[(loc["address"], loc["folder"])].append(loc)
    sampled = complete = 0
    size_complete = tokens_complete = 0
    preview_tokens_total = 0
    errors: list[str] = []
    for (address, folder), locs in by_place.items():
        session = sessions.get(address)
        if session is None:
            errors.append(f"{address}: no session")
            continue
        uids = [int(l["uid"]) for l in locs]
        size_of = {int(l["uid"]): int(l["size"] or 0) for l in locs}
        try:
            with session.lock:
                slices = session.header_and_text_many(folder, uids, SLICE_BYTES)
        except (AccountUnavailable, MailboxError) as exc:
            errors.append(f"{address} {folder!r}: {exc}")
            continue
        for uid, (raw, partial) in slices.items():
            text = body_text(parse_message(raw), max_bytes=SLICE_BYTES * 4)["text"]
            sampled += 1
            n = counter(text)
            preview_tokens_total += counter(text[:PREVIEW_CHARS])
            if not partial and size_of.get(uid):
                complete += 1
                size_complete += size_of[uid]
                tokens_complete += n
    if not sampled:
        raise MailboxError("no body could be sampled: " + ("; ".join(errors) if errors else "nothing to read in the window"))
    row = {
        "sampled": sampled,
        "complete": complete,
        "bytes": size_complete,
        "tokens": tokens_complete,
        "preview_tokens": round(preview_tokens_total / sampled, 1),
        "tokenizer": TOKENIZER,
        "computed_at": now_iso(),
    }
    store.set_calibration(row)
    out = {**row, "tokens_per_kb": tokens_per_kb(row), "years": years, "since": since}
    if errors:
        out["errors"] = errors
    return out


def tokens_per_kb(cal: dict[str, Any]) -> float | None:
    """Tokens of body text per kilobyte of message on the wire (RFC822.SIZE,
    attachments included: that is what the store knows of each message)."""
    if not cal.get("bytes"):
        return None
    return round(cal["tokens"] / (cal["bytes"] / 1024), 2)


def estimate(store: MailStore, *, years: int = 3, now: datetime | None = None) -> dict[str, Any]:
    """The numbers, for the server to price and Maurice to say: how many
    messages, how many of them correspondence, over the window; the tokens
    of a light pass and of a full reading; the nights."""
    since = window_start(years, now)
    cal = store.calibration()
    counts = store.window_counts(since)
    to_read = counts["correspondence"] + counts["other"]
    out: dict[str, Any] = {
        "years": years,
        "since": since,
        "messages": store.totals()["messages"],
        "window": counts,
        "to_read": to_read,
        "bytes_to_read": counts["bytes_to_read"],
        "calibration": {**cal, "tokens_per_kb": tokens_per_kb(cal)} if cal else None,
    }
    if cal and tokens_per_kb(cal):
        per_kb = tokens_per_kb(cal) or 0.0
        out["tokens"] = {
            "light": int(to_read * (HEADER_TOKENS + cal["preview_tokens"])),
            "full": int(counts["bytes_to_read"] / 1024 * per_kb),
        }
    else:
        out["tokens"] = None
        out["note"] = "not calibrated yet: run calibrate first"
    # A night's capacity: measured once the reading passes ran (lot 4, a
    # night being taken as four hours of reading), assumed until then.
    cap = store.capacity()
    per_night = int(cap["per_hour"] * NIGHT_HOURS) if cap else NIGHT_MESSAGES
    per_night = max(1, per_night)
    nights = max(1, math.ceil(to_read / per_night)) if to_read else 0
    out["nights"] = {"low": nights, "high": nights + 1 if nights else 0, "per_night": per_night, "measured": bool(cap)}
    return out
