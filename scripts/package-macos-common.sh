#!/usr/bin/env bash
set -euo pipefail

create_manual_dmg_stage_dir() {
  mktemp -d "${TMPDIR:-/tmp}/whereclaw-dmg-stage.XXXXXX"
}

prepare_manual_dmg_stage() {
  local app_dir="$1"
  local stage_dir="$2"

  rm -rf "$stage_dir"
  mkdir -p "$stage_dir"
  cp -R "$app_dir" "$stage_dir/WhereClaw.app"
  ln -s /Applications "$stage_dir/Applications"
}

build_manual_dmg() {
  local app_dir="$1"
  local stage_dir="$2"
  local dmg_path="$3"

  prepare_manual_dmg_stage "$app_dir" "$stage_dir"
  mkdir -p "$(dirname "$dmg_path")"
  rm -f "$dmg_path"
  hdiutil create -volname "WhereClaw" -srcfolder "$stage_dir" -ov -format UDZO "$dmg_path"
}
