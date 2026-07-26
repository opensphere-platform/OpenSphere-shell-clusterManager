#!/usr/bin/env python3
"""Read-only Ceph snapshot service for the OpenSphere Cluster Manager.

The service accepts no command text from callers. It executes only the fixed
allowlist below with the existing Rook external-cluster credential files.
Credential values are never copied into responses or logs.
"""

from __future__ import annotations

import json
import hmac
import os
import re
import subprocess
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse


PORT = int(os.environ.get("PORT", "8080"))
CACHE_SECONDS = max(5, min(300, int(os.environ.get("CACHE_SECONDS", "30"))))
COMMAND_TIMEOUT_SECONDS = max(3, min(30, int(os.environ.get("COMMAND_TIMEOUT_SECONDS", "8"))))
MAX_COMMAND_OUTPUT_BYTES = max(64 * 1024, min(8 * 1024 * 1024, int(os.environ.get("MAX_COMMAND_OUTPUT_BYTES", str(2 * 1024 * 1024)))))
CREDENTIAL_DIR = os.environ.get("CREDENTIAL_DIR", "/var/run/opensphere-ceph/credentials")
MONITOR_FILE = os.environ.get("MONITOR_FILE", "/var/run/opensphere-ceph/monitors/data")
USER_ID_FILE = os.path.join(CREDENTIAL_DIR, "userID")
USER_KEY_FILE = os.path.join(CREDENTIAL_DIR, "userKey")
API_TOKEN_FILE = os.environ.get("API_TOKEN_FILE", "/var/run/opensphere-ceph/api-auth/token")

COMMANDS = {
    "status": ["status"],
    "health": ["health", "detail"],
    "capacity": ["df", "detail"],
    "osds": ["osd", "df", "tree"],
    "pgs": ["pg", "stat"],
    "hosts": ["orch", "host", "ls"],
    "services": ["orch", "ps"],
    "versions": ["versions"],
}

MONITOR_PATTERN = re.compile(
    r"^(?:(?:v1|v2):)?(?:\[[0-9a-fA-F:]+\]|[A-Za-z0-9][A-Za-z0-9.-]{0,252}):(3300|6789)(?:/0)?$"
)

_cache_lock = threading.Lock()
_collection_lock = threading.Lock()
_cache_value: dict | None = None
_cache_monotonic = 0.0
_request_slots = threading.BoundedSemaphore(16)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def read_text(path: str, limit: int) -> str:
    with open(path, "r", encoding="utf-8") as handle:
        value = handle.read(limit + 1)
    if len(value) > limit:
        raise ValueError("configuration value exceeds its allowed size")
    return value.strip()


def connection_arguments() -> tuple[list[str], str | None]:
    try:
        user_id = read_text(USER_ID_FILE, 512)
        key_stat = os.stat(USER_KEY_FILE)
        monitor_data = read_text(MONITOR_FILE, 16 * 1024)
    except FileNotFoundError:
        return [], "Ceph connection Secret or monitor ConfigMap is not configured."
    except (OSError, ValueError):
        return [], "Ceph connection files could not be read safely."

    if key_stat.st_size < 16 or key_stat.st_size > 4096:
        return [], "Ceph credential file has an invalid size."
    entity = user_id if user_id.startswith("client.") else f"client.{user_id}"
    if not re.fullmatch(r"client\.[A-Za-z0-9][A-Za-z0-9._-]{0,254}", entity):
        return [], "CephX entity has an invalid format."

    monitors: list[str] = []
    for entry in monitor_data.split(","):
        endpoint = entry.strip().split("=", 1)[-1].strip()
        if endpoint:
            if not MONITOR_PATTERN.fullmatch(endpoint):
                return [], "Monitor endpoint data has an invalid format."
            monitors.append(endpoint)
    if not monitors:
        return [], "No monitor endpoints are configured."

    return [
        "ceph",
        "--conf",
        "/dev/null",
        "--name",
        entity,
        "--keyfile",
        USER_KEY_FILE,
        "--mon-host",
        ",".join(monitors),
        "--connect-timeout",
        "5",
    ], None


def classify_failure(stderr: str, return_code: int) -> tuple[str, str]:
    normalized = stderr.lower()
    if "permission denied" in normalized or "access denied" in normalized or "eacces" in normalized:
        return "PermissionDenied", "The connected CephX account cannot read this section."
    if "no valid command found" in normalized or "unrecognized command" in normalized or "orchestrator" in normalized and "not available" in normalized:
        return "Unsupported", "This Ceph cluster does not expose this command."
    if "timed out" in normalized or return_code == 124:
        return "Timeout", "Ceph did not respond within the observation timeout."
    return "CommandFailed", "Ceph returned an error while collecting this section."


