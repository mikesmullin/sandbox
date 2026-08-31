# Debian agent desktop: Xvfb + XFCE + headed browser-use Chromium + Selkies
# (H.264/WebSocket stream via pixelflux, Opus audio via pcmflux over PulseAudio)
# + vercel-labs/agent-browser attached over CDP (does not launch its own Chrome)
# + bun Angela owner process (file-io / shell / headed browser tools).
#
# Playwright Chromium is glibc, so this image is Debian rather than Alpine.
ARG SELKIES_REF=92cdd57607309d14d14cbfa527f854bac93664b9

FROM --platform=$BUILDPLATFORM docker.io/library/node:24-bookworm-slim AS selkies-web
ARG SELKIES_REF
COPY vendor/certs /opt/certs
RUN apt-get update
RUN apt-get install -y --no-install-recommends ca-certificates curl patch
RUN if [ -s /opt/certs/corporate-ca.pem ]; then \
        cp /opt/certs/corporate-ca.pem /usr/local/share/ca-certificates/corporate-ca.crt; \
        update-ca-certificates; \
    fi
RUN mkdir -p /work
RUN curl -fsSL "https://github.com/selkies-project/selkies/archive/${SELKIES_REF}.tar.gz" \
      | tar -xz -C /work --strip-components=3 "selkies-${SELKIES_REF}/addons/selkies-web-core"
COPY patches/selkies-start-video.patch /tmp/selkies-start-video.patch
RUN patch -d /work -p1 < /tmp/selkies-start-video.patch
WORKDIR /work
RUN npm install --no-audit --no-fund
RUN npm run build

FROM docker.io/oven/bun:1.2-debian AS bunbin

FROM docker.io/debian:bookworm-slim

COPY vendor/certs /opt/certs

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
    NODE_EXTRA_CA_CERTS=/opt/certs/corporate-ca.pem \
    IN_DOCKER=1 \
    BROWSER_USE_CHROME_NO_SANDBOX=1 \
    PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
    UV_INSTALL_DIR=/usr/local/bin

RUN apt-get update
RUN apt-get install -y --no-install-recommends \
    bash tini sudo ca-certificates curl wget openssl socat procps htop
RUN apt-get install -y --no-install-recommends \
    dbus dbus-x11 xvfb x11-utils xdotool scrot
RUN apt-get install -y --no-install-recommends \
    xfce4 xfce4-terminal thunar mousepad adwaita-icon-theme
RUN apt-get install -y --no-install-recommends \
    fonts-dejavu-core fonts-liberation
RUN apt-get install -y --no-install-recommends \
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2
RUN apt-get install -y --no-install-recommends \
    libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3
RUN apt-get install -y --no-install-recommends \
    libxrandr2 libgbm1 libasound2 libpango-1.0-0 libcairo2
RUN apt-get install -y --no-install-recommends \
    libgtk-3-0 libxshmfence1 libglu1-mesa
RUN apt-get install -y --no-install-recommends \
    python3 python3-venv python3-pip python3-numpy
RUN apt-get install -y --no-install-recommends pulseaudio pulseaudio-utils
RUN apt-get install -y --no-install-recommends nodejs npm
RUN apt-get purge -y xfce4-screensaver light-locker xfce4-power-manager 2>/dev/null || true
RUN apt-get autoremove -y

RUN if [ -s /opt/certs/corporate-ca.pem ]; then \
            cp /opt/certs/corporate-ca.pem /usr/local/share/ca-certificates/corporate-ca.crt; \
            update-ca-certificates; \
        fi

# browser-use venv + Playwright Chromium (the headed browser). Not Debian chromium.
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
RUN uv python install 3.12
RUN uv venv --python 3.12 /opt/browser-use/venv
RUN uv pip install --python /opt/browser-use/venv/bin/python browser-use playwright
RUN /opt/browser-use/venv/bin/playwright install --with-deps --no-shell chromium
RUN CHROME="$(find /opt/ms-playwright -path '*/chrome-linux*/chrome' -type f | tail -1)" \
    && test -n "$CHROME" \
    && test -x "$CHROME" \
    && ln -sfn "$CHROME" /opt/browser-use/chrome
RUN /opt/browser-use/chrome --version

# Dock / exo helper is copied later as /usr/local/bin/browser-use-open.

# vercel-labs/agent-browser MCP only. The GNU linux native binary is selected at install.
# Do not overwrite npm's bin link — a self-symlink here makes a loop.
# 0.28+ ships `agent-browser mcp` (stdio).
RUN npm install -g agent-browser@0.35.1
RUN npm cache clean --force
RUN ln -sfn /usr/local/lib/node_modules/agent-browser/bin/agent-browser.js /usr/local/bin/agent-browser
RUN chmod +x /usr/local/lib/node_modules/agent-browser/bin/agent-browser.js
RUN find /usr/local/lib/node_modules/agent-browser/bin -name 'agent-browser-linux*' -exec chmod +x {} \;
RUN agent-browser --version
RUN agent-browser mcp --help >/dev/null

