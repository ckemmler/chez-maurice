"""The metadata relay seam: which lookups go to the host's relay, and how.

No network: only the request each provider helper would send is examined.
"""

from __future__ import annotations

import os
import sys
import tempfile
import urllib.parse
import urllib.request
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
# Before the import: the module resolves its garden root once, at load.
os.environ.setdefault("MAURICE_GARDENS_DIR", tempfile.mkdtemp(prefix="garden-relay-test-"))

from tools.garden import server as g  # noqa: E402

KEYS = (
    "TMDB_API_KEY", "GOOGLE_BOOKS_API_KEY", "PODCASTINDEX_API_KEY", "PODCASTINDEX_API_SECRET",
    "IGDB_CLIENT_ID", "IGDB_CLIENT_SECRET",
)


@pytest.fixture(autouse=True)
def no_keys(monkeypatch, tmp_path):
    for key in (*KEYS, "MAURICE_METADATA_RELAY_URL", "MAURICE_METADATA_RELAY_TOKEN"):
        monkeypatch.delenv(key, raising=False)
    # No household row either: a database that is not there.
    monkeypatch.setattr(g, "_MAURICE_DB", str(tmp_path / "absent.db"))


@pytest.fixture
def relay(monkeypatch):
    monkeypatch.setenv("MAURICE_METADATA_RELAY_URL", "https://meta.example.org/")
    monkeypatch.setenv("MAURICE_METADATA_RELAY_TOKEN", "lobet.abc123")


@pytest.fixture
def sent(monkeypatch):
    """What the helpers hand to urlopen, after the seam."""
    seen: list[urllib.request.Request] = []

    class Answer:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def read(self):
            return b'{"results": [], "items": [], "feeds": [], "release-groups": []}'

    def fake(req, **kwargs):
        seen.append(req)
        return Answer()

    monkeypatch.setattr(urllib.request, "urlopen", fake)
    monkeypatch.setattr(g, "_MUSICBRAINZ_MIN_INTERVAL", 0)
    return seen


def query_of(req: urllib.request.Request) -> dict[str, str]:
    return dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(req.full_url).query))


def test_without_a_relay_nothing_changes(sent):
    assert g._api_key("TMDB_API_KEY", "tmdb_api_key") == ""
    g._musicbrainz_search("Kind of Blue", None, None)
    assert sent[0].full_url.startswith("https://musicbrainz.org/ws/2/release-group?")


def test_half_a_configuration_is_no_relay(monkeypatch):
    monkeypatch.setenv("MAURICE_METADATA_RELAY_URL", "https://meta.example.org")
    assert g._metadata_relay() == ("", "")
    assert g._api_key("TMDB_API_KEY", "tmdb_api_key") == ""


def test_a_borrowed_key_never_leaves_and_the_token_goes_instead(relay, sent):
    key = g._api_key("TMDB_API_KEY", "tmdb_api_key")
    assert key  # the "no key configured" checks pass
    g._tmdb_search("Dune", 1984, key)
    g._tmdb_details(841, key)
    search, details = sent
    assert search.full_url.startswith("https://meta.example.org/v1/tmdb/search/movie?")
    assert query_of(search) == {"query": "Dune", "year": "1984"}
    assert details.full_url == "https://meta.example.org/v1/tmdb/movie/841?append_to_response=credits"
    for req in sent:
        assert req.get_header("Authorization") == "Bearer lobet.abc123"
        assert g._RELAY_KEY not in req.full_url


def test_a_key_of_its_own_still_goes_straight_to_the_provider(relay, sent, monkeypatch):
    monkeypatch.setenv("TMDB_API_KEY", "household-key")
    g._tmdb_search("Dune", None, g._api_key("TMDB_API_KEY", "tmdb_api_key"))
    assert sent[0].full_url.startswith("https://api.themoviedb.org/3/search/movie?")
    assert query_of(sent[0])["api_key"] == "household-key"
    assert sent[0].get_header("Authorization") is None


def test_books_podcasts_and_games_follow(relay, sent):
    g._google_books_search("Humus", "Gaspard Koenig", g._api_key("GOOGLE_BOOKS_API_KEY", "google_books_api_key"), lang="fr")
    g._google_books_volume("abc_123")
    api_key = g._api_key("PODCASTINDEX_API_KEY", "podcastindex_api_key")
    api_secret = g._api_key("PODCASTINDEX_API_SECRET", "podcastindex_api_secret")
    g._podcastindex_search("Radiolab", api_key, api_secret)
    g._igdb_search("Outer Wilds", None, *g._igdb_credentials(), 5)
    books, volume, podcast, game = sent
    assert books.full_url.startswith("https://meta.example.org/v1/googlebooks/volumes?")
    assert query_of(books) == {"q": "intitle:Humus+inauthor:Gaspard Koenig", "langRestrict": "fr"}
    assert volume.full_url == "https://meta.example.org/v1/googlebooks/volumes/abc_123"
    assert podcast.full_url == "https://meta.example.org/v1/podcastindex/search/byterm?q=Radiolab"
    # The provider's own signature headers are not the relay's business.
    assert podcast.get_header("X-auth-key") is None
    assert game.full_url == "https://meta.example.org/v1/igdb/games"
    assert game.get_method() == "POST"
    assert b'search "Outer Wilds"' in game.data
    assert game.get_header("Client-id") is None
    # No Twitch token was bought: four lookups, four requests, all to the relay.
    assert all(r.get_header("Authorization") == "Bearer lobet.abc123" for r in sent)


def test_musicbrainz_always_goes_through_a_relay(relay, sent):
    g._musicbrainz_search("Kind of Blue", "Miles Davis", 1959, 5)
    g._musicbrainz_by_id("8e8a594f-2175-38c7-a871-abb68ec363e7")
    search, record = sent
    assert search.full_url.startswith("https://meta.example.org/v1/musicbrainz/release-group?")
    assert query_of(search)["query"] == 'releasegroup:"Kind of Blue" AND artist:"Miles Davis" AND firstreleasedate:1959'
    assert record.full_url.startswith(
        "https://meta.example.org/v1/musicbrainz/release-group/8e8a594f-2175-38c7-a871-abb68ec363e7?"
    )


def test_what_is_not_a_provider_is_left_alone(relay):
    cover = urllib.request.Request("https://image.tmdb.org/t/p/w500/x.jpg")
    assert g._via_relay(cover) is cover
    wikidata = urllib.request.Request("https://www.wikidata.org/w/api.php?action=wbsearchentities")
    assert g._via_relay(wikidata) is wikidata
