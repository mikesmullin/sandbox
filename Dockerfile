# Debian agent desktop: Xvfb + XFCE + headed browser-use Chromium + Selkies
# (H.264/WebSocket stream via pixelflux, Opus audio via pcmflux over PulseAudio)
# + vercel-labs/agent-browser attached over CDP (does not launch its own Chrome)
# + bun Angela owner process (file-io / shell / headed browser tools).
#
# Playwright Chromium is glibc, so this image is Debian rather than Alpine.
FROM docker.io/oven/bun:1.2-debian AS bunbin

FROM docker.io/debian:bookworm-slim

ENV LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:99 \
    GEOMETRY=1280x800x24 \
    SELKIES_PORT=6080 \
    CDP_PORT=9222 \
    HOME=/home/agent \
    USER=agent \
    XDG_RUNTIME_DIR=/tmp/runtime-agent \
    XDG_CURRENT_DESKTOP=XFCE \
    XFCE_PANEL_MIGRATE_DEFAULT=true \
    AGENT_BROWSER_HEADED=1 \
    AGENT_PORT=8091 \
    ANGELA_MCP_ROOT=/opt/mcp \
    ANGELA_PROJECT_ROOT=/workspace \
    AGENT_MODEL=llama-server:default \
    DAD_PROXY_URL=https://host.containers.internal:1234 \
    DAD_PROXY_CA_FILE=/opt/certs/ca.pem \
    LLAMA_SERVER_BASE_URL=https://host.containers.internal:1234 \
    IN_DOCKER=1 \
    BROWSER_USE_CHROME_NO_SANDBOX=1 \
    PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
    UV_INSTALL_DIR=/usr/local/bin

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash tini sudo ca-certificates curl wget openssl \
        dbus dbus-x11 \
        xvfb x11-utils \
        xfce4 xfce4-terminal thunar mousepad \
        adwaita-icon-theme \
        fonts-dejavu-core fonts-liberation \
        libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
        libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
        libxrandr2 libgbm1 libasound2 libpango-1.0-0 libcairo2 \
        libgtk-3-0 libxshmfence1 libglu1-mesa \
        python3 python3-venv python3-pip python3-numpy \
        pulseaudio pulseaudio-utils \
        nodejs npm \
        xdotool scrot \
        procps htop \
        socat \
    && apt-get purge -y xfce4-screensaver light-locker xfce4-power-manager 2>/dev/null || true \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

# browser-use venv + Playwright Chromium (the headed browser). Not Debian chromium.
RUN curl -LsSf https://astral.sh/uv/install.sh | sh \
    && export PATH="/usr/local/bin:/root/.local/bin:$PATH" \
    && uv python install 3.12 \
    && uv venv --python 3.12 /opt/browser-use/venv \
    && uv pip install --python /opt/browser-use/venv/bin/python browser-use playwright \
    && /opt/browser-use/venv/bin/playwright install --with-deps --no-shell chromium \
    && CHROME="$(ls -d /opt/ms-playwright/chromium-*/chrome-linux/chrome /opt/ms-playwright/chromium-*/chrome-linux64/chrome 2>/dev/null | tail -1)" \
    && test -n "$CHROME" && test -x "$CHROME" \
    && ln -sfn "$CHROME" /opt/browser-use/chrome \
    && "$CHROME" --version

# Dock / exo helper is copied later as /usr/local/bin/browser-use-open.

# vercel-labs/agent-browser MCP only. The GNU linux native binary is selected at install.
# Do not overwrite npm's bin link — a self-symlink here makes a loop.
# 0.28+ ships `agent-browser mcp` (stdio).
RUN npm install -g agent-browser@0.35.1 \
    && npm cache clean --force \
    && ln -sfn /usr/local/lib/node_modules/agent-browser/bin/agent-browser.js /usr/local/bin/agent-browser \
    && chmod +x /usr/local/lib/node_modules/agent-browser/bin/agent-browser.js \
    && find /usr/local/lib/node_modules/agent-browser/bin -name 'agent-browser-linux*' -exec chmod +x {} \; \
    && agent-browser --version \
    && agent-browser mcp --help >/dev/null

