#!/usr/bin/env bash
set -euo pipefail

skill_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fixture="$skill_root/templates/fixture.request.json"
temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/google-flow-video-fixture.XXXXXX")"
cleanup() { rm -rf "$temp_dir"; }
trap cleanup EXIT

runtime="$temp_dir/runtime"
cp -R "$skill_root/assets/runtime/flow-bridge" "$runtime"
cd "$runtime"
pnpm install --frozen-lockfile
FLOWBRIDGE_DB_PATH="$temp_dir/fixture.sqlite" pnpm --silent flowctl generate --file "$fixture" --no-run
