"""Mail accounts, who they belong to, and where their passwords are.

An account belongs to exactly one member, and a member only ever sees their
own: the gateway names the caller by id on every request, and there is no path
— not for the owner, not for an admin — into another member's mailbox.

Accounts come from two places, merged per member:

* **The server** — what the member added themselves from the app (the
  ``mail_accounts`` table, password encrypted at rest). The tool reads them,
  password included, from ``/api/local/mail-accounts/<member id>``: loopback
  only, and only with the gateway's own key (``MAURICE_MCP_TOKEN``) in
  ``X-Maurice-Tool-Token``. This is the ordinary path.
* **A TOML file**, ``email.toml`` beside ``maurice.db`` (``~/.maurice`` on a
  Mac, the data volume in the container), or wherever ``MAURICE_EMAIL_CONFIG``
  points — the admin's path, for what the app cannot describe (Proton through
  Bridge on the Mac, a Keychain entry that already exists). The smallest
  account is two lines, a member and an address; everything else is guessed
  from the domain (see providers.py) and can be overridden. The file holds no
  secrets: passwords come from the macOS Keychain (service ``maurice-email``,
  account = the address, unless the account names another), then from
  ``MAURICE_EMAIL_<NAME>_PASSWORD``.
"""

from __future__ import annotations

import ipaddress
import logging
import os
import re
import hashlib
import json
import sqlite3
import ssl
import subprocess
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

try:
    import tomllib
except ModuleNotFoundError:  # pragma: no cover - Python < 3.11
    import tomli as tomllib  # type: ignore[no-redef]

from . import providers

log = logging.getLogger("maurice.email")

KEYCHAIN_SERVICE = "maurice-email"
_NAME = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")


class ConfigError(RuntimeError):
    """The accounts file is missing a piece or says something unsafe."""


class CredentialError(RuntimeError):
    """No usable password for an account. Degrades that account, not the tool."""


@dataclass(frozen=True)
class Account:
    name: str
    member: str  # the username, as a human writes it
    address: str
    provider: str | None
    host: str
    port: int
    security: str
    username: str
    auth: str
    gmail: bool
    tls_verify: bool = True
    keychain_service: str = KEYCHAIN_SERVICE
    keychain_account: str | None = None
    password_env: str | None = None
    timeout_seconds: float = 30.0
    password_help: str = ""
    source: str = "file"  # file | app
    # An account from the server carries its password; a file account never does.
    password: str | None = field(default=None, repr=False, compare=False)
    password_error: str | None = None

    def describe(self) -> dict[str, Any]:
        return {
            "account": self.name,
            "address": self.address,
            "provider": self.provider or "custom",
            "server": f"{self.host}:{self.port} ({self.security})",
            "gmail_search": self.gmail,
            "added_from": self.source,
        }

    def fingerprint(self) -> str:
        """Changes when anything a connection depends on does — a new password
        above all — so a session opened with the old one is not reused."""
        parts = [self.host, str(self.port), self.security, self.username, self.password or ""]
        return hashlib.sha256("\x00".join(parts).encode()).hexdigest()[:16]


@dataclass
class EmailConfig:
    path: Path
    accounts: list[Account] = field(default_factory=list)
    max_message_bytes: int = 10_000_000
    _member_ids: dict[str, str | None] = field(default_factory=dict)

    def for_member(self, member_id: str) -> list[Account]:
        """The accounts that belong to the member with this id. Never anyone else's."""
        return [a for a in self.accounts if self._resolve(a.member) == member_id]

    def for_username(self, username: str) -> list[Account]:
        return [a for a in self.accounts if a.member == username]

    def _resolve(self, username: str) -> str | None:
        if username not in self._member_ids:
            self._member_ids[username] = resolve_member_id(username)
        return self._member_ids[username]


def maurice_db_path() -> Path:
    # maurice.db sits in the app dir, not under [paths] data_dir — the same
    # resolution as tools/shared/model_config.py and the server's lib/appDir.ts.
    return Path(os.environ.get("MAURICE_DATA_DIR") or (Path.home() / ".maurice")) / "maurice.db"


def default_config_path() -> Path:
    """Beside maurice.db: ~/.maurice on a Mac, the data volume in the container."""
    return maurice_db_path().parent / "email.toml"


