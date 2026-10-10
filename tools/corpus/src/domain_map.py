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


def groups_payload(groups: list[Group], key: str = "conversation_ids") -> list[dict[str, Any]]:
    """What the MCP tool returns: no vectors, just the ids and the numbers.
    `key` names the ids for what they are (`note_paths` for the notes)."""
    return [
        {
            key: g.conversation_ids,
            "size": g.size,
            "cohesion": round(g.cohesion, 4),
            "depth": g.depth,
            "parent_size": g.parent_size,
        }
        for g in groups
    ]


# ── Which domain does this resemble? ─────────────────────────────────────────
#
# Measured on the owner's store on 10 October 2026, before anything was built
# on it: a centroid per adopted domain does not work. A domain made of a
# hundred everyday questions in French sits in the middle of everything said
# in French — "how long is the flight to Beijing" scored 0.82 against a
# health domain — and no threshold separates a conversation's own domain
# (median cosine 0.73) from the best domain of a conversation that has none
# (0.62). What does work is asking the neighbours: centre the vectors on the
# member's mean (which removes what every conversation of theirs shares),
# take the twelve nearest conversations among *all* of them, bound or not,
# and count how many belong to one domain. The unbound ones are what makes
# "none" a possible answer. Leaving each conversation out of its own vote:
# seven of twelve finds 57 % of the bound conversations and is wrong on
# 0.8 %; on a single turn's vector, six of twelve finds about half and is
# wrong on 3.5 %, nine of twelve on 1 %.

MATCH_K = 12
#: Below this many conversations the neighbours say nothing worth hearing.
MATCH_MIN_CONVERSATIONS = 30


@dataclass
class Neighbourhood:
    """A member's conversations, centred and ready to be asked."""

    ids: list[str]
    mean: np.ndarray
    X: np.ndarray  # centred, unit rows

    @classmethod
    def of(cls, vectors: Mapping[str, np.ndarray]) -> "Neighbourhood":
        ids = list(vectors.keys())
        if not ids:
            return cls(ids=[], mean=np.zeros(0, dtype=np.float32), X=np.zeros((0, 0), dtype=np.float32))
        raw = np.stack([np.asarray(vectors[i], dtype=np.float32) for i in ids])
        mean = raw.mean(axis=0)
        return cls(ids=ids, mean=mean, X=_centred(raw, mean))


@dataclass
class Kept:
    """A member's neighbourhood as it was last read from their store, with
    what it was read from: the store's signature at the time, and the chunk
    rows behind each conversation's vector."""

    signature: tuple
    rows: dict[str, tuple]
    vectors: dict[str, np.ndarray]
    hood: Neighbourhood


def keep_neighbourhood(store: Any, member_id: str, kept: Kept | None = None, *, roles: Iterable[str] = ("user",)) -> Kept:
    """The member's neighbourhood, brought up to date from `kept`.

    Every turn writes its conversation to the store, so the neighbourhood is
    stale after each one. Read whole, it cost the owner's five thousand
    conversations thirty-eight seconds a turn (10 October 2026); here only
    the conversations whose chunk rows changed are read again, and those that
    left the store are dropped. Runs in a worker thread (src/mcp_server.py).
    """
    # Read before the rows: a chunk written in between leaves a signature
    # older than what was read, and the next call simply comes back.
    signature = store.conversation_signature(member_id=member_id)
    rows = store.conversation_chunk_rows(roles=roles, member_id=member_id)
    known = kept.rows if kept else {}
    changed = {cid: ids for cid, ids in rows.items() if known.get(cid) != ids}
    vectors = {cid: v for cid, v in (kept.vectors if kept else {}).items() if cid in rows and cid not in changed}
    if changed:
        vectors.update(store.centroids_of_rows(changed, member_id=member_id))
    return Kept(signature=signature, rows=rows, vectors=vectors, hood=Neighbourhood.of(vectors))


def _centred(M: np.ndarray, mean: np.ndarray) -> np.ndarray:
    C = M - mean
    norms = np.linalg.norm(C, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return C / norms


def match_domains(
    hood: Neighbourhood,
    domains: Mapping[str, Iterable[str]],
    *,
    candidates: Iterable[str] | None = None,
    queries: Mapping[str, np.ndarray] | None = None,
    exclude: Iterable[str] = (),
    k: int = MATCH_K,
) -> list[dict[str, Any]]:
    """The domain each item's neighbours belong to, and how many of them.

    `domains` maps a domain to the conversations bound to it. `candidates`
    are conversations of the neighbourhood (each left out of its own vote);
    `queries` are vectors from elsewhere — a turn just embedded — keyed by
    whatever the caller wants back; `exclude` keeps conversations out of
    every vote (the one a turn belongs to). An item comes back as
    `{id, domain, votes, k}`, `domain` None when no neighbour is bound.
    """
    n = len(hood.ids)
    if n < MATCH_MIN_CONVERSATIONS:
        return []
    index = {cid: i for i, cid in enumerate(hood.ids)}
    names = list(domains.keys())
    label = np.full(n, -1, dtype=int)
    for d, cids in enumerate(domains.values()):
        for cid in cids:
            i = index.get(str(cid))
            if i is not None:
                label[i] = d
    kk = max(1, min(k, n - 1))
    out_of = np.array([index[c] for c in exclude if c in index], dtype=int)

    def vote(key: str, sims: np.ndarray) -> dict[str, Any]:
        if out_of.size:
            sims[out_of] = -2.0
        near = label[np.argpartition(-sims, kk - 1)[:kk]]
        near = near[near >= 0]
        if near.size == 0:
            return {"id": key, "domain": None, "votes": 0, "k": kk}
        counts = np.bincount(near, minlength=len(names))
        best = int(counts.argmax())
        return {"id": key, "domain": names[best], "votes": int(counts[best]), "k": kk}

    out: list[dict[str, Any]] = []
    for cid in candidates or ():
        i = index.get(str(cid))
        if i is None:
            continue
        sims = hood.X @ hood.X[i]
        sims[i] = -2.0
        out.append(vote(str(cid), sims))
    for key, vec in (queries or {}).items():
        q = _centred(np.asarray(vec, dtype=np.float32)[None, :], hood.mean)[0]
        out.append(vote(str(key), hood.X @ q))
    return out


__all__ = [
    "Group", "Kept", "MATCH_K", "MATCH_MIN_CONVERSATIONS", "Neighbourhood", "centroids", "cluster", "default_k",
    "groups_payload", "keep_neighbourhood", "match_domains", "merge_close", "spherical_kmeans",
]
