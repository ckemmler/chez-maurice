"""The member's word on the reading (specs/mail-import.md, lot 3): a yes or a
no kept as one `reading` job in the member's store, reported by scan_status,
never a second row for a second word, and never a word about money."""

from __future__ import annotations

import asyncio
import json
import re

import pytest

from tools.email import reading, server
from tools.email.cli import main as cli_main
from tools.email.reading import KIND

from .fakes import FakeIMAPClient
from .test_scan import app_dir, make_service, messages, store  # noqa: F401 — fixtures

pytestmark = pytest.mark.usefixtures("app_dir")


CLIENT = None


def service(tmp_path):
    global CLIENT
    CLIENT = FakeIMAPClient({"INBOX": messages(3)})
    return make_service(tmp_path, {"alex@icloud.com": CLIENT})


def alex(svc):
    return svc.accounts(member_id="id-alex")


def test_a_yes_leaves_one_approved_job_with_no_ceiling_and_nothing_read(tmp_path):
    svc = service(tmp_path)
    out = svc.approve_reading(alex(svc), years=3)
    assert out["status"] == "approved" and out["already"] is False
    job = out["job"]
    assert job["kind"] == KIND and job["state"] == "approved"
    assert job["budget_eur"] is None and job["spent_eur"] == 0
    assert job["cursor"] == {"years": 3}
    # Nothing was fetched: the consent is a row, not a run.
    assert not [c for c in CLIENT.calls if c[0] in ("fetch", "select_folder", "examine")]
    assert store().totals()["messages"] == 0


def test_a_second_yes_marks_the_same_job_and_opens_no_other(tmp_path):
    svc = service(tmp_path)
    first = svc.approve_reading(alex(svc))
    second = svc.approve_reading(alex(svc), years=5)
    assert second["already"] is True and second["job"]["id"] == first["job"]["id"]
    assert second["job"]["cursor"] == {"years": 3}  # the word given stands; a new window is a new word
    import sqlite3
    with sqlite3.connect(store().path) as conn:
        assert conn.execute("SELECT COUNT(*) FROM jobs WHERE kind = ?", (KIND,)).fetchone()[0] == 1


def test_a_no_is_kept_and_can_be_turned_around_on_the_same_row(tmp_path):
    svc = service(tmp_path)
    no = svc.decline_reading(alex(svc))
    assert no["status"] == "declined" and no["job"]["state"] == "declined"
    again = svc.decline_reading(alex(svc))
    assert again["already"] is True and again["job"]["id"] == no["job"]["id"]
    yes = svc.approve_reading(alex(svc), years=2)
    assert yes["status"] == "approved" and yes["already"] is False and yes["job"]["id"] == no["job"]["id"]
    assert yes["job"]["cursor"] == {"years": 2}
    back = svc.decline_reading(alex(svc))
    assert back["job"]["id"] == no["job"]["id"] and back["job"]["state"] == "declined"


def test_scan_status_reports_the_word(tmp_path):
    svc = service(tmp_path)
    assert svc.scan_status(alex(svc))["reading"] is None
    svc.approve_reading(alex(svc))
    status = svc.scan_status(alex(svc))
    assert status["reading"]["state"] == "approved" and status["running"] is False
    svc.decline_reading(alex(svc))
    assert svc.scan_status(alex(svc))["reading"]["state"] == "declined"


def test_a_reading_under_way_is_left_alone_by_a_word(tmp_path):
    """Lot 4 will run the approved job; a yes or a no meanwhile does not
    open a second one nor stop the first (that is scan_stop's)."""
    svc = service(tmp_path)
    st = store()
    running = st.create_job("id-alex", KIND, state="running", cursor={"years": 3})
    yes = reading.approve(st, "id-alex")
    assert yes["status"] == "running" and yes["job"]["id"] == running["id"] and "under way" in yes["note"]
    no = reading.decline(st, "id-alex")
    assert no["status"] == "running" and st.job(running["id"])["state"] == "running"
    # Once that run is done, a new word opens a new job.
    st.update_job(running["id"], state="done")
    fresh = reading.approve(st, "id-alex")
    assert fresh["job"]["id"] != running["id"] and fresh["job"]["state"] == "approved"


