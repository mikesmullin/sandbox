use serde_json::{json, Value};

use super::containers;
use super::snapshots;
use crate::config;
use crate::http::{Request, Response};

pub async fn handle(req: Request) -> Response {
    let parts = req.segments();
    let rest: Vec<&str> = parts.into_iter().skip(1).collect();
    let resource = rest.first().copied().unwrap_or("");
    let id = rest.get(1).copied();
    let action = rest.get(2).copied();
    let method = req.method.as_str();

    match (method, resource, id, action) {
        ("GET", "containers", None, _) => match containers::get_container_list().await {
            Ok(list) => Response::ok(json!({ "containers": list })),
            Err(e) => Response::error(500, e),
        },

        ("GET", "config", None, _) => {
            let viewer = config::app_config()
                .get("viewer")
                .cloned()
                .unwrap_or_else(|| json!({}));
            let viewer = if viewer.is_object() { viewer } else { json!({}) };
            Response::ok(json!({ "viewer": viewer }))
        }

        ("GET", "containers", Some(id), Some("viewer")) => {
            match containers::mint_viewer_url(id).await {
                Ok(url) => Response::ok(json!({ "url": url })),
                Err(e) => Response::error(503, e),
            }
        }

        ("GET", "containers", Some(id), Some("thumb")) => match snapshots::read_snapshot(id) {
            Ok(img) => Response::bytes(200, "image/png", img).with_header("cache-control", "no-cache"),
            Err(e) => Response::error(404, e),
        },

        ("GET", "containers", Some(id), None) => match containers::inspect_container(id).await {
            Ok(info) => {
                let mut body = json!({ "id": id });
                if let Value::Object(map) = &mut body {
                    map.insert("inspect".into(), info);
                }
                Response::ok(body)
            }
            Err(e) => Response::error(404, e),
        },

        ("POST", "containers", None, _) => {
            let body = req.json().unwrap_or_else(|| json!({}));
            match containers::create_container(&body).await {
                Ok(c) => Response::json(
                    201,
                    json!({
                        "id": c.id,
                        "state": "running",
                        "mcpPort": c.mcp_port,
                        "quicPort": c.quic_port,
                    }),
                ),
                Err(e) => Response::error(500, e),
            }
        }

        ("POST", "containers", Some(id), Some("snapshot")) => {
            match snapshots::capture_snapshot(id).await {
                Some(snap) => Response::ok(snap),
                None => Response::error(501, "Screenshot not supported"),
            }
        }

        ("DELETE", "containers", Some(id), None) => {
            if let Err(e) = containers::stop_container(id).await {
                return Response::error(500, e);
            }
            match containers::delete_container(id).await {
                Ok(()) => Response::ok(json!({ "deleted": id })),
                Err(e) => Response::error(500, e),
            }
        }

        _ => Response::error(404, "API not found"),
    }
}
