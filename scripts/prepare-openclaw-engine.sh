#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENGINE_DIR="$ROOT_DIR/whereclaw-engine"
NODE_RUNTIME_DIR="$ENGINE_DIR/node-runtime"
TEMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TEMP_DIR"
}

trap cleanup EXIT

OPENCLAW_PACKAGE="${OPENCLAW_PACKAGE:-openclaw-cn@latest}"
NODE_VERSION="${NODE_VERSION:-22.20.0}"
OLLAMA_VERSION="${OLLAMA_VERSION:-0.17.7}"
OPTIONAL_CHANNEL_PLUGIN_DIRS=(
  "bluebubbles"
  "feishu"
  "googlechat"
  "line"
  "matrix"
  "mattermost"
  "msteams"
  "nextcloud-talk"
  "nostr"
  "qqbot"
  "synology-chat"
  "tlon"
  "twitch"
  "zalo"
  "zalouser"
)

detect_ollama_platform_dir_for() {
  local os="$1"
  local arch="$2"

  case "$os" in
    Darwin)
      case "$arch" in
        arm64) echo "darwin-arm64" ;;
        x86_64) echo "darwin-x64" ;;
        *)
          echo "Unsupported macOS architecture for Ollama: $arch" >&2
          exit 1
          ;;
      esac
      ;;
    Linux)
      case "$arch" in
        x86_64) echo "linux-x64" ;;
        aarch64|arm64) echo "linux-arm64" ;;
        *)
          echo "Unsupported Linux architecture for Ollama: $arch" >&2
          exit 1
          ;;
      esac
      ;;
    *)
      echo "Unsupported OS for bundled Ollama in this script: $os" >&2
      exit 1
      ;;
  esac
}

detect_ollama_platform_dir() {
  detect_ollama_platform_dir_for "$(uname -s)" "$(uname -m)"
}

detect_ollama_archive_for() {
  local os="$1"
  local arch="$2"

  case "$os" in
    Darwin)
      case "$arch" in
        arm64|x86_64) echo "ollama-darwin.tgz" ;;
        *)
          echo "Unsupported macOS architecture for Ollama archive: $arch" >&2
          exit 1
          ;;
      esac
      ;;
    Linux)
      case "$arch" in
        x86_64) echo "ollama-linux-amd64.tgz" ;;
        aarch64|arm64) echo "ollama-linux-arm64.tgz" ;;
        *)
          echo "Unsupported Linux architecture for Ollama archive: $arch" >&2
          exit 1
          ;;
      esac
      ;;
    *)
      echo "Unsupported OS for Ollama archive: $os" >&2
      exit 1
      ;;
  esac
}

detect_node_archive() {
  local os
  local arch

  os="$(uname -s)"
  arch="$(uname -m)"

  case "$os" in
    Darwin)
      case "$arch" in
        arm64) echo "node-v${NODE_VERSION}-darwin-arm64.tar.gz" ;;
        x86_64) echo "node-v${NODE_VERSION}-darwin-x64.tar.gz" ;;
        *)
          echo "Unsupported macOS architecture: $arch" >&2
          exit 1
          ;;
      esac
      ;;
    Linux)
      case "$arch" in
        x86_64) echo "node-v${NODE_VERSION}-linux-x64.tar.xz" ;;
        aarch64|arm64) echo "node-v${NODE_VERSION}-linux-arm64.tar.xz" ;;
        *)
          echo "Unsupported Linux architecture: $arch" >&2
          exit 1
          ;;
      esac
      ;;
    *)
      echo "Unsupported OS for this script: $os" >&2
      exit 1
      ;;
  esac
}

download_and_extract_node() {
  local archive_name
  local archive_path
  local extract_dir
  local runtime_source

  archive_name="$(detect_node_archive)"
  archive_path="$TEMP_DIR/$archive_name"
  extract_dir="$TEMP_DIR/node-extract"

  mkdir -p "$extract_dir"

  echo "Downloading Node.js $NODE_VERSION ($archive_name)..."
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/${archive_name}" -o "$archive_path"

  case "$archive_name" in
    *.tar.gz) tar -xzf "$archive_path" -C "$extract_dir" ;;
    *.tar.xz) tar -xJf "$archive_path" -C "$extract_dir" ;;
    *)
      echo "Unsupported Node archive format: $archive_name" >&2
      exit 1
      ;;
  esac

  runtime_source="$(find "$extract_dir" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
  if [[ -z "$runtime_source" ]]; then
    echo "Unable to locate extracted Node runtime directory." >&2
    exit 1
  fi

  rm -rf "$NODE_RUNTIME_DIR"
  mkdir -p "$NODE_RUNTIME_DIR"
  cp -R "$runtime_source"/. "$NODE_RUNTIME_DIR"

  if [[ ! -x "$NODE_RUNTIME_DIR/bin/node" ]]; then
    echo "Bundled Node runtime is missing bin/node." >&2
    exit 1
  fi

  if [[ ! -f "$NODE_RUNTIME_DIR/bin/npm" ]]; then
    echo "Bundled Node runtime is missing bin/npm." >&2
    exit 1
  fi
}

