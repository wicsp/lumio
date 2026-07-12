#!/usr/bin/env python3
"""Manage B站 "稍后再看" (Watch Later) list.

Usage:
    python watch_later.py list [-c <cookie-file>] [--json]
    python watch_later.py delete <index> [-c <cookie-file>]
    python watch_later.py delete --bvid <BV号> [-c <cookie-file>]
    python watch_later.py delete --all [-c <cookie-file>] [--yes]
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

BILI_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    ),
    "Referer": "https://www.bilibili.com/",
}


def load_cookies(cookie_file: str) -> dict[str, str]:
    """Load Netscape-format cookie file, return dict of name→value."""
    cookies = {}
    with open(cookie_file) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split("\t")
            if len(parts) >= 7:
                cookies[parts[5]] = parts[6]
    return cookies


def api_request(
    url: str,
    cookie_file: str | None = None,
    method: str = "GET",
    data: dict | None = None,
) -> dict:
    """Make an API request to B站 with optional cookies and CSRF token."""
    cookies = {}
    if cookie_file and Path(cookie_file).exists():
        cookies = load_cookies(cookie_file)

    req = urllib.request.Request(url, headers=BILI_HEADERS.copy())

    if cookies:
        cookie_str = "; ".join(f"{k}={v}" for k, v in cookies.items())
        req.add_header("Cookie", cookie_str)

    body = None
    if method == "POST" and data:
        # Include CSRF token from bili_jct cookie
        csrf = cookies.get("bili_jct", "")
        data["csrf"] = csrf
        body = urllib.parse.urlencode(data).encode()
        req.add_header("Content-Type", "application/x-www-form-urlencoded")

    try:
        with urllib.request.urlopen(req, data=body, timeout=15) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code}: {e.reason}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Request failed: {e}", file=sys.stderr)
        sys.exit(1)


def list_watch_later(
    cookie_file: str,
    as_json: bool = False,
    display: bool = True,
) -> list[dict]:
    """Fetch and display watch later list."""
    resp = api_request("https://api.bilibili.com/x/v2/history/toview", cookie_file)
    if resp.get("code") != 0:
        print(f"API error: {resp.get('message')}", file=sys.stderr)
        sys.exit(1)

    items = resp["data"]["list"]
    count = resp["data"]["count"]

    if as_json and display:
        # Simplified output for programmatic use
        simplified = []
        for v in items:
            simplified.append({
                "index": len(simplified) + 1,
                "title": v["title"],
                "bvid": v["bvid"],
                "aid": v["aid"],
                "owner": v["owner"]["name"],
                "duration": v["duration"],
                "view": v["stat"]["view"],
                "pubdate": v["pubdate"],
            })
        print(json.dumps(simplified, ensure_ascii=False, indent=2))
    elif display:
        print(f"共 {count} 个视频\n")
        for i, v in enumerate(items):
            dur_m, dur_s = divmod(v["duration"], 60)
            dur_str = f"{dur_m}:{dur_s:02d}"
            print(f"{i+1:3d}. [{dur_str}] {v['title']}")
            print(f"     {v['bvid']}  UP: {v['owner']['name']}  👁 {v['stat']['view']:,}")
            print()

    return items


def find_by_index(index: int, total: int) -> int:
    """Validate and return 0-based index from 1-based user input."""
    if index < 1 or index > total:
        print(f"Error: index {index} out of range (1-{total})", file=sys.stderr)
        sys.exit(1)
    return index - 1


def find_by_bvid(bvid: str, items: list[dict]) -> int | None:
    """Find item index by a canonical BV-prefixed identifier."""
    if not re.fullmatch(r"BV[a-zA-Z0-9]{10}", bvid):
        print("Error: BV号必须包含 BV 前缀，例如 BV1sE7h6VESd", file=sys.stderr)
        sys.exit(1)
    for i, v in enumerate(items):
        if v["bvid"] == bvid:
            return i
    return None


def delete_videos(aids: list[int], cookie_file: str) -> int:
    """Delete one or more videos from watch later. Returns number deleted."""
    data = {"ids": ",".join(str(a) for a in aids)}
    resp = api_request(
        "https://api.bilibili.com/x/v2/history/toview/del",
        cookie_file,
        method="POST",
        data=data,
    )
    if resp.get("code") != 0:
        print(f"Delete failed: {resp.get('message')}", file=sys.stderr)
        return 0
    return len(aids)


def cmd_list(args):
    list_watch_later(args.cookie_file, as_json=args.json)


def cmd_delete(args):
    items = list_watch_later(args.cookie_file, display=False)  # Fetch quietly, then validate

    if args.all:
        if not items:
            print("稍后再看已经是空的", file=sys.stderr)
            return
        if not args.yes:
            print(f"⚠ 即将删除全部 {len(items)} 个视频", file=sys.stderr)
            confirm = input("确认删除？输入 yes 继续: ")
            if confirm.strip().lower() != "yes":
                print("已取消", file=sys.stderr)
                return
        aids = [v["aid"] for v in items]
        n = delete_videos(aids, args.cookie_file)
        print(f"已删除全部 {n} 个视频", file=sys.stderr)

    elif args.bvid:
        idx = find_by_bvid(args.bvid, items)
        if idx is None:
            print(f"Error: {args.bvid} 不在稍后再看中", file=sys.stderr)
            sys.exit(1)
        aid = items[idx]["aid"]
        title = items[idx]["title"]
        n = delete_videos([aid], args.cookie_file)
        if n:
            print(f"已删除: {title}", file=sys.stderr)

    elif args.index is not None:
        idx = find_by_index(args.index, len(items))
        aid = items[idx]["aid"]
        title = items[idx]["title"]
        n = delete_videos([aid], args.cookie_file)
        if n:
            print(f"已删除: {title}", file=sys.stderr)

    else:
        print("Error: 需要指定 index、--bvid 或 --all", file=sys.stderr)
        sys.exit(1)


def main():
    parser = argparse.ArgumentParser(
        description="Manage B站 '稍后再看' (Watch Later) list"
    )
    parser.add_argument(
        "-c", "--cookie-file", default="/tmp/bilibili_cookies.txt",
        help="Netscape-format cookie file (default: /tmp/bilibili_cookies.txt)"
    )

    sub = parser.add_subparsers(dest="command", required=True)

    # list
    p_list = sub.add_parser("list", help="列出稍后再看")
    p_list.add_argument("-c", "--cookie-file", default="/tmp/bilibili_cookies.txt",
                         help="Netscape-format cookie file")
    p_list.add_argument("--json", action="store_true", help="JSON format output")

    # delete
    p_del = sub.add_parser("delete", help="删除稍后再看视频")
    p_del.add_argument("-c", "--cookie-file", default="/tmp/bilibili_cookies.txt",
                        help="Netscape-format cookie file")
    p_del.add_argument("index", nargs="?", type=int, help="序号 (1-based)")
    p_del.add_argument("--bvid", help="按 BV 号删除")
    p_del.add_argument("--all", action="store_true", help="删除全部")
    p_del.add_argument("--yes", action="store_true", help="跳过确认")

    args = parser.parse_args()

    # Resolve cookie file (could come from parent or subparser)
    cookie_file = getattr(args, 'cookie_file', '/tmp/bilibili_cookies.txt')

    # Check cookies
    if not Path(cookie_file).exists():
        print(f"Error: Cookie file not found: {cookie_file}", file=sys.stderr)
        print("Run extract_cookies.py first.", file=sys.stderr)
        sys.exit(1)

    # Patch cookie_file onto args for uniform access
    args.cookie_file = cookie_file
    if args.command == "list":
        cmd_list(args)
    elif args.command == "delete":
        cmd_delete(args)


if __name__ == "__main__":
    main()
