#!/usr/bin/env python3
"""Écrire à la main le cahier d'un domaine — la session P0 bis du design « Un
seul Maurice, des domaines qui émergent » (note maurice-domaines, 4c et 6).

Le cahier est la pièce centrale et la seule non testée : un texte court que
Maurice écrit sur un pan de la vie d'un membre, que le membre lit, corrige ou
jette. Avant d'en faire un système, ce script en fabrique quelques-uns pour
qu'on les lise.

Pour un membre et un groupe de la cartographie (`map_domains.py --json`), ou une
liste de conversations : retrouve les conversations récentes du domaine, et
demande au modèle de nuit d'écrire un cahier de trois cents tokens au plus, en
français, à la deuxième personne, à partir d'extraits. Puis, une seconde fois, à
partir de ce premier cahier et des extraits des conversations plus récentes :
le chemin incrémental, celui qui tournera chaque nuit. Chaque passe est
rendue avec son coût réel, lu dans la réponse d'usage du serveur.

    .venv/bin/python tools/corpus/scripts/write_brief.py --member candide \
        --map cartographie.json --group 25 --name "Ma santé et celle de ma famille" \
        --model mistral-small-3.2-24b-instruct-2506 --model deepseek-v4-flash-0731 \
        --out ~/.maurice/gardens/candide/notes/fr/maurice-domaines-cahiers-essai.md

Rien n'est écrit dans maurice.db ni dans le corpus. Le modèle est appelé par la
porte ancillaire du serveur (`tools/shared/model_config.complete_full`), avec
un modèle explicite : c'est une expérience qui compare des modèles, pas une
fonction qui choisit le sien.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
import time
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Any

_HERE = Path(__file__).resolve()
_REPO_ROOT = _HERE.parents[3]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from tools.shared.model_config import complete_full  # noqa: E402

# Le taux de pricing.ts (2026-09-16), pour rendre les coûts en centimes d'euro
# comme la table de la note de design.
EUR_USD = 1.1537
MAX_TOKENS = 300


# ── Entrées ──────────────────────────────────────────────────────────────────


def _ro(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def _squash(text: str) -> str:
    text = re.sub(r"```.*?```", " ", text or "", flags=re.S)
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def _cut(text: str, n: int) -> str:
    text = _squash(text)
    return text if len(text) <= n else text[: n - 1].rsplit(" ", 1)[0] + "…"


@dataclass
class Convo:
    id: str
    title: str
    last: datetime
    turns: list[tuple[str, str]]  # (role, content)


def load_convos(db: sqlite3.Connection, ids: list[str]) -> list[Convo]:
    out: list[Convo] = []
    for cid in ids:
        rows = db.execute(
            "SELECT role, content, created_at FROM messages WHERE conversation_id = ? "
            "AND role IN ('user', 'assistant') ORDER BY created_at",
            (cid,),
        ).fetchall()
        rows = [r for r in rows if (r["content"] or "").strip()]
        if not rows:
            continue
        title = (db.execute("SELECT title FROM conversations WHERE id = ?", (cid,)).fetchone() or [""])[0] or ""
        last = datetime.fromisoformat(rows[-1]["created_at"].replace("Z", "").split(".")[0].replace("T", " ")[:19])
        out.append(Convo(cid, title.strip(), last, [(r["role"], r["content"]) for r in rows]))
    out.sort(key=lambda c: c.last)
    return out


def excerpt(c: Convo, *, budget: int) -> str:
    """Un extrait d'une conversation : la première question en entier (presque),
    puis les tours suivants coupés court, jusqu'au budget de caractères."""
    lines = [f"— {c.last:%d %B %Y} — « {c.title or '(sans titre)'} »"]
    used = 0
    for i, (role, content) in enumerate(c.turns):
        cap = 500 if i == 0 else (280 if role == "user" else 380)
        piece = _cut(content, cap)
        if not piece:
            continue
        who = "Toi" if role == "user" else "Maurice"
        line = f"  {who} : {piece}"
        if used + len(line) > budget:
            break
        lines.append(line)
        used += len(line)
    return "\n".join(lines)


# ── Le modèle ────────────────────────────────────────────────────────────────

SYSTEM = """Tu es Maurice, l'assistant personnel de {name}. Tu tiens pour chaque pan de sa
vie un cahier : ta mémoire de travail sur ce domaine, rendue visible. {name} le
lira, le corrigera ou le jettera. Écris en français, à la deuxième personne
(« tu »), sobrement, sans flatterie ni remplissage. Pas de titre, pas de
préambule, pas de conclusion, pas de liste à puces : deux ou trois courts
paragraphes. Trois cents tokens au plus — environ deux cents mots. Dates et
faits concrets plutôt que généralités ; ce qui est en cours et les fils
ouverts plutôt qu'un résumé de tout."""

