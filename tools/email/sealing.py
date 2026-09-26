"""Sealing a value under the household key — the Python side of
``server/src/services/mailAccounts.ts``.

Same key, same cipher, same envelope, so a value sealed by either side opens
on the other:

* the key is ``MAURICE_SECRET_KEY`` (32 bytes, base64 or 64 hex characters)
  when set, else ``secret.key`` in the app dir — created on first use, owner
  read-only, never overwritten (``O_EXCL``: a key another process wrote a
  moment ago must not be lost, and with it everything sealed under it);
* AES-256-GCM, a fresh 12-byte IV per seal;
* ``"v1:" + base64(iv ‖ tag ‖ body)``. ``cryptography`` hands back body ‖ tag,
  so the pieces are reordered to match Node's layout.

What this protects: a copy of the store without the key — a backup, a
snapshot, a support dump — carries no readable subject. What it does not: a
process on the running server, which must read the store while the member
sleeps. That is the threat model the TS side states, and this side inherits it.
"""

from __future__ import annotations

import base64
import binascii
import os
import re
from pathlib import Path

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from .accounts import maurice_db_path

_HEX = re.compile(r"^[0-9a-fA-F]{64}$")
_cached_key: bytes | None = None


class SealError(RuntimeError):
    """A sealed value that does not open: another key, or not a seal at all."""


def _parse_key(value: str) -> bytes | None:
    v = value.strip()
    try:
        key = bytes.fromhex(v) if _HEX.match(v) else base64.b64decode(v, validate=True)
    except (ValueError, binascii.Error):
        return None
    return key if len(key) == 32 else None


def secret_key_path() -> Path:
    return maurice_db_path().parent / "secret.key"


def household_key() -> bytes:
    global _cached_key
    if _cached_key is not None:
        return _cached_key
    env = os.environ.get("MAURICE_SECRET_KEY")
    if env:
        key = _parse_key(env)
        if key is None:
            raise SealError("MAURICE_SECRET_KEY must be 32 bytes, as 64 hex characters or base64")
        _cached_key = key
        return key
    path = secret_key_path()
    if path.exists():
        key = _parse_key(path.read_text())
        if key is None:
            raise SealError(f"{path} does not hold a 32-byte key")
        _cached_key = key
        return key
    path.parent.mkdir(parents=True, exist_ok=True)
    key = os.urandom(32)
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        # The server wrote it between our exists() and our open(): use theirs.
        return household_key()
    with os.fdopen(fd, "w") as f:
        f.write(base64.b64encode(key).decode() + "\n")
    os.chmod(path, 0o600)
    _cached_key = key
    return key


def reset_key_cache() -> None:
    """Tests only: forget the cached key so a changed env or file is read again."""
    global _cached_key
    _cached_key = None


def seal(plain: str) -> str:
    iv = os.urandom(12)
    sealed = AESGCM(household_key()).encrypt(iv, plain.encode("utf-8"), None)
    body, tag = sealed[:-16], sealed[-16:]
    return "v1:" + base64.b64encode(iv + tag + body).decode()


def unseal(sealed: str) -> str:
    if not sealed.startswith("v1:"):
        raise SealError("unknown secret format")
    try:
        raw = base64.b64decode(sealed[3:], validate=True)
    except (ValueError, binascii.Error) as exc:
        raise SealError("sealed value is not base64") from exc
    if len(raw) < 28:
        raise SealError("sealed value is too short")
    iv, tag, body = raw[:12], raw[12:28], raw[28:]
    try:
        return AESGCM(household_key()).decrypt(iv, body + tag, None).decode("utf-8")
    except InvalidTag as exc:
        raise SealError("the sealed value does not open with this household's key") from exc
