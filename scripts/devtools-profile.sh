# shellcheck shell=sh
# Sourced from /etc/profile.d and the desktop entrypoint.
export PYENV_ROOT="${PYENV_ROOT:-/opt/pyenv}"
export RBENV_ROOT="${RBENV_ROOT:-/opt/rbenv}"
export RUSTUP_HOME="${RUSTUP_HOME:-/opt/rustup}"
export CARGO_HOME="${CARGO_HOME:-/opt/cargo}"
export GOPATH="${GOPATH:-$HOME/go}"
devtools_path="/opt/pyenv/bin:/opt/pyenv/shims:/opt/rbenv/bin:/opt/rbenv/shims:/opt/cargo/bin:/usr/local/go/bin:/opt/node/bin:/opt/zig"
case ":$PATH:" in
  *":/opt/pyenv/shims:"*) ;;
  *) PATH="${devtools_path}:$PATH" ;;
esac
export PATH
unset devtools_path
