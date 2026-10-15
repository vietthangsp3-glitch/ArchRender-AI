"""Minimal authenticated control gateway for a private ComfyUI instance.

The gateway accepts only an allowlisted API-prompt graph. It never accepts an
upstream URL, filesystem path, shell command, model download, or browser cookie.
"""

from __future__ import annotations

import hmac
import hashlib
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
import uuid
import threading
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

TOKEN = os.environ.get("AI_ENGINE_WORKER_TOKEN", "")
COMFYUI_URL = os.environ.get("AI_ENGINE_COMFYUI_URL", "http://comfyui:8188").rstrip("/")
MAX_REQUEST_BYTES = int(os.environ.get("AI_ENGINE_MAX_REQUEST_BYTES", "1048576"))
MAX_INPUT_BYTES = int(os.environ.get("AI_ENGINE_MAX_INPUT_BYTES", "104857600"))
UPSTREAM_TIMEOUT = int(os.environ.get("AI_ENGINE_UPSTREAM_TIMEOUT_SECONDS", "30"))
OUTPUT_ROOT = Path(os.environ.get("AI_ENGINE_OUTPUT_ROOT", "/engine-output")).resolve()
INPUT_ROOT = Path(os.environ.get("AI_ENGINE_INPUT_ROOT", "/engine-input")).resolve()
STATE_PATH = Path(os.environ.get("AI_ENGINE_STATE_PATH", "/engine-state/executions.json")).resolve()
SAFE_ID = re.compile(r"^[0-9a-f-]{36}$")
SAFE_FILE = re.compile(r"^[A-Za-z0-9_.-]{1,180}$")
ALLOWED_NODES = {
    "CheckpointLoaderSimple", "CLIPTextEncode", "LoadImage", "VAEEncode", "KSampler",
    "VAEDecode", "SaveImage", "ControlNetLoader", "ControlNetApplyAdvanced", "ImageScale",
    "UpscaleModelLoader", "ImageUpscaleWithModel", "WanImageToVideo", "CreateVideo", "SaveVideo",
}
STATE_LOCK = threading.Lock()


def load_executions() -> dict[str, str]:
    if not STATE_PATH.exists():
        return {}
    value = json.loads(STATE_PATH.read_text(encoding="utf-8"))
    if not isinstance(value, dict) or any(
        not SAFE_ID.fullmatch(key) or not isinstance(item, str)
        or not (SAFE_ID.fullmatch(item) or (item.startswith("pending:") and SAFE_ID.fullmatch(item.removeprefix("pending:"))))
        for key, item in value.items()
    ):
        raise RuntimeError("AI engine state file is invalid")
    return value


EXECUTIONS: dict[str, str] = load_executions()


def persist_executions() -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    temporary = STATE_PATH.with_name(f".{STATE_PATH.name}.{uuid.uuid4().hex}.tmp")
    with temporary.open("x", encoding="utf-8") as destination:
        json.dump(EXECUTIONS, destination, separators=(",", ":"), sort_keys=True)
        destination.flush()
        os.fsync(destination.fileno())
    os.replace(temporary, STATE_PATH)
    if hasattr(os, "O_DIRECTORY"):
        directory_fd = os.open(STATE_PATH.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)


def require_configuration() -> None:
    if len(TOKEN) < 32:
        raise RuntimeError("AI_ENGINE_WORKER_TOKEN must contain at least 32 characters")
    parsed = urllib.parse.urlparse(COMFYUI_URL)
    if parsed.scheme != "http" or parsed.hostname != "comfyui" or parsed.port != 8188:
        raise RuntimeError("AI_ENGINE_COMFYUI_URL must target the private compose service")
    if not 1024 <= MAX_REQUEST_BYTES <= 4 * 1024 * 1024:
        raise RuntimeError("AI_ENGINE_MAX_REQUEST_BYTES is outside the safe range")
    if not 1024 <= MAX_INPUT_BYTES <= 512 * 1024 * 1024:
        raise RuntimeError("AI_ENGINE_MAX_INPUT_BYTES is outside the safe range")
    if not 1 <= UPSTREAM_TIMEOUT <= 120:
        raise RuntimeError("AI_ENGINE_UPSTREAM_TIMEOUT_SECONDS is outside the safe range")


def upstream(path: str, method: str = "GET", body: dict[str, Any] | None = None) -> tuple[int, bytes, dict[str, str]]:
    data = None if body is None else json.dumps(body, separators=(",", ":")).encode()
    request = urllib.request.Request(
        f"{COMFYUI_URL}{path}", data=data, method=method,
        headers={"Accept": "application/json", **({"Content-Type": "application/json"} if data else {})},
    )
    try:
        with urllib.request.urlopen(request, timeout=UPSTREAM_TIMEOUT) as response:
            return response.status, response.read(32 * 1024 * 1024), dict(response.headers.items())
    except urllib.error.HTTPError as error:
        return error.code, error.read(64 * 1024), dict(error.headers.items())


