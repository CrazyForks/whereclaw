#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/package-macos-common.sh"
TARGET="aarch64-apple-darwin"
BUILD_VARIANT="${WHERECLAW_BUILD_VARIANT:-local}"
APP_DIR="$ROOT_DIR/src-tauri/target/$TARGET/release/bundle/macos/WhereClaw.app"
LEGACY_STAGE_DIR="$ROOT_DIR/src-tauri/target/$TARGET/release/manual-dmg"
STAGE_DIR="$(create_manual_dmg_stage_dir)"
DMG_DIR="$ROOT_DIR/release-artifacts/macos-arm64-${BUILD_VARIANT}"
DMG_FILENAME="$(node "$ROOT_DIR/scripts/package-version.mjs" macos-dmg-filename aarch64 "$BUILD_VARIANT")"
DMG_PATH="$DMG_DIR/$DMG_FILENAME"

cleanup() {
  rm -rf "$STAGE_DIR"
}

trap cleanup EXIT

cd "$ROOT_DIR"
rm -rf "$LEGACY_STAGE_DIR"
npm ci
WHERECLAW_BUILD_VARIANT="$BUILD_VARIANT" npm run prepare:openclaw-engine
WHERECLAW_BUILD_VARIANT="$BUILD_VARIANT" npm run tauri build -- --target "$TARGET" --bundles app
codesign --force --deep --sign - "$APP_DIR"
codesign --verify --deep --strict --verbose=2 "$APP_DIR"
build_manual_dmg "$APP_DIR" "$STAGE_DIR" "$DMG_PATH"
echo "Created $DMG_PATH"
