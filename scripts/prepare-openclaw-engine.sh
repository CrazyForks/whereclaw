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

NODE_VERSION="${NODE_VERSION:-22.20.0}"
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
        x86_64) echo "ollama-linux-amd64.tar.zst" ;;
        aarch64|arm64) echo "ollama-linux-arm64.tar.zst" ;;
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

download_file() {
  local url="$1"
  local output_path="$2"
  local label="$3"
  local partial_path="${output_path}.part"
  local attempt

  rm -f "$partial_path"

  for attempt in 1 2 3; do
    echo "Downloading $label (attempt $attempt/3)..."
    if curl -fL --retry 3 --retry-delay 2 --connect-timeout 20 -o "$partial_path" "$url"; then
      mv "$partial_path" "$output_path"
      return 0
    fi

    rm -f "$partial_path"
    if [[ "$attempt" != "3" ]]; then
      sleep 2
    fi
  done

  echo "Failed to download $label after 3 attempts." >&2
  return 1
}

has_existing_node_runtime() {
  local version_file="$NODE_RUNTIME_DIR/VERSION"

  if [[ ! -x "$NODE_RUNTIME_DIR/bin/node" || ! -f "$NODE_RUNTIME_DIR/bin/npm" || ! -f "$version_file" ]]; then
    return 1
  fi

  [[ "$(tr -d '\r\n' <"$version_file")" == "$NODE_VERSION" ]]
}

download_and_extract_node() {
  local archive_name
  local archive_path
  local extract_dir
  local runtime_source

  if has_existing_node_runtime; then
    echo "Reusing bundled Node.js runtime $NODE_VERSION from $NODE_RUNTIME_DIR"
    return
  fi

  archive_name="$(detect_node_archive)"
  archive_path="$TEMP_DIR/$archive_name"
  extract_dir="$TEMP_DIR/node-extract"

  mkdir -p "$extract_dir"

  download_file \
    "https://nodejs.org/dist/v${NODE_VERSION}/${archive_name}" \
    "$archive_path" \
    "Node.js $NODE_VERSION ($archive_name)"

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

  printf "%s\n" "$NODE_VERSION" >"$NODE_RUNTIME_DIR/VERSION"
}

download_and_extract_ollama() {
  local platform_dir
  local archive_name
  local archive_path
  local extract_dir
  local runtime_dir
  local ollama_binary
  local ollama_version_output
  local resolved_ollama_version

  platform_dir="$(detect_ollama_platform_dir)"
  archive_name="$(detect_ollama_archive_for "$(uname -s)" "$(uname -m)")"
  archive_path="$TEMP_DIR/$archive_name"
  extract_dir="$TEMP_DIR/ollama-extract"
  runtime_dir="$ENGINE_DIR/ollama/$platform_dir"

  mkdir -p "$extract_dir"

  download_file \
    "https://github.com/ollama/ollama/releases/latest/download/${archive_name}" \
    "$archive_path" \
    "latest Ollama ($archive_name)"
  case "$archive_name" in
    *.tgz|*.tar.gz) tar -xzf "$archive_path" -C "$extract_dir" ;;
    *.tar.zst) tar --zstd -xf "$archive_path" -C "$extract_dir" ;;
    *)
      echo "Unsupported Ollama archive format: $archive_name" >&2
      exit 1
      ;;
  esac

  rm -rf "$runtime_dir"
  mkdir -p "$runtime_dir"
  cp -R "$extract_dir"/. "$runtime_dir"

  ollama_binary="$(find "$runtime_dir" -type f -name ollama -perm -111 | head -n 1 || true)"
  if [[ -z "$ollama_binary" ]]; then
    ollama_binary="$(find "$runtime_dir" -type f -name ollama | head -n 1 || true)"
  fi

  if [[ -z "$ollama_binary" ]]; then
    echo "Bundled Ollama runtime is missing ollama binary." >&2
    exit 1
  fi

  if [[ "$ollama_binary" != "$runtime_dir/ollama" ]]; then
    cp "$ollama_binary" "$runtime_dir/ollama"
    chmod +x "$runtime_dir/ollama"
  fi

  ollama_version_output="$("$runtime_dir/ollama" --version)"
  resolved_ollama_version="$(printf "%s\n" "$ollama_version_output" | sed -nE 's/.*([0-9]+\.[0-9]+\.[0-9]+).*/\1/p' | head -n 1)"
  if [[ -z "$resolved_ollama_version" ]]; then
    echo "Unable to determine downloaded Ollama version from: $ollama_version_output" >&2
    exit 1
  fi

  printf "%s\n" "$resolved_ollama_version" >"$ENGINE_DIR/ollama/VERSION"
}

