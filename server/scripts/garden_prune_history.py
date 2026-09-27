#!/usr/bin/env python3
"""Prune every past version of a garden of the lines that cite forgotten mail.

Lot 6 of specs/contacts.md, "also erase it from the history". Called by the
server (services/mailForget.ts) after the current version was pruned and
committed:

    garden_prune_history.py <repo> <ids-file>

Every blob of the history goes through the same rule as the current files:
a line whose `maurice-mail:` links all point at a forgotten message is
dropped, a forgotten link leaves a line that has others. The history is
streamed out with `git fast-export`, the blobs rewritten, and streamed back
with `git fast-import --force`; the working tree is reset to the rewritten
HEAD (the same content: it was pruned and committed first), the reflogs are
expired and the old objects pruned, then the rewritten branches are
force-pushed to `origin` when there is one, and the remote's old objects
pruned too when it is a local bare repository.

No dependency beyond git and the standard library (git filter-repo is not
installed on the household's Mac).
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
from urllib.parse import unquote

LINK = re.compile(rb"\[((?:\\.|[^\]\\])*)\]\(maurice-mail:([^)\s]+)\)")


def prune(data: bytes, gone: set[str]) -> bytes:
    if b"maurice-mail:" not in data:
        return data
    out = []
    for line in data.split(b"\n"):
        links = list(LINK.finditer(line))
        if not links:
            out.append(line)
            continue
        dead = [m for m in links if unquote(m.group(2).decode("utf-8", "replace")) in gone]
        if len(dead) == len(links):
            continue
        for m in dead:
            line = line.replace(m.group(0), b"")
        if dead:
            line = re.sub(rb"\s*;\s*;\s*", b" ; ", line)
            line = re.sub(rb"\xe2\x80\x94\s*;\s*", "— ".encode(), line)
            line = re.sub(rb"\s*;\s*$", b"", line).rstrip()
        out.append(line)
    return b"\n".join(out)


def main() -> int:
    repo, ids_file = sys.argv[1], sys.argv[2]
    gone = {x.strip() for x in open(ids_file, encoding="utf-8") if x.strip()}
    if not gone:
        return 0
    git = lambda *a, **k: subprocess.run(["git", "-C", repo, *a], check=True, **k)  # noqa: E731
    branch = subprocess.run(["git", "-C", repo, "symbolic-ref", "--short", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()

    export = subprocess.Popen(
        ["git", "-C", repo, "fast-export", "--all", "--signed-tags=strip", "--tag-of-filtered-object=rewrite", "--reencode=yes"],
        stdout=subprocess.PIPE,
    )
    imp = subprocess.Popen(["git", "-C", repo, "fast-import", "--force", "--quiet"], stdin=subprocess.PIPE)
    src, dst = export.stdout, imp.stdin
    assert src and dst
    command = b""
    changed = 0
    while True:
        line = src.readline()
        if not line:
            break
        if line.startswith(b"data "):
            n = int(line[5:].strip())
            data = src.read(n)
            if command == b"blob":
                new = prune(data, gone)
                if new != data:
                    changed += 1
                data = new
            dst.write(b"data %d\n" % len(data))
            dst.write(data)
            continue
        word = line.split(b" ", 1)[0].strip()
        if word in (b"blob", b"commit", b"tag", b"reset", b"feature", b"progress", b"checkpoint", b"done", b"option"):
            command = word
        dst.write(line)
    dst.close()
    if export.wait() != 0 or imp.wait() != 0:
        print("fast-export or fast-import failed", file=sys.stderr)
        return 1

    git("reset", "--hard", "--quiet", branch)
    git("reflog", "expire", "--expire=now", "--all")
    git("gc", "--prune=now", "--quiet")
    remote = subprocess.run(["git", "-C", repo, "remote", "get-url", "origin"], capture_output=True, text=True)
    if remote.returncode == 0:
        git("push", "--force", "--quiet", "origin", f"{branch}:{branch}")
        url = remote.stdout.strip()
        if os.path.isdir(url):
            subprocess.run(["git", "-C", url, "reflog", "expire", "--expire=now", "--all"], check=False)
            subprocess.run(["git", "-C", url, "gc", "--prune=now", "--quiet"], check=False)
    print(f"{changed} blob(s) pruned")
    return 0


if __name__ == "__main__":
    sys.exit(main())