def resolve_member_id(username: str) -> str | None:
    """The member id the gateway will hand us for this username.

    Best effort and read-only: an unreadable registry or an unknown name gives
    None, which matches no caller — the guard fails closed, never open.
    """
    db = maurice_db_path()
    if not db.exists():
        log.warning("no maurice.db at %s; member %r stays unresolved", db, username)
        return None
    try:
        with sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=2.0) as conn:
            row = conn.execute(
                "SELECT id FROM users WHERE username = ? OR id = ?", (username, username)
            ).fetchone()
    except sqlite3.Error as exc:
        log.warning("could not resolve member %r against %s: %s", username, db, exc)
        return None
    return str(row[0]) if row else None


def _is_loopback(host: str) -> bool:
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _account(raw: dict[str, Any], taken: set[tuple[str, str]], *, dedupe: bool = False) -> Account:
    member = str(raw.get("member") or "").strip()
    address = str(raw.get("address") or "").strip()
    if not member or not address or "@" not in address:
        raise ConfigError(f"an account needs a member and an address: {raw!r}")

    provider = None
    if raw.get("provider"):
        provider = providers.PROVIDERS.get(str(raw["provider"]))
        if provider is None:
            raise ConfigError(
                f"{address}: unknown provider {raw['provider']!r} "
                f"(known: {', '.join(sorted(providers.PROVIDERS))})"
            )
    else:
        provider = providers.for_address(address)

    host = raw.get("host") or (provider.host if provider else None)
    if not host:
        raise ConfigError(
            f"{address}: the domain is not one we recognise; name its IMAP server "
            "with host = \"imap.example.org\" (and port/security if they are unusual), "
            "or provider = \"gmail\" for a Google Workspace address"
        )
    security = raw.get("security") or (provider.security if provider else "tls")
    if security not in {"tls", "starttls"}:
        raise ConfigError(f"{address}: security must be tls or starttls, not {security!r}")
    port = int(raw.get("port") or (provider.port if provider else (993 if security == "tls" else 143)))

    auth = provider.auth if provider and not raw.get("host") else "password"
    tls_verify = bool(raw.get("tls_verify", auth != "bridge"))
    if not tls_verify and not _is_loopback(str(host)):
        # Skipping certificate checks is for Proton Bridge's self-signed cert on
        # this machine. Anywhere else it hands the password to whoever answers.
        raise ConfigError(f"{address}: tls_verify = false is only allowed for a loopback host")

    name = str(raw.get("name") or (provider.key if provider else address.split("@")[1].split(".")[0]))
    name = name.lower()
    if not _NAME.match(name):
        raise ConfigError(f"{address}: account name {name!r} must be short, lowercase, [a-z0-9_-]")
    if dedupe:
        base, n = name, 2
        while (member, name) in taken:
            name, n = f"{base[:28]}-{n}", n + 1
    if (member, name) in taken:
        raise ConfigError(f"member {member!r} has two accounts named {name!r}; give one a name")
    taken.add((member, name))

    return Account(
        name=name,
        member=member,
        address=address,
        provider=provider.key if provider else None,
        host=str(host),
        port=port,
        security=security,
        username=str(raw.get("username") or address),
        auth=auth,
        gmail=bool(raw.get("gmail", provider.gmail if provider else False)),
        tls_verify=tls_verify,
        keychain_service=str(raw.get("keychain_service") or KEYCHAIN_SERVICE),
        keychain_account=str(raw.get("keychain_account") or address),
        password_env=str(raw.get("password_env") or f"MAURICE_EMAIL_{name.upper().replace('-', '_')}_PASSWORD"),
        timeout_seconds=float(raw.get("timeout_seconds", 30.0)),
        password_help=provider.password_help if provider else "",
    )