RUN groupadd -g 1000 agent \
    && useradd -m -u 1000 -g agent -s /bin/bash agent \
    && echo 'agent ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/agent \
    && chmod 440 /etc/sudoers.d/agent \
    && mkdir -p /workspace /tmp/runtime-agent /home/agent/.config/browser-use \
    && chown -R agent:agent /home/agent /workspace /tmp/runtime-agent /opt/browser-use /opt/ms-playwright

COPY --from=bunbin /usr/local/bin/bun /usr/local/bin/bun
COPY vendor/mcp /opt/mcp
COPY vendor/agl /opt/vendor/agl
COPY vendor/angela /opt/vendor/angela
COPY agent /opt/agent
COPY vendor/certs /opt/certs
COPY vendor/nvidia /opt/nvidia
COPY scripts/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY scripts/xfce-session.sh /usr/local/bin/xfce-session.sh
COPY scripts/browser-use-headed.py /usr/local/bin/browser-use-headed.py
COPY scripts/browser-use-window.py /usr/local/bin/browser-use-window.py
COPY scripts/chromium-open.sh /usr/local/bin/browser-use-open
COPY desktop/ /etc/skel/.config/
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/xfce-session.sh \
         /usr/local/bin/browser-use-headed.py /usr/local/bin/browser-use-window.py \
         /usr/local/bin/browser-use-open \
    && ln -sfn /usr/local/bin/browser-use-open /usr/local/bin/chromium \
    && printf '%s\n' \
         '[Desktop Entry]' \
         'Version=1.0' \
         'Type=Application' \
         'Name=browser-use' \
         'Comment=Headed browser-use Chromium' \
         'Exec=/usr/local/bin/browser-use-open %U' \
         'Icon=org.xfce.webbrowser' \
         'Terminal=false' \
         'StartupNotify=true' \
         'Categories=Network;WebBrowser;' \
         'MimeType=text/html;text/xml;application/xhtml+xml;x-scheme-handler/http;x-scheme-handler/https;x-scheme-handler/about;' \
         > /usr/share/applications/browser-use.desktop \
    && cp /usr/share/applications/browser-use.desktop /usr/share/applications/chromium.desktop \
    && mkdir -p /usr/share/xfce4/helpers \
    && printf '%s\n' \
         '[Desktop Entry]' \
         'Version=1.0' \
         'Icon=org.xfce.webbrowser' \
         'Type=X-XFCE-Helper' \
         'Name=browser-use' \
         'StartupNotify=true' \
         'X-XFCE-Binaries=browser-use-open;' \
         'X-XFCE-Category=WebBrowser' \
         'X-XFCE-Commands=/usr/local/bin/browser-use-open;' \
         'X-XFCE-CommandsWithParameter=/usr/local/bin/browser-use-open "%s";' \
         > /usr/share/xfce4/helpers/browser-use.desktop \
    && mkdir -p /home/agent/.config /home/agent/.bun \
    && cp -a /etc/skel/.config/. /home/agent/.config/ \
    && mkdir -p /etc/xdg/xfce4/panel \
    && cp /etc/skel/.config/xfce4/xfconf/xfce-perchannel-xml/xfce4-panel.xml \
         /etc/xdg/xfce4/panel/default.xml \
    && if [ -f /etc/skel/.config/mimeapps.list ]; then \
         cp /etc/skel/.config/mimeapps.list /etc/xdg/mimeapps.list; \
       fi \
    && update-alternatives --install /usr/bin/x-www-browser x-www-browser /usr/local/bin/browser-use-open 200 \
    && update-alternatives --install /usr/bin/gnome-www-browser gnome-www-browser /usr/local/bin/browser-use-open 200 \
    && chown -R agent:agent /home/agent /opt/agent /opt/mcp /opt/vendor /opt/certs /workspace

