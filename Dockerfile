# Alpine agent desktop: Xvfb + XFCE + Thunar + Chromium + x11vnc + noVNC
# + vercel-labs/agent-browser attached to Chromium over CDP
# + bun Angela owner process (file-io / shell / headed browser tools).
FROM docker.io/oven/bun:1.2-alpine AS bunbin

FROM docker.io/alpine:3.22

ENV LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    DISPLAY=:99 \
    GEOMETRY=1280x800x24 \
    VNC_PORT=5900 \
    NOVNC_PORT=6080 \
    CDP_PORT=9222 \
    HOME=/home/agent \
    USER=agent \
    XDG_RUNTIME_DIR=/tmp/runtime-agent \
    XDG_CURRENT_DESKTOP=XFCE \
    XFCE_PANEL_MIGRATE_DEFAULT=true \
    AGENT_BROWSER_EXECUTABLE_PATH=/usr/local/bin/chromium \
    AGENT_BROWSER_HEADED=1 \
    AGENT_PORT=8091 \
    ANGELA_MCP_ROOT=/opt/mcp \
    ANGELA_PROJECT_ROOT=/workspace \
    AGENT_MODEL=llama-server:default \
    DAD_PROXY_URL=https://host.containers.internal:1234 \
    DAD_PROXY_CA_FILE=/opt/certs/ca.pem \
    LLAMA_SERVER_BASE_URL=https://host.containers.internal:1234

RUN apk add --no-cache \
        bash tini sudo ca-certificates curl wget openssl \
        dbus dbus-x11 \
        xvfb xdpyinfo xset x11vnc \
        xfce4 xfce4-terminal thunar mousepad \
        adwaita-icon-theme \
        font-dejavu font-liberation \
        mesa-dri-gallium mesa-egl mesa-gbm \
        nss nss-tools freetype harfbuzz \
        chromium \
        python3 py3-numpy \
        novnc websockify \
        nodejs npm \
        xdotool scrot \
        procps htop \
        gtk+3.0 \
    && apk del xfce4-screensaver xfce4-power-manager light-locker 2>/dev/null || true \
    && rm -rf /var/cache/apk/*

# Chromium cannot nest its user-namespace sandbox inside the container.
# The Kind pod is the sandbox. agent-browser talks to this same binary over CDP.
RUN printf '%s\n' \
      '#!/bin/sh' \
      'exec /usr/bin/chromium \' \
      '  --no-sandbox \' \
      '  --disable-gpu \' \
      '  --disable-dev-shm-usage \' \
      '  --disable-software-rasterizer \' \
      '  --remote-debugging-port=${CDP_PORT:-9222} \' \
      '  --remote-debugging-address=127.0.0.1 \' \
      '  --no-first-run \' \
      '  --no-default-browser-check \' \
      '  --disable-sync \' \
      '  --disable-features=TranslateUI,MediaRouter \' \
      '  --password-store=basic \' \
      '  --user-data-dir="${HOME}/.config/chromium" \' \
      '  "$@"' \
      > /usr/local/bin/chromium \
    && chmod +x /usr/local/bin/chromium \
    && mkdir -p /etc/chromium \
    && printf '%s\n' 'CHROMIUM_FLAGS="--no-sandbox --disable-gpu --disable-dev-shm-usage --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 --no-first-run"' \
      > /etc/chromium/chromium.conf

# Musl build of vercel-labs/agent-browser, pointed at system Chromium.
# Do not overwrite npm's bin link — a self-symlink here makes a loop.
# 0.28+ ships `agent-browser mcp` (stdio). 0.27 in the previous image had no mcp command.
RUN npm install -g agent-browser@0.35.1 \
    && npm cache clean --force \
    && test -x /usr/local/lib/node_modules/agent-browser/bin/agent-browser-linux-musl-x64 \
    && ln -sfn /usr/local/lib/node_modules/agent-browser/bin/agent-browser.js /usr/local/bin/agent-browser \
    && chmod +x /usr/local/lib/node_modules/agent-browser/bin/agent-browser.js \
                /usr/local/lib/node_modules/agent-browser/bin/agent-browser-linux-musl-x64 \
    && agent-browser --version \
    && agent-browser mcp --help >/dev/null

RUN adduser -D -u 1000 -s /bin/bash agent \
    && echo 'agent ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/agent \
    && chmod 440 /etc/sudoers.d/agent \
    && mkdir -p /workspace /tmp/runtime-agent \
    && chown -R agent:agent /home/agent /workspace /tmp/runtime-agent

COPY --from=bunbin /usr/local/bin/bun /usr/local/bin/bun
COPY vendor/mcp /opt/mcp
COPY vendor/agl /opt/vendor/agl
COPY vendor/angela /opt/vendor/angela
COPY agent /opt/agent
COPY vendor/certs /opt/certs
COPY scripts/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY scripts/xfce-session.sh /usr/local/bin/xfce-session.sh
COPY desktop/ /etc/skel/.config/
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/xfce-session.sh \
    && mkdir -p /home/agent/.config /home/agent/.bun \
    && cp -a /etc/skel/.config/. /home/agent/.config/ \
    && chown -R agent:agent /home/agent /opt/agent /opt/mcp /opt/vendor /opt/certs /workspace

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
EXPOSE 6080 5900 9222 8091
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/entrypoint.sh"]
