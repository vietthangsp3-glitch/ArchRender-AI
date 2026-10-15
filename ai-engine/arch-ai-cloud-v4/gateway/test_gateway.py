import importlib.util
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


if __name__ == "__main__":
    unittest.main()
