import importlib.util
import json
import tempfile
import unittest
import uuid
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("gateway.py")
SPEC = importlib.util.spec_from_file_location("archrender_gateway", MODULE_PATH)
assert SPEC and SPEC.loader
gateway = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gateway)


class GatewayContractTests(unittest.TestCase):
    def test_configuration_allows_only_private_engine_and_explicit_exposure(self):
        original = (
            gateway.TOKEN,
            gateway.COMFYUI_URL,
            gateway.GATEWAY_BIND_HOST,
            gateway.GATEWAY_PORT,
            gateway.GATEWAY_EXPOSURE,
        )
        try:
            gateway.TOKEN = "t" * 32
            gateway.COMFYUI_URL = "http://127.0.0.1:8188"
            gateway.GATEWAY_BIND_HOST = "0.0.0.0"
            gateway.GATEWAY_PORT = 8080
            gateway.GATEWAY_EXPOSURE = "runpod_proxy"
            gateway.require_configuration()

            gateway.GATEWAY_EXPOSURE = "private"
            with self.assertRaisesRegex(RuntimeError, "does not authorize"):
                gateway.require_configuration()

            gateway.GATEWAY_BIND_HOST = "127.0.0.1"
            gateway.GATEWAY_EXPOSURE = "private"
            gateway.COMFYUI_URL = "http://example.invalid:8188"
            with self.assertRaisesRegex(RuntimeError, "private engine"):
                gateway.require_configuration()
        finally:
            (
                gateway.TOKEN,
                gateway.COMFYUI_URL,
                gateway.GATEWAY_BIND_HOST,
                gateway.GATEWAY_PORT,
                gateway.GATEWAY_EXPOSURE,
            ) = original

    def test_execution_state_is_atomically_persisted_and_recoverable(self):
        with tempfile.TemporaryDirectory(prefix="archrender-gateway-test-") as directory:
            gateway.STATE_PATH = Path(directory) / "executions.json"
            execution_id = str(uuid.uuid4())
            prompt_id = str(uuid.uuid4())
            gateway.EXECUTIONS = {execution_id: prompt_id}
            gateway.persist_executions()
            self.assertEqual(gateway.load_executions(), {execution_id: prompt_id})
            self.assertEqual(list(Path(directory).glob("*.tmp")), [])

    def test_pending_mutation_identity_survives_restart(self):
        with tempfile.TemporaryDirectory(prefix="archrender-gateway-test-") as directory:
            gateway.STATE_PATH = Path(directory) / "executions.json"
            execution_id = str(uuid.uuid4())
            client_id = str(uuid.uuid4())
            gateway.EXECUTIONS = {execution_id: f"pending:{client_id}"}
            gateway.persist_executions()
            self.assertEqual(gateway.load_executions()[execution_id], f"pending:{client_id}")

    def test_prompt_validation_rejects_network_and_arbitrary_nodes(self):
        with self.assertRaises(ValueError):
            gateway.validate_prompt({"1": {"class_type": "LoadImage", "inputs": {"image": "https://example.invalid/input.png"}}})
        with self.assertRaises(ValueError):
            gateway.validate_prompt({"1": {"class_type": "ExecuteShell", "inputs": {}}})

    def test_verified_manifest_loader_is_bounded_and_validated(self):
        original = gateway.MODEL_MANIFEST_PATH
        try:
            with tempfile.TemporaryDirectory(prefix="archrender-gateway-manifest-") as directory:
                gateway.MODEL_MANIFEST_PATH = Path(directory) / "models.verified.manifest.json"
                gateway.MODEL_MANIFEST_PATH.write_text(
                    json.dumps({"schemaVersion": 2, "models": []}), encoding="utf-8"
                )
                self.assertEqual(gateway.load_verified_manifest()["schemaVersion"], 2)
                gateway.MODEL_MANIFEST_PATH.write_bytes(b"x" * (64 * 1024 + 1))
                with self.assertRaisesRegex(ValueError, "unavailable"):
                    gateway.load_verified_manifest()
        finally:
            gateway.MODEL_MANIFEST_PATH = original


if __name__ == "__main__":
    unittest.main()
