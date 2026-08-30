#!/usr/bin/env python3
"""Open a URL in a new window of the running browser-use Chromium via CDP.

Does not spawn a second Chrome. Pins the new window to the current XFCE
workspace so a dock click (or + desktop) lands on the screen you are on.
"""
from __future__ import annotations

import json
import os
import socket
import struct
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import urlopen

CDP_FILE = Path(os.environ.get("BROWSER_USE_CDP_FILE", "/tmp/browser-use.cdp"))
PORT_FILE = Path(os.environ.get("BROWSER_USE_CDP_PORT_FILE", "/tmp/browser-use.cdp.port"))


def cdp_http_base() -> str:
    candidates: list[str] = []
    if CDP_FILE.is_file():
        raw = CDP_FILE.read_text().strip()
        if raw:
            if raw.startswith(("ws://", "wss://", "http://", "https://")):
                u = urlparse(raw)
                scheme = "https" if u.scheme in ("wss", "https") else "http"
                candidates.append(f"{scheme}://{u.hostname}:{u.port or 9222}")
            elif "://" not in raw:
                host = raw if ":" in raw else f"127.0.0.1:{raw}"
                candidates.append(f"http://{host}")
    if PORT_FILE.is_file():
        port = PORT_FILE.read_text().strip()
        if port.isdigit():
            candidates.append(f"http://127.0.0.1:{port}")
    env_port = os.environ.get("CDP_PORT", "9222")
    candidates.append(f"http://127.0.0.1:{env_port}")
    if env_port != "9222":
        candidates.append("http://127.0.0.1:9222")
    seen: set[str] = set()
    uniq: list[str] = []
    for c in candidates:
        if c not in seen:
            seen.add(c)
            uniq.append(c)
    last_err = None
    for base in uniq:
        try:
            with urlopen(base + "/json/version", timeout=1.5) as r:
                if r.status == 200:
                    return base
        except Exception as err:
            last_err = err
    raise RuntimeError(f"browser-use CDP not reachable ({last_err})")


def http_json(url: str):
    with urlopen(url, timeout=3) as r:
        return json.loads(r.read().decode())


def ws_connect(url: str) -> socket.socket:
    u = urlparse(url)
    host = u.hostname or "127.0.0.1"
    port = u.port or (443 if u.scheme == "wss" else 80)
    path = u.path or "/"
    if u.query:
        path += "?" + u.query
    key = os.urandom(16)
    import base64

    req = (
        f"GET {path} HTTP/1.1\r\n"
        f"Host: {host}:{port}\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {base64.b64encode(key).decode('ascii')}\r\n"
        "Sec-WebSocket-Version: 13\r\n"
        "\r\n"
    )
    sock = socket.create_connection((host, port), timeout=5)
    sock.settimeout(5)
    sock.sendall(req.encode("ascii"))
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = sock.recv(4096)
        if not chunk:
            raise RuntimeError("CDP websocket closed during handshake")
        buf += chunk
    status = buf.split(b"\r\n", 1)[0]
    if b"101" not in status:
        raise RuntimeError(f"CDP websocket upgrade failed: {status!r}")
    return sock


def ws_send_text(sock: socket.socket, text: str) -> None:
    data = text.encode("utf-8")
    header = bytes([0x81])
    n = len(data)
    mask_bit = 0x80
    if n < 126:
        header += bytes([mask_bit | n])
    elif n < 65536:
        header += bytes([mask_bit | 126]) + struct.pack("!H", n)
    else:
        header += bytes([mask_bit | 127]) + struct.pack("!Q", n)
    mask = os.urandom(4)
    masked = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
    sock.sendall(header + mask + masked)


def ws_recv_text(sock: socket.socket) -> str:
    def recvn(n: int) -> bytes:
        buf = b""
        while len(buf) < n:
            chunk = sock.recv(n - len(buf))
            if not chunk:
                raise RuntimeError("CDP websocket closed")
            buf += chunk
        return buf

    while True:
        hdr = recvn(2)
        opcode = hdr[0] & 0x0F
        masked = bool(hdr[1] & 0x80)
        n = hdr[1] & 0x7F
        if n == 126:
            n = struct.unpack("!H", recvn(2))[0]
        elif n == 127:
            n = struct.unpack("!Q", recvn(8))[0]
        mask = recvn(4) if masked else None
        payload = recvn(n)
        if mask:
            payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        if opcode == 0x8:
            raise RuntimeError("CDP websocket close")
        if opcode == 0x9:
            # ping — ignore, wait for next
            continue
        if opcode != 0x1:
            continue
        return payload.decode("utf-8")


