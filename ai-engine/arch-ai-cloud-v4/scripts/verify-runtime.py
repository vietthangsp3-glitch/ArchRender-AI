import os
import subprocess

import torch


def fail(message: str) -> None:
    raise SystemExit(f"RUNTIME_PIN_MISMATCH:{message}")


expected_commit = os.environ["ARCHRENDER_COMFYUI_COMMIT"]
actual_commit = subprocess.check_output(
    ["git", "-C", "/opt/ComfyUI", "rev-parse", "HEAD"], text=True, timeout=5
).strip()
if actual_commit != expected_commit:
    fail("COMFYUI_COMMIT")

torch_version = torch.__version__.split("+")[0]
if torch_version != os.environ["ARCHRENDER_TORCH_VERSION"]:
    fail("PYTORCH_VERSION")
if torch.version.cuda != os.environ["ARCHRENDER_CUDA_VERSION"]:
    fail("CUDA_RUNTIME")

cudnn_version = torch.backends.cudnn.version()
if cudnn_version is None or str(cudnn_version)[0] != os.environ["ARCHRENDER_CUDNN_MAJOR"]:
    fail("CUDNN_MAJOR")

if os.environ.get("ARCHRENDER_REQUIRE_CUDA", "0") == "1":
    if not torch.cuda.is_available() or torch.cuda.device_count() != 1:
        fail("CUDA_DEVICE")
    if torch.cuda.get_device_properties(0).total_memory < 22 * 1024**3:
        fail("CUDA_VRAM")

print("RUNTIME_PIN_OK")
