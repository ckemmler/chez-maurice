"""Promoting a fiche makes its card of the fiche and its fragments — but not
of what a conversation with Maurice came to (a fragment carrying
`conversation:`), which is in Maurice's words and the card is published under
the member's (19 October 2026)."""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
os.environ.setdefault("MAURICE_GARDENS_DIR", tempfile.mkdtemp(prefix="garden-promote-test-"))

from tools.garden import server as g  # noqa: E402


def test_a_conversation_summary_stays_out_of_the_card(tmp_path):
    fiche = tmp_path / "books" / "fr" / "humus-fiche.md"
    frags = tmp_path / "books" / "fr" / "humus-fiche" / "_fragments"
    frags.mkdir(parents=True)
    fiche.write_text("---\ntitle: Humus\n---\n\nMon avis.\n")
    (frags / "001.frag").write_text('---\nsummary: "Clés"\n---\nLe sol.')
    (frags / "002.frag").write_text(
        '---\nsummary: "Conversation avec Maurice — Humus"\nconversation: abc\ntranscript_hash: f00\n---\nMaurice dit.'
    )

    body = g._promoted_body(fiche, "\nMon avis.\n")

    assert body == "Mon avis.\n\nLe sol."
