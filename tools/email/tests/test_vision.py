"""A scanned attachment read by a model that reads images (7 October 2026).
The model is played here: no test asks the server (conftest refuses it)."""

import io
import json

import pytest
from PIL import Image

from tools.email import sealing, vision
from tools.email.accounts import load_config
from tools.email.service import EmailService

from .fakes import FakeIMAPClient, build_raw
from .test_email import write_config


@pytest.fixture(autouse=True)
def household_key(monkeypatch):
    monkeypatch.setenv("MAURICE_SECRET_KEY", "0" * 64)
    sealing.reset_key_cache()
    yield
    sealing.reset_key_cache()


def picture(width=300, height=400, colour=(250, 250, 250)) -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (width, height), colour).save(out, format="JPEG")
    return out.getvalue()


def scan(pages: int, size=(300, 400)) -> bytes:
    """A PDF as a scanner makes one: a picture a page, no text."""
    out = io.BytesIO()
    images = [Image.new("RGB", size, (250 - i, 250, 250)) for i in range(pages)]
    images[0].save(out, format="PDF", save_all=True, append_images=images[1:])
    return out.getvalue()


class Reader:
    """A model that says which page it was shown, by the order asked."""

    def __init__(self, refuse_from: int | None = None, answers: dict[int, str] | None = None):
        self.calls: list[dict] = []
        self.refuse_from = refuse_from
        self.answers = answers or {}

    def __call__(self, invocation, prompt, **kw):
        self.calls.append({"invocation": invocation, "prompt": prompt, **kw})
        n = len(self.calls)
        if self.refuse_from is not None and n >= self.refuse_from:
            raise RuntimeError('attachment_vision: server said 402 — {"error":"Daily budget reached."}')
        return {"text": self.answers.get(n, f"Texte de la page, appel {n}"), "model": "gemma-4-26b-a4b-it"}


def test_a_scan_is_read_page_by_page_for_the_member(monkeypatch):
    monkeypatch.setattr(vision, "CONCURRENCY", 1)      # in order, so the fake can count
    reader = Reader()
    text, how = vision.read_scan(scan(3), "application/pdf", member_id="id-alex", complete=reader)
    assert how == "application/pdf (scan, read by gemma-4-26b-a4b-it)"
    assert text == "[page 1]\nTexte de la page, appel 1\n\n[page 2]\nTexte de la page, appel 2\n\n[page 3]\nTexte de la page, appel 3"
    assert len(reader.calls) == 3
    for call in reader.calls:
        assert call["invocation"] == "attachment_vision" and call["member_id"] == "id-alex"
        (image,) = call["images"]
        assert image["media_type"] == "image/jpeg" and len(image["data"]) > 100


def test_it_is_read_once_and_kept_sealed():
    reader = Reader()
    data = scan(2)
    first = vision.read_scan(data, "application/pdf", member_id="id-alex", complete=reader)
    again = vision.read_scan(data, "application/pdf", member_id="id-alex", complete=reader)
    assert again == first and len(reader.calls) == 2
    kept = vision.cache_path("id-alex", data)
    raw = kept.read_text()
    assert raw.startswith("v1:") and "Texte de la page" not in raw
    assert json.loads(sealing.unseal(raw))["model"] == "gemma-4-26b-a4b-it"
    # Another member's reading of the same file is their own, paid by them.
    vision.read_scan(data, "application/pdf", member_id="id-sam", complete=reader)
    assert len(reader.calls) == 4


def test_a_refusal_stops_the_reading_and_keeps_nothing(monkeypatch):
    monkeypatch.setattr(vision, "CONCURRENCY", 1)
    reader = Reader(refuse_from=2)
    data = scan(4)
    text, how = vision.read_scan(data, "application/pdf", member_id="id-alex", complete=reader)
    assert text.startswith("[page 1]\nTexte de la page, appel 1")
    assert "[the reading stopped after 1 of 4 page(s): Daily budget reached.]" in text
    # Not one more page was asked for once the server said no.
    assert len(reader.calls) == 2
    assert not vision.cache_path("id-alex", data).exists()


