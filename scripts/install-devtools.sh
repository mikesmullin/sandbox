#!/bin/bash
# Install current stable toolchains into the desktop image.
# Invoked from Dockerfile as root. Latest versions are resolved at build time.
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
export PYENV_ROOT=/opt/pyenv
export RBENV_ROOT=/opt/rbenv
export RUSTUP_HOME=/opt/rustup
export CARGO_HOME=/opt/cargo
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) GOARCH=amd64; NODEARCH=x64; ZIGARCH=x86_64 ;;
  aarch64|arm64) GOARCH=arm64; NODEARCH=arm64; ZIGARCH=aarch64 ;;
  *) echo "unsupported arch: $ARCH" >&2; exit 1 ;;
esac

log() { printf '[devtools] %s\n' "$*"; }

apt-get update
apt-get install -y --no-install-recommends \
  build-essential ca-certificates curl wget git xz-utils unzip tar gnupg pkg-config \
  libssl-dev zlib1g-dev libbz2-dev libreadline-dev libsqlite3-dev libncursesw5-dev \
  libffi-dev liblzma-dev libxml2-dev libxmlsec1-dev tk-dev libyaml-dev \
  libcurl4-openssl-dev libexpat1-dev gettext cmake \
  autoconf bison libgdbm-dev

# --- GitHub CLI (apt repo tracks latest gh) ---
install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  -o /etc/apt/keyrings/githubcli-archive-keyring.gpg
chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  > /etc/apt/sources.list.d/github-cli.list
apt-get update
apt-get install -y gh

# --- rust (stable) first — git 2.55+ links libgitcore via cargo ---
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
  | sh -s -- -y --no-modify-path --default-toolchain stable
ln -sfn /opt/cargo/bin/rustc /usr/local/bin/rustc
ln -sfn /opt/cargo/bin/cargo /usr/local/bin/cargo
ln -sfn /opt/cargo/bin/rustup /usr/local/bin/rustup
export PATH="/opt/cargo/bin:/usr/local/bin:$PATH"

# --- git (build latest stable tag) ---
GIT_VER="$(curl -fsSL https://api.github.com/repos/git/git/tags \
  | python3 -c 'import json,re,sys
try:
    tags=json.load(sys.stdin)
except Exception:
    tags=[]
for t in tags:
    n=str(t.get("name") or "").lstrip("v")
    if re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", n):
        print(n); break
' || true)"
GIT_VER="${GIT_VER:-2.51.0}"
log "git $GIT_VER"
curl -fsSL "https://codeload.github.com/git/git/tar.gz/refs/tags/v${GIT_VER}" \
  | tar -xz -C /tmp
make -C "/tmp/git-${GIT_VER}" prefix=/usr/local all -j"$(nproc)"
make -C "/tmp/git-${GIT_VER}" prefix=/usr/local install
rm -rf "/tmp/git-${GIT_VER}"

# --- Node.js + npm (newest Current) ---
NODE_VER="$(curl -fsSL https://nodejs.org/dist/index.json \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["version"].lstrip("v"))')"
log "node $NODE_VER"
mkdir -p /opt/node
curl -fsSL "https://nodejs.org/dist/v${NODE_VER}/node-v${NODE_VER}-linux-${NODEARCH}.tar.xz" \
  | tar -xJ -C /opt/node --strip-components=1
ln -sfn /opt/node/bin/node /usr/local/bin/node
ln -sfn /opt/node/bin/npm /usr/local/bin/npm
ln -sfn /opt/node/bin/npx /usr/local/bin/npx
ln -sfn /opt/node/bin/corepack /usr/local/bin/corepack 2>/dev/null || true

# --- bun (latest) ---
export BUN_INSTALL=/usr/local
curl -fsSL https://bun.sh/install | bash
# installer may land in /usr/local/bin/bun already

# --- uv (latest) ---
export UV_INSTALL_DIR=/usr/local/bin
curl -LsSf https://astral.sh/uv/install.sh | sh
# also a current CPython for `uv run` / `uv python`
uv python install 3

# --- pyenv + latest CPython 3.x + pip ---
if [ ! -d "$PYENV_ROOT/.git" ]; then
  git clone --depth 1 https://github.com/pyenv/pyenv.git "$PYENV_ROOT"
fi
export PATH="$PYENV_ROOT/bin:$PATH"
PY_VER="$("$PYENV_ROOT/bin/pyenv" install -l | sed 's/^[[:space:]]*//' | grep -E '^3\.[0-9]+\.[0-9]+$' | tail -1)"
log "pyenv python $PY_VER"
MAKE_OPTS="-j$(nproc)" PYTHON_CONFIGURE_OPTS="--enable-shared" \
  "$PYENV_ROOT/bin/pyenv" install -s "$PY_VER"