install_openclaw() {
  local install_root="$TEMP_DIR/openclaw-install"
  local runtime_bin="$NODE_RUNTIME_DIR/bin"
  local npm_binary="$runtime_bin/npm"
  local npm_cache="$TEMP_DIR/npm-cache"
  local package_root="$ENGINE_DIR/openclaw/node_modules/openclaw"
  local runtime_control_ui_dir="$runtime_bin/control-ui"

  mkdir -p "$install_root" "$npm_cache"

  echo "Installing OpenClaw package openclaw@latest..."
  PATH="$runtime_bin:$PATH" NPM_CONFIG_CACHE="$npm_cache" npm_config_cache="$npm_cache" "$npm_binary" init -y --prefix "$install_root" >/dev/null
  PATH="$runtime_bin:$PATH" NPM_CONFIG_CACHE="$npm_cache" npm_config_cache="$npm_cache" "$npm_binary" install --prefix "$install_root" --no-audit --no-fund --omit=dev openclaw@latest

  rm -rf "$ENGINE_DIR/openclaw/node_modules"
  mkdir -p "$ENGINE_DIR/openclaw"

  cp -R "$install_root/node_modules" "$ENGINE_DIR/openclaw/node_modules"
  cp "$install_root/package.json" "$ENGINE_DIR/openclaw/package.json"
  if [[ -f "$install_root/package-lock.json" ]]; then
    cp "$install_root/package-lock.json" "$ENGINE_DIR/openclaw/package-lock.json"
  fi

  if [[ ! -f "$package_root/openclaw.mjs" ]]; then
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

remove_unsafe_plugin_local_links() {
  local plugin_root="$1"
  local plugin_node_modules="$plugin_root/node_modules"

  if [[ ! -d "$plugin_node_modules" ]]; then
    return
  fi

  for unsafe_name in whereclaw openclaw; do
    if [[ -e "$plugin_node_modules/$unsafe_name" ]]; then
      echo "Removing unsafe local linked dependency from $(basename "$plugin_root"): $unsafe_name" >&2
      rm -rf "$plugin_node_modules/$unsafe_name"
    fi
  done
}

install_optional_channel_plugin_dependencies() {
  local runtime_bin="$NODE_RUNTIME_DIR/bin"
  local npm_binary="$runtime_bin/npm"
  local npm_cache="$TEMP_DIR/npm-cache"
  local extensions_root="$ENGINE_DIR/openclaw/node_modules/openclaw/dist/extensions"

  if [[ ! -d "$extensions_root" ]]; then
    return
  fi

  for plugin_dir in "${OPTIONAL_CHANNEL_PLUGIN_DIRS[@]}"; do
    if [[ -f "$extensions_root/$plugin_dir/package.json" ]]; then
      echo "Installing bundled plugin dependencies for $plugin_dir..."
      if ! PATH="$runtime_bin:$PATH" NPM_CONFIG_CACHE="$npm_cache" npm_config_cache="$npm_cache" "$npm_binary" install --prefix "$extensions_root/$plugin_dir" --no-audit --no-fund --omit=dev; then
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

  if [[ ! -f "$ENGINE_DIR/templates/openclaw.json" ]]; then
    printf "{}\n" >"$ENGINE_DIR/templates/openclaw.json"
  fi

  cat <<EOF
Prepared whereclaw-engine successfully.

Node version:      $NODE_VERSION
OpenClaw package:  openclaw@latest
Node runtime:      $NODE_RUNTIME_DIR
Node binary:       $NODE_RUNTIME_DIR/bin/node
NPM binary:        $NODE_RUNTIME_DIR/bin/npm
Ollama version:    $(cat "$ENGINE_DIR/ollama/VERSION")
Ollama runtime:    $ENGINE_DIR/ollama/$ollama_platform_dir
Ollama binary:     $ENGINE_DIR/ollama/$ollama_platform_dir/ollama
OpenClaw entry:    $ENGINE_DIR/openclaw/node_modules/openclaw/openclaw.mjs
Control UI:        $ENGINE_DIR/openclaw/node_modules/openclaw/dist/control-ui/index.html
Runtime UI copy:   $NODE_RUNTIME_DIR/bin/control-ui/index.html
EOF
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
