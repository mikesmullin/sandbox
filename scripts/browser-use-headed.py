#!/opt/browser-use/venv/bin/python
"""Launch a headed browser-use Chromium on DISPLAY and keep it alive.

Stealth launch args come from browser-use (no --enable-automation, blink
AutomationControlled disabled). agent-browser attaches over CDP; it must not
spawn a second Chrome.
"""
from __future__ import annotations

import asyncio
import glob
import json
import os
import re
import signal
import sys
from pathlib import Path
from urllib.request import urlopen
from urllib.parse import urlparse

CDP_FILE = Path(os.environ.get("BROWSER_USE_CDP_FILE", "/tmp/browser-use.cdp"))
PORT_FILE = Path(os.environ.get("BROWSER_USE_CDP_PORT_FILE", "/tmp/browser-use.cdp.port"))
# Path must contain "browser-use-user-data-dir-" so browser-use does not copy
# the profile into a random /tmp/browser-use-user-data-dir-* (see profile.py
# _copy_profile). Snapshot restore writes this same directory.
USER_DATA = Path(
    os.environ.get(
        "BROWSER_USE_USER_DATA_DIR",
        os.path.expanduser("~/.config/browser-use-user-data-dir-live"),
    )
)
PREFERRED_PORT = int(os.environ.get("CDP_PORT", "9222"))


def find_chrome() -> str:
    env = os.environ.get("BROWSER_USE_CHROME") or os.environ.get("BROWSER_USE_EXECUTABLE")
    if env and os.path.isfile(env) and os.access(env, os.X_OK):
        return env
    roots = [
        os.environ.get("PLAYWRIGHT_BROWSERS_PATH", "/opt/ms-playwright"),
        os.path.expanduser("~/.cache/ms-playwright"),
        "/opt/ms-playwright",
    ]
    hits: list[str] = []
    for root in roots:
        if not root:
            continue
        hits.extend(glob.glob(os.path.join(root, "chromium-*/chrome-linux/chrome")))
        hits.extend(glob.glob(os.path.join(root, "chromium-*/chrome-linux64/chrome")))
    hits = [p for p in hits if os.path.isfile(p) and os.access(p, os.X_OK)]
    if not hits:
        print("[browser-use] no Playwright Chromium under PLAYWRIGHT_BROWSERS_PATH", file=sys.stderr)
        sys.exit(1)
    hits.sort()
    return hits[-1]


def write_cdp(url: str) -> None:
    CDP_FILE.parent.mkdir(parents=True, exist_ok=True)
    CDP_FILE.write_text(url.strip() + "\n")
    parsed = urlparse(url)
    port = parsed.port or PREFERRED_PORT
    PORT_FILE.write_text(str(port) + "\n")
    print(f"[browser-use] cdp={url}", flush=True)


def discover_cdp() -> str | None:
    for cmdline_path in glob.glob("/proc/[0-9]*/cmdline"):
        try:
            cmdline = Path(cmdline_path).read_bytes().replace(b"\0", b" ").decode()
        except (OSError, UnicodeDecodeError):
            continue
        if "chrome" not in cmdline:
            continue
        match = re.search(r"--remote-debugging-port=(\d+)", cmdline)
        if not match:
            continue
        url = f"http://127.0.0.1:{match.group(1)}"
        try:
            with urlopen(f"{url}/json/version", timeout=0.2) as response:
                data = json.load(response)
            if data.get("webSocketDebuggerUrl"):
                return url
        except Exception:
            continue
    return None


async def main() -> int:
    from browser_use import Browser

    chrome = find_chrome()
    os.environ.setdefault("IN_DOCKER", "1")
    os.environ.setdefault("BROWSER_USE_CHROME_NO_SANDBOX", "1")
    USER_DATA.mkdir(parents=True, exist_ok=True)
    display = os.environ.get("DISPLAY", ":99")
    width, height = 1280, 800
    geom = os.environ.get("GEOMETRY", "1280x800x24")
    try:
        wh = geom.split("x", 2)
        width, height = int(wh[0]), int(wh[1])
    except (ValueError, IndexError):
        pass

    print(f"[browser-use] chrome={chrome} display={display} size={width}x{height}", flush=True)

    browser = Browser(
        executable_path=chrome,
        headless=False,
        keep_alive=True,
        chromium_sandbox=False,
        highlight_elements=False,
        no_viewport=True,
        window_size={"width": width, "height": height},
        user_data_dir=str(USER_DATA),
        args=[
            f"--remote-debugging-port={PREFERRED_PORT}",
            "--remote-debugging-address=127.0.0.1",
            "--start-maximized",
            "--ignore-gpu-blocklist",
            "--enable-gpu",
            "--enable-webgl",
            "--enable-webgl2",
            "--use-gl=angle",
            "--use-angle=vulkan",
            "--enable-features=Vulkan,DefaultANGLEVulkan,VulkanFromANGLE",
        ],
        env={
            "DISPLAY": display,
            "HOME": os.environ.get("HOME", "/home/agent"),
            "XDG_RUNTIME_DIR": os.environ.get("XDG_RUNTIME_DIR", "/tmp/runtime-agent"),
            "LANG": os.environ.get("LANG", "C.UTF-8"),
            **{
                k: os.environ[k]
                for k in (
                    "LD_LIBRARY_PATH",
                    "VK_ICD_FILENAMES",
                    "__EGL_VENDOR_LIBRARY_DIRS",
                    "__EGL_EXTERNAL_PLATFORM_CONFIG_DIRS",
                    "NVIDIA_VISIBLE_DEVICES",
                    "NVIDIA_DRIVER_CAPABILITIES",
                )
                if os.environ.get(k)
            },
        },
    )
    start_task = asyncio.create_task(browser.start())
    cdp = None
    for _ in range(240):
        if start_task.done():
            await start_task
            cdp = browser.cdp_url
            break
        cdp = await asyncio.to_thread(discover_cdp)
        if cdp:
            break
        await asyncio.sleep(0.25)
    if not cdp:
        await start_task
        cdp = browser.cdp_url or f"http://127.0.0.1:{PREFERRED_PORT}"
    write_cdp(cdp)

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, stop.set)
        except NotImplementedError:
            signal.signal(sig, lambda *_: stop.set())
    await stop.wait()
    print("[browser-use] stopping", flush=True)
    try:
        await browser.kill()
    except Exception as err:
        print(f"[browser-use] kill: {err}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
