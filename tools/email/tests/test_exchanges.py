"""What the header store answers without the mailbox: a search's matches
ordered by the date the mail bears, and the exchanges with one person."""

from __future__ import annotations

import pytest

from tools.email import sealing, server
from tools.email.service import EmailService
from tools.email.accounts import load_config
from tools.email.imap import MailboxError

from .fakes import FakeIMAPClient, build_raw
from .test_email import CONFIG, write_config


@pytest.fixture(autouse=True)
def fresh_key(monkeypatch):
    monkeypatch.delenv("MAURICE_SECRET_KEY", raising=False)
    sealing.reset_key_cache()
    yield
    sealing.reset_key_cache()


def mail(subject: str, sender: str, date: str, **headers: str) -> bytes:
    return build_raw(subject, sender, "corps", date=date, message_id=f"<{abs(hash(subject))}@x.example>", headers=headers)


def proton_like() -> FakeIMAPClient:
    """An archive imported after the fact: the old mail has the high UIDs."""
    return FakeIMAPClient({
        "INBOX": {
            1: mail("Partie du domicile en frais", "Alex <alex@icloud.com>", "Tue, 22 Sep 2026 10:22:48 +0000", To="Mélanie Fricheteau <mela@partfin.be>"),
            2: mail("Paiement WinBooks", "Alex <alex@icloud.com>", "Thu, 10 Sep 2026 09:00:00 +0000", To="mela@partfin.be"),
            3: mail("RE: Dépôt rejeté", "=?utf-8?q?M=C3=A9lanie_Fricheteau?= <mela@partfin.be>", "Wed, 26 Aug 2026 10:04:26 +0000"),
            4: mail("Newsletter", "Shop <news@shop.example>", "Mon, 21 Sep 2026 08:00:00 +0000"),
            5: mail("Bonjour", "Carmela <carmela@partfin.be>", "Mon, 21 Sep 2026 09:00:00 +0000", To="carmela@partfin.be"),
            900: mail("RE: achat vélo", "Mélanie Fricheteau <mela@partfin.be>", "Tue, 12 Dec 2017 10:01:30 +0000"),
            901: mail("achat vélo", "Alex <alex@icloud.com>", "Mon, 11 Dec 2017 10:01:30 +0000", Cc="mela@partfin.be"),
            902: mail("RE: TVA", "FRICHETEAU Melanie <mela@partfin.be>", "Wed, 06 Dec 2017 10:01:30 +0000"),
        },
    })


def walked(tmp_path) -> tuple[EmailService, FakeIMAPClient]:
    client = proton_like()
    svc = EmailService(load_config(write_config(tmp_path, CONFIG)), client_factory=lambda acc: client.clone())
    svc.scan_start(svc.accounts(member_id="id-alex"), account="icloud", background=False)
    return svc, client


def test_a_search_returns_the_newest_by_date_not_by_uid(tmp_path):
    svc, _ = walked(tmp_path)
    out = svc.search(svc.accounts(member_id="id-alex"), account="icloud", sender="partfin.be", limit=2)
    assert [m["subject"] for m in out["messages"]] == ["Bonjour", "RE: Dépôt rejeté"]
    assert out["matches"] == 4  # FROM: her three, and carmela@


def test_mail_newer_than_the_walk_comes_first(tmp_path):
    svc, client = walked(tmp_path)
    client.folders["INBOX"][1000] = mail("Réponse domicile", "Mélanie Fricheteau <mela@partfin.be>", "Sun, 27 Sep 2026 08:00:00 +0000")
    out = svc.search(svc.accounts(member_id="id-alex"), account="icloud", sender="mela@partfin.be", limit=2)
    # IMAP's FROM is a substring match: carmela@ is in, as it always was.
    assert [m["subject"] for m in out["messages"]] == ["Réponse domicile", "Bonjour"]


def test_without_a_store_a_search_keeps_the_uid_order(tmp_path):
    client = proton_like()
    svc = EmailService(load_config(write_config(tmp_path, CONFIG)), client_factory=lambda acc: client.clone())
    out = svc.search(svc.accounts(member_id="id-alex"), account="icloud", sender="mela@partfin.be", limit=2)
    assert {m["subject"] for m in out["messages"]} == {"RE: achat vélo", "RE: TVA"}


