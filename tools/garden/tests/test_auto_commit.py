"""The garden tool's commits share the repository with the Maurice server.

What is held down: a commit takes only its own paths, never what the server
staged a moment before for a commit of its own (the night's export); a path
matching nothing git knows does not sink the commit; and a commit waits out
an index lock the other writer holds rather than failing.
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
os.environ.setdefault("MAURICE_GARDENS_DIR", tempfile.mkdtemp(prefix="garden-commit-test-"))

from tools.garden import server as g  # noqa: E402


def repo(tmp_path: Path) -> Path:
    root = tmp_path / "garden"
    root.mkdir()
    env = {**os.environ, "GIT_CONFIG_GLOBAL": os.devnull}
    for args in (["init", "-q", "--initial-branch=main"], ["config", "user.name", "t"], ["config", "user.email", "t@t"]):
        subprocess.run(["git", *args], cwd=root, check=True, env=env)
    (root / "first.md").write_text("first\n")
    subprocess.run(["git", "add", "first.md"], cwd=root, check=True)
    subprocess.run(["git", "commit", "-qm", "first"], cwd=root, check=True)
    return root


def git(root: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=root, capture_output=True, text=True).stdout.strip()


def test_a_commit_takes_only_its_own_paths(tmp_path):
    root = repo(tmp_path)
    # The server's export has staged its file for its own commit.
    (root / "_maurice").mkdir()
    (root / "_maurice" / "progress.jsonl").write_text("{}\n")
    git(root, "add", "_maurice/progress.jsonl")

    (root / "note.md").write_text("a note\n")
    g._commit_paths(root, ["note.md"], "Create note: note")

    assert git(root, "show", "--name-only", "--format=", "HEAD") == "note.md"
    assert git(root, "diff", "--cached", "--name-only") == "_maurice/progress.jsonl"


def test_a_path_matching_nothing_does_not_sink_the_commit(tmp_path):
    root = repo(tmp_path)
    (root / ".gitignore").write_text("*.tmp\n")
    (root / "images").mkdir()
    (root / "images" / "only-ignored.tmp").write_text("x")
    (root / "note.md").write_text("a note\n")
    g._commit_paths(root, ["note.md", "images"], "Create note: note")
    assert git(root, "log", "-1", "--format=%s") == "Create note: note"
    assert git(root, "status", "--porcelain") == "?? .gitignore"


def test_a_held_index_lock_is_waited_out(tmp_path):
    root = repo(tmp_path)
    lock = root / ".git" / "index.lock"
    lock.write_text("")
    threading.Timer(0.08, lock.unlink).start()
    (root / "note.md").write_text("a note\n")
    started = time.monotonic()
    g._commit_paths(root, ["note.md"], "Create note: note")
    assert git(root, "log", "-1", "--format=%s") == "Create note: note"
    assert time.monotonic() - started < 2
