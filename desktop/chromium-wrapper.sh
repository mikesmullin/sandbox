#!/bin/sh
# chromium wrapper — the ONLY reliable injection point (the cua-driver resolves
# the browser itself and bypasses PATH wrappers; every launch path — the
# driver's own launches, launch_app/.desktop, the openbox menu, agent exec —
# converges here).
#
# Layer 1 — GPU/shm survival (the original wrapper's job):
#   --disable-gpu            ANGLE-Vulkan hard-aborts in the container (the
#                            process is a zombie in <1s without it).
#   --disable-dev-shm-usage  /dev/shm is a 64MB tmpfs in these guests; a
#                            second windowed chromium dies for lack of shared
#                            memory without it.
#
# Layer 2 — DEFERRED WARMUP (Mike, 2026-10-14): the boot-time prewarm retired
# (RAM/shm saved for browser-less jobs); the warmup rides the FIRST `chromium`
# invocation instead. Deterministic by construction — no recipe burden: any
# plain launch produces a driver-attachable, theme-correct browser.
#   --remote-debugging-port=0      → DevToolsActivePort: consent-free CDP
#                                    discovery for the cua-driver.
#   --force-renderer-accessibility → the COMPLETE AT-SPI tree (existing-profile
#                                    attach requires it on Linux).
#   --no-sandbox                   → no user namespaces under Apple Containers.
#   the no-first-run flag set      → no first-run noise on any launch path.
#   --start-maximized              → the prewarm's window posture.
#   the BAKED profile              → the black-theme extension + tuned
#                                    placement (no --user-data-dir passed =
#                                    the default profile ~/.config/chromium).
#   + stale-artifact cleanup       → a reused named profile carries rot:
#                                    SingletonLock/DevToolsActivePort left by a
#                                    dead instance poison the next launch
#                                    (browser_endpoint_owner_mismatch).
#                                    Cleaned when no LIVE chromium holds them;
#                                    a live instance just gains a new window.
# The DRIVER's own launches pass --user-data-dir (their isolated lease, the
# verified 806ms prepare→discover→bind path) — respected UNTOUCHED: only the
# unconditional survival flags apply, nothing is injected, no profile is
# cleaned. The boot-time prewarm (CUA_PREWARM_BROWSER=1) still exists and now
# also rides this wrapper (its explicit flags are seen → nothing doubled).

REAL=/usr/lib/chromium/chromium.real

# ── scan the caller's flags — inject only what is missing ──────────────────
seen_cdp=0; seen_a11y=0; seen_nosandbox=0; seen_nofirstrun=0; seen_nodbcheck=0
seen_nosearch=0; seen_nocrashbubble=0; seen_maximized=0; seen_udd=0
for a in "$@"; do
  case "$a" in
    --remote-debugging-port*) seen_cdp=1 ;;
    --force-renderer-accessibility) seen_a11y=1 ;;
    --no-sandbox) seen_nosandbox=1 ;;
    --no-first-run) seen_nofirstrun=1 ;;
    --no-default-browser-check) seen_nodbcheck=1 ;;
    --disable-search-engine-choice-screen) seen_nosearch=1 ;;
    --disable-session-crashed-bubble) seen_nocrashbubble=1 ;;
    --start-maximized) seen_maximized=1 ;;
    --user-data-dir*) seen_udd=1 ;;
  esac
done

# ── unconditional survival flags (both layers, every launch) ───────────────
set -- --disable-gpu --disable-dev-shm-usage "$@"

if [ "$seen_udd" = "0" ]; then
  # ── deferred warmup: plain launches (the baked profile) ──────────────────
  PROFILE_DIR="${HOME:-/home/desktop}/.config/chromium"
  # Profile-rot cleanup: a dead instance's Singleton lock (a symlink whose
  # target ends in the pid) + a stale DevToolsActivePort poison the next
  # launch. A LIVE instance is left alone (its launch opens a new window in
  # the existing process — chromium's normal singleton behavior).
  if [ -L "$PROFILE_DIR/SingletonLock" ]; then
    target=$(readlink "$PROFILE_DIR/SingletonLock" 2>/dev/null) || target=''
    pid=${target##*-}
    case "$pid" in
      ''|*[!0-9]*) pid='' ;;
    esac
    if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$PROFILE_DIR/SingletonLock" "$PROFILE_DIR/SingletonCookie" \
            "$PROFILE_DIR/SingletonSocket" "$PROFILE_DIR/DevToolsActivePort" \
            2>/dev/null
    fi
  elif [ ! -e "$PROFILE_DIR/SingletonLock" ] && [ -f "$PROFILE_DIR/DevToolsActivePort" ]; then
    rm -f "$PROFILE_DIR/DevToolsActivePort" 2>/dev/null
  fi

  # The warmup flag set — the prewarm's exact set, missing-only.
  [ "$seen_nosandbox" = "0" ]       && set -- --no-sandbox "$@"
  [ "$seen_nofirstrun" = "0" ]      && set -- --no-first-run "$@"
  [ "$seen_nodbcheck" = "0" ]       && set -- --no-default-browser-check "$@"
  [ "$seen_nosearch" = "0" ]        && set -- --disable-search-engine-choice-screen "$@"
  [ "$seen_nocrashbubble" = "0" ]   && set -- --disable-session-crashed-bubble "$@"
  [ "$seen_a11y" = "0" ]            && set -- --force-renderer-accessibility "$@"
  [ "$seen_cdp" = "0" ]             && set -- --remote-debugging-port=0 "$@"
  [ "$seen_maximized" = "0" ]       && set -- --start-maximized "$@"
fi

exec "$REAL" "$@"