def test_the_word_is_the_members_and_reaches_the_tools_and_the_cli(tmp_path, monkeypatch):
    svc = service(tmp_path)
    monkeypatch.setattr(server, "_service", svc)
    monkeypatch.setattr(server, "get_member_id", lambda: "id-alex")

    def call(name, args=None):
        return json.loads(asyncio.run(server.call_tool(name, args or {}))[0].text)

    assert call("approve_reading", {"years": 4})["job"]["cursor"] == {"years": 4}
    assert call("scan_status")["reading"]["state"] == "approved"
    assert call("decline_reading")["status"] == "declined"
    # Another member's store is another file: nothing of Alex's in it.
    monkeypatch.setattr(server, "get_member_id", lambda: "id-sam")
    assert call("scan_status")["reading"] is None

    monkeypatch.setattr("sys.stdout", __import__("io").StringIO())
    import sys
    assert cli_main(["--member", "alex", "--config", str(tmp_path / "email.toml"), "approve-reading", "--years", "1"]) == 0
    assert '"state": "approved"' in sys.stdout.getvalue()


def test_nothing_the_member_could_see_speaks_of_money():
    tools = {t.name: t for t in asyncio.run(server.list_tools())}
    for name in ("approve_reading", "decline_reading", "scan_status"):
        text = tools[name].description + json.dumps(tools[name].inputSchema)
        assert not re.search(r"€|euro|cost|price|token|budget", text, re.I), name


# ── lot 4: the passes' material ──────────────────────────────────────────

from tools.email import sealing  # noqa: E402
from tools.email.calibrate import estimate  # noqa: E402

from .fakes import build_raw  # noqa: E402


def words(n):
    return " ".join(f"mot{i}" for i in range(n))


def corpus(n: int = 12) -> dict[int, bytes]:
    """Correspondence of this month, a newsletter, and one old message."""
    out = {}
    for uid in range(1, n + 1):
        bulk = uid % 4 == 0
        out[uid] = build_raw(f"Sujet {uid}", "News <news@list.example>" if bulk else f"Ami {uid} <ami{uid}@example.org>",
                             words(300 if uid == 1 else 40), date=f"Mon, 0{uid % 7 + 1} Sep 2026 09:00:00 +0200",
                             message_id=f"<m{uid}@x>", headers={"List-Id": "<news.list.example>"} if bulk else None)
    out[n + 1] = build_raw("Vieux", "vieux@example.org", words(50), date="Mon, 01 Jan 2018 09:00:00 +0100", message_id="<old@x>")
    return out


def ready(tmp_path):
    """A walked, triaged, approved store; the fake client that serves it."""
    client = FakeIMAPClient({"INBOX": corpus()})
    svc = make_service(tmp_path, {"alex@icloud.com": client})
    from .test_scan import scan as walk
    walk(svc)
    svc.triage(alex(svc))
    svc.approve_reading(alex(svc), years=3)
    return svc, client


def test_the_light_pass_gets_previews_of_the_window_newest_first_and_stores_nothing(tmp_path):
    svc, client = ready(tmp_path)
    batch = svc.reading_next(alex(svc), stage="light", limit=5)
    assert batch["stage"] == "light" and len(batch["messages"]) == 5 and batch["missing"] == []
    m = batch["messages"][0]
    assert set(m) >= {"id", "from", "to", "date", "subject", "preview"}
    assert m["subject"].startswith("Sujet") and "mot0" in m["preview"] and len(m["preview"]) <= 600
    dates = [x["date"] for x in batch["messages"]]
    assert dates == sorted(dates, reverse=True)
    # Nine correspondence messages in the window (12 minus 3 newsletters), none judged yet.
    assert batch["progress"] == {"messages": 9, "to_light": 9, "kept": 0, "skipped": 0, "to_read": 0, "read": 0}
    # Peeked, and nothing of it in the store.
    assert not any(c[0] == "store_flags" or c[0] == "add_flags" for c in client.calls)
    assert store().readings(kept_only=False) == []


