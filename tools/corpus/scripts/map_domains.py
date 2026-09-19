#!/usr/bin/env python3
"""Cartographie hors ligne des domaines d'un membre — l'étape 0 du design
« Un seul Maurice, des domaines qui émergent » (note maurice-domaines).

Prend les vecteurs de conversation d'un membre dans le corpus (sqlite-vec, un
fichier par membre), en fait un centroïde par conversation, regroupe, ne garde
que les groupes qui reviennent sur des mois et sont encore vivants, demande au
modèle ancillaire de nommer et décrire chaque groupe retenu, et écrit le
résultat dans une note du jardin qu'on regarde ensemble.

Aucune dépendance au-delà de numpy et sqlite-vec (déjà dans le venv du dépôt) :
la nuit qui viendra après ne doit pas embarquer scikit-learn pour ça.

    .venv/bin/python tools/corpus/scripts/map_domains.py --member candide
    .venv/bin/python tools/corpus/scripts/map_domains.py --member paola --no-llm

Rien n'est écrit dans maurice.db ni dans le corpus : les deux sont ouverts en
lecture seule. Seule la note de sortie (et un JSON à côté) sont produits.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sqlite3
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

import numpy as np

_HERE = Path(__file__).resolve()
_REPO_ROOT = _HERE.parents[3]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

# ── Entrées ──────────────────────────────────────────────────────────────────


def _ro(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def resolve_member(db: sqlite3.Connection, who: str) -> tuple[str, str, str]:
    row = db.execute(
        "SELECT id, username, display_name FROM users WHERE username = ? OR id = ?", (who, who)
    ).fetchone()
    if not row:
        sys.exit(f"membre inconnu : {who}")
    return row["id"], row["username"], row["display_name"]


@dataclass
class Convo:
    id: str
    title: str
    origin: str
    first: datetime
    last: datetime
    n_messages: int
    opening: str
    n_chunks: int = 0
    vector: np.ndarray | None = None


def load_conversations(db: sqlite3.Connection, member_id: str) -> dict[str, Convo]:
    rows = db.execute(
        """
        SELECT c.id, c.title, COALESCE(c.origin, '') AS origin,
               MIN(m.created_at) AS first, MAX(m.created_at) AS last,
               COUNT(m.id) AS n
        FROM conversations c
        JOIN messages m ON m.conversation_id = c.id
        WHERE c.user_id = ? AND m.role != 'system'
        GROUP BY c.id
        """,
        (member_id,),
    ).fetchall()
    out: dict[str, Convo] = {}
    for r in rows:
        out[r["id"]] = Convo(
            id=r["id"],
            title=(r["title"] or "").strip(),
            origin=r["origin"] or "maurice",
            first=_parse_dt(r["first"]),
            last=_parse_dt(r["last"]),
            n_messages=r["n"],
            opening="",
        )
    # La première phrase de l'utilisateur, pour l'échantillon donné au modèle.
    for r in db.execute(
        """
        SELECT conversation_id, content FROM messages
        WHERE role = 'user' AND conversation_id IN (
            SELECT id FROM conversations WHERE user_id = ?
        )
        ORDER BY conversation_id, created_at
        """,
        (member_id,),
    ):
        c = out.get(r["conversation_id"])
        if c is not None and not c.opening:
            c.opening = _squash(r["content"])[:300]
    return out


def _parse_dt(s: str) -> datetime:
    s = (s or "").replace("T", " ").split(".")[0].rstrip("Z")
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.strptime(s[: len("2000-01-01 00:00:00")], fmt)
        except ValueError:
            continue
    return datetime(1970, 1, 1)


_MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août",
         "septembre", "octobre", "novembre", "décembre"]


def mois(d: datetime | date) -> str:
    return f"{_MOIS[d.month - 1]} {d.year}"


def jour(d: datetime | date) -> str:
    return f"{d.day} {_MOIS[d.month - 1]} {d.year}"


def _squash(text: str) -> str:
    text = re.sub(r"```.*?```", " ", text or "", flags=re.S)
    return re.sub(r"\s+", " ", text).strip()


def load_vectors(vectors_db: Path, convos: dict[str, Convo], roles: tuple[str, ...]) -> None:
    """Somme des vecteurs de chunks par conversation, puis normalisation : un
    centroïde par conversation sur la sphère. `roles` dit quels tours comptent :
    les réponses de Maurice se ressemblent toutes (sa voix, ses outils) et
    tirent les conversations vécues dans un même bloc ; les tours de
    l'utilisateur disent de quoi il parle."""
    import sqlite_vec  # type: ignore

    # Pas de `mode=ro` ici : un fichier WAL sans son -shm refuse de s'ouvrir en
    # lecture seule (erreur 14), et ce script ne fait que lire de toute façon.
    conn = sqlite3.connect(str(vectors_db))
    conn.execute("PRAGMA query_only = 1")
    conn.enable_load_extension(True)
    sqlite_vec.load(conn)
    conn.enable_load_extension(False)
    dim = int(conn.execute("SELECT value FROM corpus_meta WHERE key='vector_size'").fetchone()[0])
    sums: dict[str, np.ndarray] = {}
    cur = conn.execute(
        """
        SELECT json_extract(c.payload, '$.conversation_id') AS cid, v.embedding
        FROM chunks c JOIN vec_chunks v ON v.rowid = c.id
        WHERE c.source_type = 'conversation'
          AND json_extract(c.payload, '$.role') IN (%s)
        """ % ",".join("?" * len(roles)),
        roles,
    )
    n = 0
    for cid, blob in cur:
        if cid not in convos:
            continue
        vec = np.frombuffer(blob, dtype=np.float32)
        if vec.shape[0] != dim:
            continue
        norm = np.linalg.norm(vec)
        if norm == 0:
            continue
        acc = sums.get(cid)
        if acc is None:
            sums[cid] = (vec / norm).astype(np.float64)
        else:
            acc += vec / norm
        convos[cid].n_chunks += 1
        n += 1
    conn.close()
    for cid, acc in sums.items():
        convos[cid].vector = (acc / np.linalg.norm(acc)).astype(np.float32)
    print(f"[vectors] {n} chunks → {len(sums)} conversations avec centroïde (dim {dim})", file=sys.stderr)