download_and_extract_ollama() {
  local platform_dir
  local archive_name
  local archive_path
  local extract_dir
  local runtime_dir

  platform_dir="$(detect_ollama_platform_dir)"
  archive_name="$(detect_ollama_archive_for "$(uname -s)" "$(uname -m)")"
  archive_path="$TEMP_DIR/$archive_name"
  extract_dir="$TEMP_DIR/ollama-extract"
  runtime_dir="$ENGINE_DIR/ollama/$platform_dir"

  mkdir -p "$extract_dir"

  echo "Downloading Ollama $OLLAMA_VERSION ($archive_name)..."
  curl -fsSL "https://github.com/ollama/ollama/releases/download/v${OLLAMA_VERSION}/${archive_name}" -o "$archive_path"
  tar -xzf "$archive_path" -C "$extract_dir"

  rm -rf "$runtime_dir"
  mkdir -p "$runtime_dir"
  cp -R "$extract_dir"/. "$runtime_dir"

  if [[ ! -x "$runtime_dir/ollama" ]]; then
    echo "Bundled Ollama runtime is missing ollama binary." >&2
    exit 1
  fi
}

install_openclaw() {
  local install_root="$TEMP_DIR/openclaw-install"
  local runtime_bin="$NODE_RUNTIME_DIR/bin"
  local npm_binary="$runtime_bin/npm"
  local package_root="$ENGINE_DIR/openclaw/node_modules/openclaw-cn"
  local runtime_control_ui_dir="$runtime_bin/control-ui"

  mkdir -p "$install_root"

  echo "Installing OpenClaw package $OPENCLAW_PACKAGE..."
  PATH="$runtime_bin:$PATH" "$npm_binary" init -y --prefix "$install_root" >/dev/null
  PATH="$runtime_bin:$PATH" "$npm_binary" install --prefix "$install_root" --no-audit --no-fund --omit=dev "$OPENCLAW_PACKAGE"

  rm -rf "$ENGINE_DIR/openclaw/node_modules"
  mkdir -p "$ENGINE_DIR/openclaw"

  cp -R "$install_root/node_modules" "$ENGINE_DIR/openclaw/node_modules"
  cp "$install_root/package.json" "$ENGINE_DIR/openclaw/package.json"
  if [[ -f "$install_root/package-lock.json" ]]; then
    cp "$install_root/package-lock.json" "$ENGINE_DIR/openclaw/package-lock.json"
  fi

  if [[ ! -f "$package_root/dist/entry.js" ]]; then
    echo "Installed OpenClaw entry script was not found." >&2
    exit 1
  fi

  if [[ ! -f "$package_root/dist/control-ui/index.html" ]]; then
    echo "Installed OpenClaw Control UI assets were not found." >&2
    exit 1
  fi

  rm -rf "$runtime_control_ui_dir"
  cp -R "$package_root/dist/control-ui" "$runtime_control_ui_dir"
}

install_optional_channel_plugin_dependencies() {
  local runtime_bin="$NODE_RUNTIME_DIR/bin"
  local npm_binary="$runtime_bin/npm"
  local extensions_root="$ENGINE_DIR/openclaw/node_modules/openclaw-cn/extensions"

  if [[ ! -d "$extensions_root" ]]; then
    return
  fi

  for plugin_dir in "${OPTIONAL_CHANNEL_PLUGIN_DIRS[@]}"; do
    if [[ -f "$extensions_root/$plugin_dir/package.json" ]]; then
      echo "Installing bundled plugin dependencies for $plugin_dir..."
      if ! PATH="$runtime_bin:$PATH" "$npm_binary" install --prefix "$extensions_root/$plugin_dir" --no-audit --no-fund --omit=dev; then
        echo "Skipping optional plugin dependency install for $plugin_dir due to npm install failure." >&2
      fi
    fi
  done
}

main() {
  local ollama_platform_dir

  ollama_platform_dir="$(detect_ollama_platform_dir)"
  mkdir -p "$ENGINE_DIR/openclaw" "$ENGINE_DIR/templates" "$ENGINE_DIR/ollama"

  download_and_extract_node
  download_and_extract_ollama
  install_openclaw
  install_optional_channel_plugin_dependencies

  printf "%s\n" "$OLLAMA_VERSION" >"$ENGINE_DIR/ollama/VERSION"

  if [[ ! -f "$ENGINE_DIR/templates/openclaw.json" ]]; then
    printf "{}\n" >"$ENGINE_DIR/templates/openclaw.json"
  fi

  cat <<EOF
Prepared whereclaw-engine successfully.

Node version:      $NODE_VERSION
OpenClaw package:  $OPENCLAW_PACKAGE
Node runtime:      $NODE_RUNTIME_DIR
Node binary:       $NODE_RUNTIME_DIR/bin/node
NPM binary:        $NODE_RUNTIME_DIR/bin/npm
Ollama version:    $OLLAMA_VERSION
Ollama runtime:    $ENGINE_DIR/ollama/$ollama_platform_dir
Ollama binary:     $ENGINE_DIR/ollama/$ollama_platform_dir/ollama
OpenClaw entry:    $ENGINE_DIR/openclaw/node_modules/openclaw-cn/dist/entry.js
Control UI:        $ENGINE_DIR/openclaw/node_modules/openclaw-cn/dist/control-ui/index.html
Runtime UI copy:   $NODE_RUNTIME_DIR/bin/control-ui/index.html
EOF
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