def execute(command_id: str, base_arguments: list[str]) -> dict:
    started = time.monotonic()
    args = [*base_arguments, *COMMANDS[command_id], "--format", "json"]
    try:
        # File-backed output prevents a large Ceph response from being buffered
        # into the observer process before the size limit can be enforced.
        with tempfile.TemporaryFile() as stdout_file, tempfile.TemporaryFile() as stderr_file:
            process = subprocess.Popen(
                args,
                stdin=subprocess.DEVNULL,
                stdout=stdout_file,
                stderr=stderr_file,
                env={**os.environ, "HOME": "/tmp"},
            )
            try:
                process.wait(timeout=COMMAND_TIMEOUT_SECONDS)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
                raise
            stdout_size = stdout_file.tell()
            stderr_size = stderr_file.tell()
            if stdout_size > MAX_COMMAND_OUTPUT_BYTES or stderr_size > MAX_COMMAND_OUTPUT_BYTES:
                return {
                    "available": False,
                    "reason": "ResponseTooLarge",
                    "message": "Ceph returned more data than the observer allows.",
                    "durationMs": int((time.monotonic() - started) * 1000),
                }
            stdout_file.seek(0)
            stderr_file.seek(0)
            stdout = stdout_file.read(MAX_COMMAND_OUTPUT_BYTES + 1)
            stderr_bytes = stderr_file.read(min(MAX_COMMAND_OUTPUT_BYTES, 8192))
            return_code = process.returncode
    except subprocess.TimeoutExpired:
        return {
            "available": False,
            "reason": "Timeout",
            "message": "Ceph did not respond within the observation timeout.",
            "durationMs": int((time.monotonic() - started) * 1000),
        }
    except OSError:
        return {
            "available": False,
            "reason": "ObserverUnavailable",
            "message": "The Ceph command-line client is unavailable.",
            "durationMs": int((time.monotonic() - started) * 1000),
        }

    duration_ms = int((time.monotonic() - started) * 1000)
    stderr = stderr_bytes.decode("utf-8", errors="replace")[:8192]
    if return_code != 0:
        reason, message = classify_failure(stderr, return_code)
        return {
            "available": False,
            "reason": reason,
            "message": message,
            "durationMs": duration_ms,
        }
    try:
        data = json.loads(stdout.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return {
            "available": False,
            "reason": "InvalidResponse",
            "message": "Ceph returned a response that is not valid JSON.",
            "durationMs": duration_ms,
        }
    return {
        "available": True,
        "reason": "Available",
        "message": "Read-only observation succeeded.",
        "durationMs": duration_ms,
        "data": data,
    }


def collect_snapshot() -> dict:
    started = time.monotonic()
    base_arguments, configuration_error = connection_arguments()
    if configuration_error:
        results = {
            command_id: {
                "available": False,
                "reason": "NotConfigured",
                "message": configuration_error,
                "durationMs": 0,
            }
            for command_id in COMMANDS
        }
    else:
        with ThreadPoolExecutor(max_workers=4, thread_name_prefix="ceph-observer") as executor:
            futures = {
                command_id: executor.submit(execute, command_id, base_arguments)
                for command_id in COMMANDS
            }
            results = {
                command_id: futures[command_id].result()
                for command_id in COMMANDS
            }
    return {
        "schemaVersion": 1,
        "observedAt": utc_now(),
        "durationMs": int((time.monotonic() - started) * 1000),
        "results": results,
    }


def snapshot(force: bool) -> dict:
    global _cache_value, _cache_monotonic
    with _cache_lock:
        age = time.monotonic() - _cache_monotonic
        if not force and _cache_value is not None and age < CACHE_SECONDS:
            return {**_cache_value, "cached": True, "cacheAgeSeconds": round(age, 3)}
    # Only one collection may execute, but cached readers are not blocked for
    # the full duration of eight Ceph CLI commands.
    with _collection_lock:
        with _cache_lock:
            age = time.monotonic() - _cache_monotonic
            if _cache_value is not None and (not force or age < 5):
                if age < CACHE_SECONDS or force:
                    return {**_cache_value, "cached": True, "cacheAgeSeconds": round(age, 3)}
        value = collect_snapshot()
        with _cache_lock:
            _cache_value = value
            _cache_monotonic = time.monotonic()
        return {**value, "cached": False, "cacheAgeSeconds": 0}


def configured_api_token() -> str | None:
    try:
        token = read_text(API_TOKEN_FILE, 256)
    except (FileNotFoundError, OSError, ValueError):
        return None
    return token if len(token) >= 32 else None


class Handler(BaseHTTPRequestHandler):
    server_version = "opensphere-ceph-observer/1"

    def log_message(self, fmt: str, *args) -> None:
        # Log only the HTTP request metadata. Ceph arguments and output are never logged.
        print(f"{self.address_string()} - {fmt % args}", flush=True)

    def write_json(self, status: int, body: dict) -> None:
        payload = json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("cache-control", "no-store")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler contract
        if not _request_slots.acquire(blocking=False):
            self.write_json(503, {"error": "observer request capacity exhausted"})
            return
        try:
            self._do_get()
        finally:
            _request_slots.release()

    def _do_get(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/healthz":
            self.write_json(200, {"ok": True})
            return
        if parsed.path == "/readyz":
            _, configuration_error = connection_arguments()
            ready = configuration_error is None and configured_api_token() is not None
            self.write_json(200 if ready else 503, {"ok": ready})
            return
        if parsed.path != "/snapshot":
            self.write_json(404, {"error": "not found"})
            return
        expected = configured_api_token()
        supplied = self.headers.get("x-opensphere-observer-token", "")
        if expected is None or not hmac.compare_digest(supplied, expected):
            self.write_json(401, {"error": "observer authentication required"})
            return
        force = parse_qs(parsed.query).get("refresh", ["0"])[0] == "1"
        self.write_json(200, snapshot(force))


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
