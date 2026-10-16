from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time
import urllib.request


children: list[subprocess.Popen[bytes]] = []
stopping = False


def safe_log(event: str, **fields: object) -> None:
    print(json.dumps({"event": event, **fields}, separators=(",", ":")), flush=True)


def stop_children() -> None:
    global stopping
    stopping = True
    for child in reversed(children):
        if child.poll() is None:
            child.terminate()
    deadline = time.monotonic() + 30
    for child in reversed(children):
        if child.poll() is not None:
            continue
        try:
            child.wait(timeout=max(0.1, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=5)


def handle_signal(signum: int, _frame: object) -> None:
    safe_log("runpod_supervisor_signal", signal=signal.Signals(signum).name)
    stop_children()


def wait_for_comfyui(process: subprocess.Popen[bytes]) -> bool:
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline and not stopping:
        if process.poll() is not None:
            return False
        try:
            with urllib.request.urlopen("http://127.0.0.1:8188/system_stats", timeout=3) as response:
                if response.status == 200:
                    return True
        except Exception:
            time.sleep(1)
    return False


def main() -> int:
    mode = os.environ["ARCHRENDER_RUNPOD_MODE"]
    comfyui = [
        sys.executable,
        "/opt/ComfyUI/main.py",
        "--listen",
        "127.0.0.1",
        "--port",
        "8188",
        "--models-directory",
        os.environ["ARCHRENDER_MODELS_ROOT"],
        "--input-directory",
        os.environ["COMFYUI_INPUT_ROOT"],
        "--output-directory",
        os.environ["COMFYUI_OUTPUT_ROOT"],
        "--temp-directory",
        os.environ["COMFYUI_TEMP_ROOT"],
        "--user-directory",
        os.environ["COMFYUI_USER_ROOT"],
        "--disable-all-custom-nodes",
        "--disable-api-nodes",
        "--disable-auto-launch",
        "--preview-method",
        "none",
    ]
    if mode == "smoke":
        comfyui.append("--cpu")

    safe_log("runpod_process_start", process="comfyui", mode=mode.upper())
    comfy_process = subprocess.Popen(comfyui)
    children.append(comfy_process)
    if not wait_for_comfyui(comfy_process):
        safe_log("runpod_process_failed", process="comfyui", code="STARTUP_NOT_READY")
        stop_children()
        return 1

    safe_log("runpod_process_ready", process="comfyui")
    gateway_process = subprocess.Popen([sys.executable, "/opt/archrender/gateway.py"])
    children.append(gateway_process)
    safe_log("runpod_process_start", process="gateway", mode=mode.upper())

    while not stopping:
        for name, process in (("comfyui", comfy_process), ("gateway", gateway_process)):
            code = process.poll()
            if code is not None:
                safe_log("runpod_process_exit", process=name, code=code, expected=False)
                stop_children()
                return 1
        time.sleep(1)

    safe_log("runpod_supervisor_stopped", status="CLEAN")
    return 0


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)
    raise SystemExit(main())
