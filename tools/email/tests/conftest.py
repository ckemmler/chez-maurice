import pytest

from tools.email import accounts as accounts_mod

MEMBER_IDS = {"alex": "id-alex", "sam": "id-sam"}


@pytest.fixture(autouse=True)
def member_registry(monkeypatch):
    """Usernames resolve without a maurice.db, and no server answers: nothing
    was added from the app unless a test says so."""
    monkeypatch.setattr(accounts_mod, "resolve_member_id", lambda username: MEMBER_IDS.get(username))
    monkeypatch.setattr(accounts_mod, "fetch_app_accounts", lambda member_id, taken: ([], None))
