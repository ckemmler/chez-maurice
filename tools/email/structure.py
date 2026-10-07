"""A message's attachments, from its BODYSTRUCTURE — without downloading it.

A message is fetched whole to be read (``service.get_message``), up to
``max_message_bytes``: past that, only its headers and the start of its text
cross the wire, so that a 40 MB video is not downloaded to yield a paragraph.
That left the attachments of a large message out of reach — and a message is
large precisely because of what is attached to it.

IMAP can say what a message is made of without sending it: BODYSTRUCTURE lists
every part with its type, name, encoding and size, and ``BODY[<section>]``
then fetches one part alone. This module reads that list the way
``message.attachment_parts`` reads a parsed message — same rules, same order —
so an attachment's index means the same thing whichever way it was found.

The shape is IMAP's (RFC 3501 §7.4.2) as ``imapclient`` parses it: a multipart
is ``(parts, subtype, params, …)`` with a list first; a single part is
``(type, subtype, params, id, description, encoding, size, …)`` followed by
extension fields whose position depends on the type, which is why the
disposition is looked for rather than indexed.
"""

from __future__ import annotations

import base64
import quopri
from dataclasses import dataclass
from email.header import decode_header, make_header
from email.message import EmailMessage
from typing import Any, Iterator
from urllib.parse import unquote


@dataclass(frozen=True)
class PartInfo:
    """One leaf of a message: where it is (``section``, as ``BODY[…]`` takes
    it) and what the server says of it."""

    section: str
    content_type: str
    filename: str | None
    encoding: str
    size: int            # as transferred: a base64 part is a third larger than its file
    charset: str | None
    disposition: str | None
    content_id: str | None


def _text(value: Any) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return "" if value is None else str(value)


def _params(value: Any) -> dict[str, str]:
    """``(b"NAME", b"a.pdf", b"CHARSET", b"utf-8")`` → ``{"name": "a.pdf", …}``."""
    if not isinstance(value, (list, tuple)):
        return {}
    return {_text(value[i]).lower(): _text(value[i + 1]) for i in range(0, len(value) - 1, 2)}


def _decoded(name: str | None) -> str | None:
    """A filename as the sender wrote it: RFC 2047 words (``=?utf-8?B?…?=``)
    and RFC 2231 values (``utf-8''caf%C3%A9.pdf``) are both in use."""
    if not name:
        return None
    if "''" in name and "=?" not in name:
        charset, _, rest = name.partition("''")
        try:
            return unquote(rest, encoding=charset or "utf-8", errors="replace")
        except LookupError:
            return unquote(rest)
    try:
        return str(make_header(decode_header(name)))
    except Exception:
        return name


def _is_multipart(structure: Any) -> bool:
    return isinstance(structure, (list, tuple)) and bool(structure) and isinstance(structure[0], (list, tuple))


def _disposition(structure: Any) -> tuple[str | None, dict[str, str]]:
    for field in structure[7:]:
        if isinstance(field, (list, tuple)) and field and isinstance(field[0], bytes):
            kind = _text(field[0]).lower()
            if kind in {"attachment", "inline"}:
                return kind, _params(field[1] if len(field) > 1 else None)
    return None, {}


def leaves(structure: Any, prefix: str = "") -> Iterator[PartInfo]:
    """Every single part, depth first, with its section number."""
    if _is_multipart(structure):
        for number, child in enumerate(structure[0], 1):
            yield from leaves(child, f"{prefix}.{number}" if prefix else str(number))
        return
    section = prefix or "1"
    maintype, subtype = _text(structure[0]).lower(), _text(structure[1]).lower()
    if maintype == "message" and subtype == "rfc822" and len(structure) > 8 and isinstance(structure[8], (list, tuple)):
        # An attached message: its own parts are numbered under it, and it is
        # read through them, as a parsed message is walked.
        inner = structure[8]
        yield from leaves(inner, section if _is_multipart(inner) else f"{section}.1")
        return
    params = _params(structure[2])
    disposition, disposition_params = _disposition(structure)
    filename = disposition_params.get("filename*") or disposition_params.get("filename") or params.get("name*") or params.get("name")
    yield PartInfo(
        section=section,
        content_type=f"{maintype}/{subtype}",
        filename=_decoded(filename),
        encoding=_text(structure[5]).lower(),
        size=int(structure[6] or 0),
        charset=params.get("charset"),
        disposition=disposition,
        content_id=_text(structure[3]) or None,
    )


def is_attachment(part: PartInfo) -> bool:
    """The rule of ``message._is_attachment``, on what the server says."""
    maintype = part.content_type.split("/", 1)[0]
    # An image the HTML points at by Content-ID is part of the layout, unless
    # the sender attached it outright.
    if maintype == "image" and part.content_id and part.disposition != "attachment":
        return False
    if part.disposition == "attachment":
        return True
    return bool(part.filename) and maintype != "text"


def attachments(structure: Any) -> list[PartInfo]:
    """The message's attachments, in a stable order — their index is their id."""
    return [part for part in leaves(structure) if is_attachment(part)]


def as_part(info: PartInfo, body: bytes) -> Any:
    """The fetched bytes of one part, as a part ``message.attachment_text``
    reads: decoded from its transfer encoding, under its type and name."""
    if info.encoding == "base64":
        payload = base64.b64decode(body, validate=False)
    elif info.encoding == "quoted-printable":
        payload = quopri.decodestring(body)
    else:
        payload = body
    maintype, _, subtype = info.content_type.partition("/")
    holder = EmailMessage()
    if maintype == "text":
        holder.add_attachment(payload.decode(info.charset or "utf-8", errors="replace"), subtype=subtype or "plain", filename=info.filename)
    else:
        holder.add_attachment(payload, maintype=maintype or "application", subtype=subtype or "octet-stream", filename=info.filename)
    return next(holder.iter_attachments())