RUN groupadd -g 1000 agent
RUN useradd -m -u 1000 -g agent -s /bin/bash agent
RUN echo 'agent ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/agent && chmod 440 /etc/sudoers.d/agent
RUN mkdir -p /workspace /tmp/runtime-agent /home/agent/.config/browser-use
RUN chown -R agent:agent /home/agent /workspace /tmp/runtime-agent

COPY --from=bunbin /usr/local/bin/bun /usr/local/bin/bun
COPY vendor/nvidia /opt/nvidia
COPY scripts/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY scripts/xfce-session.sh /usr/local/bin/xfce-session.sh
COPY scripts/browser-use-headed.py /usr/local/bin/browser-use-headed.py
COPY scripts/browser-use-window.py /usr/local/bin/browser-use-window.py
COPY scripts/chromium-open.sh /usr/local/bin/browser-use-open
COPY desktop/ /etc/skel/.config/
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/xfce-session.sh \
         /usr/local/bin/browser-use-headed.py /usr/local/bin/browser-use-window.py \
        /usr/local/bin/browser-use-open
RUN ln -sfn /usr/local/bin/browser-use-open /usr/local/bin/chromium
RUN printf '%s\n' \
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
            > /usr/share/applications/browser-use.desktop
    RUN cp /usr/share/applications/browser-use.desktop /usr/share/applications/chromium.desktop
    RUN mkdir -p /usr/share/xfce4/helpers
    RUN printf '%s\n' \
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
         > /usr/share/xfce4/helpers/browser-use.desktop
RUN mkdir -p /home/agent/.config /home/agent/.bun
RUN cp -a /etc/skel/.config/. /home/agent/.config/
RUN mkdir -p /etc/xdg/xfce4/panel
RUN cp /etc/skel/.config/xfce4/xfconf/xfce-perchannel-xml/xfce4-panel.xml \
    /etc/xdg/xfce4/panel/default.xml
RUN if [ -f /etc/skel/.config/mimeapps.list ]; then \
        cp /etc/skel/.config/mimeapps.list /etc/xdg/mimeapps.list; \
    fi
RUN update-alternatives --install /usr/bin/x-www-browser x-www-browser /usr/local/bin/browser-use-open 200
RUN update-alternatives --install /usr/bin/gnome-www-browser gnome-www-browser /usr/local/bin/browser-use-open 200
RUN chown -R agent:agent /home/agent /opt/certs /workspace

# xdg-open / gio default-app lookups. Late so Playwright layers stay cached.
RUN apt-get update
RUN apt-get install -y --no-install-recommends xdg-utils git openssh-client xz-utils libatomic1
RUN apt-get install -y --no-install-recommends \
    build-essential pkg-config cmake autoconf \
    gh rustc cargo golang-go ruby-full ruby-dev
RUN apt-get install -y --no-install-recommends \
    iputils-ping dnsutils traceroute netcat-openbsd iproute2 \
    lsof tcpdump nmap jq rsync less vim-tiny
RUN apt-get install -y --no-install-recommends \
    mesa-utils mesa-vulkan-drivers vulkan-tools

# Current git / gh / pyenv+CPython / uv / node+npm / bun / rust / go / zig / ruby.
ARG INSTALL_FULL_DEVTOOLS=1
ARG SKIP_GIT_SOURCE_BUILD=0
ARG TARGETARCH
COPY scripts/install-devtools.sh /usr/local/bin/install-devtools.sh
COPY scripts/devtools-profile.sh /etc/profile.d/devtools.sh
RUN chmod +x /usr/local/bin/install-devtools.sh
RUN if [ "${INSTALL_FULL_DEVTOOLS}" = "1" ]; then \
        SKIP_GIT_SOURCE_BUILD="${SKIP_GIT_SOURCE_BUILD}" /usr/local/bin/install-devtools.sh; \
    fi
RUN if [ "${INSTALL_FULL_DEVTOOLS}" != "1" ]; then \
        case "${TARGETARCH}" in amd64) node_arch=x64 ;; arm64) node_arch=arm64 ;; *) exit 1 ;; esac; \
        NODE_VER="$(curl -fsSL https://nodejs.org/dist/index.json | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["version"].lstrip("v"))')"; \
        mkdir -p /opt/node; \
        curl -fsSL "https://nodejs.org/dist/v${NODE_VER}/node-v${NODE_VER}-linux-${node_arch}.tar.xz" -o /tmp/node.tar.xz; \
        tar -xJf /tmp/node.tar.xz -C /opt/node --strip-components=1; \
        /opt/node/bin/node --version; \
    fi
