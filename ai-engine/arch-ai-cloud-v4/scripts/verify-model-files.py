from __future__ import annotations

import hashlib
import json
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path


REQUIRED_MODELS = {
    "architecture_image_sdxl",
    "architecture_image_sdxl_control",
    "architecture_upscale_realesrgan_x4plus",
}
MANIFEST_PATH = Path("/opt/archrender/config/models.manifest.json")


def fail(code: str) -> None:
    print(json.dumps({"event": "runpod_model_verification", "status": "FAIL", "code": code}), flush=True)
    raise SystemExit(1)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(8 * 1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def verify(manifest_path: Path, model_root: Path) -> tuple[dict[str, int], dict[str, object]]:
    model_root = model_root.resolve()
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    selected = [model for model in manifest.get("models", []) if model.get("id") in REQUIRED_MODELS]
    if {model.get("id") for model in selected} != REQUIRED_MODELS:
        fail("MODEL_SET_INCOMPLETE")

    artifacts: dict[str, dict[str, object]] = {}
    for model in selected:
        for artifact in model.get("artifacts", []):
            relative = artifact.get("relativePath")
            if not isinstance(relative, str) or not relative:
                fail("MODEL_IDENTITY_INVALID")
            existing = artifacts.get(relative)
            identity = (artifact.get("sizeBytes"), artifact.get("sha256"))
            if existing and identity != (existing.get("sizeBytes"), existing.get("sha256")):
                fail("MODEL_IDENTITY_CONFLICT")
            artifacts[relative] = artifact

    expected_bytes = 0
    for relative, artifact in artifacts.items():
        expected_size = artifact.get("sizeBytes")
        expected_hash = artifact.get("sha256")
        if not isinstance(expected_size, int) or expected_size <= 0 or not isinstance(expected_hash, str) or len(expected_hash) != 64:
            fail("MODEL_EVIDENCE_INCOMPLETE")
        target = (model_root / relative).resolve()
        try:
            target.relative_to(model_root)
        except ValueError:
            fail("MODEL_PATH_ESCAPE")
        if not target.is_file():
            fail("MODEL_FILE_MISSING")
        if target.stat().st_size != expected_size:
            fail("MODEL_SIZE_MISMATCH")
        if sha256_file(target) != expected_hash:
            fail("MODEL_CHECKSUM_MISMATCH")
        expected_bytes += expected_size
    for model in selected:
        model["status"] = "READY"
        for artifact in model["artifacts"]:
            artifact["status"] = "VERIFIED"
    manifest["generatedAt"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    return {"artifacts": len(artifacts), "bytes": expected_bytes}, manifest


def persist_verified_manifest(path: Path, manifest: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    encoded = json.dumps(manifest, separators=(",", ":"), sort_keys=True).encode()
    with temporary.open("xb") as destination:
        destination.write(encoded)
        destination.flush()
        os.fsync(destination.fileno())
    os.replace(temporary, path)
    if hasattr(os, "O_DIRECTORY"):
        directory_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)


if __name__ == "__main__":
    root = Path(os.environ.get("ARCHRENDER_MODELS_ROOT", "/workspace/archrender/models")).resolve()
    result, verified_manifest = verify(MANIFEST_PATH, root)
    verified_path = Path(
        os.environ.get(
            "ARCHRENDER_VERIFIED_MANIFEST_PATH",
            "/workspace/archrender/state/models.verified.manifest.json",
        )
    ).resolve()
    persist_verified_manifest(verified_path, verified_manifest)
    print(json.dumps({"event": "runpod_model_verification", "status": "PASS", **result}), flush=True)