class Cdp:
    def __init__(self, sock: socket.socket):
        self.sock = sock
        self._id = 0

    def call(self, method: str, params: dict | None = None, timeout: float = 5.0):
        self._id += 1
        msg_id = self._id
        ws_send_text(self.sock, json.dumps({"id": msg_id, "method": method, "params": params or {}}))
        deadline = time.time() + timeout
        while time.time() < deadline:
            remaining = deadline - time.time()
            self.sock.settimeout(max(0.2, remaining))
            raw = ws_recv_text(self.sock)
            data = json.loads(raw)
            if data.get("id") != msg_id:
                continue
            if data.get("error"):
                raise RuntimeError(f"{method}: {data['error']}")
            return data.get("result") or {}
        raise TimeoutError(f"{method} timed out")


def xdotool(*args: str) -> str:
    env = os.environ.copy()
    env.setdefault("DISPLAY", ":99")
    proc = subprocess.run(
        ["xdotool", *args],
        capture_output=True,
        text=True,
        env=env,
        timeout=3,
    )
    return (proc.stdout or "").strip()


def chrome_window_ids() -> set[str]:
    ids: set[str] = set()
    for cls in ("Chromium", "chromium", "Google-chrome", "google-chrome"):
        try:
            out = xdotool("search", "--class", cls)
        except Exception:
            continue
        for line in out.splitlines():
            line = line.strip()
            if line.isdigit():
                ids.add(line)
    return ids


def pin_window(wid: str) -> None:
    try:
        current = xdotool("get_desktop") or "0"
        xdotool("set_desktop_for_window", wid, current)
        xdotool("windowactivate", "--sync", wid)
        try:
            xdotool("windowmaximize", wid)
        except Exception:
            pass
    except Exception as err:
        print(f"pin window {wid}: {err}", file=sys.stderr)


def wait_new_window(before: set[str], timeout: float = 4.0) -> str | None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        after = chrome_window_ids()
        fresh = [w for w in after if w not in before]
        if fresh:
            return fresh[-1]
        time.sleep(0.12)
    return None


def close_target(target_id: str) -> int:
    base = cdp_http_base()
    ver = http_json(base + "/json/version")
    ws_url = ver.get("webSocketDebuggerUrl")
    if not ws_url:
        print("no webSocketDebuggerUrl on browser-use CDP", file=sys.stderr)
        return 1
    sock = ws_connect(ws_url)
    try:
        cdp = Cdp(sock)
        cdp.call("Target.closeTarget", {"targetId": target_id})
        print(target_id)
        return 0
    finally:
        try:
            sock.close()
        except Exception:
            pass


def main() -> int:
    args = sys.argv[1:]
    os.environ.setdefault("DISPLAY", ":99")
    if args and args[0] in ("--close", "-c"):
        if len(args) < 2 or not args[1].strip():
            print("usage: browser-use-window.py --close <targetId>", file=sys.stderr)
            return 1
        return close_target(args[1].strip())
    url = args[0] if args else "about:blank"
    base = cdp_http_base()
    ver = http_json(base + "/json/version")
    ws_url = ver.get("webSocketDebuggerUrl")
    if not ws_url:
        print("no webSocketDebuggerUrl on browser-use CDP", file=sys.stderr)
        return 1
    before = chrome_window_ids()
    sock = ws_connect(ws_url)
    try:
        cdp = Cdp(sock)
        result = cdp.call("Target.createTarget", {"url": url, "newWindow": True})
        target_id = result.get("targetId")
        if target_id:
            try:
                win = cdp.call("Browser.getWindowForTarget", {"targetId": target_id})
                window_id = win.get("windowId")
                if window_id is not None:
                    cdp.call(
                        "Browser.setWindowBounds",
                        {"windowId": window_id, "bounds": {"windowState": "maximized"}},
                    )
            except Exception as err:
                print(f"maximize: {err}", file=sys.stderr)
        print(target_id or "ok")
    finally:
        try:
            sock.close()
        except Exception:
            pass
    wid = wait_new_window(before)
    if wid:
        pin_window(wid)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as err:
        print(str(err), file=sys.stderr)
        sys.exit(1)
