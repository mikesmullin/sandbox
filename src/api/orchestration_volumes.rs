//! Volume handling for the orchestration API — pure functions, zero I/O.
//!
//! Two volume kinds (idea #22 / RCA-1, psicom MASTER_PLAN §7.3):
//!   `Volume` (default) — named volume, ensured via `container volume create`,
//!     persists across sandbox delete by design.
//!   `Bind` — a HOST-owned directory mounted into the guest. The evidence
//!     hand-off: host stages write evidence dirs, agent-stage sandboxes mount
//!     them READ-ONLY. The host path is never created, written, or removed by
//!     this API — `created` is always false and sandbox delete NEVER touches
//!     host paths.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum VolumeKind {
    #[default]
    Volume,
    Bind,
}

/// One volume entry as persisted in the state file.
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct VolumeEntry {
    /// Legacy records predate the field and read as named volumes.
    #[serde(default, rename = "type")]
    pub kind: VolumeKind,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub name: String,
    /// Host path — bind entries only.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub path: String,
    pub mount: String,
    pub mode: String,
    #[serde(default)]
    pub created: bool,
}

/// One volume entry → its `container create` option pair.
///
/// Options ride BEFORE the image — the OPTIONS-BEFORE-TARGET lesson
/// (`container create [<options>] <image>`, same as `exec`/`run`): anything
/// after the image is the container's init arguments, not a CLI option.
pub fn volume_flags(vol: &VolumeEntry) -> Vec<String> {
    match vol.kind {
        // Apple CLI mount format (verified in `container create/run --help`,
        // then live: RO writes fail "Read-only file system"): comma-separated
        // type=<kind>,source=<host path>,target=<guest path>[,readonly] — `ro`
        // appends the readonly clause, `rw` omits it (rw is the default).
        VolumeKind::Bind => vec![
            "--mount".into(),
            format!(
                "type=bind,source={},target={}{}",
                vol.path,
                vol.mount,
                if vol.mode == "ro" { ",readonly" } else { "" }
            ),
        ],
        // Named volumes keep the legacy `-v name:mount:mode` byte-for-byte.
        VolumeKind::Volume => vec!["-v".into(), format!("{}:{}:{}", vol.name, vol.mount, vol.mode)],
    }
}

/// All volume entries → the flat option block for `container create`.
pub fn volume_create_args(volumes: &[VolumeEntry]) -> Vec<String> {
    volumes.iter().flat_map(volume_flags).collect()
}

/// Response projection for one volume entry (create/list/detail). `type` is
/// carried on EVERY entry (additive, contract §15); bind entries add `path`.
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

/// DELETE-response projection. `persisted: true` = the data outlives the
/// sandbox: named volumes survive delete (reclaim via `container volume
/// delete`), bind paths were NEVER ours — delete stops the container and does
/// not touch the host directory.
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