RUN if [ "${INSTALL_FULL_DEVTOOLS}" != "1" ]; then \
        case "${TARGETARCH}" in amd64) zig_arch=x86_64 ;; arm64) zig_arch=aarch64 ;; *) exit 1 ;; esac; \
        ZIG_VER="$(curl -fsSL https://ziglang.org/download/index.json | python3 -c 'import json,sys; data=json.load(sys.stdin); versions=[v for v in data if v[:1].isdigit()]; versions.sort(key=lambda v:[int(x) for x in v.split(".")]); print(versions[-1])')"; \
        ZIG_URL="$(curl -fsSL https://ziglang.org/download/index.json | python3 -c 'import json,sys; data=json.load(sys.stdin); print(data[sys.argv[1]][sys.argv[2]+"-linux"]["tarball"])' "${ZIG_VER}" "${zig_arch}")"; \
        mkdir -p /opt/zig; \
        curl -fsSL "${ZIG_URL}" -o /tmp/zig.tar.xz; \
        tar -xJf /tmp/zig.tar.xz -C /opt/zig --strip-components=1; \
        /opt/zig/zig version; \
    fi
RUN ln -sfn /opt/node/bin/node /usr/local/bin/node 2>/dev/null || true
RUN ln -sfn /opt/node/bin/npm /usr/local/bin/npm 2>/dev/null || true
RUN ln -sfn /opt/node/bin/npx /usr/local/bin/npx 2>/dev/null || true
RUN ln -sfn /opt/zig/zig /usr/local/bin/zig 2>/dev/null || true
RUN printf '\n# desktop toolchains\n[ -f /etc/profile.d/devtools.sh ] && . /etc/profile.d/devtools.sh\n' >> /etc/bash.bashrc
RUN chown -R agent:agent /home/agent

# Selkies: H.264/WebSocket desktop stream (video via pixelflux, Opus audio via
# pcmflux) in its own venv. The pixelflux/pcmflux `selkies` (script `selkies`,
# flags --subfolder / --encoder=h264enc) is not on PyPI yet — PyPI `selkies` is
# the old GStreamer build (script `selkies-gstreamer`) and the GitHub .deb ships
# only the js-interposer. The app needs pixelflux/pcmflux 2.1.0 (2.0.0 is missing
# SOFTWARE_H264_ENCODER, which the settings payload references at runtime), and
# 2.1.0 is published only on GitHub releases (not PyPI) as prebuilt manylinux_2_28
# cp312 wheels for x86_64 and aarch64 — no Rust build on bookworm. Install the
# wheel matching TARGETARCH first (satisfying
# the ~=2.1.0 pin), then the app from a pinned main-commit source tarball WITH its
# deps (pyee, cryptography, uvloop, … — __main__ imports webrtc_mode even in
# websockets mode). Encoder auto-picks NVENC when the vendored /opt/nvidia libs +
# a GPU are present, else software x264. Placed after the slow devtools layer so
# iterating on Selkies does not rebuild it.
ARG SELKIES_REF
ARG PIXELFLUX_RELEASE=e72d820
ARG PCMFLUX_RELEASE=a8fac8d
RUN uv venv --python 3.12 /opt/selkies
RUN case "${TARGETARCH}" in amd64) wheel_arch=x86_64 ;; arm64) wheel_arch=aarch64 ;; *) exit 1 ;; esac; \
    uv pip install --python /opt/selkies/bin/python \
      "https://github.com/selkies-project/pixelflux/releases/download/${PIXELFLUX_RELEASE}/pixelflux-2.1.0-cp312-cp312-manylinux_2_28_${wheel_arch}.whl"
RUN case "${TARGETARCH}" in amd64) wheel_arch=x86_64 ;; arm64) wheel_arch=aarch64 ;; *) exit 1 ;; esac; \
    uv pip install --python /opt/selkies/bin/python \
      "https://github.com/selkies-project/pcmflux/releases/download/${PCMFLUX_RELEASE}/pcmflux-2.1.0-cp312-cp312-manylinux_2_28_${wheel_arch}.whl"
RUN uv pip install --python /opt/selkies/bin/python \
    "https://github.com/selkies-project/selkies/archive/${SELKIES_REF}.tar.gz"
RUN /opt/selkies/bin/python -c "import pixelflux; assert hasattr(pixelflux, 'SOFTWARE_H264_ENCODER')"
RUN /opt/selkies/bin/python -c "import pcmflux; import selkies.__main__"
RUN ln -sfn /opt/selkies/bin/selkies /usr/local/bin/selkies
RUN chown -R agent:agent /opt/selkies

# Selkies' client is architecture-neutral. Build it natively in the first stage
# so cross-platform desktop builds do not run Vite through CPU emulation.
COPY --from=selkies-web --chown=agent:agent /work/dist /opt/selkies-web

# npm's agl-ai is stale. Link the vendored /workspace/agl tree (copied to
# /opt/vendor/agl) so every cwd — including Angela's /workspace jail —
# resolves llama-server and the rest of the current provider set.
COPY --chown=agent:agent vendor/mcp /opt/mcp
COPY --chown=agent:agent vendor/agl /opt/vendor/agl
COPY --chown=agent:agent vendor/angela /opt/vendor/angela
COPY --chown=agent:agent agent /opt/agent
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
