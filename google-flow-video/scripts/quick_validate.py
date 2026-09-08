#!/usr/bin/env python3
"""Validate this portable Skill without installing dependencies or contacting Flow."""
from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REQUIRED = [
    "SKILL.md", "agents/openai.yaml", "references/audio-policy.md",
    "references/runtime-operations.md", "references/executor-session-lifecycle.md", "templates/request.background_music_only.json",
    "templates/fixture.request.json", "templates/delivery.manifest.template.json",
    "scripts/execute_fixture.sh", "scripts/bootstrap_runtime.sh", "scripts/package_skill.sh", "scripts/install_skill.sh",
    "assets/runtime/flow-bridge/package.json", "assets/runtime/flow-bridge/pnpm-lock.yaml",
    "assets/runtime/flow-bridge/apps/flowctl/src/index.ts",
    "assets/runtime/flow-bridge/scripts/production.py", "assets/runtime/flow-bridge/docs/PRODUCTION_CLI.md",
    "tests/runtime/acceptance/cli-blackbox.test.ts.dist",
    "tests/runtime/production/test_production_cli.py",
]
FORBIDDEN_PARTS = {"node_modules", ".git", ".pnpm", "venv", "__pycache__", "data", "out", "qc", "test-reports"}
FORBIDDEN_SUFFIXES = {".sqlite", ".sqlite-wal", ".sqlite-shm", ".mp4", ".mov", ".wav", ".mp3", ".log", ".token"}
PRIVATE_PATH = re.compile("/" + "(?:Users|home)" + r"/|file:" + "///|[A-Za-z]:\\\\" + "Users" + r"\\\\", re.I)

def fail(message: str) -> None:
    print(f"FAIL: {message}", file=sys.stderr)
    raise SystemExit(1)

for item in REQUIRED:
    if not (ROOT / item).is_file():
        fail(f"missing required file: {item}")

skill = (ROOT / "SKILL.md").read_text(encoding="utf-8")
if not skill.startswith("---\nname: google-flow-video\n"):
    fail("SKILL.md has invalid name frontmatter")
for template in ("templates/request.background_music_only.json", "templates/fixture.request.json", "templates/delivery.manifest.template.json"):
    json.loads((ROOT / template).read_text(encoding="utf-8"))

lifecycle = (ROOT / "references/executor-session-lifecycle.md").read_text(encoding="utf-8")
for required_clause in (
    "exactly one browser executor owner",
    "Do not create a tab, a window, a profile, or a new Flow session as fallback",
    "never closes the user tab",
    "EXISTING_SESSION_REQUIRED",
):
    if required_clause not in lifecycle:
        fail(f"executor lifecycle is missing required contract: {required_clause}")

files = []
for path in ROOT.rglob("*"):
    relative = path.relative_to(ROOT)
    if any(part in FORBIDDEN_PARTS for part in relative.parts):
        fail(f"forbidden packaged path: {relative}")
    if path.is_file():
        if relative.as_posix() == "PACKAGE.sha256":
            continue
        if path.suffix.lower() in FORBIDDEN_SUFFIXES:
            fail(f"forbidden packaged artifact: {relative}")
        text = path.read_text(encoding="utf-8", errors="ignore")
        if PRIVATE_PATH.search(text):
            fail(f"private absolute path found in: {relative}")
        files.append(relative.as_posix())

privacy = ROOT / "scripts/release_privacy_check.py"
result = __import__("subprocess").run([sys.executable, str(privacy)], text=True, capture_output=True)
if result.returncode:
    fail(result.stderr.strip() or result.stdout.strip())

manifest = "\n".join(f"{hashlib.sha256((ROOT / p).read_bytes()).hexdigest()}  {p}" for p in sorted(files)) + "\n"
(ROOT / "PACKAGE.sha256").write_text(manifest, encoding="utf-8")
print(f"OK: {len(files)} files validated; PACKAGE.sha256 refreshed")
