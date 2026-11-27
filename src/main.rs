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
    let _ = lan_token::token();

    let server = Server::new()
        .route("/healthz", |_req: Request| async move {
            Response::ok(serde_json::json!({ "ok": true }))
        })
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
        .route("/mcp", |req: Request| async move { api::mcp_server::handle(req).await })
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
