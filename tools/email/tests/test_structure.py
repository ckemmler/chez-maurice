"""The attachments of a message too large to fetch whole (7 October 2026):
listed from its BODYSTRUCTURE, read one part at a time."""

from pathlib import Path

import pytest

from tools.email.accounts import load_config
from tools.email.message import attachment_parts, parse_message
from tools.email.service import EmailService
from tools.email.structure import attachments, leaves

from .fakes import FakeIMAPClient, bodystructure, build_raw
from .test_email import write_config

FIXTURES = Path(__file__).parent / "fixtures"
LOGO = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


def service_with(tmp_path, raw):
    client = FakeIMAPClient({"INBOX": {1: raw}})
    svc = EmailService(load_config(write_config(tmp_path, '[[accounts]]\nmember = "alex"\naddress = "a@icloud.com"\n')),
                       client_factory=lambda acc: client)
    svc.config.max_message_bytes = 10          # every message here is "too large"
    return svc, svc.accounts(member_id="id-alex"), client


def fetched(client):
    return [part for call in client.calls if call[0] == "fetch" for part in call[1][1]]


def big(**kw):
    return build_raw("Compte rendu", "a@b.c", "Voir les pièces jointes.", attachments=[
        ("notes.txt", "text/plain", "Total 84 € — été".encode()),
        ("compte-rendu.doc", "application/msword", (FIXTURES / "note.doc").read_bytes()),
        ("Note finale.docx", "application/octet-stream", (FIXTURES / "note.docx").read_bytes()),
        ("photo.jpg", "image/jpeg", b"\xff\xd8\xff" + b"\x00" * 300),
    ], **kw)


def test_a_large_message_lists_its_attachments_without_being_fetched(tmp_path):
    svc, alex, client = service_with(tmp_path, big())
    msg = svc.get_message(alex, uid=1)
    assert "Voir les pièces jointes" in msg["body"] and "get_attachment" in msg["attachments_note"]
    assert [(a["index"], a["filename"], a["readable"]) for a in msg["attachments"]] == [
        (0, "notes.txt", True), (1, "compte-rendu.doc", True), (2, "Note finale.docx", True), (3, "photo.jpg", False),
    ]
    # About the file's own weight, not the base64's.
    real = len((FIXTURES / "note.doc").read_bytes())
    assert abs(msg["attachments"][1]["size"] - real) < real * 0.03
    assert "BODY.PEEK[]" not in fetched(client) and "BODYSTRUCTURE" in fetched(client)


def test_one_attachment_of_a_large_message_is_fetched_alone(tmp_path):
    svc, alex, client = service_with(tmp_path, big())
    att = svc.get_attachment(alex, uid=1, index=1)
    assert att["filename"] == "compte-rendu.doc" and att["extracted_as"] == "Word document (.doc)"
    assert "Le budget voté reste inchangé" in att["text"] and "UNTRUSTED ATTACHMENT" in att["text"]
    # Only that part crossed the wire.
    assert "BODY.PEEK[]" not in fetched(client)
    assert [p for p in fetched(client) if p.startswith("BODY.PEEK[")] == ["BODY.PEEK[3]"]

    assert "Total 84 € — été" in svc.get_attachment(alex, uid=1, index=0)["text"]
    assert "Le budget voté" in svc.get_attachment(alex, uid=1, index=2)["text"]
    assert svc.get_attachment(alex, uid=1, index=3)["extracted_as"] == "image/jpeg: no text to extract"
    with pytest.raises(Exception, match="4 attachment"):
        svc.get_attachment(alex, uid=1, index=4)


def test_a_part_larger_than_the_tool_fetches_is_refused_by_name(tmp_path):
    svc, alex, client = service_with(tmp_path, big())
    svc.config.max_part_bytes = 1000
    with pytest.raises(Exception, match="compte-rendu.doc.*over the"):
        svc.get_attachment(alex, uid=1, index=1)
    # The small one beside it is still read.
    assert "Total 84 €" in svc.get_attachment(alex, uid=1, index=0)["text"]
    assert not [p for p in fetched(client) if p == "BODY.PEEK[3]"]


