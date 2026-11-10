//! Container lifecycle — all `container` invocations go through container_cli.
//!
//! Desktops are cua-spacesd images: :3211 (gRPC/MCP/viewer) + :3212/udp (QUIC).
//! The argv built here is always the Apple `container` dialect; container_cli
//! owns the runtime port (real `container` on macOS, podman/docker elsewhere)
//! and re-shapes `ls`/`inspect` output back into what this file parses.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::Sha256;

use super::container_cli as cli;
use super::images;
use super::orchestration_store;
use super::spacesd;
use crate::http::client;
use crate::util;

/// Spacesd port inside the guest (gRPC + gRPC-Web + /mcp + /media + /viewer).
pub const GUEST_MCP_PORT: u16 = 3211;
/// Spacesd QUIC media port inside the guest (UDP).
pub const GUEST_QUIC_PORT: u16 = 3212;
/// execd (guest exec MCP server) — the only daemon a headless sandbox runs.
pub const GUEST_EXEC_PORT: u16 = 3213;

/// Path served by spacesd once the desktop is actually up. Used to distinguish
/// a "port is published" container from one whose daemon is genuinely serving.
const HEALTH_PATH: &str = "/health";
/// execd's equivalent, for headless sandboxes (docs/execd-contract.md).
const EXEC_HEALTH_PATH: &str = "/healthz";
/// Max time to wait for a probe to respond before treating it as down.
const HEALTH_TIMEOUT: Duration = Duration::from_millis(1500);
/// Once confirmed-up, trust the probe for this long without re-fetching.
const KNOWN_GOOD_TTL: Duration = Duration::from_secs(30);

/// The default sandbox image — the headed one, which is what the wall's
/// "+ new box" creates. `images::all_images()` is the set the wall *lists*.
pub fn sandbox_image() -> String {
    images::Kind::Headed.image()
}

// ── tokens ──────────────────────────────────────────────────────────────────

