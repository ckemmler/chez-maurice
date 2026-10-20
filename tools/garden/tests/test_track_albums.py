"""A song is looked up through its recordings and kept under its album.

No network: MusicBrainz's answer is given.
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
os.environ.setdefault("MAURICE_GARDENS_DIR", tempfile.mkdtemp(prefix="garden-track-test-"))

from tools.garden import server as g  # noqa: E402


def release(title, mbid, kind, date, secondary=None, status="Official"):
    return {"title": title, "date": date, "status": status,
            "release-group": {"id": mbid, "title": title, "primary-type": kind, "secondary-types": secondary or []}}


def recording(title, artist, *releases):
    return {"title": title, "artist-credit": [{"name": artist}], "releases": list(releases)}


ANSWER = {"recordings": [
    recording("Bohemian Rhapsody", "Queen",
              release("Greatest Hits", "c" * 36, "Album", "1981", ["Compilation"]),
              release("Bohemian Rhapsody", "s" * 36, "Single", "1975-10-31")),
    recording("Bohemian Rhapsody", "Queen",
              release("Live Killers", "l" * 36, "Album", "1979", ["Live"]),
              release("Complete Kampuchea Concert", "b" * 36, "Album", "1979", ["Live"], status="Bootleg")),
    recording("Bohemian Rhapsody", "Queen",
              release("A Night at the Opera", "o" * 36, "Album", "2001"),
              release("A Night at the Opera", "o" * 36, "Album", "1975-11-21")),
    recording("Bohemian Rhapsody (Live Aid)", "Queen", release("Soundtrack", "t" * 36, "Album", "2018")),
]}


def test_the_studio_album_comes_first_then_single_live_compilation(monkeypatch):
    asked = []
    monkeypatch.setattr(g, "_musicbrainz_get", lambda path, params: asked.append((path, params)) or ANSWER)
    card = g._search_album_sync({"track": "Bohemian Rhapsody", "artist": "Queen", "limit": 5})
    assert asked == [("recording", {"query": 'recording:"Bohemian Rhapsody" AND artist:"Queen"', "limit": 100})]
    # Another title (a live take named so), a bootleg: not offered.
    assert [r["title"] for r in card["results"]] == ["A Night at the Opera", "Bohemian Rhapsody", "Live Killers", "Greatest Hits"]
    top = card["results"][0]
    assert top["id"] == "o" * 36 and top["subtitle"] == "Queen" and top["track"] == "Bohemian Rhapsody"
    assert top["year"] is None
    assert top["image"] == f"https://coverartarchive.org/release-group/{'o' * 36}/front-250"


def test_an_album_search_is_unchanged_and_one_of_the_two_is_needed(monkeypatch):
    asked = []
    monkeypatch.setattr(g, "_musicbrainz_get", lambda path, params: asked.append(path) or {"release-groups": []})
    g._search_album_sync({"title": "Kind of Blue"})
    assert asked == ["release-group"]
    assert "error" in g._search_album_sync({})
