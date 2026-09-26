"""The triage and the free report (specs/mail-import.md, lot 2): bulk or
correspondence from the headers alone, the person winning over the mark; who
writes, what fills the box, which threads live, who never got an answer."""

from __future__ import annotations

import json
from datetime import datetime, timezone

import pytest

from tools.email import sealing, server
from tools.email.triage import classify, replied_addresses, report, triage_store

from .fakes import FakeIMAPClient, build_raw
from .test_scan import app_dir, make_service, scan, store  # noqa: F401 — fixtures

pytestmark = pytest.mark.usefixtures("app_dir")

ME = "alex@icloud.com"
NOW = datetime(2026, 9, 26, tzinfo=timezone.utc)


def row(sender: str | None, **fields):
    return {"sender_address": sender, "list_id": None, "list_unsubscribe": 0, "precedence": None, **fields}


# ── the rule ─────────────────────────────────────────────────────────────


def test_marks_make_bulk_and_a_person_wins_over_the_mark():
    member, replied, contacts = {ME}, {"jean@example.org"}, {"anne@example.org"}
    k = lambda r: classify(r, member=member, replied=replied, contacts=contacts)  # noqa: E731
    assert k(row("news@list.example", list_id="<news.list.example>")) == ("bulk", "list_id")
    assert k(row("shop@example.com", list_unsubscribe=1)) == ("bulk", "list_unsubscribe")
    assert k(row("robot@example.com", precedence="bulk")) == ("bulk", "precedence")
    assert k(row("robot@example.com", precedence="List")) == ("bulk", "precedence")
    assert k(row("jean@example.org", list_id="<group.example.org>")) == ("correspondence", "replied")  # a friend through a group
    assert k(row("anne@example.org", precedence="bulk")) == ("correspondence", "contact")
    assert k(row(ME, list_unsubscribe=1)) == ("correspondence", "sent")
    assert k(row("stranger@example.net")) == ("other", "unmarked")
    assert k(row(None)) == ("other", "no_sender")
    for machine in ("no-reply@accounts.google.com", "noreply@uber.com", "notifications@github.com", "do-not-reply@x.org", "mailer-daemon@x.org"):
        assert k(row(machine)) == ("bulk", "noreply"), machine
    assert k(row("norepl@example.org")) == ("other", "unmarked")


def test_the_member_answers_are_read_from_their_own_mail():
    rows = [
        {"sender_address": ME, "recipients": json.dumps(["Jean <jean@example.org>"]), "cc": json.dumps(["anne@example.org", ME])},
        {"sender_address": "other@example.org", "recipients": json.dumps([ME]), "cc": "[]"},
        {"sender_address": None, "recipients": "not json", "cc": None},
    ]
    assert replied_addresses(rows, {ME}) == {"jean@example.org", "anne@example.org"}


# ── on a store ───────────────────────────────────────────────────────────


def mailbox() -> dict[int, bytes]:
    """A year of one person's mail: a newsletter, a shop, a friend written to,
    a colleague through a group, a contact, a stranger who wrote twice and
    never heard back, and the member's own replies."""
    d = lambda m, day=1, h=9: f"Mon, {day:02d} {m} 2026 {h:02d}:00:00 +0200"  # noqa: E731
    msgs = {
        1: build_raw("Lettre 1", "News <news@list.example>", "x", date=d("Jun"), message_id="<n1@x>",
                     headers={"List-Id": "<news.list.example>", "List-Unsubscribe": "<mailto:u@x>"}),
        2: build_raw("Lettre 2", "News <news@list.example>", "x" * 5000, date=d("Jul"), message_id="<n2@x>",
                     headers={"List-Id": "<news.list.example>"}),
        3: build_raw("Votre commande", "Shop <shop@shop.example>", "x", date=d("Jul", 3), message_id="<s1@x>",
                     headers={"List-Unsubscribe": "<mailto:u@shop.example>"}),
        12: build_raw("Alerte", "Robot <robot@example.com>", "x", date=d("Jul", 4), message_id="<r1@x>",
                      headers={"Precedence": "bulk"}),
        4: build_raw("Projet jardin", "Jean <jean@example.org>", "x", date=d("Aug", 1), message_id="<j1@x>"),
        5: build_raw("Re: Projet jardin", f"Alex <{ME}>", "x", date=d("Aug", 2), message_id="<a1@x>",
                     headers={"References": "<j1@x>", "To": "jean@example.org"}),
        6: build_raw("Re: Projet jardin", "Jean <jean@example.org>", "x", date=d("Sep", 20), message_id="<j2@x>",
                     headers={"References": "<j1@x> <a1@x>"}),
        7: build_raw("Réunion", "Paul <paul@work.example>", "x", date=d("Sep", 10), message_id="<p1@x>",
                     headers={"List-Id": "<team.work.example>"}),
        8: build_raw("Devis", "Inconnu <inconnu@example.net>", "x", date=d("May", 5), message_id="<i1@x>"),
        9: build_raw("Relance devis", "Inconnu <inconnu@example.net>", "x", date=d("Jun", 5), message_id="<i2@x>",
                     headers={"References": "<i1@x>"}),
        10: build_raw("Vieux", "Ancien <ancien@example.org>", "x", date="Mon, 01 Jan 2018 09:00:00 +0100", message_id="<old@x>"),
        11: build_raw("Bonjour", "Anne <anne@example.org>", "x", date=d("Sep", 1), message_id="<an1@x>"),
    }
    return msgs


