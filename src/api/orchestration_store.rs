use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::images::Kind;
use super::orchestration_volumes::VolumeEntry;
use crate::util;

pub fn state_file() -> std::path::PathBuf {
    if let Ok(p) = std::env::var("ORCHESTRATION_STATE_FILE") {
        return std::path::PathBuf::from(p);
    }
    util::project_root().join("tmp").join("orchestration-state.json")
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct RepoEntry {
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#ref: Option<String>,
    #[serde(default)]
    pub cloned: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Transition {
    pub state: String,
    pub at: String,
}

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
    #[serde(default)]
    pub kind: Kind,
    pub cpus: u64,
    pub memory: String,
    #[serde(default = "default_true")]
    pub network: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub devices: Vec<String>,
    #[serde(default)]
    pub transitions: Vec<Transition>,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
    #[serde(default)]
    pub error: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backref: Option<Map<String, Value>>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub aborted: bool,
}

fn default_true() -> bool {
    true
}

pub fn backref_for(id: &str) -> Option<Value> {
    let raw = std::fs::read_to_string(state_file()).ok()?;
    let doc: Value = serde_json::from_str(&raw).ok()?;
    let backref = doc.pointer(&format!("/sandboxes/{}/backref", json_pointer_escape(id)))?;
    backref.is_object().then(|| backref.clone())
}

fn json_pointer_escape(s: &str) -> String {
    s.replace('~', "~0").replace('/', "~1")
}