# xdg-open / gio default-app lookups. Late so Playwright layers stay cached.
RUN apt-get update \
    && apt-get install -y --no-install-recommends xdg-utils git openssh-client \
    && rm -rf /var/lib/apt/lists/*

# Current git / gh / pyenv+CPython / uv / node+npm / bun / rust / go / zig / ruby.
COPY scripts/install-devtools.sh /usr/local/bin/install-devtools.sh
COPY scripts/devtools-profile.sh /etc/profile.d/devtools.sh
RUN chmod +x /usr/local/bin/install-devtools.sh \
    && /usr/local/bin/install-devtools.sh \
    && printf '\n# desktop toolchains\n[ -f /etc/profile.d/devtools.sh ] && . /etc/profile.d/devtools.sh\n' \
         >> /etc/bash.bashrc \
    && chown -R agent:agent /home/agent

# Selkies: H.264/WebSocket desktop stream (video via pixelflux, Opus audio via
# pcmflux) in its own venv. The pixelflux/pcmflux `selkies` (script `selkies`,
# flags --subfolder / --encoder=h264enc) is not on PyPI yet — PyPI `selkies` is
# the old GStreamer build (script `selkies-gstreamer`) and the GitHub .deb ships
# only the js-interposer. The app needs pixelflux/pcmflux 2.1.0 (2.0.0 is missing
# SOFTWARE_H264_ENCODER, which the settings payload references at runtime), and
# 2.1.0 is published only on GitHub releases (not PyPI) as prebuilt manylinux_2_28
# cp312 wheels — no Rust build on bookworm. Install those wheels first (satisfying
# the ~=2.1.0 pin), then the app from a pinned main-commit source tarball WITH its
# deps (pyee, cryptography, uvloop, … — __main__ imports webrtc_mode even in
# websockets mode). Encoder auto-picks NVENC when the vendored /opt/nvidia libs +
# a GPU are present, else software x264. Placed after the slow devtools layer so
# iterating on Selkies does not rebuild it.
ARG SELKIES_REF=92cdd57607309d14d14cbfa527f854bac93664b9
ARG PIXELFLUX_WHL=https://github.com/selkies-project/pixelflux/releases/download/e72d820/pixelflux-2.1.0-cp312-cp312-manylinux_2_28_x86_64.whl
ARG PCMFLUX_WHL=https://github.com/selkies-project/pcmflux/releases/download/a8fac8d/pcmflux-2.1.0-cp312-cp312-manylinux_2_28_x86_64.whl
RUN export PATH="/usr/local/bin:/root/.local/bin:$PATH" \
    && uv venv --python 3.12 /opt/selkies \
    && uv pip install --python /opt/selkies/bin/python "${PIXELFLUX_WHL}" "${PCMFLUX_WHL}" \
    && uv pip install --python /opt/selkies/bin/python \
         "https://github.com/selkies-project/selkies/archive/${SELKIES_REF}.tar.gz" \
    && /opt/selkies/bin/python -c "import pixelflux; assert hasattr(pixelflux, 'SOFTWARE_H264_ENCODER'); import selkies.__main__" \
    && ln -sfn /opt/selkies/bin/selkies /usr/local/bin/selkies \
    && chown -R agent:agent /opt/selkies

# Selkies' HTML5 client is a Vite app (addons/selkies-web-core) that CI builds and
# injects as the `selkies.selkies_web` package — the pip/sdist install does NOT
# include it, so the server logs "No module named 'selkies.selkies_web'" and serves
# no web UI. Build it here from the same pinned commit and serve it via --web-root
# (which the server prefers over the packaged module when it has index.html).
RUN . /etc/profile.d/devtools.sh 2>/dev/null || true; \
    set -eux; \
    mkdir -p /tmp/webbuild && cd /tmp/webbuild; \
    curl -fsSL "https://github.com/selkies-project/selkies/archive/${SELKIES_REF}.tar.gz" \
      | tar -xz --strip-components=1 "selkies-${SELKIES_REF}/addons/selkies-web-core"; \
    cd addons/selkies-web-core; \
    npm install --no-audit --no-fund; \
    npm run build; \
    mkdir -p /opt/selkies-web; \
    cp -a dist/. /opt/selkies-web/; \
    test -f /opt/selkies-web/index.html; \
    cd /; rm -rf /tmp/webbuild; \
    chown -R agent:agent /opt/selkies-web

# npm's agl-ai is stale. Link the vendored /workspace/agl tree (copied to
# /opt/vendor/agl) so every cwd — including Angela's /workspace jail —
# resolves llama-server and the rest of the current provider set.
USER agent
WORKDIR /opt/vendor/agl
RUN bun link
WORKDIR /opt/vendor/angela
RUN bun link
WORKDIR /opt/mcp
RUN bun install --production
WORKDIR /opt/agent
RUN bun install --production

WORKDIR /workspace
EXPOSE 6080 9222 8091
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
