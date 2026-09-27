import pytest

from tools.email import accounts as accounts_mod

MEMBER_IDS = {"alex": "id-alex", "sam": "id-sam"}


@pytest.fixture(autouse=True)
def sandboxed_app_dir(monkeypatch, tmp_path):
    """Nothing here reads or writes the household's ~/.maurice: a search now
    looks for the member's header store, and a test that forgot to point the
    app dir elsewhere would find the live one."""
    monkeypatch.setenv("MAURICE_DATA_DIR", str(tmp_path / "app"))


@pytest.fixture(autouse=True)
def member_registry(monkeypatch):
    """Usernames resolve without a maurice.db, and no server answers: nothing
    was added from the app unless a test says so."""
    monkeypatch.setattr(accounts_mod, "resolve_member_id", lambda username: MEMBER_IDS.get(username))
    monkeypatch.setattr(accounts_mod, "fetch_app_accounts", lambda member_id, taken: ([], None))
