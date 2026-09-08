#!/usr/bin/env bash
set -euo pipefail

skill_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "$skill_root/../.." && pwd)"
version="$(sed -n 's/^  version: //p' "$skill_root/SKILL.md" | head -n 1)"
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "invalid or missing SKILL.md version" >&2
  exit 2
fi
archive="$repo_root/dist/google-flow-video-skill-v${version}.zip"
stage="$(mktemp -d "${TMPDIR:-/tmp}/google-flow-video-package.XXXXXX")"
cleanup() { rm -rf "$stage"; }
trap cleanup EXIT

python3 "$skill_root/scripts/quick_validate.py"
mkdir -p "$stage/google-flow-video"
for item in SKILL.md PACKAGE.sha256 agents references templates scripts assets tests; do
  cp -R "$skill_root/$item" "$stage/google-flow-video/"
done
if find "$stage/google-flow-video" -type d \( -name node_modules -o -name .git -o -name venv -o -name data -o -name out -o -name qc -o -name test-reports \) -print -quit | grep -q .; then
  echo "forbidden content in package" >&2
  exit 1
fi
mkdir -p "$repo_root/dist"
if [[ -e "$archive" ]]; then
  echo "archive already exists: $archive; choose a new explicit version before repackaging" >&2
  exit 1
fi
(cd "$stage" && zip -X -qr "$archive" google-flow-video)
shasum -a 256 "$archive" > "${archive}.sha256"
unzip -Z1 "$archive" | sort > "${archive}.files"
echo "$archive"
