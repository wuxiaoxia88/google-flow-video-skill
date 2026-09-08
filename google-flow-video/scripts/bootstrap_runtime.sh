#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 || "$1" != "--workspace" ]]; then
  echo "usage: bootstrap_runtime.sh --workspace <new-user-owned-directory>" >&2
  exit 2
fi

skill_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
workspace="$2"
if [[ -e "$workspace" ]]; then
  echo "workspace already exists; use a new empty user-owned directory" >&2
  exit 2
fi

mkdir -p "$(dirname "$workspace")"
cp -R "$skill_root/assets/runtime/flow-bridge" "$workspace"
cp -R "$skill_root/tests/runtime" "$workspace/tests"
/usr/bin/find "$workspace/tests" -type f -name '*.test.ts.dist' -exec /bin/sh -c 'for test_file do /bin/mv "$test_file" "${test_file%.dist}"; done' /bin/sh {} +
cd "$workspace"
pnpm install --frozen-lockfile
pnpm --silent flowctl doctor
