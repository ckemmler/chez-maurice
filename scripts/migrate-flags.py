#!/usr/bin/env python3
"""Migrate boolean frontmatter fields (public, private, isMoc, isTranslation)
to a single `flags: [...]` array.

Usage:
    python scripts/migrate-flags.py --dry-run   # preview changes
    python scripts/migrate-flags.py             # apply changes
"""

import argparse
import os
import re
import sys

CONTENT_ROOT = os.path.join(os.path.dirname(__file__), "..", "akita-web", "src", "content")

# Directories to walk (skip fiches)
CONTENT_DIRS = [
    "books", "articles", "blog", "essays", "podcasts",
    "movies", "series", "notes", "people", "pages",
]

# Boolean fields → flag names
BOOL_TO_FLAG = {
    "public": "public",
    "private": "encrypted",
    "isMoc": "moc",
    "isTranslation": "translation",
}

FM_FENCE = re.compile(r"^---\n(.*?)\n---", re.DOTALL)
BOOL_LINE = re.compile(r"^(public|private|isMoc|isTranslation):\s*(true|false)\s*$", re.MULTILINE)


def migrate_file(filepath: str, dry_run: bool) -> bool:
    """Returns True if the file was (or would be) modified."""
    with open(filepath, "r", encoding="utf-8") as f:
        content = f.read()

    fence = FM_FENCE.match(content)
    if not fence:
        return False

    fm_text = fence.group(1)
    flags: list[str] = []
    lines_to_remove: list[str] = []

    for m in BOOL_LINE.finditer(fm_text):
        key, val = m.group(1), m.group(2)
        if val == "true":
            flag = BOOL_TO_FLAG[key]
            flags.append(flag)
        lines_to_remove.append(m.group(0))

    if not lines_to_remove:
        return False

    # Remove old boolean lines
    new_fm = fm_text
    for line in lines_to_remove:
        new_fm = new_fm.replace(line + "\n", "")
        new_fm = new_fm.replace(line, "")  # handle last line without trailing newline

    # Remove any resulting blank lines at start/end of frontmatter
    new_fm = new_fm.strip("\n")

    # Add flags line (flow style)
    if flags:
        flags_line = f"flags: [{', '.join(flags)}]"
    else:
        flags_line = "flags: []"

    # Insert flags after tags line if present, else after first line
    if "\ntags:" in new_fm:
        # Find end of tags block (could be multi-line array)
        tag_idx = new_fm.index("\ntags:")
        # Find next non-array line
        rest = new_fm[tag_idx + 1:]
        lines = rest.split("\n")
        insert_after = tag_idx + 1 + len(lines[0])
        # Skip continuation lines (- item)
        i = 1
        while i < len(lines) and lines[i].strip().startswith("- "):
            insert_after += 1 + len(lines[i])
            i += 1
        new_fm = new_fm[:insert_after] + "\n" + flags_line + new_fm[insert_after:]
    else:
        # Insert after first line
        first_nl = new_fm.index("\n")
        new_fm = new_fm[:first_nl] + "\n" + flags_line + new_fm[first_nl:]

    new_content = content[:fence.start(1)] + new_fm + "\n" + content[fence.end(1):]

    if dry_run:
        rel = os.path.relpath(filepath, CONTENT_ROOT)
        flag_str = ", ".join(flags) if flags else "(empty)"
        print(f"  {rel}: flags=[{flag_str}]")
        return True

    with open(filepath, "w", encoding="utf-8") as f:
        f.write(new_content)
    return True


def main():
    parser = argparse.ArgumentParser(description="Migrate boolean frontmatter to flags array")
    parser.add_argument("--dry-run", action="store_true", help="Preview changes without writing")
    args = parser.parse_args()

    total = 0
    for content_dir in CONTENT_DIRS:
        dirpath = os.path.join(CONTENT_ROOT, content_dir)
        if not os.path.isdir(dirpath):
            continue
        for root, _dirs, files in os.walk(dirpath):
            for fname in sorted(files):
                if not (fname.endswith(".md") or fname.endswith(".mdx")):
                    continue
                # Skip fiches
                if fname.endswith("-fiche.md"):
                    continue
                filepath = os.path.join(root, fname)
                if migrate_file(filepath, args.dry_run):
                    total += 1

    action = "would migrate" if args.dry_run else "migrated"
    print(f"\n{action} {total} file(s)")


if __name__ == "__main__":
    main()
