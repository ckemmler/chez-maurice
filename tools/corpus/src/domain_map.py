"""Grouping a member's conversations by their vectors — the arithmetic behind
the domains' nightly mapping (design note *maurice-domaines*, 4a).

Pure numpy, no scikit-learn: one unit centroid per conversation (the sum of
its chunk vectors on the roles asked for, normalised), spherical k-means with
k-means++ seeding and a few restarts, a union-find merge of the centroids that
came out too close, and a **second level** on any group above a size — the
lesson of P0 on the owner's corpus, where a single k for three thousand
imported English conversations and a thousand French ones lived with Maurice
left the latter in one block of eight hundred.

The step-0 script (`scripts/map_domains.py`) and the corpus's MCP tool
`map_conversations` both call `cluster()`; the server does the rest (dates,
recurrence, naming, proposals) from its own database.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterable, Mapping

import numpy as np


# ── Centroids ────────────────────────────────────────────────────────────────


def centroids(chunks: Iterable[tuple[str, np.ndarray]]) -> dict[str, np.ndarray]:
    """One unit vector per conversation from its chunk vectors: each chunk is
    normalised first so a long chunk does not weigh more than a short one,
    then the sum is put back on the sphere."""
    sums: dict[str, np.ndarray] = {}
    for cid, vec in chunks:
        v = np.asarray(vec, dtype=np.float64)
        n = np.linalg.norm(v)
        if n == 0:
            continue
        acc = sums.get(cid)
        if acc is None:
            sums[cid] = v / n
        else:
            acc += v / n
    out: dict[str, np.ndarray] = {}
    for cid, acc in sums.items():
        n = np.linalg.norm(acc)
        if n > 0:
            out[cid] = (acc / n).astype(np.float32)
    return out


# ── k-means on the sphere ────────────────────────────────────────────────────


def spherical_kmeans(X: np.ndarray, k: int, *, iters: int = 40, restarts: int = 4, seed: int = 7) -> np.ndarray:
    """Labels of the best of `restarts` runs (k-means++ seeds, cosine)."""
    rng = np.random.default_rng(seed)
    n = X.shape[0]
    k = max(1, min(k, n))
    if k == 1:
        return np.zeros(n, dtype=int)
    best_labels, best_score = None, -np.inf
    for _ in range(restarts):
        centers = [X[rng.integers(n)]]
        d2 = np.full(n, np.inf)
        for _ in range(1, k):
            d2 = np.minimum(d2, 1.0 - X @ centers[-1])
            p = np.clip(d2, 0, None) ** 2
            p = p / p.sum() if p.sum() > 0 else np.full(n, 1.0 / n)
            centers.append(X[rng.choice(n, p=p)])
        C = np.stack(centers)
        labels = np.zeros(n, dtype=int)
        for it in range(iters):
            new = (X @ C.T).argmax(axis=1)
            if it > 0 and np.array_equal(new, labels):
                break
            labels = new
            for j in range(k):
                m = labels == j
                if m.any():
                    c = X[m].sum(axis=0)
                    C[j] = c / (np.linalg.norm(c) or 1.0)
                else:  # empty group: reseed on the worst-served point
                    worst = (X @ C.T).max(axis=1).argmin()
                    C[j] = X[worst]
        score = (X @ C.T).max(axis=1).sum()
        if score > best_score:
            best_score, best_labels = score, labels.copy()
    assert best_labels is not None
    return best_labels


def _centroid(M: np.ndarray) -> np.ndarray:
    c = M.sum(axis=0)
    return c / (np.linalg.norm(c) or 1.0)


def _relabel(labels: np.ndarray) -> np.ndarray:
    ids = {j: i for i, j in enumerate(sorted(set(labels.tolist())))}
    return np.array([ids[j] for j in labels], dtype=int)


def merge_close(X: np.ndarray, labels: np.ndarray, threshold: float) -> np.ndarray:
    """Merge groups whose centroids are closer than `threshold` (cosine),
    pair by pair, until none is."""
    labels = labels.copy()
    while True:
        ids = sorted(set(labels.tolist()))
        if len(ids) < 2:
            return _relabel(labels)
        C = np.stack([_centroid(X[labels == j]) for j in ids])
        S = C @ C.T
        np.fill_diagonal(S, -1)
        i, j = np.unravel_index(S.argmax(), S.shape)
        if S[i, j] < threshold:
            return _relabel(labels)
        labels = np.where(labels == ids[j], ids[i], labels)


def default_k(n: int) -> int:
    """The step-0 rule: one group per eighty conversations, four at least,
    sixty at most, never more than there are conversations."""
    return max(1, min(n, max(4, min(60, n // 80))))


# ── Groups, with a second level on the big ones ──────────────────────────────


@dataclass
class Group:
    conversation_ids: list[str]          # ordered by closeness to the centroid
    cohesion: float
    depth: int = 0                       # 0 = first level, 1 = cut out of a big group
    parent_size: int | None = None       # size of the group it was cut out of
    centroid: np.ndarray | None = field(default=None, repr=False)

    @property
    def size(self) -> int:
        return len(self.conversation_ids)


def _group(ids: list[str], X: np.ndarray, depth: int, parent: int | None) -> Group:
    cen = _centroid(X)
    sims = X @ cen
    order = np.argsort(-sims)
    return Group(
        conversation_ids=[ids[i] for i in order],
        cohesion=float(sims.mean()),
        depth=depth,
        parent_size=parent,
        centroid=cen.astype(np.float32),
    )


def cluster(
    vectors: Mapping[str, np.ndarray],
    *,
    k: int | None = None,
    merge: float = 0.90,
    split_above: int | None = 200,
    split_per: int = 60,
    max_depth: int = 1,
    seed: int = 7,
) -> list[Group]:
    """Group conversations by their centroids.

    First level: k-means (k = `default_k` unless given) then merge. Second
    level: any group larger than `split_above` is clustered again on its own,
    with one sub-group per `split_per` conversations (two at least), merged
    at the same threshold; the pieces replace it. `max_depth` bounds the
    recursion (1 = one second level). `split_above=None` turns it off.
    """
    ids = list(vectors.keys())
    if not ids:
        return []
    X = np.stack([np.asarray(vectors[i], dtype=np.float32) for i in ids])
    norms = np.linalg.norm(X, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    X = X / norms
    return _cluster_level(ids, X, k=k, merge=merge, split_above=split_above, split_per=split_per, depth=0, max_depth=max_depth, seed=seed, parent=None)


def _cluster_level(ids, X, *, k, merge, split_above, split_per, depth, max_depth, seed, parent) -> list[Group]:
    n = len(ids)
    if n == 1:
        return [_group(ids, X, depth, parent)]
    kk = k if k else default_k(n)
    labels = merge_close(X, spherical_kmeans(X, kk, seed=seed), merge)
    out: list[Group] = []
    for j in sorted(set(labels.tolist())):
        m = labels == j
        sub_ids = [i for i, keep in zip(ids, m) if keep]
        sub_X = X[m]
        if (
            split_above is not None
            and depth < max_depth
            and len(sub_ids) > split_above
        ):
            k2 = max(2, len(sub_ids) // split_per)
            out.extend(
                _cluster_level(sub_ids, sub_X, k=k2, merge=merge, split_above=split_above, split_per=split_per,
                               depth=depth + 1, max_depth=max_depth, seed=seed + 1, parent=len(sub_ids))
            )
        else:
            out.append(_group(sub_ids, sub_X, depth, parent))
    out.sort(key=lambda g: -g.size)
    return out


def groups_payload(groups: list[Group]) -> list[dict[str, Any]]:
    """What the MCP tool returns: no vectors, just the ids and the numbers."""
    return [
        {
            "conversation_ids": g.conversation_ids,
            "size": g.size,
            "cohesion": round(g.cohesion, 4),
            "depth": g.depth,
            "parent_size": g.parent_size,
        }
        for g in groups
    ]


__all__ = ["Group", "centroids", "cluster", "default_k", "groups_payload", "merge_close", "spherical_kmeans"]
