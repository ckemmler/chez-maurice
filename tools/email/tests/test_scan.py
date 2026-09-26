"""The header scan (specs/mail-import.md, lot 1): a mailbox walked end to end,
interrupted anywhere, resumed without loss or duplication."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from tools.email import sealing, server
from tools.email.accounts import load_config
from tools.email.scan import KIND
from tools.email.service import AccessDenied, EmailService
from tools.email.store import MailStore, store_path

from .fakes import FakeIMAPClient, build_raw
from .test_email import CONFIG, write_config

GMAIL_ALL = "[Gmail]/Tous les messages"


@pytest.fixture(autouse=True)
def app_dir(monkeypatch, tmp_path):
    """The store and the key live under a throwaway app dir."""
    monkeypatch.setenv("MAURICE_DATA_DIR", str(tmp_path / "app"))
    monkeypatch.delenv("MAURICE_SECRET_KEY", raising=False)
    sealing.reset_key_cache()
    yield tmp_path / "app"
    sealing.reset_key_cache()


def messages(n: int, *, start: int = 1, prefix: str = "Sujet") -> dict[int, bytes]:
    return {
        uid: build_raw(f"{prefix} {uid}", f"Expéditeur {uid % 7} <e{uid % 7}@example.org>", f"corps {uid}",
                       date=f"Mon, 01 Sep 2026 08:{uid % 60:02d}:{(uid * 7) % 60:02d} +0200",
                       message_id=f"<{prefix.lower()}-{uid}@example.org>")
        for uid in range(start, start + n)
    }


def icloud(folders: dict[str, dict[int, bytes]] | None = None, **kw) -> FakeIMAPClient:
    return FakeIMAPClient(folders or {"INBOX": messages(1200), "Archive": messages(40, start=5000, prefix="Vieux"),
                                      "Deleted Messages": messages(3, start=9000, prefix="Poubelle")},
                          flags={"Deleted Messages": (b"\\Trash",)}, **kw)


def make_service(tmp_path: Path, clients: dict[str, FakeIMAPClient]) -> EmailService:
    """Every (re)connection is a clone of the account's fake, sharing its
    mailbox: a dropped connection is answered by the same server."""
    return EmailService(load_config(write_config(tmp_path, CONFIG)), client_factory=lambda acc: clients[acc.address].clone())


def fetches(client: FakeIMAPClient, folder: str | None = None) -> list[list[int]]:
    """The FETCH journal: which UIDs each batch asked for, in order."""
    out, selected = [], None
    for name, arg in client.calls:
        if name == "examine":
            selected = arg
        elif name == "fetch" and (folder is None or selected == folder):
            out.append(arg[0])
    return out


def scan(svc: EmailService, **kw):
    alex = svc.accounts(member_id="id-alex")
    return svc.scan_start(alex, account="icloud", background=False, **kw)


def store() -> MailStore:
    return MailStore.for_member("id-alex")


def stored_uids(folder: str, address: str = "alex@icloud.com") -> list[int]:
    return sorted(l["uid"] for l in store().locations() if l["folder"] == folder and l["address"] == address)


# ── the walk ─────────────────────────────────────────────────────────────


def test_a_mailbox_is_walked_in_batches_into_the_store(tmp_path):
    client = icloud()
    svc = make_service(tmp_path, {"alex@icloud.com": client})
    out = scan(svc)
    assert out["status"] == "done"
    assert out["totals"] == {"messages": 1240, "locations": 1240, "gone": 0}
    assert stored_uids("INBOX") == list(range(1, 1201))
    assert stored_uids("Archive") == list(range(5000, 5040))
    assert stored_uids("Deleted Messages") == []  # trash is not "everywhere"
    assert [len(b) for b in fetches(client, "INBOX")] == [500, 500, 200]
    assert store().cursor("alex@icloud.com", "INBOX") == (1, 1200)
    job = out["job"]
    assert job["kind"] == KIND and job["counts"]["written"] == 1240 and job["counts"]["folders"] == 2
    assert job["bytes_fetched"] > 0 and job["last_error"] is None
    # The file is under the member's id, beside maurice.db, not in it.
    assert store_path("id-alex").exists() and store_path("id-alex").parent.name == "mail"


def test_a_second_walk_fetches_nothing(tmp_path):
    client = icloud()
    svc = make_service(tmp_path, {"alex@icloud.com": client})
    scan(svc)
    before = len(fetches(client))
    searches_before = sum(1 for c in client.calls if c[0] == "search")
    out = scan(svc)
    assert out["status"] == "done" and out["totals"]["messages"] == 1240
    # The cursor is at UIDNEXT - 1: nothing to search for, nothing to fetch.
    assert len(fetches(client)) == before
    assert sum(1 for c in client.calls if c[0] == "search") == searches_before


def test_a_large_folder_is_searched_in_windows_not_in_one_line(tmp_path):
    """imaplib refuses a SEARCH answer over a megabyte, which a 150 000-message
    archive produces for `UID 1:*` (met on a real Gmail, 26 September 2026).
    So: windows of UIDs up to UIDNEXT, and a gap of expunged mail does not
    stall the cursor."""
    sparse = {uid: raw for uid, raw in messages(30).items()}
    sparse.update({uid + 25_000: raw for uid, raw in messages(5, start=1).items()})  # 25 001..25 005
    client = icloud({"INBOX": sparse})
    svc = make_service(tmp_path, {"alex@icloud.com": client})
    out = scan(svc, batch=10)
    assert out["status"] == "done" and out["totals"]["messages"] == 30  # the five are the same five (same Message-IDs)
    assert out["totals"]["locations"] == 35
    searches = [c[1][0] for c in client.calls if c[0] == "search"]
    assert searches[0] == ["UID", "1:10000"] and searches[1] == ["UID", "10001:20000"] and searches[2] == ["UID", "20001:25005"]
    assert store().cursor("alex@icloud.com", "INBOX") == (1, 25005)
    assert [len(b) for b in fetches(client, "INBOX")] == [10, 10, 10, 5]


def test_new_mail_is_picked_up_from_the_cursor(tmp_path):
    client = icloud()
    svc = make_service(tmp_path, {"alex@icloud.com": client})
    scan(svc)
    client.folders["INBOX"].update(messages(3, start=1201))
    scan(svc)
    assert stored_uids("INBOX") == list(range(1, 1204))
    assert fetches(client, "INBOX")[-1] == [1201, 1202, 1203]


def test_the_row_holds_the_parsed_fields_and_no_body(tmp_path):
    raw = build_raw("Lettre d'info", "News <news@list.example>", "corps",
                    headers={"List-Id": "<news.list.example>", "List-Unsubscribe": "<mailto:stop@list.example>",
                             "Precedence": "Bulk", "References": "<a@x>   <b@x>", "Cc": "c@example.org"})
    client = FakeIMAPClient({"INBOX": {1: raw}})
    svc = make_service(tmp_path, {"alex@icloud.com": client})
    scan(svc)
    (row,) = store().messages()
    assert row["sender_address"] == "news@list.example" and row["sender"] == "News <news@list.example>"
    assert json.loads(row["recipients"]) == ["alex@example.org"] and json.loads(row["cc"]) == ["c@example.org"]
    assert row["list_id"] == "<news.list.example>" and row["list_unsubscribe"] == 1 and row["precedence"] == "bulk"
    assert row["refs"] == "<a@x> <b@x>" and row["identity"] == "message_id" and row["id"].startswith("fp:")
    assert row["date"].startswith("2026-09-15") and row["size"] == len(raw)
    assert "corps" not in json.dumps(row)


# ── interruption and resumption ──────────────────────────────────────────


def test_an_exception_while_writing_replays_only_that_batch(tmp_path, monkeypatch):
    client = icloud({"INBOX": messages(1200)})
    svc = make_service(tmp_path, {"alex@icloud.com": client})
    real_write = MailStore.write_batch
    calls = {"n": 0}

    def flaky(self, *args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 2:
            raise RuntimeError("disk full")
        return real_write(self, *args, **kwargs)

    monkeypatch.setattr(MailStore, "write_batch", flaky)
    out = scan(svc)
    assert out["status"] == "failed" and "disk full" in out["job"]["last_error"]
    assert stored_uids("INBOX") == list(range(1, 501))  # the first batch, and nothing half-written
    assert store().cursor("alex@icloud.com", "INBOX") == (1, 500)

    out = scan(svc)
    assert out["status"] == "done"
    assert stored_uids("INBOX") == list(range(1, 1201))
    assert len(store().messages()) == 1200  # no duplicate rows
    assert fetches(client, "INBOX") == [list(range(1, 501)), list(range(501, 1001)),
                                        list(range(501, 1001)), list(range(1001, 1201))]


def test_a_connection_lost_during_a_fetch_replays_only_that_batch(tmp_path):
    client = icloud({"INBOX": messages(1200)})
    client.faults["drop_on_fetch"] = 2
    svc = make_service(tmp_path, {"alex@icloud.com": client})
    out = scan(svc)
    assert out["status"] == "done" and out["job"]["last_error"] is None
    assert stored_uids("INBOX") == list(range(1, 1201)) and len(store().messages()) == 1200
    assert fetches(client, "INBOX") == [list(range(1, 501)), list(range(501, 1001)),
                                        list(range(501, 1001)), list(range(1001, 1201))]
    assert len(client.connections) == 3  # the template, the first connection, the one reconnection


def test_a_stop_pauses_at_a_batch_boundary_and_the_next_start_continues(tmp_path, monkeypatch):
    client = icloud({"INBOX": messages(1200)})
    svc = make_service(tmp_path, {"alex@icloud.com": client})
    real_write = MailStore.write_batch

    def stop_after_first(self, *args, **kwargs):
        real_write(self, *args, **kwargs)
        svc._scans["id-alex"][0].stop()

    monkeypatch.setattr(MailStore, "write_batch", stop_after_first)
    out = scan(svc)
    assert out["status"] == "paused" and stored_uids("INBOX") == list(range(1, 501))
    monkeypatch.setattr(MailStore, "write_batch", real_write)
    out = scan(svc)
    assert out["status"] == "done" and stored_uids("INBOX") == list(range(1, 1201))
    assert fetches(client, "INBOX") == [list(range(1, 501)), list(range(501, 1001)), list(range(1001, 1201))]


# ── UIDVALIDITY ──────────────────────────────────────────────────────────


def test_a_renumbered_folder_is_rescanned_without_ghosts(tmp_path):
    client = icloud({"INBOX": messages(30)})
    svc = make_service(tmp_path, {"alex@icloud.com": client})
    scan(svc)
    assert store().cursor("alex@icloud.com", "INBOX") == (1, 30)
    # The server rebuilt the folder: same mail, new numbering, one message gone.
    old = client.folders["INBOX"]
    client.folders["INBOX"] = {uid + 1000: raw for uid, raw in old.items() if uid != 17}
    client.uidvalidity["INBOX"] = 2
    out = scan(svc)
    assert out["status"] == "done"
    assert store().cursor("alex@icloud.com", "INBOX") == (2, 1030)
    locations = store().locations()
    assert {l["uidvalidity"] for l in locations} == {2}  # the old generation is gone
    assert sorted(l["uid"] for l in locations) == [uid + 1000 for uid in range(1, 31) if uid != 17]
    assert len(store().messages()) == 30  # identities survive the renumbering; message 17 keeps its row
    assert out["job"]["counts"]["purged"] == 30
    assert fetches(client, "INBOX")[-1] == [uid + 1000 for uid in range(1, 31) if uid != 17]  # nothing skipped


# ── reorganisation ───────────────────────────────────────────────────────


def test_a_moved_message_is_one_message_with_two_locations(tmp_path):
    client = icloud({"INBOX": messages(10), "Projets": {}})
    svc = make_service(tmp_path, {"alex@icloud.com": client})
    scan(svc)
    moved = client.folders["INBOX"].pop(4)
    client.folders["Projets"][1] = moved
    out = scan(svc)
    assert out["totals"] == {"messages": 10, "locations": 11, "gone": 0}
    (row,) = [m for m in store().messages() if m["message_id"] == "<sujet-4@example.org>"]
    assert [(l["folder"], l["uid"]) for l in store().locations(row["id"])] == [("INBOX", 4), ("Projets", 1)]


def test_a_renamed_folder_is_the_same_messages_with_new_locations(tmp_path):
    client = icloud({"INBOX": messages(3), "Projets": messages(20, start=100, prefix="Projet")})
    svc = make_service(tmp_path, {"alex@icloud.com": client})
    scan(svc)
    client.folders["Dossiers"] = client.folders.pop("Projets")
    client.uidvalidity["Dossiers"] = 9
    out = scan(svc)
    assert out["totals"] == {"messages": 23, "locations": 43, "gone": 0}
    assert len(stored_uids("Dossiers")) == 20 and len(stored_uids("Projets")) == 20  # the old name is a memory


# ── Gmail ────────────────────────────────────────────────────────────────


def test_gmail_identity_is_the_msgid_not_the_uid(tmp_path):
    raw = build_raw("Votre commande", "Shop <no-reply@shop.example>", "Livrée demain")
    client = FakeIMAPClient(
        {"INBOX": {}, GMAIL_ALL: {7: raw}, "[Gmail]/Corbeille": {}},
        flags={GMAIL_ALL: (b"\\All",), "[Gmail]/Corbeille": (b"\\Trash",)},
        gm_msgids={(GMAIL_ALL, 7): 1_718_000_000_000_000_001},
    )
    svc = make_service(tmp_path, {"alex@gmail.com": client})
    alex = svc.accounts(member_id="id-alex")
    svc.scan_start(alex, account="gmail", background=False)
    (row,) = store().messages()
    assert row["id"] == "gm:1718000000000000001" and row["identity"] == "gm_msgid"
    assert "X-GM-MSGID" in fetches_parts(client)[0] and fetches(client) == [[7]]
    # Gmail gave the message a new UID (a label change on some servers, an
    # import on others); the X-GM-MSGID is the same, so is the row.
    del client.folders[GMAIL_ALL][7]
    client.folders[GMAIL_ALL][8] = raw
    client.gm_msgids[(GMAIL_ALL, 8)] = 1_718_000_000_000_000_001
    out = svc.scan_start(alex, account="gmail", background=False)
    assert out["totals"] == {"messages": 1, "locations": 2, "gone": 0}
    assert [c[1] for c in client.calls if c[0] == "examine"].count(GMAIL_ALL) >= 2
    examined = {c[1] for c in client.calls if c[0] == "examine"}
    assert examined == {GMAIL_ALL}  # \All holds everything: the inbox is not walked twice


def fetches_parts(client: FakeIMAPClient) -> list[list[str]]:
    return [arg[1] for name, arg in client.calls if name == "fetch"]


def test_objectid_servers_give_their_emailid(tmp_path):
    client = FakeIMAPClient({"INBOX": {1: build_raw("A", "a@b.c", "x")}}, capabilities=(b"IMAP4rev1", b"OBJECTID"),
                            emailids={("INBOX", 1): "M6d99665ae7ca4c6ba39e20d9f6b1f3ef"})
    svc = make_service(tmp_path, {"alex@icloud.com": client})
    scan(svc)
    (row,) = store().messages()
    assert row["id"] == "oid:m6d99665ae7ca4c6ba39e20d9f6b1f3ef" and row["identity"] == "emailid"
    assert "EMAILID" in fetches_parts(client)[0]


def test_without_a_message_id_the_identity_is_a_weak_fingerprint(tmp_path):
    client = FakeIMAPClient({"INBOX": {1: build_raw("Sans id", "a@b.c", "x", message_id=False)}})
    svc = make_service(tmp_path, {"alex@icloud.com": client})
    scan(svc)
    (row,) = store().messages()
    assert row["id"].startswith("fp2:") and row["identity"] == "weak" and row["message_id"] is None


# ── the seal ─────────────────────────────────────────────────────────────


def test_the_subject_is_sealed_in_the_file(tmp_path):
    client = FakeIMAPClient({"INBOX": {1: build_raw("Audience du 14 mars garde alternee", "avocat@cabinet.example", "x")}})
    svc = make_service(tmp_path, {"alex@icloud.com": client})
    scan(svc)
    (row,) = store().messages()
    assert sealing.unseal(row["subject_sealed"]) == "Audience du 14 mars garde alternee"
    blob = store_path("id-alex").read_bytes()
    for wal in (store_path("id-alex").with_suffix(".db-wal"),):
        if wal.exists():
            blob += wal.read_bytes()
    assert b"Audience" not in blob and b"garde alternee" not in blob
    assert b"avocat@cabinet.example" in blob  # the structural fields stay in clear, indexed


# ── who, and through which door ──────────────────────────────────────────


def test_the_store_is_the_members_and_a_call_without_a_member_is_refused(tmp_path):
    svc = make_service(tmp_path, {"alex@icloud.com": icloud({"INBOX": messages(2)}), "sam@icloud.com": icloud({"INBOX": messages(5)})})
    svc.scan_start(svc.accounts(member_id="id-alex"), account="icloud", background=False)
    svc.scan_start(svc.accounts(member_id="id-sam"), account="icloud", background=False)
    assert MailStore.for_member("id-alex").totals()["messages"] == 2
    assert MailStore.for_member("id-sam").totals()["messages"] == 5
    with pytest.raises(AccessDenied):
        svc.scan_status(svc.accounts(username="nobody"))


def test_the_mcp_tools_start_in_the_background_and_report(tmp_path, monkeypatch):
    client = icloud({"INBOX": messages(30)})
    svc = make_service(tmp_path, {"alex@icloud.com": client})
    monkeypatch.setattr(server, "_service", svc)
    monkeypatch.setattr(server, "get_member_id", lambda: "id-alex")

    def call(name, args=None):
        return json.loads(asyncio.run(server.call_tool(name, args or {}))[0].text)

    out = call("scan_mailbox", {"account": "icloud"})
    assert out["status"] in {"started", "running"} and out["job"]["kind"] == KIND
    for _ in range(200):
        status = call("scan_status")
        if not status["running"]:
            break
        asyncio.run(asyncio.sleep(0.02))
    assert status["job"]["state"] == "done" and status["totals"]["messages"] == 30
    assert status["cursors"] == [{"address": "alex@icloud.com", "folder": "INBOX", "uidvalidity": 1,
                                 "highest_uid_done": 30, "updated_at": status["cursors"][0]["updated_at"]}]
    assert call("scan_stop")["status"] in {"idle", "stopping"}


def test_a_dead_process_leaves_a_job_that_the_next_start_marks_paused(tmp_path):
    """The job row is a lease: `updated_at` moves at every batch. A 'running'
    row with a fresh heartbeat is another process, still walking — the CLI
    beside the gateway — and is joined, not doubled. A stale one is dead."""
    client = icloud({"INBOX": messages(2)})
    svc = make_service(tmp_path, {"alex@icloud.com": client})
    st = store()
    fresh = st.create_job("id-alex", KIND)
    out = scan(svc)
    assert out["status"] == "running" and out["job"]["id"] == fresh["id"] and "another process" in out["note"]
    assert st.totals()["messages"] == 0  # nothing walked over the other's cursors
    import sqlite3
    with sqlite3.connect(st.path) as conn:
        conn.execute("UPDATE jobs SET updated_at = '2026-09-26T00:00:00+00:00' WHERE id = ?", (fresh["id"],))
    out = scan(svc)
    assert out["status"] == "done"
    assert st.job(fresh["id"])["state"] == "paused"
    assert st.latest_job(KIND)["state"] == "done" and st.totals()["messages"] == 2


def test_one_folder_refusing_does_not_cost_the_others(tmp_path, monkeypatch):
    client = icloud({"INBOX": messages(3), "Broken": messages(2, start=50), "Projets": messages(4, start=100, prefix="P")})
    real_select = FakeIMAPClient.select_folder

    def select_folder(self, folder, readonly=False):
        if folder == "Broken":
            raise ValueError("[SERVERBUG] cannot EXAMINE a virtual folder")
        return real_select(self, folder, readonly)

    monkeypatch.setattr(FakeIMAPClient, "select_folder", select_folder)
    svc = make_service(tmp_path, {"alex@icloud.com": client})
    out = scan(svc)
    assert out["status"] == "failed" and "Broken" in out["job"]["last_error"]
    assert out["totals"]["messages"] == 7  # INBOX and Projets both walked
    assert out["job"]["counts"]["accounts"]["alex@icloud.com"]["folder_errors"].keys() == {"Broken"}


def test_a_server_without_uidnext_is_asked_for_its_last_uid_only(tmp_path):
    client = icloud({"INBOX": messages(30)})
    client.omit_uidnext = True
    svc = make_service(tmp_path, {"alex@icloud.com": client})
    out = scan(svc, batch=10)
    assert out["status"] == "done" and out["totals"]["messages"] == 30
    searches = [c[1][0] for c in client.calls if c[0] == "search"]
    assert searches[0] == ["UID", "*"] and searches[1] == ["UID", "1:30"]
    assert not any(s[1].endswith(":*") for s in searches)  # never the whole folder in one line


def test_a_display_name_with_a_comma_is_one_address(tmp_path):
    raw = build_raw("Rdv", '"Dupont, Jean" <jean@example.org>', "x",
                    headers={"Cc": '"Martin, Anne" <anne@example.org>, bob@example.org'})
    client = FakeIMAPClient({"INBOX": {1: raw}})
    svc = make_service(tmp_path, {"alex@icloud.com": client})
    scan(svc)
    (row,) = store().messages()
    assert row["sender"] == '"Dupont, Jean" <jean@example.org>' and row["sender_address"] == "jean@example.org"
    assert json.loads(row["cc"]) == ['"Martin, Anne" <anne@example.org>', "bob@example.org"]
