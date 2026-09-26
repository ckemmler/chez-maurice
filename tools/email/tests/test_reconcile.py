"""The weekly reconciliation (specs/mail-import.md, lot 2): the store trimmed
to what the mailbox still holds, by relisting UIDs — never by fetching."""

from __future__ import annotations

import pytest

from tools.email.reconcile import KIND
from tools.email.scan import KIND as SCAN_KIND
from tools.email.store import MailStore

from .fakes import FakeIMAPClient
from .test_scan import app_dir, icloud, make_service, messages, scan, store, stored_uids  # noqa: F401 — fixtures

pytestmark = pytest.mark.usefixtures("app_dir")


def reconcile(svc, **kw):
    alex = svc.accounts(member_id="id-alex")
    return svc.reconcile_start(alex, account="icloud", background=False, **kw)


def calls_of(client: FakeIMAPClient, name: str):
    return [arg for n, arg in client.calls if n == name]


def test_a_vanished_uid_loses_its_location_and_the_message_keeps_its_row(tmp_path):
    client = icloud({"INBOX": messages(30)})
    svc = make_service(tmp_path, {"alex@icloud.com": client})
    scan(svc)
    del client.folders["INBOX"][7]
    del client.folders["INBOX"][8]
    fetches_before = len(calls_of(client, "fetch"))
    out = reconcile(svc)
    assert out["status"] == "done" and out["job"]["kind"] == KIND
    assert out["job"]["counts"]["removed"] == 2 and out["job"]["counts"]["gone"] == 2 and out["job"]["counts"]["folders"] == 1
    assert stored_uids("INBOX") == [u for u in range(1, 31) if u not in (7, 8)]
    assert len(store().messages()) == 30  # the rows stay
    assert out["totals"] == {"messages": 30, "locations": 28, "gone": 2}
    gone = {m["message_id"] for m in store().messages() if m["gone_at"]}
    assert gone == {"<sujet-7@example.org>", "<sujet-8@example.org>"}
    # No FETCH at all: the listing is UID SEARCH windows only.
    assert len(calls_of(client, "fetch")) == fetches_before
    assert ["UID", "1:30"] in [s[0] for s in calls_of(client, "search")]


def test_a_message_seen_again_is_no_longer_gone(tmp_path):
    client = icloud({"INBOX": messages(5), "Projets": {}})
    svc = make_service(tmp_path, {"alex@icloud.com": client})
    scan(svc)
    moved = client.folders["INBOX"].pop(3)
    reconcile(svc)
    (row,) = [m for m in store().messages() if m["message_id"] == "<sujet-3@example.org>"]
    assert row["gone_at"] is not None
    # It was moved, not deleted: the next walk finds it in Projets.
    client.folders["Projets"][1] = moved
    scan(svc)
    (row,) = [m for m in store().messages() if m["message_id"] == "<sujet-3@example.org>"]
    assert row["gone_at"] is None
    assert store().totals() == {"messages": 5, "locations": 5, "gone": 0}


def test_a_folder_gone_from_list_loses_its_locations_and_its_cursor(tmp_path):
    client = icloud({"INBOX": messages(3), "Projets": messages(4, start=100, prefix="Projet")})
    svc = make_service(tmp_path, {"alex@icloud.com": client})
    scan(svc)
    assert store().cursor("alex@icloud.com", "Projets") == (1, 103)
    del client.folders["Projets"]
    out = reconcile(svc)
    assert out["job"]["counts"]["dropped_folders"] == 1 and out["job"]["counts"]["removed"] == 4
    assert stored_uids("Projets") == [] and store().cursor("alex@icloud.com", "Projets") is None
    assert out["totals"] == {"messages": 7, "locations": 3, "gone": 4}
    # Back under the same name: walked afresh, and its messages are seen again.
    client.folders["Projets"] = messages(4, start=100, prefix="Projet")
    scan(svc)
    assert store().totals() == {"messages": 7, "locations": 7, "gone": 0}


