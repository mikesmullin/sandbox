//! sbox B-SIDE — the headless backend.
//!
//! Serves NO static assets and NO frontend: the SPA is the sbox-a satellite,
//! which proxies `/api/*` here. Routes are matched by prefix in registration
//! order, so the orchestration entries must precede the `/api/` catch-all —
//! the same ordering discipline the Node `server.mjs` documented.

mod api;
mod config;
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
    println!("sbox-b  image={}  runtime={runtime}", api::containers::sandbox_image());

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
        .route("/api/", |req: Request| async move { api::handlers::handle(req).await });

    if let Err(e) = server.run(&host, port).await {
        eprintln!("sbox-b: {e}");
        std::process::exit(1);
    }
}
