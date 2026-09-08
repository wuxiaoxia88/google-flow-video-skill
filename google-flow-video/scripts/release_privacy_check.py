#!/usr/bin/env python3
"""Check a public Skill tree for portable fixtures and release metadata."""
from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EMAIL = re.compile(r"(?<![\w.+-])[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})(?![\w.+-])")
FLOW_UUID = re.compile(r"https://flow\.google\.com/project/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?:/edit/[0-9a-f-]+)?", re.I)
TEST_UUID = re.compile(r"00000000-0000-4000-8000-0000000000[0-9]{2}", re.I)
NOREPLY = re.compile(r"(?:[0-9]+\+)?[A-Za-z0-9-]+@users\.noreply\.github\.com", re.I)

def fail(message: str) -> None:
    print(f"FAIL: {message}", file=sys.stderr)
    raise SystemExit(1)

def check_package(root: Path) -> None:
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.name == "PACKAGE.sha256":
            continue
        relative = path.relative_to(root)
        text = path.read_text(encoding="utf-8", errors="ignore")
        for match in EMAIL.finditer(text):
            # `https://user@host/...` is a malformed-URL security fixture, not
            # an email address. Keep that parser regression test usable.
            if text[max(0, match.start() - 3):match.start()] == "://":
                continue
            if match.group(1).lower() != "example.com":
                fail(f"non-fixture email address in packaged content: {relative}")
        # RFC 4122-shaped fixtures are permitted only from the visibly reserved
        # zero-prefix range; all other UUID-shaped Flow URLs are treated as
        # publish-blocking project/session identifiers.
        if FLOW_UUID.search(TEST_UUID.sub("fixture-uuid", text)):
            fail(f"UUID-shaped Flow URL in packaged content; use a named synthetic fixture: {relative}")

def check_git(worktree: Path) -> None:
    result = subprocess.run(
        ["git", "-C", str(worktree), "log", "--all", "--format=%ae%x00%ce"],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode:
        fail(f"cannot read Git metadata: {result.stderr.strip()}")
    emails = {email for row in result.stdout.splitlines() for email in row.split("\x00") if email}
    if not emails:
        fail("Git history has no commit metadata to verify")
    for email in sorted(emails):
        if not NOREPLY.fullmatch(email):
            fail("Git author/committer email is not a GitHub noreply address")

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--git-worktree", type=Path, help="also verify all reachable commit author and committer emails")
args = parser.parse_args()
check_package(ROOT)
if args.git_worktree:
    check_git(args.git_worktree.resolve())
print("OK: portable content uses synthetic identifiers and fixture-only email addresses")
