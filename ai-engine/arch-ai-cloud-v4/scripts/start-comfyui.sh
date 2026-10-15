#!/bin/sh
set -eu

test -d /opt/ComfyUI/models
test -d /opt/ComfyUI/input
test -d /opt/ComfyUI/output
python /usr/local/lib/archrender/verify-runtime.py

exec python /opt/ComfyUI/main.py \
  --listen "${COMFYUI_LISTEN:-0.0.0.0}" \
  --port "${COMFYUI_PORT:-8188}" \
  --disable-api-nodes \
  --disable-auto-launch \
  --preview-method none

