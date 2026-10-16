import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("verify-model-files.py")
SPEC = importlib.util.spec_from_file_location("archrender_verify_models", MODULE_PATH)
assert SPEC and SPEC.loader
verifier = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(verifier)


class RunpodModelVerificationTests(unittest.TestCase):
    def fixture(self, directory: str) -> tuple[Path, Path]:
        root = Path(directory) / "models"
        root.mkdir()
        artifact_path = root / "checkpoints" / "fixture.bin"
        artifact_path.parent.mkdir()
        payload = b"synthetic-model-fixture"
        artifact_path.write_bytes(payload)
        artifact = {
            "relativePath": "checkpoints/fixture.bin",
            "sizeBytes": len(payload),
            "sha256": hashlib.sha256(payload).hexdigest(),
        }
        manifest = {
            "schemaVersion": 2,
            "generatedAt": "2026-10-16T00:00:00.000Z",
            "models": [
                {"id": model_id, "status": "PENDING_VERIFICATION", "artifacts": [dict(artifact, status="PENDING_VERIFICATION")]}
                for model_id in sorted(verifier.REQUIRED_MODELS)
            ]
        }
        manifest_path = Path(directory) / "manifest.json"
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        return manifest_path, root

    def test_unique_artifact_is_verified_once(self):
        with tempfile.TemporaryDirectory(prefix="archrender-model-test-") as directory:
            manifest_path, root = self.fixture(directory)
            result, promoted = verifier.verify(manifest_path, root)
            self.assertEqual(result, {"artifacts": 1, "bytes": 23})
            self.assertTrue(all(model["status"] == "READY" for model in promoted["models"]))
            self.assertTrue(all(
                artifact["status"] == "VERIFIED"
                for model in promoted["models"] for artifact in model["artifacts"]
            ))
            state_path = root / "state" / "models.verified.manifest.json"
            verifier.persist_verified_manifest(state_path, promoted)
            self.assertEqual(json.loads(state_path.read_text(encoding="utf-8"))["schemaVersion"], 2)
            self.assertEqual(list(state_path.parent.glob("*.tmp")), [])

    def test_checksum_mismatch_fails_closed(self):
        with tempfile.TemporaryDirectory(prefix="archrender-model-test-") as directory:
            manifest_path, root = self.fixture(directory)
            (root / "checkpoints" / "fixture.bin").write_bytes(b"synthetic-model-fixturE")
            with self.assertRaises(SystemExit):
                verifier.verify(manifest_path, root)


if __name__ == "__main__":
    unittest.main()
