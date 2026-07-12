#!/usr/bin/env python3
"""Fetch B站 video AI subtitle and output plain text transcript.

Usage:
    python fetch_subtitle.py <url> [--cookie-file <path>] [--lang ai-zh]

Requires: A Netscape-format cookie file with valid B站 SESSDATA.
If no cookie file provided, uses /tmp/bilibili_cookies.txt.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

# WBI mixin key table (fixed array from B站 frontend)
MIXIN_KEY = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
    27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
    37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
    22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 52, 44, 34,
]

BILI_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    ),
    "Referer": "https://www.bilibili.com/",
}


def parse_bv(url: str) -> str:
    """Extract BV号 from B站 URL."""
    m = re.search(r"BV[a-zA-Z0-9]{10}", url)
    if m:
        return m.group(0)
    # Maybe it's already a BV号
    if re.match(r"^BV[a-zA-Z0-9]{10}$", url):
        return url
    raise ValueError(f"Cannot extract BV号 from: {url}")


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
                # domain, flag, path, secure, expires, name, value
                cookies[parts[5]] = parts[6]
    return cookies


def wbi_sign(params: dict, img_key: str, sub_key: str) -> tuple[str, int]:
    """Compute WBI signature (w_rid + wts)."""
    raw = img_key + sub_key
    mixin = "".join(raw[i] for i in MIXIN_KEY[:32])
    params["wts"] = int(time.time())
    query = urllib.parse.urlencode(sorted(params.items()))
    w_rid = hashlib.md5((query + mixin).encode()).hexdigest()
    return w_rid, params["wts"]


def api_get(url: str, cookie_file: str | None = None) -> dict:
    """Make a GET request to B站 API with optional cookies."""
    req = urllib.request.Request(url, headers=BILI_HEADERS)

    if cookie_file and Path(cookie_file).exists():
        cookies = load_cookies(cookie_file)
        cookie_str = "; ".join(f"{k}={v}" for k, v in cookies.items())
        req.add_header("Cookie", cookie_str)

    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code}: {e.reason}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Request failed: {e}", file=sys.stderr)
        sys.exit(1)


def get_wbi_keys(cookie_file: str | None) -> tuple[str, str, bool]:
    """Get WBI img_key, sub_key and login status."""
    nav = api_get("https://api.bilibili.com/x/web-interface/nav", cookie_file)
    data = nav.get("data", {})
    wbi = data.get("wbi_img", {})
    img_key = wbi.get("img_url", "").split("/")[-1].replace(".png", "")
    sub_key = wbi.get("sub_url", "").split("/")[-1].replace(".png", "")
    is_login = data.get("isLogin", False)
    return img_key, sub_key, is_login


def fetch_video_info(bvid: str, cookie_file: str | None) -> dict[str, str]:
    """Fetch video title and description from view API."""
    view_data = api_get(
        f"https://api.bilibili.com/x/web-interface/view?bvid={bvid}",
        cookie_file,
    )
    data = view_data.get("data", {})
    return {
        "title": data.get("title", ""),
        "desc": data.get("desc", ""),
    }


def fetch_subtitle(bvid: str, cid: str, cookie_file: str | None, lang: str = "ai-zh") -> str | None:
    """Fetch subtitle JSON and extract text content."""
    # Get wbi keys and sign
    img_key, sub_key, _ = get_wbi_keys(cookie_file)
    w_rid, wts = wbi_sign({"bvid": bvid, "cid": cid}, img_key, sub_key)

    # Call player API
    player_url = (
        f"https://api.bilibili.com/x/player/wbi/v2?"
        f"bvid={bvid}&cid={cid}&w_rid={w_rid}&wts={wts}"
    )
    player_data = api_get(player_url, cookie_file)

    subs = player_data.get("data", {}).get("subtitle", {}).get("subtitles", [])
    if not subs:
        return None

    # Find matching language
    sub_url = None
    for s in subs:
        if s.get("lan") == lang:
            sub_url = s["subtitle_url"]
            break
    if not sub_url:
        # Fallback: first available
        sub_url = subs[0]["subtitle_url"]

    # Download subtitle JSON
    if sub_url.startswith("//"):
        sub_url = "https:" + sub_url
    sub_data = api_get(sub_url)
    body = sub_data.get("body", [])

    # Build transcript
    lines = []
    for item in body:
        start = item.get("from", 0)
        content = item.get("content", "")
        lines.append(f"[{start:.1f}s] {content}")

    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(
        description="Extract B站 video AI subtitle as text transcript"
    )
    parser.add_argument("url", help="B站 video URL or BV号")
    parser.add_argument(
        "-c", "--cookie-file", default="/tmp/bilibili_cookies.txt",
        help="Netscape-format cookie file (default: /tmp/bilibili_cookies.txt)"
    )
    parser.add_argument(
        "-l", "--lang", default="ai-zh",
        help="Subtitle language code (default: ai-zh for Chinese AI subs)"
    )
    parser.add_argument(
        "-o", "--output", default=None,
        help="Output file path (default: stdout)"
    )
    parser.add_argument(
        "--list-subs", action="store_true",
        help="List available subtitles instead of downloading"
    )
    parser.add_argument(
        "--no-timestamps", action="store_true",
        help="Remove timestamps from transcript"
    )
    parser.add_argument(
        "--no-desc", action="store_true",
        help="Skip fetching video description"
    )
    args = parser.parse_args()

    # Parse BV
    bvid = parse_bv(args.url)
    print(f"BV: {bvid}", file=sys.stderr)

    # Check cookies
    if not Path(args.cookie_file).exists():
        print(f"Error: Cookie file not found: {args.cookie_file}", file=sys.stderr)
        print("Run extract_cookies.py first to get B站 login cookies.", file=sys.stderr)
        sys.exit(1)

    # Get pagelist for cid(s)
    pagelist_data = api_get(
        f"https://api.bilibili.com/x/player/pagelist?bvid={bvid}",
        args.cookie_file,
    )
    pages = pagelist_data.get("data", [])
    if not pages:
        print("Error: No video parts found", file=sys.stderr)
        sys.exit(1)

    print(f"Found {len(pages)} part(s)", file=sys.stderr)

    # Fetch video description
    video_header = ""
    if not args.no_desc:
        info = fetch_video_info(bvid, args.cookie_file)
        if info["title"]:
            video_header += f"# {info['title']}\n"
        if info["desc"]:
            video_header += f"\n## 视频简介\n\n{info['desc']}\n"
        if video_header:
            video_header += "\n---\n\n"

    all_transcripts = []

    for i, page in enumerate(pages):
        cid = str(page["cid"])
        part_name = page.get("part", f"Part {i+1}")
        print(f"Part {i+1}: {part_name} (cid={cid})", file=sys.stderr)

        # Check available subtitles
        img_key, sub_key, _ = get_wbi_keys(args.cookie_file)
        w_rid, wts = wbi_sign({"bvid": bvid, "cid": cid}, img_key, sub_key)
        player_url = (
            f"https://api.bilibili.com/x/player/wbi/v2?"
            f"bvid={bvid}&cid={cid}&w_rid={w_rid}&wts={wts}"
        )
        player_data = api_get(player_url, args.cookie_file)
        subs = player_data.get("data", {}).get("subtitle", {}).get("subtitles", [])

        if args.list_subs:
            print(f"  Available subtitles:", file=sys.stderr)
            for s in subs:
                print(f"    {s.get('lan_doc')} ({s.get('lan')})", file=sys.stderr)
            continue

        if not subs:
            print(f"  ⚠ No subtitles available for this part", file=sys.stderr)
            continue

        transcript = fetch_subtitle(bvid, cid, args.cookie_file, args.lang)
        if transcript:
            if args.no_timestamps:
                transcript = "\n".join(
                    line.split("] ", 1)[1] if "] " in line else line
                    for line in transcript.split("\n")
                )
            if len(pages) > 1:
                all_transcripts.append(f"=== {part_name} ===\n{transcript}")
            else:
                all_transcripts.append(transcript)

    if args.list_subs:
        return

    result = video_header + "\n\n".join(all_transcripts)
    if args.output:
        with open(args.output, "w") as f:
            f.write(result)
        print(f"\nTranscript saved → {args.output} ({len(result)} chars)", file=sys.stderr)
    else:
        print(result)


if __name__ == "__main__":
    main()
