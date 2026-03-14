#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="x86_64-unknown-linux-gnu"
OUT_DIR="$ROOT_DIR/release-artifacts/linux-x64"

cd "$ROOT_DIR"
npm ci
npm run prepare:openclaw-engine
npm run tauri build -- --target "$TARGET" --bundles appimage,deb,rpm
mkdir -p "$OUT_DIR"
find "$ROOT_DIR/src-tauri/target/$TARGET/release/bundle" -type f \( -name '*.AppImage' -o -name '*.deb' -o -name '*.rpm' \) -exec cp {} "$OUT_DIR"/ \;
echo "Artifacts copied to $OUT_DIR"