def test_the_store_is_triaged_and_the_verdicts_are_kept_with_their_reasons(tmp_path):
    client = FakeIMAPClient({"INBOX": mailbox()})
    svc = make_service(tmp_path, {ME: client})
    scan(svc)
    alex = svc.accounts(member_id="id-alex")
    out = svc.triage(alex, contacts=["Anne@example.org"])
    assert out["messages"] == 12 and ME in out["member_addresses"] and out["replied_to"] == 1 and out["contacts"] == 1
    assert out["counts"] == {"bulk": 5, "correspondence": 4, "other": 3}
    assert out["reasons"] == {"list_id": 3, "list_unsubscribe": 1, "precedence": 1, "replied": 2, "sent": 1, "contact": 1, "unmarked": 3}
    st = store()
    kinds = st.triage_kinds()
    by_mid = {m["message_id"]: m["id"] for m in st.messages()}
    assert kinds[by_mid["<j1@x>"]] == "correspondence" and kinds[by_mid["<p1@x>"]] == "bulk" and kinds[by_mid["<i1@x>"]] == "other"
    # Recomputable: without the contact, Anne is a stranger.
    out = svc.triage(alex)
    assert out["counts"] == {"bulk": 5, "correspondence": 3, "other": 4}
    assert st.triage_counts()["counts"] == {"bulk": 5, "correspondence": 3, "other": 4}


def test_the_report_says_who_writes_what_fills_what_lives_and_who_never_heard_back(tmp_path):
    client = FakeIMAPClient({"INBOX": mailbox()})
    svc = make_service(tmp_path, {ME: client})
    scan(svc)
    svc.triage(svc.accounts(member_id="id-alex"), contacts=["anne@example.org"])
    out = report(store(), member={ME}, unseal=sealing.unseal, years=3, now=NOW)
    assert out["since"] == "2023-09-27" and out["totals"] == {
        "messages": 12, "in_window": 11, "bulk": 5, "correspondence": 4, "other": 2, "untriaged": 0, "gone": 0,
    }
    who = {e["sender"]: e for e in out["who_writes"]}
    assert set(who) == {"jean@example.org", "inconnu@example.net", "anne@example.org"}  # no bulk, not the member, not 2018
    assert who["jean@example.org"] == {"sender": "jean@example.org", "name": "Jean <jean@example.org>", "messages": 2,
                                       "first": "2026-08-01", "last": "2026-09-20", "kind": "correspondence", "replied": True}
    assert who["inconnu@example.net"]["replied"] is False
    fills = out["what_fills"]
    assert [e["source"] for e in fills["by_messages"]] == ["<news.list.example>", "<team.work.example>", "robot@example.com", "shop@shop.example"]
    assert fills["by_bytes"][0]["source"] == "<news.list.example>" and fills["by_bytes"][0]["bytes"] > 5000
    (alive,) = out["alive_threads"]
    assert alive["subject"] == "Projet jardin" and alive["messages"] == 3 and alive["last"] == "2026-09-20"
    assert alive["participants"] == [ME, "jean@example.org"]
    assert out["never_answered"] == [{"sender": "inconnu@example.net", "name": "Inconnu <inconnu@example.net>", "messages": 2,
                                      "first": "2026-05-05", "last": "2026-06-05", "replied": False}]


def test_the_report_tool_triages_first_when_nothing_was(tmp_path, monkeypatch):
    client = FakeIMAPClient({"INBOX": mailbox()})
    svc = make_service(tmp_path, {ME: client})
    scan(svc)
    monkeypatch.setattr(server, "_service", svc)
    monkeypatch.setattr(server, "get_member_id", lambda: "id-alex")
    import asyncio

    out = json.loads(asyncio.run(server.call_tool("mailbox_report", {"years": 3}))[0].text)
    assert out["totals"]["untriaged"] == 0 and out["totals"]["bulk"] == 5
    assert "third parties" in out["notice"]
    out = json.loads(asyncio.run(server.call_tool("triage_mailbox", {"contacts": ["anne@example.org"]}))[0].text)
    assert out["counts"]["correspondence"] == 4
