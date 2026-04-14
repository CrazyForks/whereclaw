#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="x86_64-unknown-linux-gnu"
BUILD_VARIANT="${WHERECLAW_BUILD_VARIANT:-local}"
OUT_DIR="$ROOT_DIR/release-artifacts/linux-x64-${BUILD_VARIANT}"

cd "$ROOT_DIR"
npm ci
WHERECLAW_BUILD_VARIANT="$BUILD_VARIANT" npm run prepare:openclaw-engine
WHERECLAW_BUILD_VARIANT="$BUILD_VARIANT" npm run tauri build -- --target "$TARGET" --bundles appimage,deb,rpm
mkdir -p "$OUT_DIR"
find "$ROOT_DIR/src-tauri/target/$TARGET/release/bundle" -type f \( -name '*.AppImage' -o -name '*.deb' -o -name '*.rpm' \) -exec cp {} "$OUT_DIR"/ \;
echo "Artifacts copied to $OUT_DIR"
