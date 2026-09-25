"""Where a mailbox lives, guessed from the address.

The point of this table is that a member should only ever have to give an
address and a password. The host, the port and the transport are looked up from
the domain; an account can still name them outright for a provider that is not
here (a company server, a small host), and that always wins.

``auth`` says what the provider accepts over IMAP today:

* ``password`` — an app-specific password (Gmail, iCloud, Yahoo, Fastmail…) or
  the account password (most French ISPs);
* ``bridge`` — Proton: the password Proton Bridge generates, on loopback;
* ``oauth`` — the provider no longer takes a password over IMAP at all
  (Outlook.com / Hotmail). Listed so the refusal is explicit rather than a
  baffling login failure; OAuth is not implemented yet.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Provider:
    key: str
    label: str
    host: str
    port: int = 993
    security: str = "tls"  # tls | starttls
    auth: str = "password"  # password | bridge | oauth
    # Gmail speaks X-GM-RAW (its own search syntax) and keeps every message in
    # one \All folder, which changes what "search everything" means.
    gmail: bool = False
    password_help: str = ""


GMAIL = Provider(
    "gmail",
    "Gmail",
    "imap.gmail.com",
    gmail=True,
    password_help=(
        "An app password: turn on 2-Step Verification, then create one at "
        "https://myaccount.google.com/apppasswords"
    ),
)
ICLOUD = Provider(
    "icloud",
    "iCloud",
    "imap.mail.me.com",
    password_help="An app-specific password, from https://account.apple.com (Sign-In and Security).",
)
FASTMAIL = Provider(
    "fastmail",
    "Fastmail",
    "imap.fastmail.com",
    password_help="An app password, from Settings → Privacy & Security → Integrations.",
)
YAHOO = Provider(
    "yahoo",
    "Yahoo",
    "imap.mail.yahoo.com",
    password_help="An app password, from Account Security → Generate app password.",
)
OUTLOOK = Provider(
    "outlook",
    "Outlook.com",
    "outlook.office365.com",
    auth="oauth",
    password_help="Microsoft accepts only OAuth over IMAP; not supported yet.",
)
PROTON = Provider(
    "proton",
    "Proton (via Bridge)",
    "127.0.0.1",
    port=1143,
    security="starttls",
    auth="bridge",
    password_help="The password Proton Bridge shows under Mailbox details, not the Proton login.",
)
ORANGE = Provider("orange", "Orange", "imap.orange.fr")
FREE = Provider("free", "Free", "imap.free.fr")
SFR = Provider("sfr", "SFR", "imap.sfr.fr")
LAPOSTE = Provider("laposte", "La Poste", "imap.laposte.net")

PROVIDERS: dict[str, Provider] = {
    p.key: p for p in (GMAIL, ICLOUD, FASTMAIL, YAHOO, OUTLOOK, PROTON, ORANGE, FREE, SFR, LAPOSTE)
}

_DOMAINS: dict[str, Provider] = {
    "gmail.com": GMAIL,
    "googlemail.com": GMAIL,
    "icloud.com": ICLOUD,
    "me.com": ICLOUD,
    "mac.com": ICLOUD,
    "fastmail.com": FASTMAIL,
    "fastmail.fm": FASTMAIL,
    "yahoo.com": YAHOO,
    "yahoo.fr": YAHOO,
    "ymail.com": YAHOO,
    "outlook.com": OUTLOOK,
    "outlook.fr": OUTLOOK,
    "hotmail.com": OUTLOOK,
    "hotmail.fr": OUTLOOK,
    "live.com": OUTLOOK,
    "live.fr": OUTLOOK,
    "msn.com": OUTLOOK,
    "proton.me": PROTON,
    "protonmail.com": PROTON,
    "pm.me": PROTON,
    "orange.fr": ORANGE,
    "wanadoo.fr": ORANGE,
    "free.fr": FREE,
    "sfr.fr": SFR,
    "neuf.fr": SFR,
    "laposte.net": LAPOSTE,
}


def for_address(address: str) -> Provider | None:
    """The provider an address's domain belongs to, or None for a domain we do
    not know (a custom domain: the account then has to name its host)."""
    domain = address.rpartition("@")[2].strip().lower().rstrip(".")
    return _DOMAINS.get(domain)