def load_config(path: Path | str | None = None) -> EmailConfig:
    config_path = Path(
        os.path.expanduser(str(path or os.environ.get("MAURICE_EMAIL_CONFIG") or default_config_path()))
    )
    if not config_path.exists():
        # Not an error: a household that has not set mail up has no accounts.
        return EmailConfig(path=config_path)
    with config_path.open("rb") as f:
        try:
            raw = tomllib.load(f)
        except tomllib.TOMLDecodeError as exc:
            raise ConfigError(f"{config_path}: {exc}") from exc
    taken: set[tuple[str, str]] = set()
    accounts = [_account(entry, taken) for entry in raw.get("accounts", [])]
    return EmailConfig(
        path=config_path,
        accounts=accounts,
        max_message_bytes=int(raw.get("max_message_bytes", 10_000_000)),
    )


# ── passwords ────────────────────────────────────────────────────────────


def _from_keychain(service: str, account: str | None) -> str | None:
    if not Path("/usr/bin/security").exists():
        return None  # not a Mac
    cmd = ["/usr/bin/security", "find-generic-password", "-s", service]
    if account:
        cmd += ["-a", account]
    cmd.append("-w")  # last: it prints the password and takes no value
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return None
    if out.returncode != 0:
        return None
    return out.stdout.rstrip("\n") or None


def password_for(account: Account) -> str:
    if account.password_error:
        raise CredentialError(f"{account.address}: {account.password_error}")
    if account.password:
        return account.password
    if account.auth == "oauth":
        raise CredentialError(
            f"{account.address}: {account.password_help or 'this provider needs OAuth, which is not supported yet'}"
        )
    password = _from_keychain(account.keychain_service, account.keychain_account)
    if password:
        return password
    if account.password_env and os.environ.get(account.password_env):
        return os.environ[account.password_env]
    hint = f" {account.password_help}" if account.password_help else ""
    raise CredentialError(
        f"no password for {account.address}. Store it with: security add-generic-password "
        f"-s {account.keychain_service} -a {account.keychain_account} -w "
        f"(or set {account.password_env}).{hint}"
    )


# ── accounts the member added from the app ──────────────────────────────


def _server_bases() -> list[str]:
    """Where this household's server listens: TLS on the Mac (its own
    certificate), plain HTTP in the container — try both on loopback, as
    tools/shared/model_config.py does. ``MAURICE_API_BASE`` settles it."""
    base = os.environ.get("MAURICE_API_BASE")
    if base:
        return [base.rstrip("/")]
    port = os.environ.get("PORT") or "3001"
    return [f"https://127.0.0.1:{port}", f"http://127.0.0.1:{port}"]


_server_base: str | None = None


def fetch_app_accounts(member_id: str, taken: set[tuple[str, str]]) -> tuple[list[Account], str | None]:
    """The accounts this member added from the app, passwords included, and
    why not when they could not be read. Never raises: a server that is down
    costs these accounts, not the ones in the file."""
    global _server_base
    token = os.environ.get("MAURICE_MCP_TOKEN") or os.environ.get("AKITA_MCP_TOKEN")
    if not token:
        return [], "the gateway has no MAURICE_MCP_TOKEN, so it cannot read accounts added from the app"
    # Loopback to a certificate that is this machine's own.
    context = ssl.create_default_context()
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    path = f"/api/local/mail-accounts/{urllib.parse.quote(member_id, safe='')}"
    last: Exception | None = None
    body: dict[str, Any] | None = None
    for base in [_server_base] if _server_base else _server_bases():
        request = urllib.request.Request(base + path, headers={"Host": "localhost", "X-Maurice-Tool-Token": token})
        try:
            with urllib.request.urlopen(request, timeout=5, context=context) as resp:
                body = json.loads(resp.read().decode())
            _server_base = base
            break
        except urllib.error.HTTPError as exc:
            return [], f"the server refused the accounts request ({exc.code})"
        except (OSError, ValueError) as exc:
            last = exc
    if body is None:
        _server_base = None
        return [], f"the server could not be reached for your accounts ({last})"
    accounts = []
    for raw in body.get("accounts", []):
        entry = {k: v for k, v in raw.items() if k not in {"id", "password", "password_error"}}
        entry["member"] = member_id
        try:
            account = _account(entry, taken, dedupe=True)
        except ConfigError as exc:
            log.warning("account %s from the app is unusable: %s", raw.get("address"), exc)
            continue
        accounts.append(
            replace(account, source="app", password=raw.get("password"), password_error=raw.get("password_error"))
        )
    return accounts, None
