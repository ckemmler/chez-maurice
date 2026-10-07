"""The text of an office document that came as an attachment.

Word (``.docx``), OpenDocument (``.odt``) and the old binary Word (``.doc``).
Until 7 October 2026 the tool could only say of these that they had no text to
give, and a question about a passage of an attached document went unanswered.

The same rules as for a PDF (``message.py``): nothing is executed, nothing is
fetched, no converter is spawned — the bytes IMAP gave us are parsed here and
only their text comes out. A file that cannot be read says so in brackets, in
the text, rather than raising: a malformed attachment is the sender's problem,
not a crash.

* ``.docx`` and ``.odt`` are zip archives holding XML: the standard library
  reads them. An entry is refused past ``MAX_XML_BYTES`` — a few kilobytes of
  zip can announce gigabytes.
* ``.doc`` is an OLE compound file. ``olefile`` opens the container; the text
  is then found the way the format says (MS-DOC): the FIB at the head of the
  ``WordDocument`` stream names the table stream and where the piece table
  (the CLX) sits in it, and each piece says where its characters are and
  whether they are one byte each (cp1252) or two (UTF-16).
"""

from __future__ import annotations

import io
import re
import struct
import zipfile
from typing import Any
from xml.etree import ElementTree

DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
ODT = "application/vnd.oasis.opendocument.text"
DOC = "application/msword"

#: The types this module reads, by the extension a sender's client may have
#: left as the only clue (``application/octet-stream`` is common for these).
BY_EXTENSION = {"docx": DOCX, "odt": ODT, "doc": DOC, "dot": DOC}

MAX_XML_BYTES = 40_000_000

_W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
_T = "{urn:oasis:names:tc:opendocument:xmlns:text:1.0}"

_OLE_MAGIC = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"


def document_text(kind: str, data: bytes) -> tuple[str, str]:
    """(text, how) for one of the types above. What the bytes are wins over
    what they were called: a ``.doc`` that is a zip is read as a ``.docx``,
    which is what Word itself does."""
    if data.startswith(b"PK"):
        if kind == ODT:
            return _odt_text(data), "OpenDocument text"
        return _docx_text(data), "Word document (.docx)"
    if data.startswith(_OLE_MAGIC):
        return _doc_text(data), "Word document (.doc)"
    if data.lstrip()[:5] == b"{\\rtf":
        return "[this file is RTF under a Word name — not read]", "RTF"
    return "[this file is not a document this tool can read]", kind


