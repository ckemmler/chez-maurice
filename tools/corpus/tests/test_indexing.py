#!/usr/bin/env python3
"""Corpus indexing, against a throwaway store.

    python tests/test_indexing.py

No test framework: pip cannot install one on this repo's interpreter (the
python@3.14 pyexpat that scripts/setup-calibre-venv.sh exists to work around),
and a second virtualenv is a worse tax than forty lines of harness.

Nothing here touches the household store, the real gardens, or Ollama: the
embedder is a stub that records what it was asked to embed, which is also how
the metadata preamble gets checked.

What it covers is chosen from what actually went wrong. Every defect below was
shipped and found later — by a code review, or by watching a query come back
empty — never by the tests of the day, which exercised realistic-but-tame input
and passed.
"""

from __future__ import annotations

import asyncio
import os
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Any, Iterable

HERE = Path(__file__).resolve().parent
CORPUS = HERE.parent
sys.path.insert(0, str(CORPUS))

# The orchestrator imports `tools.shared.context`, so the repo root has to be on
# the path. Walk up rather than assume a depth: this package sits at
# <maurice>/tools/corpus now, but it spent a year being symlinked in from a
# sibling checkout and may well be again.
def _repo_root() -> Path:
    if env := os.environ.get("MAURICE_REPO"):
        return Path(env)
    for candidate in [CORPUS, *CORPUS.parents]:
        if (candidate / "tools" / "shared").is_dir():
            return candidate
        if (candidate / "maurice" / "tools" / "shared").is_dir():
            return candidate / "maurice"
    sys.exit("needs a Maurice checkout for tools.shared — set MAURICE_REPO")


sys.path.insert(0, str(_repo_root()))

TMP = Path(tempfile.mkdtemp(prefix="corpus-tests-"))
os.environ["MAURICE_CORPUS_DATA_DIR"] = str(TMP / "state")

from src.config import (  # noqa: E402
    ChunkingConfig,
    CorpusConfig,
    EmbeddingConfig,
    MetadataConfig,
    SourceConfig,
    StoreConfig,
    WatcherConfig,
)
from src.embedder import EmbeddingResult  # noqa: E402
from src.orchestrator import CorpusOrchestrator  # noqa: E402
from src.utils import build_metadata_head, build_metadata_prose, flatten_frontmatter  # noqa: E402

VECTOR_SIZE = 8
GARDENS = TMP / "gardens"
MEMBER = "candide"

# ── harness ──────────────────────────────────────────────────────────────────

_failures: list[str] = []
_count = 0


def check(label: str, ok: bool, detail: str = "") -> None:
    global _count
    _count += 1
    if not ok:
        _failures.append(label)
    print(f"{'ok  ' if ok else 'FAIL'} {label}" + (f"  → {detail}" if detail else ""))


def eq(label: str, got: Any, want: Any) -> None:
    check(label, got == want, "" if got == want else f"got {got!r}, want {want!r}")


class FakeEmbedder:
    """Deterministic vectors, and a record of every text embedded.

    Reproduces the real embedder's contract exactly, including that it drops
    blank strings — a difference between what is chunked and what is embedded is
    a vector/chunk misalignment waiting to happen, so the stub must not paper
    over it.
    """

    def __init__(self) -> None:
        self.seen: list[str] = []

    async def embed_batch(self, texts: Iterable[str]) -> EmbeddingResult:
        cleaned = [t.strip() for t in texts if t.strip()]
        self.seen.extend(cleaned)
        return EmbeddingResult(
            vectors=[[float(len(t) % 7) + i / 100 for i in range(VECTOR_SIZE)] for t in cleaned],
            model="fake",
        )


def write(rel: str, text: str) -> Path:
    path = GARDENS / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def source(source_type: str, pattern: str, *, exclude: list[str] | None = None,
           extract_from_path: dict[str, str] | None = None) -> SourceConfig:
    return SourceConfig(
        path=GARDENS,
        pattern=pattern,
        exclude=exclude or [],
        chunking=ChunkingConfig(method="paragraph", max_tokens=512, overlap_tokens=0),
        metadata=MetadataConfig(
            source_type=source_type,
            extract_from_frontmatter=True,
            extract_from_path=extract_from_path or {},
        ),
    )


def build() -> CorpusOrchestrator:
    config = CorpusConfig(
        store=StoreConfig(backend="sqlite_vec", path=TMP / "vectors"),
        embedding=EmbeddingConfig(provider="ollama", model="fake", vector_size=VECTOR_SIZE),
        watcher=WatcherConfig(),
        sources={
            "garden-notes": source("note", "*/notes/*/*.md"),
            "garden-fiches": source("fiche", "*/*/*/*-fiche.md",
                                    extract_from_path={"collection": "parent.parent.name"}),
            "garden-cards": source("card", "*/*/*/*.md",
                                   exclude=["*/notes/*/*.md", "*/*/*/*-fiche.md"],
                                   extract_from_path={"collection": "parent.parent.name"}),
            "garden-fragments": source("fragment", "*/*/*/*-fiche/_fragments/*.frag"),
        },
    )
    orch = CorpusOrchestrator(config, vector_size=VECTOR_SIZE)
    orch.embedder = FakeEmbedder()  # type: ignore[assignment]
    return orch


