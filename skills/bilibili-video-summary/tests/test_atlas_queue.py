from __future__ import annotations

import io
import json
import sys
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch


sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))
import atlas_queue  # noqa: E402


class AtlasQueueTests(unittest.TestCase):
    def test_resolve_folder_requires_exact_unique_name(self) -> None:
        response = {"data": {"list": [{"id": 1, "title": "Atlas"}, {"id": 2, "title": "Other"}]}}
        with patch.object(atlas_queue, "account_mid", return_value=42), patch.object(
            atlas_queue, "api_request", return_value=response
        ):
            self.assertEqual(atlas_queue.resolve_folder({}, "Atlas")["id"], 1)
            with self.assertRaises(atlas_queue.BilibiliApiError):
                atlas_queue.resolve_folder({}, "Missing")

    def test_list_folder_items_follows_pagination(self) -> None:
        pages = [
            {"data": {"medias": [{"bvid": "BV1"}], "has_more": True}},
            {"data": {"medias": [{"bvid": "BV2"}], "has_more": False}},
        ]
        with patch.object(atlas_queue, "api_request", side_effect=pages) as request:
            items = atlas_queue.list_folder_items({}, 123)
        self.assertEqual([item["bvid"] for item in items], ["BV1", "BV2"])
        self.assertIn("pn=2", request.call_args_list[1].args[0])

    def test_cleanup_removes_from_both_lists(self) -> None:
        favorite = {"id": 7, "bvid": "BV1xx411c7mD", "title": "video"}
        later = {"aid": 7, "bvid": "BV1xx411c7mD", "title": "video"}
        output = io.StringIO()
        with patch.object(atlas_queue, "resolve_folder", return_value={"id": 99}), patch.object(
            atlas_queue, "list_folder_items", return_value=[favorite]
        ), patch.object(atlas_queue, "list_watch_later", return_value=[later]), patch.object(
            atlas_queue, "remove_from_folder"
        ) as remove_favorite, patch.object(
            atlas_queue, "remove_from_watch_later"
        ) as remove_later, redirect_stdout(output):
            atlas_queue.cmd_cleanup({}, "Atlas", "BV1xx411c7mD")
        remove_favorite.assert_called_once_with({}, 99, 7)
        remove_later.assert_called_once_with({}, 7)
        self.assertEqual(
            json.loads(output.getvalue()),
            {"bvid": "BV1xx411c7mD", "favorite": "removed", "watch_later": "removed"},
        )

    def test_cleanup_is_idempotent_when_video_is_absent(self) -> None:
        output = io.StringIO()
        with patch.object(atlas_queue, "resolve_folder", return_value={"id": 99}), patch.object(
            atlas_queue, "list_folder_items", return_value=[]
        ), patch.object(atlas_queue, "list_watch_later", return_value=[]), redirect_stdout(output):
            atlas_queue.cmd_cleanup({}, "Atlas", "BV1xx411c7mD")
        self.assertEqual(
            json.loads(output.getvalue()),
            {"bvid": "BV1xx411c7mD", "favorite": "absent", "watch_later": "absent"},
        )

    def test_cleanup_rejects_noncanonical_identifier(self) -> None:
        with self.assertRaises(atlas_queue.BilibiliApiError):
            atlas_queue.cmd_cleanup({}, "Atlas", "not-a-bvid")


if __name__ == "__main__":
    unittest.main()