def _tidy(text: str) -> str:
    text = re.sub(r"[ \t]+\n", "\n", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


# ── zip + XML: .docx, .odt ───────────────────────────────────────────────


def _xml_entry(archive: zipfile.ZipFile, name: str) -> ElementTree.Element | None:
    try:
        info = archive.getinfo(name)
    except KeyError:
        return None
    if info.file_size > MAX_XML_BYTES:
        raise ValueError("too large")
    return ElementTree.fromstring(archive.read(info))


def _docx_text(data: bytes) -> str:
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            body = _xml_entry(archive, "word/document.xml")
            if body is None:
                return "[this file is not a Word document]"
            notes = [_xml_entry(archive, n) for n in ("word/footnotes.xml", "word/endnotes.xml")]
    except Exception as exc:
        return f"[the document could not be read: {type(exc).__name__}]"
    out: list[str] = []
    _walk_docx(body, out)
    text = _tidy("".join(out))
    for root in notes:
        if root is None:
            continue
        more: list[str] = []
        _walk_docx(root, more)
        extra = _tidy("".join(more))
        if extra:
            text += "\n\n[notes]\n" + extra
    return text or "[this document has no text]"


def _walk_docx(node: Any, out: list[str]) -> None:
    """Depth-first, so a text box inside a paragraph is read once, where it
    is. Field instructions and deleted (tracked) text are not text."""
    tag = node.tag
    if tag == _W + "t":
        out.append(node.text or "")
    elif tag == _W + "tab":
        out.append("\t")
    elif tag in (_W + "br", _W + "cr"):
        out.append("\n")
    elif tag in (_W + "instrText", _W + "delText", _W + "delInstrText"):
        return
    else:
        for child in node:
            _walk_docx(child, out)
        if tag == _W + "p":
            out.append("\n")


def _odt_text(data: bytes) -> str:
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            root = _xml_entry(archive, "content.xml")
    except Exception as exc:
        return f"[the document could not be read: {type(exc).__name__}]"
    if root is None:
        return "[this file is not an OpenDocument text]"
    out: list[str] = []
    _walk_odt(root, out)
    return _tidy("".join(out)) or "[this document has no text]"


def _walk_odt(node: Any, out: list[str]) -> None:
    tag = node.tag
    block = tag in (_T + "p", _T + "h")
    if tag == _T + "tab":
        out.append("\t")
    elif tag == _T + "line-break":
        out.append("\n")
    elif tag == _T + "s":
        out.append(" " * int(node.get(_T + "c") or 1))
    elif tag.startswith(_T) or block:
        out.append(node.text or "")
    for child in node:
        _walk_odt(child, out)
        # What follows a child inside a text element is still that element's text.
        if tag.startswith(_T):
            out.append(child.tail or "")
    if block:
        out.append("\n")


# ── the OLE compound file: .doc ──────────────────────────────────────────

# FIB offsets (MS-DOC 2.5.1): the flags, the character counts of the main
# text and of the footnotes, and where the CLX is in the table stream.
_FIB_FLAGS = 0x000A
_FIB_CCP_TEXT = 0x004C
_FIB_CCP_FTN = 0x0050
_FIB_FC_CLX = 0x01A2
_F_ENCRYPTED = 0x0100
_F_WHICH_TABLE = 0x0200


def _doc_text(data: bytes) -> str:
    try:
        import olefile  # late: only a .doc needs it
    except ImportError:
        return "[a .doc needs the olefile package, which is not installed here]"
    try:
        with olefile.OleFileIO(io.BytesIO(data)) as ole:
            if not ole.exists("WordDocument"):
                return "[this file is not a Word document]"
            main = ole.openstream("WordDocument").read()
            flags = struct.unpack_from("<H", main, _FIB_FLAGS)[0]
            if flags & _F_ENCRYPTED:
                return "[this document is protected by a password]"
            name = "1Table" if flags & _F_WHICH_TABLE else "0Table"
            if not ole.exists(name):
                return "[this Word document has no table stream — too old a format]"
            table = ole.openstream(name).read()
        return _doc_pieces(main, table) or "[this document has no text]"
    except Exception as exc:
        return f"[the document could not be read: {type(exc).__name__}]"


def _doc_pieces(main: bytes, table: bytes) -> str:
    """The main text and the footnotes, from the piece table."""
    ccp_text, ccp_ftn = struct.unpack_from("<ii", main, _FIB_CCP_TEXT)
    fc_clx, lcb_clx = struct.unpack_from("<II", main, _FIB_FC_CLX)
    clx = table[fc_clx : fc_clx + lcb_clx]
    # The CLX: any number of Prc (0x01, a 16-bit size, that many bytes), then
    # one Pcdt (0x02, a 32-bit size, the PlcPcd).
    at = 0
    while at < len(clx) and clx[at] == 0x01:
        at += 3 + struct.unpack_from("<H", clx, at + 1)[0]
    if at >= len(clx) or clx[at] != 0x02:
        return ""
    size = struct.unpack_from("<I", clx, at + 1)[0]
    plc = clx[at + 5 : at + 5 + size]
    # n + 1 character positions, then n piece descriptors of 8 bytes.
    n = (len(plc) - 4) // 12
    cps = struct.unpack_from(f"<{n + 1}I", plc, 0)
    wanted = max(0, ccp_text) + max(0, ccp_ftn)
    chunks: list[str] = []
    for i in range(n):
        start, end = cps[i], min(cps[i + 1], wanted)
        if end <= start:
            break
        fc = struct.unpack_from("<I", plc, 4 * (n + 1) + 8 * i + 2)[0]
        count = end - start
        if fc & 0x40000000:  # one byte a character
            offset = (fc & 0x3FFFFFFF) // 2
            chunks.append(main[offset : offset + count].decode("cp1252", errors="replace"))
        else:
            offset = fc & 0x3FFFFFFF
            chunks.append(main[offset : offset + 2 * count].decode("utf-16-le", errors="replace"))
    text = "".join(chunks)
    main_text, notes = text[: max(0, ccp_text)], text[max(0, ccp_text) :]
    out = _doc_clean(main_text)
    extra = _doc_clean(notes)
    return out + ("\n\n[notes]\n" + extra if extra else "")


#: A field is 0x13 instruction 0x14 result 0x15: the instruction (HYPERLINK
#: "…", PAGE, TOC \o) is not text, the result is.
_FIELD_INSTRUCTION = re.compile("\x13[^\x13\x14\x15]*\x14")
_FIELD_NO_RESULT = re.compile("\x13[^\x13\x14\x15]*\x15")


def _doc_clean(text: str) -> str:
    # Innermost first: fields nest.
    for _ in range(8):
        cleaned = _FIELD_NO_RESULT.sub("", _FIELD_INSTRUCTION.sub("", text))
        if cleaned == text:
            break
        text = cleaned
    text = (
        text.replace("\r", "\n")     # paragraph mark
        .replace("\x07\x07", "\n")   # the last cell's mark, then the row's
        .replace("\x07", "\t")       # a cell mark
        .replace("\x0b", "\n")       # line break
        .replace("\x0c", "\n\n")     # page or section break
        .replace("\x1e", "-")        # non-breaking hyphen
        .replace("\x1f", "")         # optional hyphen
    )
    # What is left below a space is anchors: pictures, footnote references.
    text = re.sub(r"[\x00-\x08\x0e-\x1f]", "", text)
    return _tidy(text)