def test_verdicts_and_readings_are_kept_the_reading_sealed_and_the_job_counts_move(tmp_path):
    svc, _client = ready(tmp_path)
    batch = svc.reading_next(alex(svc), stage="light", limit=9)
    ids = [m["id"] for m in batch["messages"]]
    keep, skip = ids[:3], ids[3:]
    r = svc.reading_record(alex(svc), verdicts=[{"id": i, "keep": True, "reason": "a real exchange", "tokens": 90} for i in keep]
                           + [{"id": i, "keep": False, "reason": "an automatic reply"} for i in skip])
    assert r["recorded"] == {"verdicts": 9, "readings": 0}
    assert r["progress"] == {"messages": 9, "to_light": 0, "kept": 3, "skipped": 6, "to_read": 3, "read": 0}
    assert r["job"]["counts"] == {"judged": 9, "kept": 3, "skipped": 6, "read": 0}
    # The full pass sees the kept ones only, with their text.
    full = svc.reading_next(alex(svc), stage="full", limit=10)
    assert sorted(m["id"] for m in full["messages"]) == sorted(keep)
    assert all("body" in m and m["truncated"] is False for m in full["messages"])
    reading = {"summary": "Ami 1 propose un dîner", "people": [{"name": "Ami 1", "role": "friend"}], "promises": []}
    r = svc.reading_record(alex(svc), readings=[{"id": keep[0], "reading": reading, "tokens": 400}])
    assert r["recorded"] == {"verdicts": 0, "readings": 1} and r["progress"]["to_read"] == 2 and r["progress"]["read"] == 1
    rows = store().readings()
    assert len(rows) == 1 and rows[0]["reading_sealed"].startswith("v1:") and "dîner" not in rows[0]["reading_sealed"]
    assert json.loads(sealing.unseal(rows[0]["reading_sealed"])) == reading
    assert rows[0]["tokens_full"] == 400 and rows[0]["tokens_light"] == 90
    # Read ones leave the full batch; a second record of the same id replaces, never doubles.
    assert sorted(m["id"] for m in svc.reading_next(alex(svc), stage="full")["messages"]) == sorted(keep[1:])
    svc.reading_record(alex(svc), readings=[{"id": keep[0], "reading": {"summary": "bis"}}])
    assert len(store().readings()) == 1


def test_control_moves_the_job_and_measures_the_capacity_that_the_estimate_then_uses(tmp_path):
    svc, _client = ready(tmp_path)
    acc = alex(svc)
    assert svc.reading_progress(acc)["capacity"] is None
    before = estimate(store(), years=3)
    assert before["nights"]["measured"] is False and before["nights"]["per_night"] == 1500
    r = svc.reading_control(acc, "running")
    assert r["job"]["state"] == "running"
    # A small run measures nothing worth the name; a real one does.
    svc.reading_control(acc, "paused", measured={"messages": 9, "seconds": 30}, seconds=30)
    assert svc.reading_progress(acc)["capacity"] is None
    r = svc.reading_control(acc, "done", measured={"messages": 360, "seconds": 1800}, seconds=1800)
    assert r["job"]["state"] == "done" and r["job"]["seconds_spent"] == 1830
    assert r["capacity"]["per_hour"] == 720 and r["capacity"]["runs"] == 1
    after = estimate(store(), years=3)
    assert after["nights"] == {"low": 1, "high": 2, "per_night": 720 * 4, "measured": True}
    with pytest.raises(ValueError):
        svc.reading_control(acc, "approved")


def test_without_a_yes_the_passes_get_nothing(tmp_path):
    svc = service(tmp_path)
    with pytest.raises(Exception, match="not approved"):
        svc.reading_next(alex(svc))
    svc.decline_reading(alex(svc))
    with pytest.raises(Exception, match="not approved"):
        svc.reading_record(alex(svc), verdicts=[])


def test_the_pass_tools_are_reachable_and_a_refusing_folder_leaves_its_messages_for_later(tmp_path, monkeypatch):
    svc, client = ready(tmp_path)
    monkeypatch.setattr(server, "_service", svc)
    monkeypatch.setattr(server, "get_member_id", lambda: "id-alex")

    def call(name, args=None):
        return json.loads(asyncio.run(server.call_tool(name, args or {}))[0].text)

    assert call("reading_progress")["job"]["state"] == "approved"
    real = FakeIMAPClient.fetch

    def broken(self, uids, parts):
        if any(str(p).startswith("BODY.PEEK[TEXT]") for p in parts):
            raise RuntimeError("boom")
        return real(self, uids, parts)

    monkeypatch.setattr(FakeIMAPClient, "fetch", broken)
    out = call("reading_next", {"stage": "light", "limit": 3})
    assert out["messages"] == [] and len(out["missing"]) == 3 and out["errors"]
    monkeypatch.setattr(FakeIMAPClient, "fetch", real)
    assert len(call("reading_next", {"stage": "light", "limit": 3})["messages"]) == 3
    assert call("reading_control", {"state": "running"})["job"]["state"] == "running"
