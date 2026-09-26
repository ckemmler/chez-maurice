"""The subject seal: the same mechanism as server/src/services/mailAccounts.ts,
so what one side seals the other opens."""

from __future__ import annotations

import base64
import os
import shutil
import subprocess
from pathlib import Path

import pytest

from tools.email import sealing

REPO = Path(__file__).resolve().parents[3]
KEY = base64.b64encode(bytes(range(32))).decode()


@pytest.fixture
def key(monkeypatch, tmp_path):
    monkeypatch.setenv("MAURICE_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("MAURICE_SECRET_KEY", KEY)
    sealing.reset_key_cache()
    yield KEY
    sealing.reset_key_cache()


def test_a_seal_opens_and_never_repeats(key):
    sealed = sealing.seal("Audience du 14 mars — garde alternée")
    assert sealed.startswith("v1:") and "Audience" not in sealed
    assert sealing.unseal(sealed) == "Audience du 14 mars — garde alternée"
    assert sealing.seal("same") != sealing.seal("same")  # a fresh IV each time
    assert sealing.unseal(sealing.seal("")) == ""


def test_another_key_fails_rather_than_decrypting_to_garbage(key, monkeypatch):
    sealed = sealing.seal("secret")
    monkeypatch.setenv("MAURICE_SECRET_KEY", base64.b64encode(bytes([7] * 32)).decode())
    sealing.reset_key_cache()
    with pytest.raises(sealing.SealError):
        sealing.unseal(sealed)
    with pytest.raises(sealing.SealError):
        sealing.unseal("v2:abcd")


def test_the_key_file_is_created_once_owner_only(monkeypatch, tmp_path):
    monkeypatch.setenv("MAURICE_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("MAURICE_SECRET_KEY", raising=False)
    sealing.reset_key_cache()
    first = sealing.household_key()
    path = tmp_path / "secret.key"
    assert path.exists() and (path.stat().st_mode & 0o777) == 0o600
    assert len(base64.b64decode(path.read_text().strip())) == 32
    sealing.reset_key_cache()
    assert sealing.household_key() == first  # read back, not regenerated
    sealing.reset_key_cache()


def _bun(script: str, env: dict[str, str]) -> str:
    out = subprocess.run(
        ["bun", "-e", script],
        cwd=REPO / "server",
        env={**os.environ, **env},
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert out.returncode == 0, out.stderr[-2000:]
    return out.stdout.strip().splitlines()[-1]


@pytest.mark.skipif(shutil.which("bun") is None or not (REPO / "server" / "node_modules").exists(),
                    reason="needs bun and the server's node_modules")
def test_a_seal_crosses_between_bun_and_python(key, tmp_path):
    """The exact mechanism of mailAccounts.ts: same key, AES-256-GCM,
    "v1:" + base64(iv ‖ tag ‖ body). Both directions."""
    env = {"MAURICE_DATA_DIR": str(tmp_path / "bun-app"), "MAURICE_SECRET_KEY": key}
    from_bun = _bun(
        'import { encryptSecret } from "./src/services/mailAccounts"; console.log(encryptSecret("Réunion école — jeudi 18h"));',
        env,
    )
    assert sealing.unseal(from_bun) == "Réunion école — jeudi 18h"
    from_python = sealing.seal("Facture septembre € 84")
    opened = _bun(
        f'import {{ decryptSecret }} from "./src/services/mailAccounts"; console.log(decryptSecret({from_python!r}));',
        env,
    )
    assert opened == "Facture septembre € 84"
