from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import patch


sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))
import nightly_atlas_queue as nightly  # noqa: E402


ITEM = {
    "id": 7,
    "bvid": "BV1xx411c7mD",
    "title": "A video",
    "upper": {"name": "Uploader"},
}


class FakeWorker:
    def __init__(self) -> None:
        self.started = 0
        self.checked = 0
        self.stopped = 0

    def start(self) -> None:
        self.started += 1

    def ensure_alive(self) -> None:
        self.checked += 1

    def stop(self) -> None:
        self.stopped += 1


class FakeAtlas:
    def __init__(self, summaries: list[list[dict]], runs: list[dict] | None = None) -> None:
        self.summary_responses = list(summaries)
        self.run_records = runs or []
        self.enqueued = 0
        self.projects = 0
        self.current_run = {"run_id": "run_new", "status": "pending"}

    def upsert_source(self, _item: dict) -> dict:
        return {"source_id": "src_1"}

    def summaries(self, _source_id: str) -> list[dict]:
        if len(self.summary_responses) > 1:
            return self.summary_responses.pop(0)
        return self.summary_responses[0]

    def runs(self) -> list[dict]:
        return self.run_records

    def run(self, _run_id: str) -> dict:
        return self.current_run

    def ensure_project(self) -> None:
        self.projects += 1

    def enqueue(self, _source: dict, _bvid: str) -> dict:
        self.enqueued += 1
        return {"run_id": "run_new", "status": "pending"}


class Clock:
    def __init__(self) -> None:
        self.value = 0.0

    def monotonic(self) -> float:
        return self.value

    def sleep(self, seconds: float) -> None:
        self.value += seconds


class NightlyQueueTests(unittest.TestCase):
    def test_empty_queue_does_not_start_pi(self) -> None:
        atlas = FakeAtlas([[]])
        worker = FakeWorker()
        result = nightly.process_queue(
            [], {}, atlas, lambda: worker, deadline_seconds=60
        )
        self.assertEqual(result.discovered, 0)
        self.assertEqual(worker.started, 0)

    def test_existing_summary_cleans_without_starting_pi(self) -> None:
        atlas = FakeAtlas([[{"resource_id": "res_1"}]])
        worker = FakeWorker()
        with patch.object(nightly.atlas_queue, "cleanup_video") as cleanup:
            result = nightly.process_queue(
                [ITEM], {}, atlas, lambda: worker, deadline_seconds=60
            )
        self.assertEqual((result.reused, result.cleaned, result.failed), (1, 1, 0))
        self.assertEqual(worker.started, 0)
        self.assertEqual(atlas.enqueued, 0)
        cleanup.assert_called_once_with({}, "Atlas", "BV1xx411c7mD")

    def test_new_run_publishes_then_cleans(self) -> None:
        summary = {"resource_id": "res_1", "produced_by_run_id": "run_new"}
        atlas = FakeAtlas([[], [], [summary]])
        worker = FakeWorker()
        clock = Clock()
        with patch.object(nightly.atlas_queue, "cleanup_video") as cleanup:
            result = nightly.process_queue(
                [ITEM],
                {},
                atlas,
                lambda: worker,
                deadline_seconds=60,
                poll_seconds=1,
                monotonic=clock.monotonic,
                sleep=clock.sleep,
            )
        self.assertEqual((result.published, result.cleaned, result.failed), (1, 1, 0))
        self.assertEqual((atlas.projects, atlas.enqueued), (1, 1))
        self.assertEqual((worker.started, worker.stopped), (1, 1))
        cleanup.assert_called_once()

    def test_failed_run_never_cleans(self) -> None:
        atlas = FakeAtlas([[], []])
        atlas.current_run = {
            "run_id": "run_new",
            "status": "failed",
            "error_message": "no subtitle",
        }
        worker = FakeWorker()
        with patch.object(nightly.atlas_queue, "cleanup_video") as cleanup:
            result = nightly.process_queue(
                [ITEM], {}, atlas, lambda: worker, deadline_seconds=60
            )
        self.assertEqual((result.failed, result.cleaned), (1, 0))
        self.assertIn("no subtitle", result.errors[0])
        cleanup.assert_not_called()

    def test_active_run_is_reused_instead_of_duplicated(self) -> None:
        active = {
            "run_id": "run_existing",
            "job_name": "bilibili-summary-v4",
            "input": {"source_id": "src_1"},
            "status": "claimed",
        }
        summary = {"resource_id": "res_1", "produced_by_run_id": "run_existing"}
        atlas = FakeAtlas([[], [], [summary]], [active])
        worker = FakeWorker()
        clock = Clock()
        with patch.object(nightly.atlas_queue, "cleanup_video"):
            result = nightly.process_queue(
                [ITEM],
                {},
                atlas,
                lambda: worker,
                deadline_seconds=60,
                poll_seconds=1,
                monotonic=clock.monotonic,
                sleep=clock.sleep,
            )
        self.assertEqual(result.published, 1)
        self.assertEqual(atlas.enqueued, 0)

    def test_terminal_run_without_resource_requires_manual_retry(self) -> None:
        failed = {
            "run_id": "run_old",
            "job_name": "bilibili-summary-v4",
            "input": {"source_id": "src_1"},
            "status": "failed",
        }
        atlas = FakeAtlas([[]], [failed])
        worker = FakeWorker()
        with patch.object(nightly.atlas_queue, "cleanup_video") as cleanup:
            result = nightly.process_queue(
                [ITEM], {}, atlas, lambda: worker, deadline_seconds=60
            )
        self.assertEqual(result.failed, 1)
        self.assertIn("manual retry required", result.errors[0])
        self.assertEqual(worker.started, 0)
        cleanup.assert_not_called()


if __name__ == "__main__":
    unittest.main()
