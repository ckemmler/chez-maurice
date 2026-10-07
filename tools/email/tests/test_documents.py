"""Office documents as attachments (7 October 2026): .docx, .odt and the old
.doc give their text; a long attachment is read in turns."""

import struct
from pathlib import Path

import pytest

from tools.email.accounts import load_config
from tools.email.documents import DOC, DOCX, ODT, _doc_pieces, document_text
from tools.email.message import BEGIN_ATTACHMENT, END_ATTACHMENT
from tools.email.service import EmailService

from .fakes import FakeIMAPClient, build_raw
from .test_email import write_config

FIXTURES = Path(__file__).parent / "fixtures"
# The three files are one page written by macOS's textutil from the same HTML.
SENTENCE = "Le budget voté reste inchangé : c’est la troisième année de suite."


def service_with(tmp_path, attachments):
    client = FakeIMAPClient({"INBOX": {1: build_raw("note", "a@b.c", "voir PJ", attachments=attachments)}})
    svc = EmailService(load_config(write_config(tmp_path, '[[accounts]]\nmember = "alex"\naddress = "a@icloud.com"\n')),
                       client_factory=lambda acc: client)
    return svc, svc.accounts(member_id="id-alex")


@pytest.mark.parametrize("name,kind,how", [
    ("note.doc", DOC, "Word document (.doc)"),
    ("note.docx", DOCX, "Word document (.docx)"),
    ("note.odt", ODT, "OpenDocument text"),
])
def test_a_document_gives_its_text(name, kind, how):
    text, said = document_text(kind, (FIXTURES / name).read_bytes())
    assert said == how
    assert text.startswith("Compte rendu — exemple")
    assert SENTENCE in text and "84 €" in text
    # The table's cells are there, in order, and nothing below a space is left.
    assert text.index("Montant") < text.index("Fournitures") < text.index("à confirmer") < text.index("Conclusion")
    assert not [c for c in text if ord(c) < 32 and c not in "\n\t"]


def test_the_doc_keeps_a_table_row_on_its_line():
    text, _ = document_text(DOC, (FIXTURES / "note.doc").read_bytes())
    assert "Poste\tMontant\nFournitures\tà confirmer\n" in text


def test_an_attached_doc_is_listed_readable_and_read(tmp_path):
    svc, alex = service_with(tmp_path, [("compte-rendu.doc", "application/msword", (FIXTURES / "note.doc").read_bytes())])
    listed = svc.get_message(alex, uid=1)["attachments"]
    assert listed[0]["filename"] == "compte-rendu.doc" and listed[0]["readable"] is True
    att = svc.get_attachment(alex, uid=1, index=0)
    assert att["extracted_as"] == "Word document (.doc)" and att["truncated"] is False
    assert SENTENCE in att["text"] and "UNTRUSTED ATTACHMENT" in att["text"]


def test_a_document_sent_as_a_plain_file_is_known_by_its_name(tmp_path):
    # Many clients say only "a file" for an attachment they do not know.
    svc, alex = service_with(tmp_path, [("Note finale.DOCX", "application/octet-stream", (FIXTURES / "note.docx").read_bytes())])
    assert svc.get_message(alex, uid=1)["attachments"][0]["readable"] is True
    assert SENTENCE in svc.get_attachment(alex, uid=1, index=0)["text"]


def test_what_the_bytes_are_wins_over_what_they_were_called(tmp_path):
    # A .docx saved under a .doc name, as Word itself opens it.
    text, how = document_text(DOC, (FIXTURES / "note.docx").read_bytes())
    assert how == "Word document (.docx)" and SENTENCE in text
    assert document_text(DOC, b"{\\rtf1 bonjour}")[0].startswith("[this file is RTF")
    assert document_text(DOCX, b"not a document")[0].startswith("[this file is not a document")
    # A broken archive says so, it does not raise.
    assert document_text(DOCX, b"PK\x03\x04 broken")[0].startswith("[the document could not be read")


def test_other_files_still_give_only_their_metadata(tmp_path):
    svc, alex = service_with(tmp_path, [("archive.zip", "application/zip", b"PK\x03\x04")])
    assert svc.get_message(alex, uid=1)["attachments"][0]["readable"] is False
    att = svc.get_attachment(alex, uid=1, index=0)
    assert att["extracted_as"] == "application/zip: no text to extract" and att["total_bytes"] == 0


def test_a_long_attachment_is_read_in_turns(tmp_path):
    whole = "".join(f"Ligne {i} — été à l’atelier.\n" for i in range(400))
    svc, alex = service_with(tmp_path, [("long.txt", "text/plain", whole.encode())])
    read, offset, turns = "", 0, 0
    while True:
        att = svc.get_attachment(alex, uid=1, index=0, max_bytes=2000, offset=offset)
        assert att["total_bytes"] == len(whole.encode())
        body = att["text"].split(BEGIN_ATTACHMENT, 1)[1].split("\n", 1)[1].rsplit("\n" + END_ATTACHMENT, 1)[0]
        read += body
        turns += 1
        if not att["truncated"]:
            assert "next_offset" not in att
            break
        offset = att["next_offset"]
    # Every character once, none cut in two, whatever the slice fell on.
    assert turns > 3 and read == whole
    # Past the end: nothing, and nothing more.
    last = svc.get_attachment(alex, uid=1, index=0, offset=10**9)
    assert last["truncated"] is False and "Ligne" not in last["text"]


def test_a_doc_of_one_byte_characters():
    """The piece table's other form: cp1252, one byte a character, at half
    the stored offset — what Word writes for a text with no character outside
    that page. textutil writes UTF-16, so this one is built by hand."""
    body = "Bonjour, été à l’atelier\r".encode("cp1252")
    main = bytearray(0x400)
    main[0x200 : 0x200 + len(body)] = body
    struct.pack_into("<ii", main, 0x004C, len(body), 0)           # ccpText, ccpFtn
    plc = struct.pack("<II", 0, len(body)) + struct.pack("<HIH", 0, 0x40000000 | (0x200 * 2), 0)
    clx = b"\x02" + struct.pack("<I", len(plc)) + plc
    struct.pack_into("<II", main, 0x01A2, 0, len(clx))            # fcClx, lcbClx
    assert _doc_pieces(bytes(main), clx) == "Bonjour, été à l’atelier"
