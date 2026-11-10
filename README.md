# sbox-a — the sandbox wall

The frontend half of **sbox**: a wall of live sandbox desktops, written in
Rust and compiled to wasm. It owns no API logic — every `/api/*` call is
forwarded to [`sbox-b`](../sbox-b).

```
   edit app/**.rs ──► cargo build --target wasm32 ──► wasm-bindgen ──► web/pkg/*
        │                                                                  │
        │                        /__m_hmr  (one websocket)                 │
        └── sbox-a-server ◄────────────────────────────────────────────────┘
                   │                                   │
                   │  /api/*  ──► sbox-b  :3000        ▼
                   │  /ajcs/* ──► AJCS    :4482     new wasm instance,
                   │                                M.unmount() → M.mount()
                   ▼                                page never reloads,
            static + HMR + wasm rebuild             stores survive
```

## Run it

```bash
cd ../sbox-b && cargo run &   # the backend must be up, or the wall polls red
./dev.sh                      # → http://127.0.0.1:3010
./dev.sh 4000                 # another port
./dev.sh --rebuild            # force a fresh wasm build on start
```

`dev.sh` installs the pinned `wasm-bindgen` CLI into `tools/` and the
`wasm32-unknown-unknown` target if either is missing, then hands the process
to the rustex1 dev server, which builds the frontend before answering the
first request.

| you edit | what happens |
|---|---|
| `app/**.rs` | wasm rebuild (~350 ms), hot-swapped — **no reload, state kept** |
| `server/**.rs` | server rebuild, process re-execs itself, client reconnects |
| `web/styles.css` | `<link>` cache-busted in place, zero redraws |
| `web/index.html` | full reload (the document shell changed) |

A compile error does not kill the dev server or cover the page: the last good
build keeps running and the error goes to the terminal.

## Layout

```
sbox-a/
├── app/src/
│   ├── lib.rs       impl App — stores, routes, the 1s poll
│   ├── store.rs     the one store: containers, selection, viewer URLs, permalinks
│   └── pages.rs     the wall + detail tree (m() hyperscript, not markup)
├── server/src/
│   ├── main.rs      Server::new(config).raw("/api/", …).raw("/ajcs/", …)
│   └── proxy.rs     the two streamed forwards
├── web/
│   ├── index.html   the document shell
│   └── styles.css   this app's type and colour (the kit skin loads first)
├── vendor/rustex1   the kit + dev server (submodule)
└── rustex1.json     packages, port, watch and static roots
```

There is no JavaScript in this repository. The only JS on the client is the
two bridge files the rustex1 kit provides (`app.mjs` boots the wasm,
`hot.mjs` speaks the hot-reload protocol) plus the m-js bundle doing the
rendering.

## The UI contract

- The **tile head** selects — it builds the batch for *− remove*, and never
  drills down.
- The **screen overlay** is a barrier: it selects an unpicked tile, and drills
  into an already-picked one.
- The detail view is addressable — `#/sandboxes/<id>` lands a box in full view,
  written with `replaceState` so Back stays sane, and cleared by the poll when
  the box disappears.
- A box without a `backref` renders **no** run chip, not a placeholder.
- The logomark is the health indicator: it goes red when polls stop landing.

Tiles are fill-tiled at `ceil(sqrt(n))` columns, capped at 4.

## Environment

| var | default | meaning |
|---|---|---|
| `SANDBOX_API_ORIGIN` | `http://127.0.0.1:3000` | the sbox-b backend |
| `SANDBOX_AJCS_ORIGIN` | `http://127.0.0.1:4482` | the AJCS core; `/ajcs/<rest>` → `/v1/<rest>` |

## Clone it

The kit is a submodule, so:

```bash
git clone <this repo> && cd sbox-a
git submodule update --init --recursive
```
