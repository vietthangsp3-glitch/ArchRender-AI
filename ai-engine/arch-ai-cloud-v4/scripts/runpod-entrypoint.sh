#!/bin/sh
set -eu

mode="${ARCHRENDER_RUNPOD_MODE:-blocked}"
persist_root="${ARCHRENDER_PERSIST_ROOT:-/workspace/archrender}"

if [ "$persist_root" != "/workspace/archrender" ]; then
  echo '{"event":"runpod_startup_failed","code":"PERSIST_ROOT_INVALID"}' >&2
  exit 1
fi

case "$mode" in
  smoke|acceptance) ;;
  *)
    echo '{"event":"runpod_startup_failed","code":"START_MODE_NOT_APPROVED"}' >&2
    exit 1
    ;;
esac

case "${AI_ENGINE_GATEWAY_BIND_HOST:-}" in
  127.0.0.1)
    [ "${ARCHRENDER_GATEWAY_EXPOSURE:-}" = "private" ] || {
      echo '{"event":"runpod_startup_failed","code":"GATEWAY_EXPOSURE_INVALID"}' >&2
      exit 1
    }
    ;;
  0.0.0.0)
    [ "${ARCHRENDER_GATEWAY_EXPOSURE:-}" = "runpod_proxy" ] || {
      echo '{"event":"runpod_startup_failed","code":"GATEWAY_EXPOSURE_INVALID"}' >&2
      exit 1
    }
    ;;
  *)
    echo '{"event":"runpod_startup_failed","code":"GATEWAY_BIND_INVALID"}' >&2
    exit 1
    ;;
esac

mkdir -p \
  "$persist_root/models" \
  "$persist_root/input" \
  "$persist_root/output" \
  "$persist_root/state" \
  "$persist_root/temp" \
  "$persist_root/user"

chown 10001:10001 \
  "$persist_root/input" \
  "$persist_root/output" \
  "$persist_root/state" \
  "$persist_root/temp" \
  "$persist_root/user"
chmod 0700 \
  "$persist_root/input" \
  "$persist_root/output" \
  "$persist_root/state" \
  "$persist_root/temp" \
  "$persist_root/user"
chmod 0755 "$persist_root" "$persist_root/models"

export ARCHRENDER_MODELS_ROOT="$persist_root/models"
export AI_ENGINE_INPUT_ROOT="$persist_root/input"
export AI_ENGINE_OUTPUT_ROOT="$persist_root/output"
export AI_ENGINE_STATE_PATH="$persist_root/state/executions.json"
export COMFYUI_INPUT_ROOT="$persist_root/input"
export COMFYUI_OUTPUT_ROOT="$persist_root/output"
export COMFYUI_TEMP_ROOT="$persist_root/temp"
export COMFYUI_USER_ROOT="$persist_root/user"

if [ "$mode" = "acceptance" ]; then
  export ARCHRENDER_REQUIRE_CUDA=1
  setpriv --reuid=10001 --regid=10001 --clear-groups \
    python /usr/local/lib/archrender/verify-runtime.py
  setpriv --reuid=10001 --regid=10001 --clear-groups \
    python /opt/archrender/verify-model-files.py
else
  export ARCHRENDER_REQUIRE_CUDA=0
  setpriv --reuid=10001 --regid=10001 --clear-groups \
    python /usr/local/lib/archrender/verify-runtime.py
  echo '{"event":"runpod_model_verification","mode":"SMOKE","status":"SKIPPED"}'
fi

echo "{\"event\":\"runpod_bootstrap\",\"mode\":\"$(printf '%s' "$mode" | tr '[:lower:]' '[:upper:]')\",\"status\":\"READY\"}"
exec setpriv --reuid=10001 --regid=10001 --clear-groups \
  python /opt/archrender/runpod-supervisor.py
