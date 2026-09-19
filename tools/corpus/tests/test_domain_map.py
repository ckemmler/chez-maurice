#!/usr/bin/env python3
"""The domains' grouping (src/domain_map.py), on a synthetic corpus.

    python tests/test_domain_map.py

Same harness as test_indexing.py: no framework, plain asserts. What is nailed
down is the shape the night relies on — a centroid per conversation, groups
that follow the planted structure, the merge of near-identical groups, the
second level that cuts a big block into its parts, ids ordered by closeness,
and the store's `conversation_centroids` on a throwaway sqlite-vec file.
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
CORPUS = HERE.parent
REPO = CORPUS.parents[1]
for p in (str(REPO), str(CORPUS)):
    if p not in sys.path:
        sys.path.insert(0, p)

from src.domain_map import centroids, cluster, default_k, merge_close, spherical_kmeans  # noqa: E402

DIM = 16
rng = np.random.default_rng(3)


def unit(v):
    v = np.asarray(v, dtype=np.float64)
    return v / np.linalg.norm(v)


def planted(n_groups: int, per: int, noise: float = 0.15, prefix: str = "c") -> tuple[dict[str, np.ndarray], dict[str, int]]:
    """`n_groups` centres far apart on the sphere, `per` conversations each."""
    centres = [unit(rng.normal(size=DIM)) for _ in range(n_groups)]
    vectors, truth = {}, {}
    for g, c in enumerate(centres):
        for i in range(per):
            cid = f"{prefix}{g}-{i}"
            vectors[cid] = unit(c + noise * rng.normal(size=DIM)).astype(np.float32)
            truth[cid] = g
    return vectors, truth


def purity(groups, truth) -> float:
    right = 0
    for g in groups:
        labels = [truth[i] for i in g.conversation_ids]
        right += max(labels.count(l) for l in set(labels))
    return right / len(truth)


def test_centroids_are_unit_and_per_conversation():
    v = centroids([("a", np.array([3.0, 0, 0])), ("a", np.array([0, 4.0, 0])), ("b", np.array([0, 0, 1.0])), ("z", np.zeros(3))])
    assert set(v) == {"a", "b"}, v.keys()
    assert abs(np.linalg.norm(v["a"]) - 1) < 1e-6
    # each chunk normalised before the sum: (1,0,0)+(0,1,0) → equal weights
    assert abs(v["a"][0] - v["a"][1]) < 1e-6


def test_default_k():
    assert default_k(3) == 3          # never more than n
    assert default_k(50) == 4
    assert default_k(800) == 10
    assert default_k(10_000) == 60


def test_kmeans_recovers_planted_groups():
    vectors, truth = planted(5, 30)
    X = np.stack([vectors[i] for i in vectors])
    labels = spherical_kmeans(X, 5)
    ids = list(vectors)
    groups = [type("G", (), {"conversation_ids": [ids[i] for i in np.where(labels == j)[0]]})() for j in set(labels.tolist())]
    assert purity(groups, truth) > 0.95


def test_merge_joins_split_groups():
    vectors, truth = planted(2, 40)
    X = np.stack([vectors[i] for i in vectors])
    labels = spherical_kmeans(X, 6)          # over-split on purpose
    merged = merge_close(X, labels, 0.80)    # the pieces of one planted group are closer than that
    assert len(set(merged.tolist())) == 2, set(merged.tolist())


def test_cluster_orders_by_closeness_and_reports_cohesion():
    vectors, truth = planted(3, 20)
    groups = cluster(vectors, k=3, split_above=None)
    assert len(groups) == 3
    assert purity(groups, truth) > 0.95
    for g in groups:
        assert 0 < g.cohesion <= 1.0
        cen = g.centroid
        sims = [float(np.asarray(vectors[i]) @ cen) for i in g.conversation_ids]
        assert sims == sorted(sims, reverse=True)
        assert g.depth == 0 and g.parent_size is None


def test_second_level_cuts_a_big_block():
    # Three tight sub-themes close together (one "life with Maurice" block) and
    # two far-away themes. A first level too coarse to separate anything (k=1)
    # leaves one block; the second level cuts it into its five parts.
    hub = unit(rng.normal(size=DIM))
    vectors, truth = {}, {}
    for s in range(3):
        sub = unit(hub + 0.5 * rng.normal(size=DIM))
        for i in range(80):
            cid = f"block{s}-{i}"
            vectors[cid] = unit(sub + 0.10 * rng.normal(size=DIM)).astype(np.float32)
            truth[cid] = s
    far, far_truth = planted(2, 30, prefix="far")
    vectors.update(far)
    truth.update({k: 10 + v for k, v in far_truth.items()})

    whole = cluster(vectors, k=1, split_above=None)
    assert [g.size for g in whole] == [300]

    cut = cluster(vectors, k=1, split_above=150, split_per=60)
    assert max(g.size for g in cut) < 150, [g.size for g in cut]
    assert all(g.depth == 1 and g.parent_size == 300 for g in cut)
    assert purity(cut, truth) > 0.9
    assert sum(g.size for g in cut) == len(vectors)


def test_cluster_small_and_empty():
    assert cluster({}) == []
    one = cluster({"only": np.ones(DIM, dtype=np.float32)})
    assert len(one) == 1 and one[0].conversation_ids == ["only"]
    vectors, _ = planted(1, 3)
    assert sum(g.size for g in cluster(vectors)) == 3


def test_store_conversation_centroids():
    import sqlite_vec  # noqa: F401 — the store needs it; skip cleanly if absent
    from src.sqlite_vec_store import SqliteVecStore

    with tempfile.TemporaryDirectory() as tmp:
        store = SqliteVecStore(vectors_dir=Path(tmp), vector_size=DIM, embedding_model="test-model")
        def rec(cid, role, vec, n):
            return {
                "chunk_id": f"{cid}-{role}-{n}", "unit_key": f"conv:{cid}", "unit_hash": f"h{cid}{n}",
                "source_type": "conversation", "vector": [float(x) for x in vec],
                "payload": {"conversation_id": cid, "role": role, "message_id": f"m{cid}{n}"},
            }
        a, b = unit(rng.normal(size=DIM)), unit(rng.normal(size=DIM))
        recs = [rec("A", "user", a, 1), rec("A", "user", a, 2), rec("A", "assistant", b, 3), rec("B", "user", b, 1)]
        recs.append({**rec("N", "user", a, 1), "source_type": "note"})
        store.bulk_load(recs, member_id="m1")
        got = store.conversation_centroids(member_id="m1")
        assert set(got) == {"A", "B"}, got.keys()
        assert float(got["A"] @ a) > 0.99
        both = store.conversation_centroids(member_id="m1", roles=["user", "assistant"])
        assert float(both["A"] @ a) < 0.99  # the assistant chunk pulled it
        only = store.conversation_centroids(member_id="m1", conversation_ids=["B"])
        assert set(only) == {"B"}
        assert store.conversation_centroids(member_id="m2") == {}
        store.close()


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for t in tests:
        try:
            t()
            print(f"ok   {t.__name__}")
        except Exception as exc:  # noqa: BLE001
            failed += 1
            print(f"FAIL {t.__name__}: {exc!r}")
    print(f"{len(tests) - failed}/{len(tests)} passed")
    sys.exit(1 if failed else 0)
