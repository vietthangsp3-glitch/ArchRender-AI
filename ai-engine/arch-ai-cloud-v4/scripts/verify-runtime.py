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

print("RUNTIME_PIN_OK")