# ── Regroupement ─────────────────────────────────────────────────────────────


def spherical_kmeans(X: np.ndarray, k: int, *, iters: int = 40, restarts: int = 4, seed: int = 7) -> np.ndarray:
    """k-means sur la sphère (vecteurs unitaires, similarité cosinus). Rend les
    étiquettes du meilleur des `restarts` essais (k-means++ pour les germes)."""
    rng = np.random.default_rng(seed)
    n = X.shape[0]
    best_labels, best_score = None, -np.inf
    for _ in range(restarts):
        # k-means++
        centers = [X[rng.integers(n)]]
        d2 = np.full(n, np.inf)
        for _ in range(1, k):
            d2 = np.minimum(d2, 1.0 - X @ centers[-1])
            p = np.clip(d2, 0, None) ** 2
            p = p / p.sum() if p.sum() > 0 else np.full(n, 1.0 / n)
            centers.append(X[rng.choice(n, p=p)])
        C = np.stack(centers)
        labels = np.zeros(n, dtype=int)
        for _ in range(iters):
            sims = X @ C.T
            new = sims.argmax(axis=1)
            if np.array_equal(new, labels) and _ > 0:
                break
            labels = new
            for j in range(k):
                m = labels == j
                if m.any():
                    c = X[m].sum(axis=0)
                    C[j] = c / (np.linalg.norm(c) or 1.0)
                else:  # groupe vide : réamorcer sur le point le moins bien servi
                    worst = (X @ C.T).max(axis=1).argmin()
                    C[j] = X[worst]
        score = (X @ C.T).max(axis=1).sum()
        if score > best_score:
            best_score, best_labels = score, labels.copy()
    assert best_labels is not None
    return best_labels


