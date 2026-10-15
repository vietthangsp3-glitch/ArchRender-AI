#!/usr/bin/env bash
set -Eeuo pipefail

COMFY_HOME="${COMFY_HOME:-/opt/ComfyUI}"
WORKSPACE="${WORKSPACE:-/workspace}"
mkdir -p "$WORKSPACE"/{models,input,output,user,custom_nodes,temp,.cache/huggingface}
mkdir -p "$COMFY_HOME"
for item in models input output user custom_nodes temp; do
  target="$COMFY_HOME/$item"
  storage="$WORKSPACE/$item"
  if [[ -L "$target" ]]; then
    current="$(readlink "$target")"
    if [[ "$current" != "$storage" ]]; then
      echo "ERROR: $target points to $current (expected $storage)" >&2; exit 1
    fi
  elif [[ -d "$target" ]]; then
    # ComfyUI ships empty model subdirectories. Preserve these paths under /workspace.
    cp -an "$target/." "$storage/" || true
    rm -rf "$target"
    ln -s "$storage" "$target"
  elif [[ -e "$target" ]]; then
    echo "ERROR: $target exists and isn't a directory" >&2; exit 1
  else
    ln -s "$storage" "$target"
  fi
done

mkdir -p "$WORKSPACE/models"/{checkpoints,loras,vae,text_encoders,clip,controlnet,diffusion_models,upscale_models,embeddings}
HOST="${COMFY_LISTEN:-127.0.0.1}"
PORT="${COMFY_PORT:-8188}"
echo "Starting ComfyUI at $HOST:$PORT; persistent files in $WORKSPACE"
exec python "$COMFY_HOME/main.py" --listen "$HOST" --port "$PORT" "$@"