/// Per-container spacesd token: HMAC(server secret, container id). The secret
/// is generated once and persisted at `.cua-secret` (or CUA_TOKEN_SECRET).
/// Deterministic so tokens survive server restarts without a store.
pub fn container_token(container_id: &str) -> String {
    let mut mac = <Hmac<Sha256>>::new_from_slice(token_secret().as_bytes())
        .expect("HMAC accepts a key of any length");
    mac.update(container_id.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

fn token_secret() -> String {
    if let Ok(s) = std::env::var("CUA_TOKEN_SECRET") {
        return s;
    }
    let path = util::project_root().join(".cua-secret");
    if let Ok(existing) = std::fs::read_to_string(&path) {
        let trimmed = existing.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    let secret = util::random_hex(32);
    util::write_private(&path, &format!("{secret}\n"));
    secret
}

// ── listing ─────────────────────────────────────────────────────────────────

#[derive(Clone, Debug)]
pub struct Row {
    pub id: String,
    pub image: String,
    pub state: String,
    pub ip: String,
}

/// Parse `container ls` into rows. Mirrors the column discipline the Node
/// parser used: a row needs at least 9 whitespace-separated fields, and the
/// columns read are 0=id, 1=image, 4=state, 5=addr.
pub fn parse_ls(stdout: &str) -> Vec<Row> {
    stdout
        .split('\n')
        .skip(1) // header
        .filter_map(|line| {
            let parts: Vec<&str> = line.trim().split_whitespace().collect();
            if parts.len() < 9 {
                return None;
            }
            Some(Row {
                id: parts[0].to_string(),
                image: parts[1].to_string(),
                state: parts[4].to_string(),
                ip: parts[5].to_string(),
            })
        })
        .collect()
}

pub async fn list_containers() -> Result<Vec<Row>, String> {
    let out = cli::run_str(&["ls"]).await?;
    if out.failed() {
        return Err(format!("container ls failed: {}", out.message()));
    }
    Ok(parse_ls(&out.stdout))
}

/// Get container details via `container inspect` (already normalized by the
/// runtime port into `[{ configuration, status }]`).
pub async fn inspect_container(id_or_name: &str) -> Result<Value, String> {
    let out = cli::run_str(&["inspect", id_or_name]).await?;
    if out.failed() {
        return Err(format!("container inspect failed: {}", out.message()));
    }
    serde_json::from_str(&out.stdout).map_err(|e| format!("inspect: unparsable output: {e}"))
}

async fn published_port(id: &str, guest_port: u16) -> Option<u16> {
    let inspected = match inspect_container(id).await {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[containers] inspect {id}: {e}");
            return None;
        }
    };
    let ports = inspected
        .get(0)?
        .pointer("/configuration/publishedPorts")?
        .as_array()?
        .clone();
    ports.iter().find_map(|entry| {
        let container_port = entry.get("containerPort")?.as_u64()?;
        let proto = entry.get("proto")?.as_str()?;
        if container_port == guest_port as u64 && proto == "tcp" {
            entry.get("hostPort")?.as_u64().map(|p| p as u16)
        } else {
            None
        }
    })
}

// ── readiness ───────────────────────────────────────────────────────────────

fn known_good() -> &'static Mutex<HashMap<String, Instant>> {
    static MAP: std::sync::OnceLock<Mutex<HashMap<String, Instant>>> = std::sync::OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Probe whether a sandbox's agent daemon is actually serving.
///
/// The path differs by kind because the daemon does: spacesd answers
/// `/health`, execd answers `/healthz`.
pub async fn probe_serving(host: &str, port: u16, kind: images::Kind) -> bool {
    let path = if kind.has_desktop() {
        HEALTH_PATH
    } else {
        EXEC_HEALTH_PATH
    };
    client::request(host, port, "GET", path, &[], None, HEALTH_TIMEOUT)
        .await
        .map(|r| r.ok())
        .unwrap_or(false)
}

/// Read-only "is spacesd serving" check, with a short TTL so an already-booted
/// container is not hammered on every poll.
pub async fn is_serving(container_id: &str, host: &str, port: u16, kind: images::Kind) -> bool {
    if let Ok(map) = known_good().lock() {
        if let Some(at) = map.get(container_id) {
            if at.elapsed() < KNOWN_GOOD_TTL {
                return true;
            }
        }
    }
    let serving = probe_serving(host, port, kind).await;
    if let Ok(mut map) = known_good().lock() {
        if serving {
            map.insert(container_id.to_string(), Instant::now());
        } else {
            map.remove(container_id);
        }
    }
    serving
}

/// Forget a container's cached readiness (used on delete so a recycled name
/// cannot inherit the previous container's "known good" stamp).
pub fn forget_readiness(container_id: &str) {
    if let Ok(mut map) = known_good().lock() {
        map.remove(container_id);
    }
}

// ── the wall's view ─────────────────────────────────────────────────────────

pub async fn get_container_list() -> Result<Vec<Value>, String> {
    // Both rows of the image matrix belong on the wall; a headless box is
    // still a sandbox, it just has nothing to show in its tile.
    let images = images::all_images();
    let rows: Vec<Row> = list_containers()
        .await?
        .into_iter()
        .filter(|c| images.iter().any(|i| *i == c.image))
        .collect();

    // The wall marks the active sandbox — the one the host MCP tools act on
    // when a client names none.
    let active = super::orchestration::active_id();
    let mut out = Vec::with_capacity(rows.len());
    for c in rows {
        let kind = images::Kind::of_image(&c.image);
        // A headless box never binds 3211; its readiness (and its only agent
        // plane) lives on the exec port instead.
        let probe_guest_port = if kind.has_desktop() {
            GUEST_MCP_PORT
        } else {
            GUEST_EXEC_PORT
        };
        let mcp_port = published_port(&c.id, probe_guest_port).await;
        let mcp_host = mcp_port.map(|_| "127.0.0.1");
        let running_with_port = c.state == "running" && mcp_port.is_some();
        let ready = match (running_with_port, mcp_host, mcp_port) {
            (true, Some(h), Some(p)) => is_serving(&c.id, h, p, kind).await,
            _ => false,
        };
        // Orchestration-tracked boxes carry their caller's backref (non-secret
        // label, verbatim); CLI-derived boxes with no record have no key.
        let backref = orchestration_store::backref_for(&c.id);
        let short_id: String = c.id.chars().rev().take(6).collect::<Vec<_>>().into_iter().rev().collect();
        let mut entry = json!({
            "id": c.id,
            "shortId": short_id,
            "image": c.image,
            "state": c.state,
            "ip": c.ip,
            "mcpHost": mcp_host,
            "mcpPort": mcp_port,
            "ready": ready,
            "kind": kind.as_str(),
            "active": active.as_deref() == Some(c.id.as_str()),
        });
        if let Some(b) = backref {
            entry["backref"] = b;
        }
        out.push(entry);
    }
    Ok(out)
}

// ── lifecycle ───────────────────────────────────────────────────────────────

pub struct Created {
    pub id: String,
    pub mcp_port: u16,
    pub quic_port: u16,
}

/// Create a new desktop container with spacesd ports published and the
/// per-container token injected (the daemon refuses non-loopback binds without
/// it; Apple publishes ports on host loopback only).
pub async fn create_container(opts: &Value) -> Result<Created, String> {
    let cpus = opts.get("cpus").and_then(Value::as_u64).unwrap_or(4);
    let memory = opts
        .get("memory")
        .and_then(Value::as_str)
        .unwrap_or("2048M")
        .to_string();
    let image = opts
        .get("image")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(sandbox_image);

    let container_id = format!("sandbox2-desktop-{}", util::random_hex(3));
    let mcp_port = util::allocate_host_port()?;
    let quic_port = util::allocate_host_port()?;

    let argv: Vec<String> = vec![
        "create".into(),
        "-p".into(),
        format!("{mcp_port}:{GUEST_MCP_PORT}"),
        "-p".into(),
        format!("{quic_port}:{GUEST_QUIC_PORT}/udp"),
        "-c".into(),
        cpus.to_string(),
        "-m".into(),
        memory,
        "--name".into(),
        container_id.clone(),
        "-e".into(),
        format!("CUA_ENV_TOKEN={}", container_token(&container_id)),
        image,
    ];

    let created = cli::run(&argv).await?;
    if created.failed() {
        return Err(format!("container create failed: {}", created.message()));
    }

    // Start immediately after creation; on failure leave no dead container.
    if let Err(e) = start_container(&container_id).await {
        if let Err(cleanup) = delete_container(&container_id).await {
            eprintln!("[containers] cleanup after start failure: {cleanup}");
        }
        return Err(e);
    }

    Ok(Created {
        id: container_id,
        mcp_port,
        quic_port,
    })
}

pub async fn start_container(id_or_name: &str) -> Result<(), String> {
    let out = cli::run_str(&["start", id_or_name]).await?;
    if out.failed() {
        return Err(format!("container start failed: {}", out.message()));
    }
    Ok(())
}

pub async fn stop_container(id_or_name: &str) -> Result<(), String> {
    let out = cli::run_str(&["stop", id_or_name]).await?;
    if out.failed() {
        return Err(format!("container stop failed: {}", out.message()));
    }
    Ok(())
}

pub async fn delete_container(id_or_name: &str) -> Result<(), String> {
    let out = cli::run_str(&["rm", id_or_name]).await?;
    forget_readiness(id_or_name);
    if out.failed() {
        return Err(format!("container delete failed: {}", out.message()));
    }
    Ok(())
}

/// Mint a fresh viewer ticket for a container and return the full viewer URL
/// for a browser iframe. Mint a new one per tile load — tickets are short-lived
/// and single-flow; reuse across rapid reloads is unreliable.
pub async fn mint_viewer_url(id: &str) -> Result<String, String> {
    let containers = get_container_list().await?;
    let found = containers
        .iter()
        .find(|c| c.get("id").and_then(Value::as_str) == Some(id));
    let container = match found {
        Some(c) if c.get("ready").and_then(Value::as_bool) == Some(true) => c,
        _ => return Err(format!("container unavailable: {id}")),
    };
    let port = container
        .get("mcpPort")
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("container unavailable: {id}"))? as u16;

    let ticket = spacesd::mint_viewer_ticket(port, &container_token(id), None).await?;
    Ok(format!("http://127.0.0.1:{port}{}", ticket.viewer_path))
}

/// Capture the sandbox desktop as a base64 PNG.
///
/// Goes through spacesd rather than shelling into the guest: spacesd already
/// owns the X display and returns an encoded frame, so there is no ImageMagick
/// dependency and no binary riding back through a CLI pipe.
///
/// The tool is `get_desktop_state` — spacesd exposes no tool called
/// "screenshot". It is the capture primitive agents are meant to use ("Capture
/// the full display in the desktop action coordinate frame … use the returned
/// PNG directly as the coordinate source for actions"), so the frame it
/// returns is the one a click would be aimed against.
pub async fn capture_screen(record: &crate::api::orchestration_store::Record) -> Result<String, String> {
    let reply = super::mcp_driver::call_gui_tool(
        record,
        "get_desktop_state",
        serde_json::json!({ "max_image_dimension": 1600 }),
    )
    .await?;
    // The tool answers an MCP image content block; pull the base64 payload out.
    let blocks = reply
        .get("content")
        .and_then(Value::as_array)
        .ok_or_else(|| "spacesd screenshot returned no content".to_string())?;
    for block in blocks {
        if block.get("type").and_then(Value::as_str) == Some("image") {
            if let Some(data) = block.get("data").and_then(Value::as_str) {
                return Ok(data.to_string());
            }
        }
    }
    Err("spacesd screenshot returned no image block".into())
}
