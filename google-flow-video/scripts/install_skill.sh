#!/usr/bin/env bash
set -euo pipefail

skill_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
codex_home="${CODEX_HOME:-$HOME/.codex}"
target_root="${CODEX_SKILLS_DIR:-$codex_home/skills}"
backup_root="${CODEX_SKILL_BACKUPS_DIR:-$codex_home/skill-backups}"
target="$target_root/google-flow-video"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"

case "$backup_root/" in
  "$target_root/"*)
    echo "backup directory must be outside the skill discovery directory: $backup_root" >&2
    exit 2
    ;;
esac

python3 "$skill_root/scripts/quick_validate.py"
mkdir -p "$target_root" "$backup_root"
if [[ -e "$target" ]]; then
  if diff -qr "$skill_root" "$target" >/dev/null 2>&1; then
    echo "already installed: $target"
    exit 0
  fi
  backup="$backup_root/google-flow-video-${timestamp}"
  mv "$target" "$backup"
  echo "backed up existing skill: $backup"
fi
cp -R "$skill_root" "$target"
echo "installed: $target"