def test_exchanges_with_an_address_every_direction_newest_first(tmp_path):
    svc, client = walked(tmp_path)
    calls = len(client.calls)
    out = svc.exchanges(svc.accounts(member_id="id-alex"), party="mela@partfin.be", limit=3)
    assert len(client.calls) == calls  # the mailbox is not asked
    assert out["total"] == 6  # from her, to her, her in copy — not carmela@
    assert out["first"].startswith("2017-12-06") and out["last"].startswith("2026-09-22")
    assert [m["subject"] for m in out["messages"]] == ["Partie du domicile en frais", "Paiement WinBooks", "RE: Dépôt rejeté"]
    first = out["messages"][0]
    assert first["where"] == {"account": "icloud", "folder": "INBOX", "uid": 1}
    assert first["mailboxes"] == ["alex@icloud.com"]
    assert out["messages"][2]["from"].startswith("Mélanie Fricheteau")
    assert out["as_of"] and "since=" in out["note"]


def test_exchanges_with_a_domain_or_a_name(tmp_path):
    svc, _ = walked(tmp_path)
    alex = svc.accounts(member_id="id-alex")
    assert svc.exchanges(alex, party="partfin.be")["total"] == 7
    out = svc.exchanges(alex, party="melanie fricheteau")
    assert out["addresses"] == ["mela@partfin.be"]
    assert out["matched"][0]["names"] == ["FRICHETEAU Melanie", "Mélanie Fricheteau"]
    assert out["total"] == 6
    nobody = svc.exchanges(alex, party="Personne Inconnue")
    assert nobody["total"] == 0 and "no sender" in nobody["note"]


def test_exchanges_need_a_walked_store(tmp_path):
    svc = EmailService(load_config(write_config(tmp_path, CONFIG)), client_factory=lambda acc: proton_like())
    with pytest.raises(MailboxError):
        svc.exchanges(svc.accounts(member_id="id-alex"), party="mela@partfin.be")


def test_the_tool_is_listed_and_dispatched(tmp_path):
    import asyncio
    names = [t.name for t in asyncio.run(server.list_tools())]
    assert "exchanges" in names
    svc, _ = walked(tmp_path)
    out = server.dispatch(svc, "exchanges", {"with": "partfin.be", "limit": 1}, member_id="id-alex")
    assert out["returned"] == 1


def test_a_message_without_a_date_does_not_stand_for_the_first_exchange(tmp_path):
    client = proton_like()
    client.folders["INBOX"][50] = build_raw("Sans date", "Mélanie Fricheteau <mela@partfin.be>", "corps", date="pas une date", message_id="<nodate@x.example>")
    svc = EmailService(load_config(write_config(tmp_path, CONFIG)), client_factory=lambda acc: client.clone())
    svc.scan_start(svc.accounts(member_id="id-alex"), account="icloud", background=False)
    out = svc.exchanges(svc.accounts(member_id="id-alex"), party="mela@partfin.be")
    assert out["total"] == 7
    assert out["first"].startswith("2017-12-06") and out["last"].startswith("2026-09-22")


def test_a_first_name_for_several_people_gives_the_candidates_not_their_mail_mixed(tmp_path):
    client = proton_like()
    client.folders["INBOX"][60] = build_raw("Salut", "Mélanie Durand <md@x.example>", "corps", date="Mon, 01 Jun 2026 08:00:00 +0000", message_id="<md@x.example>")
    svc = EmailService(load_config(write_config(tmp_path, CONFIG)), client_factory=lambda acc: client.clone())
    svc.scan_start(svc.accounts(member_id="id-alex"), account="icloud", background=False)
    alex = svc.accounts(member_id="id-alex")
    out = svc.exchanges(alex, party="Mélanie")
    assert out["ambiguous"] is True and "messages" not in out
    assert {m["address"] for m in out["matched"]} == {"mela@partfin.be", "md@x.example"}
    assert "full name" in out["note"]
    assert svc.exchanges(alex, party="Mélanie Fricheteau")["total"] == 6


def test_a_service_relaying_many_people_is_not_the_person(tmp_path):
    client = proton_like()
    relay = "Loomio <notifications@loomio.example>"
    for uid, who in [(70, "Mélanie Fricheteau (Loomio)"), (71, "Anne (Loomio)"), (72, "Bob (Loomio)"), (73, "Chloé (Loomio)")]:
        client.folders["INBOX"][uid] = build_raw(f"Fil {uid}", f"{who} <notifications@loomio.example>", "corps", date="Mon, 01 Jun 2026 08:00:00 +0000", message_id=f"<l{uid}@x.example>")
    svc = EmailService(load_config(write_config(tmp_path, CONFIG)), client_factory=lambda acc: client.clone())
    svc.scan_start(svc.accounts(member_id="id-alex"), account="icloud", background=False)
    out = svc.exchanges(svc.accounts(member_id="id-alex"), party="Mélanie Fricheteau")
    assert out["addresses"] == ["mela@partfin.be"]
    assert out["total"] == 6