def payloads(orch: CorpusOrchestrator, **where: Any) -> list[dict]:
    return list(orch.indexer.iter_chunks(where=where or None, limit=5000))


def one(orch: CorpusOrchestrator, **where: Any) -> dict:
    found = payloads(orch, **where)
    return found[0] if found else {}


# ── the fixtures, written as the garden actually writes them ─────────────────

CARD = """---
title: People of Burkina Faso should forget about democracy
source: the Guardian
url: "https://www.theguardian.com/world/x"
date_read: 2026-04-04
author: Rachel Savage
locale: fr
---

Le corps de la carte publiée, tel qu'il a été scrapé à l'époque.
"""

FICHE = """---
title: Being You
resource_collection: books
resource_id: being-you
date: '2026-03-19'
tags:
- consciousness
- neuroscience
locale: fr
meta:
  author: Anil Seth
  year: 2021
  publication: Dutton
  description: Une théorie de la conscience comme hallucination contrôlée.
---

Seth propose la conscience comme hallucination contrôlée.

Le chapitre sur Phi et l'information intégrée est le plus dense du livre.
"""

NOTE = """---
title: Rêves
tags: [rêve, journal]
locale: fr
---

Ce que je note au réveil, avant que ça s'efface.
"""


async def main() -> int:
    orch = build()

    write(f"{MEMBER}/articles/fr/burkina.md", CARD)
    write(f"{MEMBER}/books/fr/being-you-fiche.md", FICHE)
    write(f"{MEMBER}/notes/fr/reves.md", NOTE)
    write(f"{MEMBER}/books/fr/being-you-fiche/_fragments/001.frag",
          '---\nsummary: "Texte intégral — Dutton"\n---\nLe texte complet du livre.\n')

    await orch.initial_index()

    print("── each shape lands in exactly one source ──")
    for source_type, expected in [("card", 1), ("fiche", 1), ("note", 1), ("fragment", 1)]:
        files = {p["file_path"] for p in payloads(orch, source_type=source_type)}
        eq(f"{source_type}: one file", len(files), expected)
    all_files = [p["file_path"] for p in payloads(orch)]
    eq("no document indexed twice", len(set(all_files)), len({f for f in all_files}))
    fiche_as_card = [p for p in payloads(orch, source_type="card") if p["file_path"].endswith("-fiche.md")]
    eq("the exclude keeps fiches out of cards", len(fiche_as_card), 0)
    note_as_card = [p for p in payloads(orch, source_type="card") if "/notes/" in p["file_path"]]
    eq("the exclude keeps notes out of cards", len(note_as_card), 0)

    print("\n── a document cannot overwrite the corpus's own vocabulary ──")
    # The card names its publication `source`, which used to replace the name of
    # the source that indexed it: the payload said "the Guardian" where it meant
    # "garden-cards", and filtering by source was quietly broken.
    card = one(orch, source_type="card")
    eq("source is the source that indexed it", card.get("source"), "garden-cards")
    eq("the card's own `source` becomes `publication`", card.get("publication"), "the Guardian")

    print("\n── one vocabulary across the two generations of file ──")
    fiche = one(orch, source_type="fiche")
    eq("a fiche's meta.publication is reachable", fiche.get("publication"), "Dutton")
    eq("a fiche's meta.author is flattened up", fiche.get("author"), "Anil Seth")
    check("no `meta` block left in the payload", "meta" not in fiche)
    eq("collection comes from the path", fiche.get("collection"), "books")

    print("\n── the metadata preamble rides along without being stored ──")
    embedded = orch.embedder.seen  # type: ignore[attr-defined]
    fiche_chunks = payloads(orch, source_type="fiche")
    head = build_metadata_head(flatten_frontmatter(
        {"title": "Being You", "resource_collection": "books", "tags": ["consciousness", "neuroscience"],
         "meta": {"author": "Anil Seth", "year": 2021, "publication": "Dutton"}}))
    check("the head names the work and its author", "Anil Seth" in head and "Being You" in head, head.replace("\n", " · "))
    check("every fiche chunk was embedded with the head",
          all(any(t.startswith(head) and c["text"] in t for t in embedded) for c in fiche_chunks))
    check("but no stored chunk carries it",
          not any(c["text"].startswith("Being You —") for c in fiche_chunks))
    prose = build_metadata_prose(flatten_frontmatter({"meta": {"description": "Une théorie de la conscience comme hallucination contrôlée."}}))
    check("the prose is stored as its own chunk, so a hit on it can be quoted",
          any(c["text"] == prose for c in fiche_chunks), prose[:50])
    eq("and only once", sum(1 for c in fiche_chunks if c["text"] == prose), 1)

    print("\n── force ──")
    before = len(payloads(orch))
    await orch.initial_index()
    eq("an unchanged file is skipped", len(payloads(orch)), before)
    seen_before = len(orch.embedder.seen)  # type: ignore[attr-defined]
    await orch.initial_index(force=True)
    check("force re-embeds it", len(orch.embedder.seen) > seen_before)  # type: ignore[attr-defined]
    eq("without duplicating anything", len(payloads(orch)), before)

    print("\n── prune ──")
    (GARDENS / MEMBER / "articles/fr/burkina.md").unlink()
    orch.indexer.upsert_precomputed(  # a conversation: its key is not a path
        records=[{"chunk_id": "msg:abc#0", "unit_key": "msg:abc", "unit_hash": "h",
                  "source_type": "conversation",
                  "payload": {"file_path": "msg:abc", "source": "conversations", "text": "x"},
                  "vector": [0.0] * VECTOR_SIZE}],
        member_id=None,
    ) if hasattr(orch.indexer, "upsert_precomputed") else None
    result = orch.prune_missing()
    eq("the deleted card is gone", len(payloads(orch, source_type="card")), 0)
    check("it was counted", result["removed"] >= 1, str(result["by_source"]))
    eq("the fiche is untouched", len(payloads(orch, source_type="fiche")), len(fiche_chunks))
    conv = payloads(orch, source_type="conversation")
    if conv:
        eq("a conversation key is never read as a missing file", len(conv), 1)

    print("\n── filters ──")
    eq("substring, case-insensitive", len(payloads(orch, publication="dutt")), len(fiche_chunks))
    eq("list matches any", len(payloads(orch, source_type=["fiche", "note"])),
       len(fiche_chunks) + len(payloads(orch, source_type="note")))
    eq("no match is empty, not everything", len(payloads(orch, publication="nexistepas")), 0)
    try:
        payloads(orch, **{"meta.author": "Seth"})
        check("a dotted key is rejected", False)
    except ValueError as exc:
        check("a dotted key is rejected", True, str(exc))

    print("\n── frontmatter as it really comes ──")
    # The category the earlier suites lacked. A title beginning with `[` broke
    # the *writer* (a YAML flow sequence in the frontmatter); these check the
    # reader survives the same shapes, plus the ones a hand-edited file has.
    hostile = {
        "bracket-title": '---\ntitle: "[Analyse] Le nucléaire"\ntags: [x]\n---\n\nCorps.\n',
        "emoji-title": '---\ntitle: "Bilan 😀 2026"\n---\n\nCorps.\n',
        "tags-as-string": "---\ntitle: T\ntags: pas-une-liste\n---\n\nCorps.\n",
        "meta-not-a-dict": "---\ntitle: T\nmeta: juste-une-chaine\n---\n\nCorps.\n",
        "no-frontmatter": "Juste du texte, aucune entête.\n",
        "broken-yaml": "---\ntitle: [non fermé\n---\n\nCorps.\n",
        "empty-body": "---\ntitle: Fiche sans corps\nresource_collection: books\nmeta:\n  author: X\n---\n",
        "whitespace-body": "---\ntitle: Blancs\n---\n\n   \n\n  \n",
    }
    for name, text in hostile.items():
        write(f"{MEMBER}/books/fr/{name}-fiche.md", text)
    await orch.initial_index(["garden-fiches"])

    fiches = payloads(orch, source_type="fiche")
    by_file = {Path(p["file_path"]).stem: p for p in fiches}
    for name in hostile:
        stem = f"{name}-fiche"
        check(f"{name}: indexed", stem in by_file,
              "" if stem in by_file else "absent — a whole document silently lost")
    eq("a bracketed title survives the round trip",
       by_file.get("bracket-title-fiche", {}).get("title"), "[Analyse] Le nucléaire")
    eq("an emoji title is not mangled",
       by_file.get("emoji-title-fiche", {}).get("title"), "Bilan 😀 2026")
    check("tags given as a string do not crash the preamble",
          by_file.get("tags-as-string-fiche", {}).get("title") == "T")
    check("a `meta` that is not a mapping is ignored, not fatal",
          "author" not in by_file.get("meta-not-a-dict-fiche", {}))
    check("a fiche with an empty body is still findable by its metadata",
          "empty-body-fiche" in by_file)

    print("\n── chunks and vectors stay aligned ──")
    # The embedder drops blank strings; if a chunker ever emits one, the vectors
    # would be shorter than the chunks and every payload after it would carry
    # the wrong vector. Silent, and unrecoverable without a reindex.
    for p in payloads(orch):
        if not str(p.get("text", "")).strip():
            check("no blank chunk was stored", False, p["file_path"])
            break
    else:
        check("no blank chunk was stored", True)

    print(f"\n{_count} checks · " + ("ALL PASS" if not _failures else f"{len(_failures)} FAILURE(S)"))
    for f in _failures:
        print(f"   ✗ {f}")
    return 0 if not _failures else 1


if __name__ == "__main__":
    try:
        code = asyncio.run(main())
    finally:
        shutil.rmtree(TMP, ignore_errors=True)
    sys.exit(code)