"$PYENV_ROOT/bin/pyenv" global "$PY_VER"
"$PYENV_ROOT/bin/pyenv" rehash
ln -sfn "$PYENV_ROOT/versions/${PY_VER}/bin/python3" /usr/local/bin/python
ln -sfn "$PYENV_ROOT/versions/${PY_VER}/bin/python3" /usr/local/bin/python3
ln -sfn "$PYENV_ROOT/versions/${PY_VER}/bin/pip3" /usr/local/bin/pip
ln -sfn "$PYENV_ROOT/versions/${PY_VER}/bin/pip3" /usr/local/bin/pip3

# --- golang ---
GO_VER="$(curl -fsSL 'https://go.dev/VERSION?m=text' | head -1 || true)"
GO_VER="${GO_VER:-go1.25.0}"
log "go $GO_VER"
rm -rf /usr/local/go
curl -fsSL "https://go.dev/dl/${GO_VER}.linux-${GOARCH}.tar.gz" \
  | tar -xz -C /usr/local
ln -sfn /usr/local/go/bin/go /usr/local/bin/go
ln -sfn /usr/local/go/bin/gofmt /usr/local/bin/gofmt

# --- zig (latest stable, not master) ---
ZIG_VER="$(curl -fsSL https://ziglang.org/download/index.json \
  | python3 -c 'import json,sys
idx=json.load(sys.stdin)
vers=[k for k in idx if k[:1].isdigit()]
vers.sort(key=lambda s: [int(x) for x in s.split(".")])
print(vers[-1])
')"
log "zig $ZIG_VER"
ZIG_URL="$(curl -fsSL https://ziglang.org/download/index.json \
  | python3 -c 'import json,sys
idx=json.load(sys.stdin)
ver=sys.argv[1]; arch=sys.argv[2]
print(idx[ver][arch+"-linux"]["tarball"])
' "$ZIG_VER" "$ZIGARCH")"
mkdir -p /opt/zig
curl -fsSL "$ZIG_URL" | tar -xJ -C /opt/zig --strip-components=1
ln -sfn /opt/zig/zig /usr/local/bin/zig

# --- ruby via rbenv + latest stable ---
if [ ! -d "$RBENV_ROOT/.git" ]; then
  git clone --depth 1 https://github.com/rbenv/rbenv.git "$RBENV_ROOT"
fi
mkdir -p "$RBENV_ROOT/plugins"
if [ ! -d "$RBENV_ROOT/plugins/ruby-build/.git" ]; then
  git clone --depth 1 https://github.com/rbenv/ruby-build.git "$RBENV_ROOT/plugins/ruby-build"
fi
export PATH="$RBENV_ROOT/bin:$PATH"
RB_VER="$("$RBENV_ROOT/bin/rbenv" install -l | sed 's/^[[:space:]]*//' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | tail -1)"
log "rbenv ruby $RB_VER"
MAKE_OPTS="-j$(nproc)" "$RBENV_ROOT/bin/rbenv" install -s "$RB_VER"
"$RBENV_ROOT/bin/rbenv" global "$RB_VER"
"$RBENV_ROOT/bin/rbenv" rehash
"$RBENV_ROOT/versions/${RB_VER}/bin/gem" install bundler --no-document
ln -sfn "$RBENV_ROOT/versions/${RB_VER}/bin/ruby" /usr/local/bin/ruby
ln -sfn "$RBENV_ROOT/versions/${RB_VER}/bin/gem" /usr/local/bin/gem
ln -sfn "$RBENV_ROOT/versions/${RB_VER}/bin/bundle" /usr/local/bin/bundle

# world-usable by user `agent`
chown -R agent:agent \
  /opt/pyenv /opt/rbenv /opt/rustup /opt/cargo /opt/node /opt/zig 2>/dev/null || true

rm -rf /var/lib/apt/lists/* /tmp/*

log "installed versions:"
{
  git --version
  gh --version | head -1
  python3 --version
  pip3 --version
  uv --version
  node --version
  npm --version
  bun --version
  rustc --version
  cargo --version
  go version
  zig version
  ruby --version
} | while IFS= read -r line; do log "$line"; done

for cmd in git gh python3 pip3 uv node npm bun rustc cargo go zig ruby; do
  command -v "$cmd" >/dev/null || { log "MISSING $cmd"; exit 1; }
done
log "ok"
