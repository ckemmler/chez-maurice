"""Accounts a member added from the app: read from the server, passwords
included, merged with the file's, and never reused past a password change."""

from __future__ import annotations

import http.server
import json
import threading
from dataclasses import replace

import pytest

from tools.email import accounts as accounts_mod
from tools.email.accounts import load_config
from tools.email.service import AccessDenied, EmailService

from .test_email import CONFIG, gmail_client, write_config

REAL_FETCH = accounts_mod.fetch_app_accounts


def app_account(member_id, taken, **fields):
    account = accounts_mod._account({"member": member_id, **fields}, taken, dedupe=True)
    return replace(account, source="app", password=fields.get("password"))


def test_app_accounts_join_the_files_and_names_do_not_collide(tmp_path, monkeypatch):
    def fetch(member_id, taken):
        return [app_account(member_id, taken, address="alex.other@gmail.com")], None

    monkeypatch.setattr(accounts_mod, "fetch_app_accounts", fetch)
    svc = EmailService(load_config(write_config(tmp_path, CONFIG)), client_factory=lambda acc: gmail_client())
    alex = svc.accounts(member_id="id-alex")
    assert [(a.name, a.source) for a in alex] == [("icloud", "file"), ("gmail", "file"), ("gmail-2", "app")]
    assert svc.list_accounts(alex)["accounts"][2]["added_from"] == "app"
    # Sam's accounts are fetched for Sam, not Alex.
    seen = []
    monkeypatch.setattr(accounts_mod, "fetch_app_accounts", lambda m, t: (seen.append(m) or [], None))
    svc.accounts(member_id="id-sam")
    assert seen == ["id-sam"]


def test_the_password_from_the_app_is_the_one_used():
    acc = app_account("id-alex", set(), address="alex@gmail.com", password="abcdefghijklmnop")
    assert accounts_mod.password_for(acc) == "abcdefghijklmnop"
    assert "abcdefgh" not in repr(acc)  # never in a log line
    broken = replace(accounts_mod._account({"member": "id-alex", "address": "b@gmail.com"}, set()),
                     password_error="enter it again")
    with pytest.raises(accounts_mod.CredentialError, match="enter it again"):
        accounts_mod.password_for(broken)


def test_a_new_password_opens_a_new_session(tmp_path, monkeypatch):
    password = {"value": "first"}
    logins = []

    def fetch(member_id, taken):
        return [app_account(member_id, taken, address="alex@gmail.com", password=password["value"])], None

    def factory(acc):
        logins.append(accounts_mod.password_for(acc))
        return gmail_client()

    monkeypatch.setattr(accounts_mod, "fetch_app_accounts", fetch)
    svc = EmailService(load_config(tmp_path / "none.toml"), client_factory=factory)
    svc.list_folders(svc.accounts(member_id="id-alex"), None)
    svc.list_folders(svc.accounts(member_id="id-alex"), None)
    password["value"] = "second"
    svc.list_folders(svc.accounts(member_id="id-alex"), None)
    assert logins == ["first", "second"]
    assert len(svc._sessions) == 1


def test_why_the_app_accounts_are_missing_is_said(tmp_path, monkeypatch):
    monkeypatch.setattr(accounts_mod, "fetch_app_accounts", lambda m, t: ([], "the server could not be reached"))
    svc = EmailService(load_config(tmp_path / "none.toml"))
    with pytest.raises(AccessDenied, match="Settings → Mail.*could not be reached"):
        svc.search(svc.accounts(member_id="id-alex"))


def test_fetching_from_the_server_sends_the_gateway_key(monkeypatch):
    seen = {}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            seen["path"] = self.path
            seen["token"] = self.headers.get("X-Maurice-Tool-Token")
            body = json.dumps({"accounts": [
                {"id": "x", "address": "alex@gmail.com", "provider": "gmail", "password": "pw"},
                # No host and a domain nobody knows: unusable, skipped, the rest kept.
                {"id": "y", "address": "alex@example.org", "password": "pw"},
            ]}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    httpd = http.server.HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        monkeypatch.setenv("MAURICE_API_BASE", f"http://127.0.0.1:{httpd.server_address[1]}")
        monkeypatch.setenv("MAURICE_MCP_TOKEN", "gateway-key")
        monkeypatch.setattr(accounts_mod, "_server_base", None)
        accounts, note = REAL_FETCH("id alex", set())
    finally:
        httpd.shutdown()
    assert seen == {"path": "/api/local/mail-accounts/id%20alex", "token": "gateway-key"}
    assert note is None
    assert [(a.address, a.host, a.source, a.password) for a in accounts] == [
        ("alex@gmail.com", "imap.gmail.com", "app", "pw")
    ]


def test_a_refusal_is_reported_not_raised(monkeypatch):
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(403)
            self.end_headers()

        def log_message(self, *args):
            pass

    httpd = http.server.HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        monkeypatch.setenv("MAURICE_API_BASE", f"http://127.0.0.1:{httpd.server_address[1]}")
        monkeypatch.setenv("MAURICE_MCP_TOKEN", "wrong")
        monkeypatch.setattr(accounts_mod, "_server_base", None)
        accounts, note = REAL_FETCH("id-alex", set())
    finally:
        httpd.shutdown()
    assert accounts == [] and "403" in note


def test_without_the_gateway_key_nothing_is_asked(monkeypatch):
    monkeypatch.delenv("MAURICE_MCP_TOKEN", raising=False)
    monkeypatch.delenv("AKITA_MCP_TOKEN", raising=False)
    accounts, note = REAL_FETCH("id-alex", set())
    assert accounts == [] and "MAURICE_MCP_TOKEN" in note
