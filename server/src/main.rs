//! sbox A-SIDE — the frontend web app: the SPA (wall + detail), served by the
//! rustex1 dev server (static + HMR + wasm rebuild + self-restart).
//!
//! Owns NO API logic — every `/api/*` call forwards to the headless backend
//! (sbox-b, default http://127.0.0.1:3000) and every `/ajcs/*` call to the
//! AJCS core, both through src/proxy.rs.

mod proxy;

use rustex1_devserver::{args_to_config, Config, Server};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let root = std::env::current_dir().expect("current dir");
    let (config, rebuild) = args_to_config(&args, Config::discover(&root));

    // Two forwards, same streamed machinery: /api/ rides to the b-side
    // backend verbatim (the SPA's data plane); /ajcs/ rides to the AJCS core
    // path-mapped /ajcs/<rest> => /v1/<rest> (the run chip's state fetch).
    let mut server = Server::new(config)
        .raw("/api/", proxy::handle_api)
        .raw("/ajcs/", proxy::handle_ajcs);
    if rebuild {
        server = server.rebuild_on_start();
    }
    server.run();
}