def merge_close(X: np.ndarray, labels: np.ndarray, threshold: float) -> np.ndarray:
    """Fusionne les groupes dont les centroïdes sont plus proches que
    `threshold` (cosinus), en union-find, jusqu'à stabilité."""
    first = True
    while True:
        ids = sorted(set(labels.tolist()))
        C = np.stack([_centroid(X[labels == j]) for j in ids])
        S = C @ C.T
        np.fill_diagonal(S, -1)
        if first and len(ids) > 1:
            up = S[np.triu_indices(len(ids), 1)]
            q = np.quantile(up, [0.1, 0.5, 0.9, 0.99, 1.0])
            print(
                "[merge] similarité entre centroïdes — déciles 10/50/90/99/max : "
                + " ".join(f"{v:.3f}" for v in q),
                file=sys.stderr,
            )
            first = False
        i, j = np.unravel_index(S.argmax(), S.shape)
        if S[i, j] < threshold:
            return _relabel(labels)
        labels = np.where(labels == ids[j], ids[i], labels)


def _centroid(M: np.ndarray) -> np.ndarray:
    c = M.sum(axis=0)
    return c / (np.linalg.norm(c) or 1.0)


def _relabel(labels: np.ndarray) -> np.ndarray:
    ids = {j: i for i, j in enumerate(sorted(set(labels.tolist())))}
    return np.array([ids[j] for j in labels])


# ── Lecture des groupes ──────────────────────────────────────────────────────


@dataclass
class Group:
    idx: int
    members: list[Convo]
    centroid: np.ndarray
    cohesion: float
    months_active: int
    span_months: int
    first: datetime
    last: datetime
    recent_90: int
    recent_365: int
    imported: int
    verdict: str = ""
    reason: str = ""
    name: str = ""
    summary: str = ""
    llm: dict[str, Any] = field(default_factory=dict)

    @property
    def n(self) -> int:
        return len(self.members)

    def closest(self, limit: int) -> list[Convo]:
        sims = [(float(c.vector @ self.centroid), c) for c in self.members if c.vector is not None]
        sims.sort(key=lambda t: -t[0])
        return [c for _, c in sims[:limit]]


def describe_groups(convos: list[Convo], labels: np.ndarray, today: date, *, min_size: int, min_months: int, alive_days: int) -> list[Group]:
    groups: list[Group] = []
    X = np.stack([c.vector for c in convos])
    for j in sorted(set(labels.tolist())):
        members = [c for c, l in zip(convos, labels) if l == j]
        M = X[labels == j]
        cen = _centroid(M)
        cohesion = float((M @ cen).mean())
        months = {(c.first.year, c.first.month) for c in members}
        first = min(c.first for c in members)
        last = max(c.last for c in members)
        span = (last.year - first.year) * 12 + (last.month - first.month) + 1
        r90 = sum(1 for c in members if (today - c.last.date()).days <= 90)
        r365 = sum(1 for c in members if (today - c.last.date()).days <= 365)
        imported = sum(1 for c in members if c.origin in ("chatgpt", "anthropic"))
        g = Group(j, members, cen, cohesion, len(months), span, first, last, r90, r365, imported)
        age = (today - last.date()).days
        if g.n < min_size:
            g.verdict, g.reason = "bruit", f"{g.n} conversations, moins que {min_size}"
        elif g.months_active < min_months:
            g.verdict, g.reason = "bruit", f"actif {g.months_active} mois, moins que {min_months}"
        elif age > alive_days:
            g.verdict, g.reason = "a vécu", f"dernière conversation il y a {age} jours"
        else:
            g.verdict, g.reason = "vivant", f"{g.months_active} mois actifs, {r90} conversations sur 90 jours"
        groups.append(g)
    order = {"vivant": 0, "a vécu": 1, "bruit": 2}
    groups.sort(key=lambda g: (order[g.verdict], -g.recent_90, -g.n))
    return groups


# ── Nommer avec le modèle ancillaire ─────────────────────────────────────────

