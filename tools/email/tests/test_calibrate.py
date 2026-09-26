"""Bytes → tokens on sampled bodies, and the estimate (specs/mail-import.md,
lot 2): measured, never stored, a range for the server to price."""

from __future__ import annotations

import random
from datetime import datetime, timezone

import pytest

from tools.email import calibrate as cal
from tools.email.imap import MailboxError

from .fakes import FakeIMAPClient, build_raw
from .test_scan import app_dir, make_service, scan, store  # noqa: F401 — fixtures

pytestmark = pytest.mark.usefixtures("app_dir")

ME = "alex@icloud.com"
NOW = datetime(2026, 9, 26, tzinfo=timezone.utc)
words = lambda n: " ".join(f"mot{i}" for i in range(n))  # noqa: E731


def mailbox(n: int = 30) -> dict[int, bytes]:
    out = {}
    for uid in range(1, n + 1):
        bulk = uid % 3 == 0
        out[uid] = build_raw(f"Sujet {uid}", "News <news@list.example>" if bulk else f"Ami {uid} <ami{uid}@example.org>",
                             words(40 * (uid % 5 + 1)), date=f"Mon, 0{uid % 7 + 1} Sep 2026 09:00:00 +0200",
                             message_id=f"<m{uid}@x>", headers={"List-Id": "<news.list.example>"} if bulk else None)
    out[n + 1] = build_raw("Vieux", "vieux@example.org", words(100), date="Mon, 01 Jan 2018 09:00:00 +0100", message_id="<old@x>")
    return out


def fetches_of(client: FakeIMAPClient):
    return [arg for name, arg in client.calls if name == "fetch"]


def test_bodies_are_sampled_in_the_window_counted_and_not_kept(tmp_path):
    client = FakeIMAPClient({"INBOX": mailbox()})
    svc = make_service(tmp_path, {ME: client})
    scan(svc)
    alex = svc.accounts(member_id="id-alex")
    before = len(fetches_of(client))
    out = svc.calibrate(alex, years=3, sample=10)
    assert out["sampled"] == 10 and out["complete"] == 10 and out["tokens"] > 0 and out["tokens_per_kb"] > 0
    assert 0 < out["preview_tokens"] < 200 and "proxy" in out["tokenizer"]
    # The triage ran first (nothing was triaged), and the sample is drawn
    # from correspondence and other of the window: never a newsletter, never 2018.
    fetched = [uid for f in fetches_of(client)[before:] for uid in f[0]]
    assert len(fetched) == 10 and all(uid % 3 != 0 and uid <= 30 for uid in fetched)
    parts = fetches_of(client)[before][1]
    assert parts == ["BODY.PEEK[HEADER]", f"BODY.PEEK[TEXT]<0.{cal.SLICE_BYTES}>"]
    # Nothing of the bodies is in the file: one row of ratios.
    row = store().calibration()
    assert row["sampled"] == 10 and set(row) == {"sampled", "complete", "bytes", "tokens", "preview_tokens", "tokenizer", "computed_at"}
    blob = store().path.read_bytes()
    wal = store().path.with_suffix(".db-wal")
    if wal.exists():
        blob += wal.read_bytes()
    assert b"mot1 mot2" not in blob


def test_a_body_longer_than_the_slice_is_partial_and_left_out_of_the_ratio(tmp_path):
    client = FakeIMAPClient({"INBOX": {1: build_raw("Long", "a@example.org", words(6000), message_id="<l@x>"),
                                       2: build_raw("Court", "b@example.org", words(20), message_id="<c@x>")}})
    svc = make_service(tmp_path, {ME: client})
    scan(svc)
    out = svc.calibrate(svc.accounts(member_id="id-alex"), years=3)
    assert out["sampled"] == 2 and out["complete"] == 1
    assert out["bytes"] == [m["size"] for m in store().messages() if m["message_id"] == "<c@x>"][0]


def test_the_estimate_turns_counts_and_ratio_into_tokens_and_nights(tmp_path, monkeypatch):
    client = FakeIMAPClient({"INBOX": mailbox()})
    svc = make_service(tmp_path, {ME: client})
    scan(svc)
    alex = svc.accounts(member_id="id-alex")
    out = svc.estimate(alex, years=3)
    assert out["tokens"] is None and "calibrate" in out["note"]
    assert out["messages"] == 31 and out["window"]["messages"] == 30 and out["window"]["bulk"] == 10 and out["to_read"] == 20
    svc.calibrate(alex, years=3, sample=10, )
    monkeypatch.setattr(cal, "NIGHT_MESSAGES", 8)
    out = cal.estimate(store(), years=3, now=NOW)
    per_kb = out["calibration"]["tokens_per_kb"]
    assert out["tokens"]["full"] == int(out["bytes_to_read"] / 1024 * per_kb)
    assert out["tokens"]["light"] == int(20 * (cal.HEADER_TOKENS + out["calibration"]["preview_tokens"]))
    assert out["nights"] == {"low": 3, "high": 4, "per_night": 8}


def test_a_window_with_nothing_to_read_says_so(tmp_path):
    client = FakeIMAPClient({"INBOX": {1: build_raw("Vieux", "vieux@example.org", "x", date="Mon, 01 Jan 2018 09:00:00 +0100")}})
    svc = make_service(tmp_path, {ME: client})
    scan(svc)
    with pytest.raises(MailboxError, match="nothing to read"):
        svc.calibrate(svc.accounts(member_id="id-alex"), years=3)
    out = svc.estimate(svc.accounts(member_id="id-alex"), years=3)
    assert out["to_read"] == 0 and out["nights"] == {"low": 0, "high": 0, "per_night": cal.NIGHT_MESSAGES}


def test_the_sample_is_random_but_reproducible_with_a_seed(tmp_path):
    client = FakeIMAPClient({"INBOX": mailbox()})
    svc = make_service(tmp_path, {ME: client})
    scan(svc)
    svc.triage(svc.accounts(member_id="id-alex"))
    a = [l["uid"] for l in store().sample_locations(("correspondence", "other"), "2020-01-01", 5, rng=random.Random(1))]
    b = [l["uid"] for l in store().sample_locations(("correspondence", "other"), "2020-01-01", 5, rng=random.Random(1))]
    assert a == b and len(a) == 5
