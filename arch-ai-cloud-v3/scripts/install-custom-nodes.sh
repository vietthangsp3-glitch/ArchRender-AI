#!/usr/bin/env bash
set -Eeuo pipefail
COMFY_HOME="${COMFY_HOME:-/opt/ComfyUI}"
CUSTOM_NODES_DIR="${COMFY_HOME}/custom_nodes"
mkdir -p "$CUSTOM_NODES_DIR"

clone_or_update() {
  local repo="$1"
  local folder="$2"
  local dst="$CUSTOM_NODES_DIR/$folder"
  if [[ -d "$dst/.git" ]]; then
    echo "Updating $folder"
    git -C "$dst" pull --ff-only
  elif [[ -e "$dst" ]]; then
    echo "ERROR: $dst exists but is not a git repo" >&2
    exit 1
  else
    echo "Cloning $folder"
    git clone --recursive "$repo" "$dst"
  fi
}

clone_or_update "https://github.com/ltdrdata/ComfyUI-Manager.git" "ComfyUI-Manager"
clone_or_update "https://github.com/ssitu/ComfyUI_UltimateSDUpscale.git" "ComfyUI_UltimateSDUpscale"

echo "Custom node install complete. Restart ComfyUI to load new nodes."
