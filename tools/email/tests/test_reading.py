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