def test_a_page_with_no_text_is_left_out_and_a_long_scan_is_cut(monkeypatch):
    monkeypatch.setattr(vision, "CONCURRENCY", 1)
    text, _ = vision.read_scan(scan(3), "application/pdf", member_id="id-alex", complete=Reader(answers={2: "[no text]"}))
    assert "[page 1]" in text and "[page 2]" not in text and "[page 3]" in text

    monkeypatch.setattr(vision, "MAX_PAGES", 2)
    reader = Reader()
    data = scan(3, size=(320, 400))                    # another file: the first one is kept
    text, _ = vision.read_scan(data, "application/pdf", member_id="id-alex", complete=reader)
    assert len(reader.calls) == 2 and "[only the first 2 of 3 pages were read]" in text
    assert not vision.cache_path("id-alex", data).exists()


def test_a_large_photo_is_scaled_before_it_is_sent():
    reader = Reader()
    text, how = vision.read_scan(picture(4000, 3000), "image/jpeg", member_id="id-alex", complete=reader)
    assert how == "image/jpeg (scan, read by gemma-4-26b-a4b-it)" and text.startswith("[page 1]")
    import base64
    sent = Image.open(io.BytesIO(base64.b64decode(reader.calls[0]["images"][0]["data"])))
    assert max(sent.size) == vision.MAX_SIDE


def test_a_pdf_without_pictures_is_not_a_scan():
    from pypdf import PdfWriter

    buf = io.BytesIO()
    writer = PdfWriter()
    writer.add_blank_page(width=200, height=200)
    writer.write(buf)
    reader = Reader()
    assert vision.read_scan(buf.getvalue(), "application/pdf", member_id="id-alex", complete=reader) is None
    assert reader.calls == []


def service_with(tmp_path, attachments):
    client = FakeIMAPClient({"INBOX": {1: build_raw("note", "a@b.c", "voir PJ", attachments=attachments)}})
    svc = EmailService(load_config(write_config(tmp_path, '[[accounts]]\nmember = "alex"\naddress = "a@icloud.com"\n')),
                       client_factory=lambda acc: client)
    return svc, svc.accounts(member_id="id-alex")


def test_the_tool_reads_a_scanned_attachment_and_pages_through_it(tmp_path, monkeypatch):
    monkeypatch.setattr(vision, "CONCURRENCY", 1)
    reader = Reader(answers={n: f"Page {n} — " + "été à l’atelier. " * 60 for n in range(1, 4)})
    svc, alex = service_with(tmp_path, [("scan.pdf", "application/pdf", scan(3)), ("photo.jpg", "image/jpeg", picture())])
    svc.read_scan = lambda data, kind, member_id: vision.read_scan(data, kind, member_id=member_id, complete=reader)

    listed = svc.get_message(alex, uid=1)["attachments"]
    assert [(a["filename"], a["readable"]) for a in listed] == [("scan.pdf", True), ("photo.jpg", True)]

    att = svc.get_attachment(alex, uid=1, index=0, max_bytes=1500)
    assert att["extracted_as"] == "application/pdf (scan, read by gemma-4-26b-a4b-it)"
    assert "[page 1]" in att["text"] and att["truncated"] is True and "UNTRUSTED ATTACHMENT" in att["text"]
    # The next slice comes from what was kept: the pages are not read again.
    more = svc.get_attachment(alex, uid=1, index=0, max_bytes=1500, offset=att["next_offset"])
    assert len(reader.calls) == 3 and "été à l’atelier" in more["text"]

    photo = svc.get_attachment(alex, uid=1, index=1)
    assert photo["extracted_as"] == "image/jpeg (scan, read by gemma-4-26b-a4b-it)" and len(reader.calls) == 4


def test_a_pdf_with_its_text_is_not_sent_to_a_model(tmp_path):
    # conftest's reader refuses: a text PDF must never reach it.
    from tools.email.documents import DOCX  # noqa: F401  (the other readers stay as they were)

    svc, alex = service_with(tmp_path, [("notes.txt", "text/plain", "Total 84 €".encode())])
    assert "Total 84 €" in svc.get_attachment(alex, uid=1, index=0)["text"]
