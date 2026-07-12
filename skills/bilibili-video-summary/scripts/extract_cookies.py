#!/usr/bin/env python3
"""Extract and decrypt B站 login cookies from Dia or Chrome browsers on macOS.

Output: Netscape-format cookie file at --output or /tmp/bilibili_cookies.txt.
Run through the skill's uv environment so pycryptodome is available.
"""
from __future__ import annotations

import argparse
import os
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

try:
    from Crypto.Cipher import AES
    from Crypto.Protocol.KDF import PBKDF2
    from Crypto.Util.Padding import unpad
except ImportError:
    print("Error: pycryptodome required. Run `uv sync` in the skill directory.", file=sys.stderr)
    sys.exit(1)

BROWSERS = {
    "dia": {
        "name": "Dia",
        "cookie_path": "~/Library/Application Support/Dia/User Data/Default/Cookies",
        "keychain_service": "Dia Safe Storage",
        "keychain_user": "Dia",
    },
    "chrome": {
        "name": "Chrome",
        "cookie_path": "~/Library/Application Support/Google/Chrome/Default/Cookies",
        "keychain_service": "Chrome Safe Storage",
        "keychain_user": "Chrome",
    },
}

SALT = b"saltysalt"
IV = b" " * 16
KEY_LENGTH = 16
PBKDF2_ITERATIONS = 1003


def get_key_from_keychain(service: str, user: str) -> bytes | None:
    """Get the encryption key from macOS Keychain."""
    try:
        result = subprocess.run(
            ["security", "find-generic-password", "-w", "-a", user, "-s", service],
            capture_output=True, text=True, timeout=10,
        )
        if result.returncode != 0:
            return None
        password = result.stdout.strip()
        return PBKDF2(password, SALT, KEY_LENGTH, PBKDF2_ITERATIONS)
    except Exception as e:
        print(f"Keychain error for {service}: {e}", file=sys.stderr)
        return None


def decrypt_cookies(db_path: str, key: bytes) -> dict[str, str]:
    """Decrypt Chromium-encrypted cookies from SQLite database."""
    if not os.path.exists(db_path):
        return {}

    # Work on a private, unique copy to avoid browser locks and predictable
    # /tmp paths containing the user's complete browser cookie database.
    fd, tmp_db = tempfile.mkstemp(prefix="lumio-bilibili-cookies-", suffix=".sqlite")
    os.close(fd)
    os.chmod(tmp_db, 0o600)
    try:
        with open(db_path, "rb") as src, open(tmp_db, "wb") as dst:
            while chunk := src.read(1024 * 1024):
                dst.write(chunk)

        conn = sqlite3.connect(tmp_db)
        try:
            rows = conn.execute("""
                SELECT host_key, name, hex(encrypted_value), has_cross_site_ancestor
                FROM cookies
                WHERE host_key LIKE '%bilibili%'
                  AND encrypted_value IS NOT NULL
                  AND length(encrypted_value) > 0
                ORDER BY name
            """).fetchall()
        finally:
            conn.close()
    finally:
        try:
            os.unlink(tmp_db)
        except FileNotFoundError:
            pass

    decrypted: dict[str, str] = {}
    seen = set()

    for _host, name, hex_blob, has_cs in rows:
        if name in seen:
            continue
        enc = bytes.fromhex(hex_blob)

        # Strip v10/v11 prefix
        if enc[:3] not in (b"v10", b"v11"):
            continue
        enc = enc[3:]

        try:
            cipher = AES.new(key, AES.MODE_CBC, IV)
            plain = cipher.decrypt(enc)
            plain = unpad(plain, AES.block_size)
        except ValueError:
            # Try without unpadding (some entries store differently)
            try:
                cipher = AES.new(key, AES.MODE_CBC, IV)
                plain = cipher.decrypt(enc)
                plain = plain.rstrip(b"\x00")
            except Exception:
                continue
        except Exception:
            continue

        # Strip 32-byte SHA256 prefix if present (has_cross_site_ancestor)
        if has_cs and len(plain) > 32:
            candidate = plain[32:]
            try:
                text = candidate.decode("utf-8")
                if text and all(32 <= ord(c) < 127 or ord(c) > 127 for c in text):
                    decrypted[name] = text
                    seen.add(name)
                    continue
            except UnicodeDecodeError:
                pass

        # Try without stripping
        try:
            text = plain.decode("utf-8")
            if text:
                decrypted[name] = text
                seen.add(name)
        except UnicodeDecodeError:
            continue

    return decrypted


def write_netscape(cookies: dict[str, str], output: str):
    """Write cookies in Netscape format with private permissions."""
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
    flags |= getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(output, flags, 0o600)
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write("# Netscape HTTP Cookie File\n")
        f.write("# Extracted by bilibili-video-summary skill\n\n")
        for name, value in cookies.items():
            f.write(f".bilibili.com\tTRUE\t/\tTRUE\t0\t{name}\t{value}\n")


def main():
    parser = argparse.ArgumentParser(
        description="Extract B站 login cookies from browser"
    )
    parser.add_argument(
        "-b", "--browser", choices=list(BROWSERS), default="dia",
        help="Browser to extract cookies from (default: dia)"
    )
    parser.add_argument(
        "-o", "--output", default=None,
        help="Output file path (default: /tmp/bilibili_cookies.txt)"
    )
    parser.add_argument(
        "--cookie-db", default=None,
        help="Custom cookie database path (overrides browser default)"
    )
    parser.add_argument(
        "--keychain-service", default=None,
        help="Custom keychain service name"
    )
    parser.add_argument(
        "--keychain-user", default=None,
        help="Custom keychain user name"
    )
    args = parser.parse_args()

    cfg = BROWSERS[args.browser]
    cookie_path = os.path.expanduser(args.cookie_db or cfg["cookie_path"])
    service = args.keychain_service or cfg["keychain_service"]
    user = args.keychain_user or cfg["keychain_user"]

    if not os.path.exists(cookie_path):
        print(f"Error: Cookie DB not found: {cookie_path}", file=sys.stderr)
        sys.exit(1)

    # Get decryption key
    key = get_key_from_keychain(service, user)
    if key is None:
        print(f"Error: Could not get decryption key from Keychain ({service})", file=sys.stderr)
        sys.exit(1)

    # Decrypt
    cookies = decrypt_cookies(cookie_path, key)
    if not cookies:
        print("Error: No B站 cookies found or decryption failed", file=sys.stderr)
        sys.exit(1)

    # Check for login session
    sessdata = cookies.get("SESSDATA", "")
    if not sessdata:
        print("Warning: No SESSDATA cookie found — may not be logged into B站", file=sys.stderr)

    # Output
    if args.output:
        write_netscape(cookies, args.output)
        print(f"Extracted {len(cookies)} cookies → {args.output}", file=sys.stderr)
    else:
        write_netscape(cookies, "/tmp/bilibili_cookies.txt")
        print(f"Extracted {len(cookies)} cookies → /tmp/bilibili_cookies.txt", file=sys.stderr)
        # Also print the path for piping
        print("/tmp/bilibili_cookies.txt")


if __name__ == "__main__":
    main()
