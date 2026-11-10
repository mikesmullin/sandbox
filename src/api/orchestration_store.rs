//! Persisted orchestration state — the JSON state-file path, the record shape,
//! and a read-only reader that `containers.rs` can call without dragging the
//! reconcile machinery (or a module cycle) along with it.
//!
//! The reader answers ONE question — does this sandbox id carry a caller
//! `backref`? — straight from disk: no in-memory cache, no CLI calls, no
//! reconcile side effects. A missing/corrupt store, or a record without a
//! backref, reads as `None` (absence is the shape — never null).

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::images::Kind;
use super::orchestration_volumes::VolumeEntry;
use crate::util;

/// Same file the orchestration pipeline persists to; env override read at load.
pub fn state_file() -> std::path::PathBuf {
    if let Ok(p) = std::env::var("ORCHESTRATION_STATE_FILE") {
        return std::path::PathBuf::from(p);
    }
    util::project_root().join("tmp").join("orchestration-state.json")
}

/// One repo to clone into the guest.
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct RepoEntry {
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#ref: Option<String>,
    #[serde(default)]
    pub cloned: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// A per-repo failure message (the clone's stderr, truncated).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// One state transition, recorded in order.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Transition {
    pub state: String,
    pub at: String,
}

/// A tracked sandbox. Field names match the JSON the Node backend wrote, so an
/// existing `tmp/orchestration-state.json` is read without migration.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Record {
    pub id: String,
    pub state: String,
    #[serde(rename = "mcpPort")]
    pub mcp_port: u16,
    #[serde(rename = "quicPort")]
    pub quic_port: u16,
    #[serde(rename = "execPort")]
    pub exec_port: u16,
    #[serde(default)]
    pub repos: Vec<RepoEntry>,
    #[serde(default)]
    pub volumes: Vec<VolumeEntry>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    pub image: String,
    /// Which row of the image matrix this sandbox is. Defaults to `headed`,
    /// so a record written before the matrix existed reads as what it was.
    #[serde(default)]
    pub kind: Kind,
    pub cpus: u64,
    pub memory: String,
    #[serde(default)]
    pub transitions: Vec<Transition>,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
    #[serde(default)]
    /// `{ code, message }` when the pipeline failed, else absent/null.
    pub error: Option<Value>,
    /// Caller-owned, non-secret label echoed back verbatim. Absent unless the
    /// creator supplied one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backref: Option<Map<String, Value>>,
    /// Set when a DELETE asks a running pipeline to stand down. Never persisted
    /// as meaningful state across a restart.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub aborted: bool,
}

/// The caller-owned backref for a persisted sandbox id, or `None` when the
/// record is unknown, predates the field, or was created without one.
pub fn backref_for(id: &str) -> Option<Value> {
    let raw = std::fs::read_to_string(state_file()).ok()?;
    let doc: Value = serde_json::from_str(&raw).ok()?;
    let backref = doc.pointer(&format!("/sandboxes/{}/backref", json_pointer_escape(id)))?;
    // An object is the contract; anything else (a legacy scalar, null) is not
    // a backref and reads as absence.
    backref.is_object().then(|| backref.clone())
}

/// `/` and `~` carry meaning inside a JSON pointer; sandbox ids are
/// `[A-Za-z0-9-]` today, but escaping keeps a future id from silently
/// addressing the wrong node.
fn json_pointer_escape(s: &str) -> String {
    s.replace('~', "~0").replace('/', "~1")
}
