"""The fiche of one podcast episode (14 October 2026): `open_fiche` with a
`podcast_episode_id` files `<show>--<episode>-fiche.md`, its show in `meta`.

No network: Podcast Index is stubbed.
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
os.environ.setdefault("MAURICE_GARDENS_DIR", tempfile.mkdtemp(prefix="garden-episode-test-"))

from tools.garden import server as g  # noqa: E402

EPISODE = {
    "id": 61667039106,
    "feedId": 743229,
    "title": "Mathematicians’ Latest Problem: What if A.I. Can Do Our Job?",
    "datePublished": 1791884700,
    "duration": 1997,
    "link": "https://www.nytimes.com/the-daily",
    "image": "https://img.example.org/ep.jpg",
    "enclosureUrl": "https://audio.example.org/ep.mp3",
    "description": "<p>Steven Strogatz, a professor of mathematics at Cornell,</p><p>on A.I. &amp; grief.</p>",
}
FEED = {"id": 743229, "title": "The Daily", "author": "The New York Times"}


@pytest.fixture
def podcast_index(monkeypatch):
    monkeypatch.setenv("PODCASTINDEX_API_KEY", "k")
    monkeypatch.setenv("PODCASTINDEX_API_SECRET", "s")
    asked: list[tuple] = []

    def episode(episode_id, feed_id, *_):
        asked.append(("episode", episode_id, feed_id))
        return dict(EPISODE) if episode_id == EPISODE["id"] else {}

    monkeypatch.setattr(g, "_podcastindex_episode", episode)
    monkeypatch.setattr(g, "_podcastindex_by_id", lambda feed_id, *_: dict(FEED) if feed_id == FEED["id"] else {})
    monkeypatch.setattr(g, "_fiche_cover", lambda *a, **k: "")
    monkeypatch.setattr(g, "_auto_commit", lambda *a, **k: None)
    return asked


def test_the_episode_gets_its_own_fiche_under_its_show(podcast_index):
    card = g._handle_open_fiche({
        "resource_collection": "podcasts", "locale": "fr",
        "podcastindex_id": 743229, "podcast_episode_id": EPISODE["id"],
    })
    assert "error" not in card, card
    assert card["resource_id"] == "the-daily--mathematicians-latest-problem-what-if-ai-can-do-our-job"
    assert card["title"] == EPISODE["title"]
    assert card["show_title"] == "The Daily"
    assert card["fiche_created"] is True

    fm, _ = g._parse_note(g._resolve_fiche_path("podcasts", card["resource_id"], "fr"))
    meta = fm["meta"]
    assert meta["show"] == "the-daily"
    assert meta["subtitle"] == "The Daily"
    assert meta["host"] == "The New York Times"
    assert meta["podcastindex_episode_id"] == EPISODE["id"]
    assert meta["description"] == "Steven Strogatz, a professor of mathematics at Cornell, on A.I. & grief."
    assert meta["published_at"].startswith("2026-")

    # Opened again: the same fiche, nothing written twice.
    again = g._handle_open_fiche({
        "resource_collection": "podcasts", "locale": "fr",
        "podcastindex_id": 743229, "podcast_episode_id": EPISODE["id"],
    })
    assert again["resource_id"] == card["resource_id"]
    assert again["fiche_created"] is False


def test_an_episode_that_cannot_be_found_is_an_error_not_a_guess(podcast_index):
    card = g._handle_open_fiche({
        "resource_collection": "podcasts", "locale": "fr",
        "podcastindex_id": 743229, "podcast_episode_id": 1,
    })
    assert "error" in card


def test_plain_text_of_a_feed_description():
    assert g._plain_text("<p>One &amp; two</p>\n<p>three</p>") == "One & two three"
    assert g._plain_text(None) == ""