FIRST = """Le domaine s'appelle « {domain} ». Voici des extraits de conversations récentes
de {name} qui en relèvent, de la plus ancienne à la plus récente :

{excerpts}

Écris le cahier de ce domaine : ce que tu sais de ce pan de sa vie, où il en
est, ce qui reste ouvert."""

INCREMENTAL = """Le domaine s'appelle « {domain} ». Voici le cahier que tu tenais jusqu'ici :

{previous}

Et voici des extraits de conversations plus récentes, de la plus ancienne à la
plus récente :

{excerpts}

Réécris le cahier : garde ce qui reste vrai, mets à jour ce qui a bougé, retire
ce qui est dépassé, ajoute ce qui est nouveau. Un seul cahier, même longueur,
mêmes règles."""


@dataclass
class Pass:
    kind: str  # "premier" | "incrémental"
    model: str
    text: str
    prompt_chars: int
    tokens_in: int
    tokens_out: int
    cost_usd: float | None
    seconds: float
    stop: str

    @property
    def cents_eur(self) -> float | None:
        return None if self.cost_usd is None else self.cost_usd / EUR_USD * 100

    @property
    def words(self) -> int:
        return len(self.text.split())


def run_pass(kind: str, model: str, invocation: str, prompt: str, system: str) -> Pass:
    t0 = time.time()
    r = complete_full(invocation, prompt, system=system, max_tokens=MAX_TOKENS + 40, temperature=0.4, model=model, timeout=180)
    u = r.get("usage") or {}
    return Pass(
        kind=kind, model=r.get("model", model), text=r["text"], prompt_chars=len(prompt) + len(system),
        tokens_in=int(u.get("input", 0) or 0) + int(u.get("cache_read", 0) or 0),
        tokens_out=int(u.get("output", 0) or 0),
        cost_usd=u.get("cost"), seconds=time.time() - t0, stop=str(r.get("stop", "?")),
    )


# ── Sortie ───────────────────────────────────────────────────────────────────


def ensure_note(path: Path, display_name: str, today: date) -> None:
    if path.exists():
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "---\n"
        f"title: Les cahiers écrits à la main — l'essai de P0 bis\n"
        f"date: '{today.isoformat()}'\n"
        "flags: []\nlocale: fr\n"
        "description: 'Trois domaines, deux modèles de nuit, deux passes chacun (un premier cahier, "
        "puis sa réécriture à partir des conversations plus récentes) : les cahiers tels que les modèles "
        "les ont écrits, avec le coût réel de chacun. À lire pour juger si la pièce centrale tient.'\n"
        "tags:\n- maurice\n- design\n- memory\n- experiment\nicon: notebook\nparent: maurice-domaines\n"
        "internal: true\n---\n\n"
        f"# Les cahiers écrits à la main — l'essai de P0 bis\n\n"
        f"Produits le {today:%d %B %Y} par `tools/corpus/scripts/write_brief.py` sur les conversations de "
        f"{display_name}, sans rien écrire en base. Chaque domaine a deux cahiers par modèle : le **premier**, "
        "écrit à partir des conversations les plus anciennes de la sélection, et l'**incrémental**, réécrit à "
        "partir du premier et des conversations les plus récentes — le chemin que suivra la nuit. Le coût est "
        "celui que le serveur a lu dans la réponse d'usage du fournisseur, converti en centimes d'euro au taux "
        "de `pricing.ts`.\n",
        encoding="utf-8",
    )