def validate_prompt(prompt: Any) -> dict[str, Any]:
    if not isinstance(prompt, dict) or not 1 <= len(prompt) <= 96:
        raise ValueError("invalid prompt graph")
    encoded = json.dumps(prompt, separators=(",", ":"))
    if "../" in encoded or "..\\" in encoded or "http://" in encoded or "https://" in encoded or "\u0000" in encoded:
        raise ValueError("unsafe prompt scalar")
    for node_id, node in prompt.items():
        if not isinstance(node_id, str) or not node_id.isdigit() or not isinstance(node, dict):
            raise ValueError("invalid node")
        if node.get("class_type") not in ALLOWED_NODES or not isinstance(node.get("inputs"), dict):
            raise ValueError("forbidden node")
    return prompt


class Handler(BaseHTTPRequestHandler):
    server_version = "ArchRenderGateway/4"

    def log_message(self, format_string: str, *args: object) -> None:
        # Deliberately omit URL, headers, body, token, filenames and provider response.
        print(json.dumps({"event": "gateway_http", "status": args[1] if len(args) > 1 else "unknown"}), flush=True)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/healthz":
            try:
                status, _, _ = upstream("/system_stats")
                self.reply(HTTPStatus.OK, {"status": "READY" if status == 200 else "DEGRADED"})
            except Exception:
                self.reply(HTTPStatus.OK, {"status": "DEGRADED"})
            return
        if not self.authorized():
            return
        output_match = re.fullmatch(r"/v1/executions/([0-9a-f-]{36})/outputs/([A-Za-z0-9_.-]{1,180})", self.path)
        if output_match:
            self.read_output(output_match.group(1), output_match.group(2))
            return
        status_match = re.fullmatch(r"/v1/executions/([0-9a-f-]{36})", self.path)
        if status_match:
            self.execution_status(status_match.group(1))
            return
        self.reply(HTTPStatus.NOT_FOUND, {"code": "NOT_FOUND"})

    def do_POST(self) -> None:  # noqa: N802
        if not self.authorized():
            return
        if self.path == "/v1/executions":
            self.submit()
            return
        cancel_match = re.fullmatch(r"/v1/executions/([0-9a-f-]{36})/cancel", self.path)
        if cancel_match:
            self.cancel(cancel_match.group(1))
            return
        self.reply(HTTPStatus.NOT_FOUND, {"code": "NOT_FOUND"})

    def do_PUT(self) -> None:  # noqa: N802
        if not self.authorized():
            return
        match = re.fullmatch(r"/v1/workspaces/([a-f0-9]{32,80})/inputs/([A-Za-z0-9_.-]{1,180})", self.path)
        if not match:
            self.reply(HTTPStatus.NOT_FOUND, {"code": "NOT_FOUND"})
            return
        self.stage_input(match.group(1), match.group(2))

    def do_DELETE(self) -> None:  # noqa: N802
        if not self.authorized():
            return
        match = re.fullmatch(r"/v1/workspaces/([a-f0-9]{32,80})/inputs/([A-Za-z0-9_.-]{1,180})", self.path)
        if not match:
            self.reply(HTTPStatus.NOT_FOUND, {"code": "NOT_FOUND"})
            return
        self.delete_input(match.group(1), match.group(2))

    def authorized(self) -> bool:
        supplied = self.headers.get("Authorization", "")
        expected = f"Bearer {TOKEN}"
        if not hmac.compare_digest(supplied.encode(), expected.encode()):
            self.reply(HTTPStatus.UNAUTHORIZED, {"code": "UNAUTHORIZED"})
            return False
        return True

    def json_body(self) -> dict[str, Any]:
        length_text = self.headers.get("Content-Length", "")
        if not length_text.isdigit():
            raise ValueError("content length required")
        length = int(length_text)
        if not 1 <= length <= MAX_REQUEST_BYTES:
            raise ValueError("request size invalid")
        value = json.loads(self.rfile.read(length))
        if not isinstance(value, dict):
            raise ValueError("object body required")
        return value

    def submit(self) -> None:
        try:
            body = self.json_body()
            if set(body) != {"requestId", "jobId", "generation", "prompt"}:
                raise ValueError("invalid request fields")
            if not isinstance(body["generation"], int) or not 1 <= body["generation"] <= 1_000_000:
                raise ValueError("invalid generation")
            prompt = validate_prompt(body["prompt"])
            client_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"{body['jobId']}:{body['generation']}"))
            execution_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"archrender:{body['jobId']}:{body['generation']}"))
            with STATE_LOCK:
                existing_prompt_id = EXECUTIONS.get(execution_id)
            if existing_prompt_id:
                if existing_prompt_id.startswith("pending:"):
                    self.reply(HTTPStatus.CONFLICT, {"code": "EXECUTION_RECOVERY_REQUIRED"})
                    return
                self.reply(HTTPStatus.OK, {"executionId": execution_id})
                return
            with STATE_LOCK:
                EXECUTIONS[execution_id] = f"pending:{client_id}"
                persist_executions()
            status, raw, _ = upstream("/prompt", "POST", {"prompt": prompt, "client_id": client_id})
            if status != 200:
                with STATE_LOCK:
                    EXECUTIONS.pop(execution_id, None)
                    persist_executions()
                self.reply(HTTPStatus.BAD_GATEWAY, {"code": "UPSTREAM_REJECTED"})
                return
            response = json.loads(raw)
            prompt_id = response.get("prompt_id")
            if not isinstance(prompt_id, str) or not SAFE_ID.fullmatch(prompt_id):
                raise ValueError("missing upstream identity")
            with STATE_LOCK:
                EXECUTIONS[execution_id] = prompt_id
                persist_executions()
            self.reply(HTTPStatus.OK, {"executionId": execution_id})
        except (ValueError, json.JSONDecodeError):
            self.reply(HTTPStatus.BAD_REQUEST, {"code": "INVALID_REQUEST"})
        except Exception:
            self.reply(HTTPStatus.SERVICE_UNAVAILABLE, {"code": "UPSTREAM_UNAVAILABLE"})

    def stage_input(self, workspace_id: str, filename: str) -> None:
        length_text = self.headers.get("Content-Length", "")
        checksum = self.headers.get("X-Content-SHA256", "")
        if not length_text.isdigit() or not 1 <= int(length_text) <= MAX_INPUT_BYTES or not re.fullmatch(r"[a-f0-9]{64}", checksum):
            self.reply(HTTPStatus.BAD_REQUEST, {"code": "INVALID_INPUT_IDENTITY"})
            return
        target_name = f"{workspace_id}_{filename}"
        target = (INPUT_ROOT / target_name).resolve()
        if target.parent != INPUT_ROOT:
            self.reply(HTTPStatus.BAD_REQUEST, {"code": "INVALID_INPUT_IDENTITY"})
            return
        content = self.rfile.read(int(length_text))
        if len(content) != int(length_text) or hashlib.sha256(content).hexdigest() != checksum:
            self.reply(HTTPStatus.UNPROCESSABLE_ENTITY, {"code": "INPUT_CHECKSUM_MISMATCH"})
            return
        if target.exists():
            if hashlib.sha256(target.read_bytes()).hexdigest() != checksum:
                self.reply(HTTPStatus.CONFLICT, {"code": "INPUT_IDENTITY_CONFLICT"})
                return
            self.reply(HTTPStatus.OK, {"filename": target_name})
            return
        temporary = INPUT_ROOT / f".{target_name}.{uuid.uuid4().hex}.tmp"
        try:
            with temporary.open("xb") as destination:
                destination.write(content)
                destination.flush()
                os.fsync(destination.fileno())
            try:
                os.link(temporary, target)
            except FileExistsError:
                if hashlib.sha256(target.read_bytes()).hexdigest() != checksum:
                    self.reply(HTTPStatus.CONFLICT, {"code": "INPUT_IDENTITY_CONFLICT"})
                    return
            self.reply(HTTPStatus.CREATED, {"filename": target_name})
        finally:
            temporary.unlink(missing_ok=True)

    def delete_input(self, workspace_id: str, filename: str) -> None:
        checksum = self.headers.get("X-Content-SHA256", "")
        target = (INPUT_ROOT / f"{workspace_id}_{filename}").resolve()
        if target.parent != INPUT_ROOT or not re.fullmatch(r"[a-f0-9]{64}", checksum):
            self.reply(HTTPStatus.BAD_REQUEST, {"code": "INVALID_INPUT_IDENTITY"})
            return
        if not target.exists():
            self.reply(HTTPStatus.NOT_FOUND, {"code": "INPUT_NOT_FOUND"})
            return
        if hashlib.sha256(target.read_bytes()).hexdigest() != checksum:
            self.reply(HTTPStatus.CONFLICT, {"code": "INPUT_IDENTITY_CONFLICT"})
            return
        target.unlink()
        self.reply(HTTPStatus.OK, {"deleted": True})

    def execution_status(self, execution_id: str) -> None:
        prompt_id = EXECUTIONS.get(execution_id)
        if not prompt_id:
            self.reply(HTTPStatus.NOT_FOUND, {"code": "EXECUTION_NOT_FOUND"})
            return
        if prompt_id.startswith("pending:"):
            self.reply(HTTPStatus.CONFLICT, {"code": "EXECUTION_RECOVERY_REQUIRED"})
            return
        try:
            status, raw, _ = upstream(f"/history/{urllib.parse.quote(prompt_id, safe='')}")
            if status != 200:
                self.reply(HTTPStatus.BAD_GATEWAY, {"code": "UPSTREAM_REJECTED"})
                return
            history = json.loads(raw).get(prompt_id)
            if not history:
                self.reply(HTTPStatus.OK, {"executionId": execution_id, "state": "RUNNING", "progress": 0, "outputs": [], "errorCode": None})
                return
            status_info = history.get("status", {})
            completed = bool(status_info.get("completed"))
            failed = status_info.get("status_str") == "error" or any(
                isinstance(message, list) and message and message[0] == "execution_error"
                for message in status_info.get("messages", [])
            )
            output_files: list[dict[str, Any]] = []
            for node_output in history.get("outputs", {}).values():
                for group in ("images", "videos", "gifs"):
                    for item in node_output.get(group, []):
                        filename = item.get("filename")
                        if isinstance(filename, str) and SAFE_FILE.fullmatch(filename):
                            path = (OUTPUT_ROOT / filename).resolve()
                            if path.parent == OUTPUT_ROOT and path.is_file():
                                output_files.append({"filename": filename, "contentType": media_type(filename), "byteSize": path.stat().st_size})
            state = "FAILED" if failed else "SUCCEEDED" if completed else "RUNNING"
            self.reply(HTTPStatus.OK, {"executionId": execution_id, "state": state, "progress": 100 if completed and not failed else 0, "outputs": output_files[:8] if not failed else [], "errorCode": "ENGINE_EXECUTION_FAILED" if failed else None})
        except Exception:
            self.reply(HTTPStatus.SERVICE_UNAVAILABLE, {"code": "UPSTREAM_UNAVAILABLE"})

    def cancel(self, execution_id: str) -> None:
        prompt_id = EXECUTIONS.get(execution_id)
        if not prompt_id:
            self.reply(HTTPStatus.NOT_FOUND, {"code": "EXECUTION_NOT_FOUND"})
            return
        if prompt_id.startswith("pending:"):
            self.reply(HTTPStatus.CONFLICT, {"code": "EXECUTION_RECOVERY_REQUIRED"})
            return
        status, _, _ = upstream("/interrupt", "POST", {})
        self.reply(HTTPStatus.OK if status == 200 else HTTPStatus.BAD_GATEWAY, {"cancelled": status == 200})

    def read_output(self, execution_id: str, filename: str) -> None:
        prompt_id = EXECUTIONS.get(execution_id)
        if not prompt_id or prompt_id.startswith("pending:") or not SAFE_ID.fullmatch(execution_id) or not SAFE_FILE.fullmatch(filename):
            self.reply(HTTPStatus.NOT_FOUND, {"code": "OUTPUT_NOT_FOUND"})
            return
        try:
            status, raw, _ = upstream(f"/history/{urllib.parse.quote(prompt_id, safe='')}")
            history = json.loads(raw).get(prompt_id) if status == 200 else None
            allowed = {
                item.get("filename")
                for node_output in (history or {}).get("outputs", {}).values()
                for group in ("images", "videos", "gifs")
                for item in node_output.get(group, [])
                if isinstance(item, dict)
            }
            if filename not in allowed:
                self.reply(HTTPStatus.NOT_FOUND, {"code": "OUTPUT_NOT_FOUND"})
                return
        except Exception:
            self.reply(HTTPStatus.SERVICE_UNAVAILABLE, {"code": "UPSTREAM_UNAVAILABLE"})
            return
        path = (OUTPUT_ROOT / filename).resolve()
        if path.parent != OUTPUT_ROOT or not path.is_file():
            self.reply(HTTPStatus.NOT_FOUND, {"code": "OUTPUT_NOT_FOUND"})
            return
        size = path.stat().st_size
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", media_type(filename))
        self.send_header("Content-Length", str(size))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        with path.open("rb") as source:
            while chunk := source.read(64 * 1024):
                self.wfile.write(chunk)

    def reply(self, status: HTTPStatus, body: dict[str, Any]) -> None:
        raw = json.dumps(body, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(raw)


def media_type(filename: str) -> str:
    extension = filename.rsplit(".", 1)[-1].lower()
    return {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp", "mp4": "video/mp4"}.get(extension, "application/octet-stream")


if __name__ == "__main__":
    require_configuration()
    ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()