NAMING_SYSTEM = """Tu aides Maurice, un assistant personnel, à reconnaître les domaines de la vie
de l'un de ses membres à partir d'un regroupement automatique de ses conversations.
Un domaine est un pan de sa vie qu'il revient voir régulièrement : un projet, une
pratique, un rôle, un sujet qui le suit. Ce n'est ni une question d'un soir ni
une catégorie de bibliothèque. Réponds en français, sobrement, à la deuxième
personne (« tu »). Rends uniquement un objet JSON, sans commentaire autour."""

NAMING_PROMPT = """Voici un groupe de {n} conversations d'une même personne, actives de {first} à {last}
({months} mois distincts, {recent} dans les 90 derniers jours). Un échantillon :

Titres (les plus proches du centre du groupe) :
{titles}

Premières phrases de quelques-unes :
{openings}

Rends un JSON avec ces clés :
- "name" : un nom court de domaine (2 à 5 mots), tel que la personne le dirait elle-même ;
- "summary" : un paragraphe de 2 à 4 phrases qui dit ce que ce domaine contient et ce
  qui semble en cours ;
- "is_domain" : true si c'est vraiment un pan de vie cohérent, false si c'est un
  fourre-tout ou plusieurs choses sans lien ;
- "split_hint" : si c'est plusieurs choses, en une phrase lesquelles ; sinon "".
"""


def name_group(g: Group, invocation: str) -> dict[str, Any]:
    from tools.shared.model_config import complete  # type: ignore

    sample = g.closest(20)
    titles = "\n".join(f"- {c.title or '(sans titre)'} ({c.first:%Y-%m})" for c in sample)
    openings = "\n".join(
        f"- « {c.opening[:240]} »" for c in sample[:7] if c.opening
    )
    prompt = NAMING_PROMPT.format(
        n=g.n, first=mois(g.first), last=mois(g.last), months=g.months_active,
        recent=g.recent_90, titles=titles, openings=openings or "- (rien)",
    )
    text = complete(invocation, prompt, system=NAMING_SYSTEM, max_tokens=600, temperature=0.3)
    m = re.search(r"\{.*\}", text, flags=re.S)
    try:
        data = json.loads(m.group(0) if m else text)
    except json.JSONDecodeError:
        data = {"name": text.strip().split("\n")[0][:60], "summary": text.strip(), "is_domain": None, "split_hint": ""}
    return data


# ── Sortie ───────────────────────────────────────────────────────────────────