def test_a_renumbered_folder_is_purged_and_left_to_the_next_walk(tmp_path):
    client = icloud({"INBOX": messages(10)})
    svc = make_service(tmp_path, {"alex@icloud.com": client})
    scan(svc)
    client.folders["INBOX"] = {uid + 500: raw for uid, raw in client.folders["INBOX"].items()}
    client.uidvalidity["INBOX"] = 2
    out = reconcile(svc)
    assert out["job"]["counts"]["renumbered"] == 1 and out["job"]["counts"]["removed"] == 10
    assert store().cursor("alex@icloud.com", "INBOX") == (2, 0)
    assert store().totals()["gone"] == 10
    scan(svc)
    assert store().totals() == {"messages": 10, "locations": 10, "gone": 0}


def test_a_large_folder_is_listed_in_windows(tmp_path):
    sparse = dict(messages(5))
    sparse.update({uid + 25_000: raw for uid, raw in messages(3, start=6, prefix="Loin").items()})
    client = icloud({"INBOX": sparse})
    svc = make_service(tmp_path, {"alex@icloud.com": client})
    scan(svc)
    del client.folders["INBOX"][25_007]
    n = len(calls_of(client, "search"))
    out = reconcile(svc)
    assert out["job"]["counts"]["removed"] == 1
    windows = [s[0] for s in calls_of(client, "search")[n:]]
    assert windows == [["UID", "1:10000"], ["UID", "10001:20000"], ["UID", "20001:25008"]]


def test_not_while_a_walk_is_running_and_the_other_way_round(tmp_path):
    client = icloud({"INBOX": messages(2)})
    svc = make_service(tmp_path, {"alex@icloud.com": client})
    st = store()
    walking = st.create_job("id-alex", SCAN_KIND)
    out = reconcile(svc)
    assert out["status"] == "running" and out["job"]["id"] == walking["id"] and "headers job" in out["note"]
    st.update_job(walking["id"], state="done")
    trimming = st.create_job("id-alex", KIND)
    out = scan(svc)
    assert out["status"] == "running" and out["job"]["id"] == trimming["id"] and "reconcile job" in out["note"]
    st.update_job(trimming["id"], state="done")
    assert scan(svc)["status"] == "done"
    status = svc.scan_status(svc.accounts(member_id="id-alex"))
    assert status["running"] is False and status["job"]["kind"] == SCAN_KIND and status["reconcile"]["kind"] == KIND


def test_a_folder_that_refuses_is_skipped_and_nothing_of_it_is_removed(tmp_path, monkeypatch):
    client = icloud({"INBOX": messages(3), "Broken": messages(2, start=50)})
    svc = make_service(tmp_path, {"alex@icloud.com": client})
    scan(svc)
    real_select = FakeIMAPClient.select_folder

    def select_folder(self, folder, readonly=False):
        if folder == "Broken":
            raise ValueError("[SERVERBUG] cannot EXAMINE")
        return real_select(self, folder, readonly)

    monkeypatch.setattr(FakeIMAPClient, "select_folder", select_folder)
    del client.folders["INBOX"][2]
    out = reconcile(svc)
    assert out["status"] == "failed" and "Broken" in out["job"]["last_error"]
    assert out["job"]["counts"]["removed"] == 1 and len(stored_uids("Broken")) == 2


def test_a_stop_mid_listing_removes_nothing_of_that_folder(tmp_path, monkeypatch):
    sparse = dict(messages(30))
    sparse.update({uid + 25_000: raw for uid, raw in messages(3, start=31, prefix="Loin").items()})
    client = icloud({"INBOX": sparse})
    svc = make_service(tmp_path, {"alex@icloud.com": client})
    scan(svc, batch=10)
    del client.folders["INBOX"][5]
    real_search = FakeIMAPClient.search

    def stop_on_search(self, criteria, charset=None):
        svc._scans["id-alex"][0].stop()  # after the first window; two more were due
        return real_search(self, criteria, charset)

    monkeypatch.setattr(FakeIMAPClient, "search", stop_on_search)
    out = svc.reconcile_start(svc.accounts(member_id="id-alex"), account="icloud", background=False)
    assert out["status"] == "paused" and out["job"]["last_error"] is None
    assert store().totals()["locations"] == 33  # a partial list must not delete anything
