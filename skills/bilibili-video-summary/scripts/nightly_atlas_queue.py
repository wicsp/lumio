#!/usr/bin/env python3
"""Run the publication-gated nightly Bilibili Atlas queue."""
from __future__ import annotations

import fcntl
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Callable, Protocol

import atlas_queue


SCRIPT_DIR = Path(__file__).resolve().parent
LUMIO_ROOT = SCRIPT_DIR.parents[2]
TERMINAL_STATUSES = {"completed", "failed", "cancelled"}
ACTIVE_STATUSES = {"pending", "claimed"}


class ControllerError(RuntimeError):
    pass


class Worker(Protocol):
    def start(self) -> None: ...
    def ensure_alive(self) -> None: ...
    def stop(self) -> None: ...


class AtlasControlClient:
    def __init__(self, base_url: str, token: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.token = token

    def request(
        self, method: str, path: str, payload: dict[str, Any] | None = None
    ) -> Any:
        body = json.dumps(payload).encode() if payload is not None else None
        request = urllib.request.Request(
            f"{self.base_url}{path}",
            data=body,
            method=method,
            headers={
                "Authorization": f"Bearer {self.token}",
                "Content-Type": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                return json.loads(response.read())
        except Exception as error:
            raise ControllerError(f"Atlas {method} {path} failed: {error}") from error

    def upsert_source(self, item: dict[str, Any]) -> dict[str, Any]:
        bvid = item["bvid"]
        url = f"https://www.bilibili.com/video/{bvid}"
        return self.request(
            "POST",
            "/api/sources",
            {
                "source_key": f"bilibili:{bvid}",
                "kind": "video",
                "canonical_uri": url,
                "title": item.get("title"),
                "external_ids": {"bvid": bvid},
                "metadata": {
                    "captured_via": "lumio-nightly-atlas-queue",
                    "bilibili_owner": (item.get("upper") or {}).get("name"),
                },
            },
        )

    def summaries(self, source_id: str) -> list[dict[str, Any]]:
        query = urllib.parse.urlencode(
            {"source_id": source_id, "kind": "summary", "limit": 100}
        )
        return self.request("GET", f"/api/resources?{query}")

    def runs(self) -> list[dict[str, Any]]:
        query = urllib.parse.urlencode(
            {"project_id": "bilibili-capture", "limit": 500}
        )
        return self.request("GET", f"/api/runs?{query}")

    def run(self, run_id: str) -> dict[str, Any]:
        return self.request("GET", f"/api/runs/{urllib.parse.quote(run_id)}")

    def ensure_project(self) -> None:
        self.request(
            "POST",
            "/api/projects",
            {
                "project_id": "bilibili-capture",
                "name": "Bilibili Video Capture",
                "description": "Bilibili Sources captured for Resource generation.",
            },
        )

    def enqueue(self, source: dict[str, Any], bvid: str) -> dict[str, Any]:
        url = f"https://www.bilibili.com/video/{bvid}"
        return self.request(
            "POST",
            "/api/runs/enqueue",
            {
                "project_id": "bilibili-capture",
                "job_name": "bilibili-summary-v4",
                "capabilities_required": ["bilibili-summary-v4"],
                "input": {
                    "url": url,
                    "canonical_url": url,
                    "source_id": source["source_id"],
                },
                "priority": 5,
                "max_attempts": 1,
                "metadata": {"origin": "bilibili-atlas-favorites-nightly"},
            },
        )


class HeadlessPiWorker:
    def __init__(self, pi_bin: str, startup_seconds: float = 3.0) -> None:
        self.pi_bin = pi_bin
        self.startup_seconds = startup_seconds
        self.process: subprocess.Popen[bytes] | None = None

    def start(self) -> None:
        if self.process is not None:
            return
        environment = os.environ.copy()
        environment["LUMIO_AGENT_MODE"] = "background"
        command = [
            self.pi_bin,
            "--mode",
            "rpc",
            "--no-session",
            "--approve",
            "--no-extensions",
            "-e",
            str(LUMIO_ROOT / "extensions" / "atlas" / "index.ts"),
            "--no-builtin-tools",
            "--no-skills",
            "--no-prompt-templates",
            "--no-themes",
            "--no-context-files",
        ]
        self.process = subprocess.Popen(
            command,
            cwd=LUMIO_ROOT,
            env=environment,
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        time.sleep(self.startup_seconds)
        self.ensure_alive()

    def ensure_alive(self) -> None:
        if self.process is None or self.process.poll() is not None:
            raise ControllerError("headless Pi worker exited unexpectedly")

    def stop(self) -> None:
        process = self.process
        self.process = None
        if process is None or process.poll() is not None:
            return
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


@dataclass
class QueueResult:
    discovered: int = 0
    published: int = 0
    reused: int = 0
    cleaned: int = 0
    failed: int = 0
    deferred: int = 0
    errors: list[str] = field(default_factory=list)

    def error(self, bvid: str, message: str) -> None:
        self.failed += 1
        if len(self.errors) < 10:
            self.errors.append(f"{bvid}: {message}")


def _matching_runs(runs: list[dict[str, Any]], source_id: str) -> list[dict[str, Any]]:
    return [
        run
        for run in runs
        if run.get("job_name") == "bilibili-summary-v4"
        and (run.get("input") or {}).get("source_id") == source_id
    ]


def process_queue(
    items: list[dict[str, Any]],
    cookies: dict[str, str],
    atlas: AtlasControlClient,
    worker_factory: Callable[[], Worker],
    *,
    deadline_seconds: float,
    poll_seconds: float = 10.0,
    monotonic: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
) -> QueueResult:
    result = QueueResult(discovered=len(items))
    deadline = monotonic() + deadline_seconds
    worker: Worker | None = None
    try:
        for item in items:
            bvid = str(item.get("bvid") or "")
            if monotonic() >= deadline:
                result.deferred += 1
                continue
            try:
                source = atlas.upsert_source(item)
                source_id = source["source_id"]
                if atlas.summaries(source_id):
                    result.reused += 1
                    atlas_queue.cleanup_video(cookies, "Atlas", bvid)
                    result.cleaned += 1
                    continue

                matches = _matching_runs(atlas.runs(), source_id)
                active = next(
                    (run for run in matches if run.get("status") in ACTIVE_STATUSES),
                    None,
                )
                if active is not None:
                    run = active
                elif matches:
                    status = matches[0].get("status")
                    raise ControllerError(
                        f"existing {status} Run has no summary Resource; manual retry required"
                    )
                else:
                    if worker is None:
                        worker = worker_factory()
                        worker.start()
                    atlas.ensure_project()
                    run = atlas.enqueue(source, bvid)

                if worker is None:
                    worker = worker_factory()
                    worker.start()
                run_id = run["run_id"]
                while monotonic() < deadline:
                    worker.ensure_alive()
                    summaries = atlas.summaries(source_id)
                    accepted = next(
                        (
                            summary
                            for summary in summaries
                            if summary.get("produced_by_run_id") == run_id
                        ),
                        None,
                    )
                    if accepted is not None:
                        result.published += 1
                        atlas_queue.cleanup_video(cookies, "Atlas", bvid)
                        result.cleaned += 1
                        break
                    current = atlas.run(run_id)
                    status = current.get("status")
                    if status in {"failed", "cancelled"}:
                        raise ControllerError(
                            f"Run {run_id} ended {status}: {current.get('error_message') or 'no detail'}"
                        )
                    if status == "completed":
                        raise ControllerError(
                            f"Run {run_id} completed without a matching summary Resource"
                        )
                    sleep(min(poll_seconds, max(0.0, deadline - monotonic())))
                else:
                    result.deferred += 1
            except Exception as error:
                result.error(bvid or "unknown", str(error))
    finally:
        if worker is not None:
            worker.stop()
    return result


def _extract_cookies(browser: str, output: Path) -> None:
    completed = subprocess.run(
        [
            sys.executable,
            str(SCRIPT_DIR / "extract_cookies.py"),
            "-b",
            browser,
            "-o",
            str(output),
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=60,
        check=False,
    )
    if completed.returncode != 0 or not output.exists():
        raise ControllerError("Bilibili browser-cookie extraction failed")


def _configuration() -> tuple[AtlasControlClient, str, float, str]:
    url = os.environ.get("ATLAS_URL", "").strip()
    token_file = Path(os.environ.get("ATLAS_AGENT_TOKEN_FILE", "")).expanduser()
    if not url or not token_file.is_file():
        raise ControllerError("ATLAS_URL or ATLAS_AGENT_TOKEN_FILE is not configured")
    token = token_file.read_text(encoding="utf-8").strip()
    if not token:
        raise ControllerError("Atlas control credential is empty")
    pi_bin = os.environ.get("LUMIO_PI_BIN") or shutil.which("pi")
    if not pi_bin:
        raise ControllerError("pi executable was not found")
    deadline = float(os.environ.get("LUMIO_BILIBILI_NIGHTLY_SECONDS", "21600"))
    browser = os.environ.get("LUMIO_BILIBILI_BROWSER", "dia")
    return AtlasControlClient(url, token), pi_bin, deadline, browser


def main() -> None:
    state_dir = Path.home() / ".local" / "state" / "lumio"
    state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock_file = (state_dir / "bilibili-atlas-queue.lock").open("w")
    try:
        fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print(json.dumps({"status": "already_running"}))
        return

    atlas, pi_bin, deadline, browser = _configuration()
    descriptor, cookie_name = tempfile.mkstemp(prefix="lumio-bilibili-nightly-", suffix=".cookies")
    os.close(descriptor)
    cookie_path = Path(cookie_name)
    cookie_path.unlink(missing_ok=True)
    try:
        _extract_cookies(browser, cookie_path)
        cookies = atlas_queue.load_cookies(str(cookie_path))
        folder = atlas_queue.resolve_folder(cookies, "Atlas")
        items = atlas_queue.list_folder_items(cookies, int(folder["id"]))
        result = process_queue(
            items,
            cookies,
            atlas,
            lambda: HeadlessPiWorker(pi_bin),
            deadline_seconds=deadline,
        )
        print(json.dumps(asdict(result), ensure_ascii=False))
        if result.failed:
            raise SystemExit(1)
    finally:
        cookie_path.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
