"""What makes two IMAP messages the same message.

Never the folder: a member will reorganise their folders — with Maurice's
help, that is rather the point — and a message moved or a folder renamed must
not become a second message. In order of preference:

1. ``X-GM-MSGID`` on Gmail: one number per message, whatever labels it wears;
2. ``EMAILID`` (RFC 8474) when the server announces ``OBJECTID``;
3. a fingerprint of the normalised ``Message-ID``, ``From`` and ``Date``;
4. without a ``Message-ID``, a fingerprint of ``Date``, ``From``, ``To`` and
   ``Subject`` — the weakest, and marked as such.

The prefix says which rule produced the id, so a later pass can tell a strong
identity from a guess.
"""

from __future__ import annotations

import hashlib
import re
from typing import Any

_WS = re.compile(r"\s+")


def _norm(value: Any) -> str:
    return _WS.sub(" ", str(value or "")).strip().lower()


def _addresses(values: Any) -> str:
    return ",".join(sorted(_norm(v) for v in (values or [])))


def _fingerprint(*parts: str) -> str:
    return hashlib.sha256("\x00".join(parts).encode("utf-8")).hexdigest()[:32]


def message_identity(envelope: dict[str, Any]) -> tuple[str, str]:
    """``(id, kind)`` for one envelope as ``Session.envelopes`` returns it."""
    gm = envelope.get("gm_msgid")
    if gm:
        return f"gm:{int(gm)}", "gm_msgid"
    oid = envelope.get("emailid")
    if oid:
        return f"oid:{_norm(oid)}", "emailid"
    message_id = _norm(envelope.get("message_id"))
    sender = _addresses(envelope.get("from"))
    date = _norm(envelope.get("date"))
    if message_id:
        return f"fp:{_fingerprint(message_id, sender, date)}", "message_id"
    return (
        f"fp2:{_fingerprint(date, sender, _addresses(envelope.get('to')), _norm(envelope.get('subject')))}",
        "weak",
    )
