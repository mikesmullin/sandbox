use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum VolumeKind {
    #[default]
    Volume,
    Bind,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct VolumeEntry {
    #[serde(default, rename = "type")]
    pub kind: VolumeKind,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub name: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub path: String,
    pub mount: String,
    pub mode: String,
    #[serde(default)]
    pub created: bool,
}

pub fn volume_flags(vol: &VolumeEntry) -> Vec<String> {
    match vol.kind {
        VolumeKind::Bind => vec![
            "--mount".into(),
            format!(
                "type=bind,source={},target={}{}",
                vol.path,
                vol.mount,
                if vol.mode == "ro" { ",readonly" } else { "" }
            ),
        ],
        VolumeKind::Volume => vec!["-v".into(), format!("{}:{}:{}", vol.name, vol.mount, vol.mode)],
    }
}

pub fn volume_create_args(volumes: &[VolumeEntry]) -> Vec<String> {
    volumes.iter().flat_map(volume_flags).collect()
}

pub fn to_volume_detail(vol: &VolumeEntry) -> Value {
    match vol.kind {
        VolumeKind::Bind => json!({
            "type": "bind",
            "path": vol.path,
            "mount": vol.mount,
            "mode": vol.mode,
            "created": false,
        }),
        VolumeKind::Volume => json!({
            "type": "volume",
            "name": vol.name,
            "mount": vol.mount,
            "mode": vol.mode,
            "created": vol.created,
        }),
    }
}

pub fn to_volume_after_delete(vol: &VolumeEntry) -> Value {
    match vol.kind {
        VolumeKind::Bind => json!({
            "type": "bind",
            "path": vol.path,
            "mount": vol.mount,
            "mode": vol.mode,
            "persisted": true,
        }),
        VolumeKind::Volume => json!({
            "type": "volume",
            "name": vol.name,
            "mount": vol.mount,
            "mode": vol.mode,
            "persisted": true,
        }),
    }
}