def write_note(path: Path, *, display_name: str, username: str, today: date, convos: dict[str, Convo],
               groups: list[Group], params: dict[str, Any], invocation: str | None) -> None:
    n_total = len(convos)
    n_vec = sum(1 for c in convos.values() if c.vector is not None)
    vivants = [g for g in groups if g.verdict == "vivant"]
    vecus = [g for g in groups if g.verdict == "a vécu"]
    bruit = [g for g in groups if g.verdict == "bruit"]
    origins = Counter(c.origin for c in convos.values())

    lines: list[str] = []
    lines.append("---")
    lines.append(f"title: Cartographie des domaines de {display_name} — {jour(today)}")
    lines.append(f"date: '{today.isoformat()}'")
    lines.append("flags: []")
    lines.append("locale: fr")
    lines.append(
        "description: 'Sortie brute du script hors ligne de cartographie (étape 0 du design des domaines) "
        f"sur les conversations de {display_name} : les groupes trouvés dans les vecteurs, ceux qui vivent, "
        "ceux qui ont vécu, le bruit.'"
    )
    lines.append("tags:\n- maurice\n- design\n- memory\n- experiment")
    lines.append("icon: map")
    lines.append("parent: maurice-domaines")
    lines.append("internal: true")
    lines.append("---\n")
    lines.append(f"# Cartographie des domaines de {display_name}\n")
    lines.append(
        f"Produit le {jour(today)} par `tools/corpus/scripts/map_domains.py`, sans rien écrire "
        "en base. À lire comme une proposition brute : c'est l'expérience qui décide si l'émergence "
        "produit quelque chose que la personne reconnaît comme sa vie ([[maurice-domaines]], étape 0).\n"
    )
    lines.append("## Le corpus\n")
    lines.append(f"- {n_total} conversations, {n_vec} avec un centroïde dans le corpus ;")
    lines.append("- origines : " + ", ".join(f"{k} {v}" for k, v in origins.most_common()) + " ;")
    lines.append(
        f"- centroïde par conversation sur les tours `{params['roles']}` ;"
    )
    lines.append(
        f"- regroupement : k-means sphérique k={params['k']}, fusion des centroïdes au-dessus de "
        f"{params['merge']:.2f} de cosinus → {len(groups)} groupes ;"
    )
    lines.append(
        f"- seuils : au moins {params['min_size']} conversations et {params['min_months']} mois actifs, "
        f"vivant si la dernière conversation a moins de {params['alive_days']} jours ;"
    )
    lines.append(f"- nommage : {'modèle ancillaire, invocation `' + invocation + '`' if invocation else 'aucun (--no-llm)'}.\n")
    lines.append(f"**{len(vivants)} domaines vivants, {len(vecus)} qui ont vécu, {len(bruit)} groupes de bruit.**\n")

    def section(title: str, gs: list[Group], *, full: bool) -> None:
        lines.append(f"## {title}\n")
        if not gs:
            lines.append("_Rien._\n")
            return
        for g in gs:
            head = g.name or f"Groupe {g.idx}"
            lines.append(f"### {head}\n")
            lines.append(
                f"- {g.n} conversations, de {mois(g.first)} à {mois(g.last)}, {g.months_active} mois actifs "
                f"sur {g.span_months} ; {g.recent_90} sur 90 jours, {g.recent_365} sur un an ; "
                f"{g.imported} importées ; cohésion {g.cohesion:.2f}."
            )
            lines.append(f"- Verdict : **{g.verdict}** ({g.reason}).")
            if g.llm:
                if g.llm.get("is_domain") is False:
                    lines.append("- Le modèle n'y voit pas un domaine" + (f" : {g.llm.get('split_hint')}" if g.llm.get("split_hint") else "."))
                elif g.llm.get("split_hint"):
                    lines.append(f"- À couper, peut-être : {g.llm['split_hint']}")
            if g.summary:
                lines.append(f"\n{g.summary}\n")
            sample = g.closest(12 if full else 5)
            lines.append("Conversations les plus proches du centre :\n")
            for c in sample:
                lines.append(f"- {c.first:%Y-%m-%d} — {c.title or c.opening[:80] or '(sans titre)'}")
            lines.append("")

    section("Domaines vivants", vivants, full=True)
    section("Domaines qui ont vécu", vecus, full=True)
    section("Le reste (bruit ou trop petit)", bruit, full=False)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines), encoding="utf-8")


def dump_json(path: Path, groups: list[Group], params: dict[str, Any]) -> None:
    data = {
        "params": params,
        "groups": [
            {
                "idx": g.idx, "verdict": g.verdict, "reason": g.reason, "name": g.name, "summary": g.summary,
                "llm": g.llm, "n": g.n, "cohesion": g.cohesion, "months_active": g.months_active,
                "span_months": g.span_months, "first": g.first.isoformat(), "last": g.last.isoformat(),
                "recent_90": g.recent_90, "recent_365": g.recent_365, "imported": g.imported,
                "conversation_ids": [c.id for c in g.members],
            }
            for g in groups
        ],
    }
    path.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")


