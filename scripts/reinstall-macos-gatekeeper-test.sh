#!/usr/bin/env bash
set -euo pipefail

DMG_PATH="${1:-/Users/fc/Documents/GitHub/whereclaw/release-artifacts/macos-arm64/WhereClaw_1.0.0_aarch64.dmg}"
APP_NAME="WhereClaw.app"
APP_BUNDLE_ID="com.whereclaw.desktop"
APP_DEST="/Applications/$APP_NAME"
USER_APP_DEST="$HOME/Applications/$APP_NAME"
MOUNT_POINT=""
TEMP_MOUNT_PARENT=""

cleanup() {
  if [[ -n "$MOUNT_POINT" ]] && mount | grep -Fq "on $MOUNT_POINT "; then
    hdiutil detach "$MOUNT_POINT" >/dev/null 2>&1 || true
  fi

  if [[ -n "$TEMP_MOUNT_PARENT" ]] && [[ -d "$TEMP_MOUNT_PARENT" ]]; then
    rmdir "$TEMP_MOUNT_PARENT" >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT

if [[ ! -f "$DMG_PATH" ]]; then
  echo "DMG not found: $DMG_PATH" >&2
  exit 1
fi

if [[ $EUID -eq 0 ]]; then
  echo "Please run this script as your normal macOS user, not as root." >&2
  exit 1
fi

QUARANTINE_VALUE="0083;$(printf '%x' "$(date +%s)");Safari;$(uuidgen)"

echo "Using DMG: $DMG_PATH"
echo "Quarantine value: $QUARANTINE_VALUE"

pkill -x "WhereClaw" 2>/dev/null || true

rm -rf \
  "$APP_DEST" \
  "$USER_APP_DEST" \
  "$HOME/Library/Application Support/WhereClaw" \
  "$HOME/Library/Application Support/$APP_BUNDLE_ID" \
  "$HOME/Library/Caches/WhereClaw" \
  "$HOME/Library/Caches/$APP_BUNDLE_ID" \
  "$HOME/Library/Preferences/$APP_BUNDLE_ID.plist" \
  "$HOME/Library/Saved Application State/$APP_BUNDLE_ID.savedState" \
  "$HOME/Library/Logs/WhereClaw" \
  "$HOME/Library/Logs/$APP_BUNDLE_ID" \
  "$HOME/Library/WebKit/$APP_BUNDLE_ID" \
  "$HOME/Library/HTTPStorages/$APP_BUNDLE_ID" \
  "$HOME/Library/Containers/$APP_BUNDLE_ID" \
  "$HOME/Library/Group Containers/$APP_BUNDLE_ID"

xattr -d com.apple.quarantine "$DMG_PATH" >/dev/null 2>&1 || true
xattr -w com.apple.quarantine "$QUARANTINE_VALUE" "$DMG_PATH"

echo "DMG quarantine:"
xattr -l "$DMG_PATH" | grep com.apple.quarantine || true

TEMP_MOUNT_PARENT="$(mktemp -d /tmp/whereclaw-gk.XXXXXX)"
MOUNT_POINT="$TEMP_MOUNT_PARENT/mount"
mkdir -p "$MOUNT_POINT"

hdiutil attach -nobrowse -readonly -mountpoint "$MOUNT_POINT" "$DMG_PATH" >/dev/null

if [[ ! -d "$MOUNT_POINT/$APP_NAME" ]]; then
  echo "App not found inside DMG: $MOUNT_POINT/$APP_NAME" >&2
  exit 1
fi

sudo /usr/bin/ditto "$MOUNT_POINT/$APP_NAME" "$APP_DEST"

sudo xattr -d com.apple.quarantine "$APP_DEST" >/dev/null 2>&1 || true
sudo xattr -r -w com.apple.quarantine "$QUARANTINE_VALUE" "$APP_DEST"

echo
echo "Installed app quarantine:"
xattr -l "$APP_DEST" | grep com.apple.quarantine || true

echo
echo "Gatekeeper assessment:"
spctl --assess --type execute -vv "$APP_DEST" || true

echo
echo "Opening app..."
open "$APP_DEST"

echo
echo "If macOS still opens it without a warning, this user account has likely"
echo "already remembered an allow/override for this app identity. In that case,"
echo "test with a fresh macOS user account or a different Mac for a guaranteed"
echo "first-open Gatekeeper prompt."
