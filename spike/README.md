# spike/

Upstream reference material for the desktop image. Not built, not run — read.

## cua-ref/

A copy of the files [trycua/cua](https://github.com/trycua/cua) ships for its
own Linux desktop image, plus the `cua.env.v1` protobuf definitions.
`desktop/` is derived from these, so when something in the guest misbehaves
this is the "what does upstream actually do here?" answer without a network
round-trip or a guess:

| file | what it settles |
|---|---|
| `Dockerfile`, `image.json` | the package set and layout a working cua desktop image has |
| `entrypoint.sh`, `start-desktop.sh`, `supervisord.conf` | boot order: dbus → Xvfb → session → audio → spacesd |
| `start-audio.sh`, `10-cua-virtual-devices.conf` | the headless PipeWire setup (`desktop/pipewire/` is a byte-identical copy) |
| `ensure-env-token.sh`, `env-token-mode.sh` | how the env token is materialized before the daemon binds |
| `start-spacesd.sh`, `cua-spacesd.service` | the daemon's own flags and supervision |
| `healthcheck.sh` | the readiness signal the backend's probe mirrors (`/health`) |
| `build-spacesd-linux.sh` | upstream's build recipe, which `desktop/build-spacesd.sh` diverges from (musl + our two patches) |
| `proto/*.proto` | the wire contract — the viewer-ticket call in `src/api/spacesd.rs` is hand-rolled against `system.proto` |

## Why it stays

Two things in this repo are written directly against upstream internals and
will break when upstream moves:

1. **`desktop/build-spacesd.sh` patches cua's source at build time** — the
   viewer CSP and the musl desktop gates. When a patch anchor moves, the diff
   between `cua-ref/` and the new upstream tree is where the replacement
   anchor is found.
2. **`src/api/spacesd.rs` speaks hand-rolled protobuf** over gRPC-Web, with no
   generated stubs. `proto/system.proto` is the only description of the field
   numbers it encodes and parses.

Refresh it by re-copying from a current checkout of upstream when either of
those is being rebased; nothing here is consumed by a build.
