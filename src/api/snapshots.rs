//! Snapshot and thumbnail service.
//!
//! Capture runs ImageMagick's `import` inside the guest through the container
//! CLI. The desktop image does not ship ImageMagick today, so this is a
//! best-effort path: a failure answers `None` and the route turns that into a
//! 501, exactly as the Node version did.

use std::path::PathBuf;
use std::process::Stdio;

use serde_json::{json, Value};
use tokio::process::Command;

use super::container_cli as cli;

fn snap_dir() -> PathBuf {
    PathBuf::from(
        std::env::var("SBOX_SNAPSHOT_DIR").unwrap_or_else(|_| "/tmp/sandbox2-snapshots".into()),
    )
}

fn now_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Capture a snapshot (screenshot) of a container's desktop.
///
/// Unlike every other CLI call this one wants BINARY stdout, so it spawns the
/// runtime binary directly rather than going through `container_cli::run`,
/// which trims and lossily decodes output as UTF-8.
pub async fn capture_snapshot(container_id: &str) -> Option<Value> {
    let rt = cli::runtime().ok()?;
    let out = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        Command::new(&rt.bin)
            .args(["exec", container_id, "import", "-window", "root", "PNG:-"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output(),
    )
    .await
    .ok()?
    .ok()?;

    if !out.status.success() || out.stdout.is_empty() {
        return None;
    }

    let dir = snap_dir();
    std::fs::create_dir_all(&dir).ok()?;
    let timestamp = now_millis();
    let path = dir.join(format!("{container_id}-{timestamp}.png"));
    std::fs::write(&path, &out.stdout).ok()?;
    Some(json!({
        "path": path.to_string_lossy(),
        "timestamp": timestamp as u64,
    }))
}

/// Read the most recent snapshot for a container.
pub fn read_snapshot(container_id: &str) -> Result<Vec<u8>, String> {
    let latest = list_snapshots(container_id)
        .into_iter()
        .next()
        .ok_or_else(|| format!("No snapshots for {container_id}"))?;
    std::fs::read(&latest).map_err(|e| format!("{e}"))
}

/// Snapshots for a container, newest first.
fn list_snapshots(container_id: &str) -> Vec<PathBuf> {
    let prefix = format!("{container_id}-");
    let mut files: Vec<PathBuf> = match std::fs::read_dir(snap_dir()) {
        Ok(entries) => entries
            .filter_map(Result::ok)
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| n.starts_with(&prefix) && n.ends_with(".png"))
                    .unwrap_or(false)
            })
            .collect(),
        Err(_) => return Vec::new(),
    };
    // Names carry a millisecond stamp, so a reverse lexical sort is newest-first.
    files.sort();
    files.reverse();
    files
}

/// The URL the SPA uses for a container's thumbnail.
pub fn thumb_url(container_id: &str) -> String {
    format!(
        "/api/snapshots/{}/thumb",
        crate::http::server::percent_encode(container_id)
    )
}