def test_the_index_is_the_same_whichever_way_the_message_was_read(tmp_path):
    """A signature's logo is not an attachment, an HTML body is not either,
    and what is left is numbered alike from the parsed message and from the
    server's description of it."""
    from email.message import EmailMessage

    msg = EmailMessage()
    msg["Subject"], msg["From"], msg["To"] = "Suivi", "a@b.c", "alex@example.org"
    msg.set_content("Bonjour")
    msg.add_alternative('<p>Bonjour <img src="cid:logo"></p>', subtype="html")
    msg.get_payload()[1].add_related(LOGO, maintype="image", subtype="png", cid="<logo>", filename="image001.png", disposition="inline")
    msg.add_attachment(b"%PDF-1.4", maintype="application", subtype="pdf", filename="été — reçu.pdf")
    msg.add_attachment(LOGO, maintype="image", subtype="png", filename="plan.png")
    raw = msg.as_bytes()

    parsed = [p.get_filename() for p in attachment_parts(parse_message(raw))]
    described = attachments(bodystructure(raw))
    assert [p.filename for p in described] == parsed == ["été — reçu.pdf", "plan.png"]
    # Sections count from the outermost multipart; the body's own parts come first.
    assert [p.section for p in described] == ["2", "3"]
    assert [p.section for p in leaves(bodystructure(raw))][:3] == ["1.1", "1.2.1", "1.2.2"]


def test_a_message_that_is_one_part_is_section_one():
    raw = build_raw("Seul", "a@b.c", "Une seule partie.")
    assert [(p.section, p.content_type) for p in leaves(bodystructure(raw))] == [("1", "text/plain")]
    assert attachments(bodystructure(raw)) == []


def test_the_shape_gmail_answers():
    """What a real server sent for a message with an HTML body, a signature
    image and two PDFs — names replaced, structure kept."""
    structure = (
        [
            ([([(b"TEXT", b"PLAIN", (b"CHARSET", b"windows-1258"), None, None, b"QUOTED-PRINTABLE", 4268, 86, None, None, None),
                (b"TEXT", b"HTML", (b"CHARSET", b"windows-1258"), None, None, b"QUOTED-PRINTABLE", 18381, 368, None, None, None)],
               b"ALTERNATIVE", (b"BOUNDARY", b"_000_"), None, None),
              (b"IMAGE", b"JPEG", (b"NAME", b"image001.jpg"), b"<image001.jpg@01DC>", b"image001.jpg", b"BASE64", 6922, None,
               (b"INLINE", (b"CREATION-DATE", b"x", b"FILENAME", b"image001.jpg", b"SIZE", b"5056")), None)],
             b"RELATED", (b"BOUNDARY", b"_001_", b"TYPE", b"multipart/alternative"), None, None),
            (b"APPLICATION", b"PDF", (b"NAME", b"=?utf-8?B?TGl2cmV0IMOpdMOpLnBkZg==?="), None, b"Livret.pdf", b"BASE64", 8762250, None,
             (b"ATTACHMENT", (b"FILENAME", b"=?utf-8?B?TGl2cmV0IMOpdMOpLnBkZg==?=", b"SIZE", b"6403181")), None),
            (b"APPLICATION", b"PDF", (b"NAME", b"Annexe.pdf"), None, b"Annexe.pdf", b"BASE64", 1274430, None,
             (b"ATTACHMENT", (b"FILENAME*", b"utf-8''Annexe%20%C3%A9t%C3%A9.pdf")), None),
        ],
        b"MIXED", (b"BOUNDARY", b"_002_"), None, None,
    )
    found = attachments(structure)
    assert [(p.section, p.filename, p.encoding, p.size) for p in found] == [
        ("2", "Livret été.pdf", "base64", 8762250), ("3", "Annexe été.pdf", "base64", 1274430),
    ]
