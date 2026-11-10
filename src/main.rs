//! sbox B-SIDE — the headless backend.
//!
//! Serves NO static assets and NO frontend: the SPA is the sbox-a satellite,
//! which proxies `/api/*` here. Routes are matched by prefix in registration
//! order, so the orchestration entries must precede the `/api/` catch-all —
//! the same ordering discipline the Node `server.mjs` documented.

mod api;
mod config;
mod lan_token;
mod http;
mod util;

use http::{Request, Response, Server};

const DEFAULT_PORT: u16 = 3000;

#[tokio::main]
async fn main() {
    let host = std::env::var("HOST").unwrap_or_else(|_| "127.0.0.1".into());
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(DEFAULT_PORT);

    let runtime = match api::container_cli::runtime() {
        Ok(rt) => format!("{} ({:?})", rt.bin, rt.kind),
        Err(e) => format!("none — {e}"),
    };
    println!(
        "sbox-b  images=[{}]  runtime={runtime}",
        api::images::all_images().join(", ")
    );
    // Touch the token once at boot so a fresh install prints it here rather
    // than on whichever request happens to be first.
    let _ = lan_token::token();

    // Dispatch is in registration order, so the two orchestration entries must
    // precede the `/api/` catch-all — the catch-all would otherwise 404 them.
    let server = Server::new()
        .route("/healthz", |_req: Request| async move {
            Response::ok(serde_json::json!({ "ok": true }))
        })
        // The MCP/exec driver claims ONLY the sandbox /mcp and /exec sub-paths
        // (the two driver facades), so every other /api/orchestration/* path
        // still falls through to the lifecycle handler below.
        .route("/api/orchestration/sandboxes/", |req: Request| async move {
            if api::mcp_driver::claims(&req.path) {
                api::mcp_driver::handle(req).await
            } else {
                api::orchestration::handle(req).await
            }
        })
        .route("/api/orchestration", |req: Request| async move {
            api::orchestration::handle(req).await
        })
        // The host-level MCP tool server (SBOX_PLAN1 §3.1). Bearer-token
        // authenticated on every call, including loopback — this is the plane
        // that creates containers with host mounts and runs shell in them.
        .route("/mcp", |req: Request| async move { api::mcp_server::handle(req).await })
        // The tool-call journal the wall tails: ?after=<seq> for the tail.
        .route("/api/journal", |req: Request| async move {
            let after = req
                .query
                .get("after")
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(0);
            Response::ok(serde_json::json!({
                "entries": api::journal::since(after, 500),
                "head": api::journal::head(),
            }))
        })
        .route("/api/", |req: Request| async move { api::handlers::handle(req).await });

    if let Err(e) = server.run(&host, port).await {
        eprintln!("sbox-b: {e}");
        std::process::exit(1);
    }
}