# ── Main ─────────────────────────────────────────────────────────────────────


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--member", required=True, help="username ou id du membre")
    ap.add_argument("--db", type=Path, default=Path(os.environ.get("MAURICE_DB", Path.home() / ".maurice/maurice.db")))
    ap.add_argument("--vectors-dir", type=Path, default=None, help="répertoire des <member>.db (défaut : tools/corpus/data/vectors du dépôt)")
    ap.add_argument("--gardens-dir", type=Path, default=Path(os.environ.get("MAURICE_GARDENS_DIR", Path.home() / ".maurice/gardens")))
    ap.add_argument("--out", type=Path, default=None, help="note de sortie (défaut : le jardin du membre, notes/fr/maurice-domaines-cartographie-<username>.md)")
    ap.add_argument("--json", type=Path, default=None, help="dump JSON des groupes")
    ap.add_argument("--k", type=int, default=0, help="nombre de groupes k-means (défaut : n/80 borné à [4, 60])")
    ap.add_argument("--merge", type=float, default=0.90, help="fusionner les groupes dont les centroïdes dépassent ce cosinus")
    ap.add_argument("--min-size", type=int, default=8)
    ap.add_argument("--min-months", type=int, default=4)
    ap.add_argument("--alive-days", type=int, default=180)
    ap.add_argument("--invocation", default="conversation_summary", help="invocation ancillaire pour nommer (voir server/src/services/ancillary.ts)")
    ap.add_argument("--no-llm", action="store_true", help="ne pas nommer : regroupement et statistiques seulement")
    ap.add_argument("--roles", default="user", help="tours qui entrent dans le centroïde : user (défaut), ou user,assistant")
    ap.add_argument("--today", type=lambda s: date.fromisoformat(s), default=date.today())
    args = ap.parse_args()

    db = _ro(args.db)
    member_id, username, display_name = resolve_member(db, args.member)
    vectors_dir = args.vectors_dir or (_REPO_ROOT / "tools/corpus/data/vectors")
    vectors_db = vectors_dir / f"{member_id}.db"
    if not vectors_db.exists():
        sys.exit(f"pas de vecteurs pour {username} : {vectors_db}")

    convos = load_conversations(db, member_id)
    print(f"[db] {len(convos)} conversations de {display_name}", file=sys.stderr)
    roles = tuple(r.strip() for r in args.roles.split(",") if r.strip())
    load_vectors(vectors_db, convos, roles)
    with_vec = [c for c in convos.values() if c.vector is not None]
    if len(with_vec) < 4:
        print(f"[stop] {len(with_vec)} conversations vectorisées : rien à cartographier", file=sys.stderr)
        groups: list[Group] = []
        k = 0
    else:
        X = np.stack([c.vector for c in with_vec])
        k = args.k or max(4, min(60, len(with_vec) // 80))
        k = min(k, len(with_vec))
        labels = spherical_kmeans(X, k)
        labels = merge_close(X, labels, args.merge)
        print(f"[cluster] k={k} → {len(set(labels.tolist()))} groupes après fusion à {args.merge}", file=sys.stderr)
        groups = describe_groups(with_vec, labels, args.today, min_size=args.min_size, min_months=args.min_months, alive_days=args.alive_days)

    params = {"k": k, "merge": args.merge, "min_size": args.min_size, "min_months": args.min_months, "alive_days": args.alive_days, "roles": ",".join(roles)}
    invocation = None if args.no_llm else args.invocation
    for g in groups:
        tag = f"[{g.verdict:7}] n={g.n:4} mois={g.months_active:2} 90j={g.recent_90:3} coh={g.cohesion:.2f}"
        if invocation and g.verdict in ("vivant", "a vécu"):
            try:
                g.llm = name_group(g, invocation)
                g.name = str(g.llm.get("name") or "").strip()
                g.summary = str(g.llm.get("summary") or "").strip()
            except Exception as exc:  # noqa: BLE001 — on veut la note quand même
                g.llm = {"error": str(exc)}
                print(f"  ! nommage raté pour le groupe {g.idx} : {exc}", file=sys.stderr)
        sample = "; ".join((c.title or c.opening)[:40] for c in g.closest(3))
        print(f"{tag}  {g.name or ''}  ← {sample}", file=sys.stderr)

    out = args.out or (args.gardens_dir / username / "notes" / "fr" / f"maurice-domaines-cartographie-{username}.md")
    write_note(out, display_name=display_name, username=username, today=args.today, convos=convos, groups=groups, params=params, invocation=invocation)
    print(f"[note] {out}", file=sys.stderr)
    if args.json:
        dump_json(args.json, groups, params)
        print(f"[json] {args.json}", file=sys.stderr)


if __name__ == "__main__":
    main()
