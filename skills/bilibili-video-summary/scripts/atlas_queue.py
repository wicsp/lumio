#!/usr/bin/env python3
"""Use one Bilibili favorites folder as the Atlas ingestion queue.

The queue is deliberately narrow: it can list one exact folder and clean up one
video at a time.  It never offers a bulk-delete operation.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


BILI_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    ),
    "Referer": "https://www.bilibili.com/",
}


class BilibiliApiError(RuntimeError):
    """A transport or Bilibili application-level failure."""


def load_cookies(cookie_file: str) -> dict[str, str]:
    cookies: dict[str, str] = {}
    with open(cookie_file, encoding="utf-8") as file:
        for raw_line in file:
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split("\t")
            if len(parts) >= 7:
                cookies[parts[5]] = parts[6]
    return cookies


def api_request(
    url: str,
    cookies: dict[str, str],
    *,
    data: dict[str, str | int] | None = None,
) -> dict[str, Any]:
    headers = BILI_HEADERS.copy()
    headers["Cookie"] = "; ".join(f"{key}={value}" for key, value in cookies.items())
    body = None
    if data is not None:
        payload = dict(data)
        payload["csrf"] = cookies.get("bili_jct", "")
        body = urllib.parse.urlencode(payload).encode()
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    request = urllib.request.Request(url, headers=headers, data=body)
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            result = json.loads(response.read())
    except Exception as error:
        raise BilibiliApiError(f"request failed: {error}") from error
    if result.get("code") != 0:
        raise BilibiliApiError(
            f"Bilibili API error {result.get('code')}: {result.get('message')}"
        )
    return result


def account_mid(cookies: dict[str, str]) -> int:
    result = api_request("https://api.bilibili.com/x/web-interface/nav", cookies)
    mid = result.get("data", {}).get("mid")
    if not isinstance(mid, int) or mid <= 0:
        raise BilibiliApiError("the browser cookie is not logged in to Bilibili")
    return mid


def resolve_folder(cookies: dict[str, str], folder_name: str) -> dict[str, Any]:
    query = urllib.parse.urlencode({"up_mid": account_mid(cookies)})
    result = api_request(
        f"https://api.bilibili.com/x/v3/fav/folder/created/list-all?{query}",
        cookies,
    )
    matches = [folder for folder in result.get("data", {}).get("list", []) if folder.get("title") == folder_name]
    if not matches:
        raise BilibiliApiError(f"favorites folder not found: {folder_name}")
    if len(matches) > 1:
        raise BilibiliApiError(f"favorites folder name is ambiguous: {folder_name}")
    return matches[0]


def list_folder_items(cookies: dict[str, str], media_id: int) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    page = 1
    while True:
        query = urllib.parse.urlencode(
            {
                "media_id": media_id,
                "pn": page,
                "ps": 20,
                "keyword": "",
                "order": "mtime",
                "type": 0,
                "tid": 0,
                "platform": "web",
            }
        )
        result = api_request(
            f"https://api.bilibili.com/x/v3/fav/resource/list?{query}", cookies
        )
        data = result.get("data") or {}
        page_items = data.get("medias") or []
        items.extend(page_items)
        if not data.get("has_more"):
            break
        page += 1
    return items


def list_watch_later(cookies: dict[str, str]) -> list[dict[str, Any]]:
    result = api_request("https://api.bilibili.com/x/v2/history/toview", cookies)
    return result.get("data", {}).get("list", [])


def remove_from_folder(cookies: dict[str, str], media_id: int, aid: int) -> None:
    api_request(
        "https://api.bilibili.com/x/v3/fav/resource/deal",
        cookies,
        data={
            "rid": aid,
            "type": 2,
            "add_media_ids": "",
            "del_media_ids": media_id,
            "platform": "web",
        },
    )


def remove_from_watch_later(cookies: dict[str, str], aid: int) -> None:
    api_request(
        "https://api.bilibili.com/x/v2/history/toview/del",
        cookies,
        data={"ids": str(aid)},
    )


def simplified(item: dict[str, Any]) -> dict[str, Any]:
    upper = item.get("upper") or item.get("owner") or {}
    return {
        "title": item.get("title"),
        "bvid": item.get("bvid"),
        "aid": item.get("id", item.get("aid")),
        "owner": upper.get("name"),
        "duration": item.get("duration"),
    }


def cmd_list(cookies: dict[str, str], folder_name: str, as_json: bool) -> None:
    folder = resolve_folder(cookies, folder_name)
    items = list_folder_items(cookies, int(folder["id"]))
    output = [simplified(item) for item in items]
    if as_json:
        print(json.dumps(output, ensure_ascii=False, indent=2))
        return
    print(f"{folder_name}: {len(output)} 个视频\n")
    for index, item in enumerate(output, 1):
        minutes, seconds = divmod(int(item["duration"] or 0), 60)
        print(f"{index:3d}. [{minutes}:{seconds:02d}] {item['title']}")
        print(f"     {item['bvid']}  UP: {item['owner']}")


def cleanup_video(
    cookies: dict[str, str], folder_name: str, bvid: str
) -> dict[str, str]:
    if not re.fullmatch(r"BV[a-zA-Z0-9]{10}", bvid):
        raise BilibiliApiError("invalid BV identifier")
    folder = resolve_folder(cookies, folder_name)
    media_id = int(folder["id"])
    favorite = next(
        (item for item in list_folder_items(cookies, media_id) if item.get("bvid") == bvid),
        None,
    )
    later = next(
        (item for item in list_watch_later(cookies) if item.get("bvid") == bvid),
        None,
    )
    aid_value = (favorite or {}).get("id") or (later or {}).get("aid")
    if aid_value is None:
        return {"bvid": bvid, "favorite": "absent", "watch_later": "absent"}
    aid = int(aid_value)
    favorite_status = "absent"
    watch_later_status = "absent"
    if favorite is not None:
        remove_from_folder(cookies, media_id, aid)
        favorite_status = "removed"
    if later is not None:
        remove_from_watch_later(cookies, aid)
        watch_later_status = "removed"
    return {
        "bvid": bvid,
        "favorite": favorite_status,
        "watch_later": watch_later_status,
    }


def cmd_cleanup(cookies: dict[str, str], folder_name: str, bvid: str) -> None:
    print(json.dumps(cleanup_video(cookies, folder_name, bvid)))


def main() -> None:
    parser = argparse.ArgumentParser(description="Manage the Bilibili Atlas queue")
    parser.add_argument("-c", "--cookie-file", default="/tmp/bilibili_cookies.txt")
    parser.add_argument("--folder", default="Atlas", help="exact favorites folder name")
    subparsers = parser.add_subparsers(dest="command", required=True)
    list_parser = subparsers.add_parser("list", help="list queued videos")
    list_parser.add_argument(
        "-c", "--cookie-file", default=argparse.SUPPRESS, help=argparse.SUPPRESS
    )
    list_parser.add_argument(
        "--folder", default=argparse.SUPPRESS, help=argparse.SUPPRESS
    )
    list_parser.add_argument("--json", action="store_true")
    cleanup_parser = subparsers.add_parser(
        "cleanup", help="remove one successfully published video from both queues"
    )
    cleanup_parser.add_argument(
        "-c", "--cookie-file", default=argparse.SUPPRESS, help=argparse.SUPPRESS
    )
    cleanup_parser.add_argument(
        "--folder", default=argparse.SUPPRESS, help=argparse.SUPPRESS
    )
    cleanup_parser.add_argument("--bvid", required=True)
    args = parser.parse_args()

    cookie_path = Path(args.cookie_file)
    if not cookie_path.exists():
        parser.error(f"cookie file not found: {cookie_path}")
    try:
        cookies = load_cookies(str(cookie_path))
        if args.command == "list":
            cmd_list(cookies, args.folder, args.json)
        else:
            cmd_cleanup(cookies, args.folder, args.bvid)
    except BilibiliApiError as error:
        print(f"Error: {error}", file=sys.stderr)
        raise SystemExit(1) from error


if __name__ == "__main__":
    main()