def append_domain(path: Path, *, domain: str, group_size: int, older: list[Convo], newer: list[Convo], results: dict[str, list[Pass]]) -> None:
    lines = [f"\n## {domain}\n"]
    lines.append(
        f"{group_size} conversations dans le groupe ; {len(older)} anciennes pour le premier cahier "
        f"({older[0].last:%Y-%m-%d} → {older[-1].last:%Y-%m-%d}), {len(newer)} récentes pour l'incrémental "
        f"({newer[0].last:%Y-%m-%d} → {newer[-1].last:%Y-%m-%d}).\n"
    )
    lines.append("Conversations retenues :\n")
    for c in older + newer:
        lines.append(f"- {c.last:%Y-%m-%d} — {c.title or '(sans titre)'}")
    for model, passes in results.items():
        lines.append(f"\n### {model}\n")
        for p in passes:
            cost = f"{p.cents_eur:.2f} c€" if p.cents_eur is not None else "non tarifé"
            lines.append(
                f"**Cahier {p.kind}** — {p.tokens_in} tokens entrés, {p.tokens_out} sortis, {cost}, "
                f"{p.seconds:.1f} s, {p.words} mots" + (f", arrêt `{p.stop}`" if p.stop != "end" else "") + "\n"
            )
            lines.append("> " + p.text.replace("\n", "\n> ") + "\n")
        total = sum(p.cents_eur or 0 for p in passes)
        lines.append(f"_Les deux passes : {total:.2f} c€._\n")
    lines.append("**Verdict de Candide :** _(à écrire)_\n")
    with path.open("a", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")


# ── Main ─────────────────────────────────────────────────────────────────────


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--member", required=True, help="username ou id du membre")
    ap.add_argument("--db", type=Path, default=Path(os.environ.get("MAURICE_DB", Path.home() / ".maurice/maurice.db")))
    ap.add_argument("--map", type=Path, help="JSON de map_domains.py (--json)")
    ap.add_argument("--group", type=int, help="idx du groupe dans la cartographie")
    ap.add_argument("--conversations", help="ou : ids de conversations, séparés par des virgules")
    ap.add_argument("--name", required=True, help="le nom du domaine, tel qu'on le dirait")
    ap.add_argument("--model", action="append", required=True, help="modèle(s) de nuit à essayer (id du roster)")
    ap.add_argument("--invocation", default="conversation_summary", help="invocation ancillaire (le modèle est explicite de toute façon)")
    ap.add_argument("--recent", type=int, default=10, help="conversations récentes retenues (moitié anciennes, moitié récentes)")
    ap.add_argument("--budget", type=int, default=1800, help="caractères par extrait de conversation")
    ap.add_argument("--out", type=Path, required=True, help="note du jardin (créée si absente, un domaine ajouté par appel)")
    ap.add_argument("--json", type=Path, help="dump JSON des passes (ajouté)")
    ap.add_argument("--today", type=lambda s: date.fromisoformat(s), default=date.today())
    args = ap.parse_args()

    db = _ro(args.db)
    row = db.execute("SELECT id, display_name FROM users WHERE username = ? OR id = ?", (args.member, args.member)).fetchone()
    if not row:
        sys.exit(f"membre inconnu : {args.member}")
    member_id, display_name = row["id"], row["display_name"]

    if args.conversations:
        ids = [s.strip() for s in args.conversations.split(",") if s.strip()]
        group_size = len(ids)
    elif args.map and args.group is not None:
        data = json.loads(args.map.read_text())
        g = next((g for g in data["groups"] if g["idx"] == args.group), None)
        if g is None:
            sys.exit(f"groupe {args.group} absent de {args.map}")
        ids = g["conversation_ids"]
        group_size = g["n"]
    else:
        sys.exit("donner --map et --group, ou --conversations")

    convos = load_convos(db, ids)
    convos = [c for c in convos if any(r == "user" for r, _ in c.turns)]
    recent = convos[-args.recent :]
    if len(recent) < 2:
        sys.exit(f"{len(recent)} conversation(s) utilisable(s) : rien à écrire")
    half = max(1, len(recent) // 2)
    older, newer = recent[:half], recent[half:]
    print(f"[{args.name}] {group_size} conversations, {len(older)} anciennes + {len(newer)} récentes", file=sys.stderr)

    system = SYSTEM.format(name=display_name)
    first_prompt = FIRST.format(domain=args.name, name=display_name, excerpts="\n\n".join(excerpt(c, budget=args.budget) for c in older))
    results: dict[str, list[Pass]] = {}
    for model in args.model:
        passes: list[Pass] = []
        p1 = run_pass("premier", model, args.invocation, first_prompt, system)
        passes.append(p1)
        print(f"  {model} premier : {p1.tokens_in}→{p1.tokens_out} tokens, {p1.cents_eur if p1.cents_eur is None else round(p1.cents_eur, 2)} c€, {p1.seconds:.1f} s, {p1.words} mots", file=sys.stderr)
        inc_prompt = INCREMENTAL.format(domain=args.name, previous=p1.text, excerpts="\n\n".join(excerpt(c, budget=args.budget) for c in newer))
        p2 = run_pass("incrémental", model, args.invocation, inc_prompt, system)
        passes.append(p2)
        print(f"  {model} incrémental : {p2.tokens_in}→{p2.tokens_out} tokens, {p2.cents_eur if p2.cents_eur is None else round(p2.cents_eur, 2)} c€, {p2.seconds:.1f} s, {p2.words} mots", file=sys.stderr)
        results[model] = passes

    ensure_note(args.out, display_name, args.today)
    append_domain(args.out, domain=args.name, group_size=group_size, older=older, newer=newer, results=results)
    print(f"[note] {args.out}", file=sys.stderr)
    if args.json:
        dump: list[dict[str, Any]] = json.loads(args.json.read_text()) if args.json.exists() else []
        for model, passes in results.items():
            for p in passes:
                dump.append({"domain": args.name, "member": member_id, "model": model, **{k: v for k, v in p.__dict__.items()}})
        args.json.write_text(json.dumps(dump, ensure_ascii=False, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
