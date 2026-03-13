#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/prepare-openclaw-engine.sh"

assert_equals() {
  local expected="$1"
  local actual="$2"
  local message="$3"

  if [[ "$expected" != "$actual" ]]; then
    printf 'FAIL: %s\nexpected: %s\nactual: %s\n' "$message" "$expected" "$actual" >&2
    exit 1
  fi
}

assert_equals "linux-x64" "$(detect_ollama_platform_dir_for Linux x86_64)" "linux x64 ollama dir"
assert_equals "ollama-linux-amd64.tgz" "$(detect_ollama_archive_for Linux x86_64)" "linux x64 ollama archive"

printf 'ok\n'
