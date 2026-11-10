//! Orchestration create-payload validation — pure functions, zero I/O.
//!
//! Validation is deliberately polite: every bad field is reported in one
//! response so AJCS can fix requests in a single round-trip.
//!
//! The Node original leaned on regular expressions. These are hand-written
//! predicates instead — the patterns are small and character-classy, and
//! spelling them out keeps a regex crate out of the dependency set while
//! producing the same accept/reject decisions and the same messages.

use serde_json::{Map, Value};

use super::orchestration_volumes::{VolumeEntry, VolumeKind};
use super::orchestration_store::RepoEntry;

pub const MAX_REPOS: usize = 20;
pub const MAX_VOLUMES: usize = 16;
const BACKREF_URL_MAX: usize = 2048;

/// What a create payload becomes once accepted.
pub struct CreateInput {
    pub repos: Vec<RepoEntry>,
    pub volumes: Vec<VolumeEntry>,
    pub cpus: Option<u64>,
    pub memory: Option<String>,
    pub backref: Option<Map<String, Value>>,
}

/// `{ code, message, details }` — the error envelope every AJCS route returns.
pub struct ValidationError {
    pub code: &'static str,
    pub message: String,
    pub details: Value,
}

// ── field predicates ────────────────────────────────────────────────────────

/// `^(?:[a-z][a-z0-9+.-]*://|[^@\s]+@[^\s:]+:)\S+$` — a URL with a scheme, or
/// an scp-style `user@host:path`.
fn is_repo_url(v: &str) -> bool {
    let t = v.trim();
    if t.is_empty() || t.len() > 2048 || t.chars().any(char::is_whitespace) {
        return false;
    }
    if let Some(idx) = t.find("://") {
        let scheme = &t[..idx];
        let mut chars = scheme.chars();
        let first_ok = chars
            .next()
            .map(|c| c.is_ascii_alphabetic())
            .unwrap_or(false);
        let rest_ok = chars.all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '.' || c == '-');
        return first_ok && rest_ok && t.len() > idx + 3;
    }
    // scp-style: <user>@<host>:<path>, where user has no '@' and host no ':'.
    if let Some(at) = t.find('@') {
        let (user, after) = (&t[..at], &t[at + 1..]);
        if user.is_empty() || user.contains('@') {
            return false;
        }
        if let Some(colon) = after.find(':') {
            let (host, path) = (&after[..colon], &after[colon + 1..]);
            return !host.is_empty() && !path.is_empty();
        }
    }
    false
}

/// A branch or tag: non-empty, no whitespace, no leading dash, max 200.
fn is_git_ref(v: &str) -> bool {
    let t = v.trim();
    !t.is_empty() && !t.starts_with('-') && t.len() <= 200 && !t.chars().any(char::is_whitespace)
}

/// `^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`
fn is_volume_name(v: &str) -> bool {
    let mut chars = v.chars();
    let first = match chars.next() {
        Some(c) => c,
        None => return false,
    };
    if !first.is_ascii_alphanumeric() || v.len() > 64 {
        return false;
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-')
}

/// An absolute guest path without spaces or ':' (and not '/').
fn is_mount_path(v: &str) -> bool {
    v.starts_with('/')
        && v.len() <= 256
        && v != "/"
        && !v.chars().any(|c| c.is_whitespace() || c == ':')
}

/// Host bind path (idea #22/RCA-1): must be ABSOLUTE (relative paths are the
/// classic mistake), and must survive the comma-separated `--mount` format —
/// so no whitespace, ':' or ','. '/' is rejected: binding the host root is
/// never the intent and far too dangerous to accept by default.
fn is_bind_path(v: &str) -> bool {
    v.starts_with('/')
        && v.len() <= 256
        && v != "/"
        && !v.chars().any(|c| c.is_whitespace() || c == ':' || c == ',')
}

/// `^[a-z][a-z0-9_-]*$`, max 32.
fn is_backref_name(v: &str) -> bool {
    let mut chars = v.chars();
    let first = match chars.next() {
        Some(c) => c,
        None => return false,
    };
    if !first.is_ascii_lowercase() || v.len() > 32 {
        return false;
    }
    chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
}

fn is_http_url(v: &str) -> bool {
    if v.len() > BACKREF_URL_MAX {
        return false;
    }
    let rest = match v.strip_prefix("http://").or_else(|| v.strip_prefix("https://")) {
        Some(r) => r,
        None => return false,
    };
    // A URL needs an authority; `http://` alone is not one.
    !rest.is_empty() && !rest.starts_with('/') && !rest.chars().any(char::is_whitespace)
}

/// `^\d+(M|G)$`, converted to MiB.
fn memory_mb(spec: &str) -> Option<u64> {
    let (digits, unit) = spec.split_at(spec.len().checked_sub(1)?);
    if digits.is_empty() || !digits.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let n: u64 = digits.parse().ok()?;
    match unit {
        "M" | "m" => Some(n),
        "G" | "g" => Some(n * 1024),
        _ => None,
    }
}

// ── entry checks ────────────────────────────────────────────────────────────

fn unknown_fields(obj: &Map<String, Value>, allowed: &[&str]) -> Vec<String> {
    obj.keys()
        .filter(|k| !allowed.contains(&k.as_str()))
        .cloned()
        .collect()
}

fn as_str<'a>(obj: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    obj.get(key).and_then(Value::as_str)
}

fn check_repos(raw: &Value, problems: &mut Vec<String>) -> Vec<RepoEntry> {
    let arr = match raw.as_array() {
        Some(a) => a,
        None => {
            problems.push("repos must be an array".into());
            return Vec::new();
        }
    };
    if arr.len() > MAX_REPOS {
        problems.push(format!("repos accepts at most {MAX_REPOS} entries"));
        return Vec::new();
    }
    let mut out = Vec::new();
    for (i, entry) in arr.iter().enumerate() {
        let obj = match entry.as_object() {
            Some(o) => o,
            None => {
                problems.push(format!("repos[{i}] must be an object"));
                continue;
            }
        };
        let extra = unknown_fields(obj, &["url", "ref"]);
        if !extra.is_empty() {
            problems.push(format!("repos[{i}] has unknown field(s): {}", extra.join(", ")));
            continue;
        }
        let mut bad = Vec::new();
        let url = as_str(obj, "url").unwrap_or("");
        if !is_repo_url(url) {
            bad.push(format!(
                "repos[{i}].url must be an http(s)/git/ssh URL or scp-style spec"
            ));
        }
        let git_ref = match obj.get("ref") {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) if is_git_ref(s) => Some(s.trim().to_string()),
            Some(_) => {
                bad.push(format!(
                    "repos[{i}].ref must be a branch or tag name (no whitespace, no leading dash)"
                ));
                None
            }
        };
        if !bad.is_empty() {
            problems.extend(bad);
            continue;
        }
        out.push(RepoEntry {
            url: url.trim().to_string(),
            r#ref: git_ref,
            ..Default::default()
        });
    }
    out
}

fn check_volumes(raw: &Value, problems: &mut Vec<String>) -> Vec<VolumeEntry> {
    let arr = match raw.as_array() {
        Some(a) => a,
        None => {
            problems.push("volumes must be an array".into());
            return Vec::new();
        }
    };
    if arr.len() > MAX_VOLUMES {
        problems.push(format!("volumes accepts at most {MAX_VOLUMES} entries"));
        return Vec::new();
    }
    let mut out = Vec::new();
    for (i, entry) in arr.iter().enumerate() {
        let obj = match entry.as_object() {
            Some(o) => o,
            None => {
                problems.push(format!("volumes[{i}] must be an object"));
                continue;
            }
        };
        // The field set is resolved PER ENTRY: an entry without `type` is a
        // named volume, and a stray `path` on it is reported as an unknown
        // field rather than silently guessing a bind.
        let kind_text = obj.get("type");
        let is_bind = kind_text.and_then(Value::as_str) == Some("bind");
        let allowed: &[&str] = if is_bind {
            &["type", "path", "mount", "mode"]
        } else {
            &["type", "name", "mount", "mode"]
        };
        let extra = unknown_fields(obj, allowed);
        if !extra.is_empty() {
            problems.push(format!(
                "volumes[{i}] has unknown field(s): {}",
                extra.join(", ")
            ));
            continue;
        }

        let mut bad = Vec::new();
        match kind_text {
            None | Some(Value::Null) => {}
            Some(Value::String(s)) if s == "volume" || s == "bind" => {}
            Some(_) => bad.push(format!(
                "volumes[{i}].type must be 'volume' (default) or 'bind'"
            )),
        }
        let mount = as_str(obj, "mount").unwrap_or("");
        if !is_mount_path(mount) {
            bad.push(format!(
                "volumes[{i}].mount must be an absolute guest path without spaces or ':' (and not '/')"
            ));
        }
        let mode = match obj.get("mode") {
            None | Some(Value::Null) => "rw".to_string(),
            Some(Value::String(s)) if s == "ro" || s == "rw" => s.clone(),
            Some(_) => {
                bad.push(format!("volumes[{i}].mode must be 'ro' or 'rw'"));
                "rw".to_string()
            }
        };
        let (name, path) = if is_bind {
            let p = as_str(obj, "path").unwrap_or("");
            if !is_bind_path(p) {
                bad.push(format!(
                    "volumes[{i}].path must be an absolute host path without spaces, ':' or ',' (and not '/')"
                ));
            }
            (String::new(), p.to_string())
        } else {
            let n = as_str(obj, "name").unwrap_or("");
            if !is_volume_name(n) {
                bad.push(format!(
                    "volumes[{i}].name must match /^[A-Za-z0-9][A-Za-z0-9_.-]{{0,63}}$/"
                ));
            }
            (n.to_string(), String::new())
        };
        if !bad.is_empty() {
            problems.extend(bad);
            continue;
        }
        out.push(VolumeEntry {
            kind: if is_bind { VolumeKind::Bind } else { VolumeKind::Volume },
            name,
            path,
            mount: mount.to_string(),
            mode,
            created: false,
        });
    }
    out
}

/// Duplicate-mount rejection across ALL volume entries — named AND bind
/// (`container create` fails duplicate attachments regardless of kind).
/// Duplicate NAMES stay a volume-only rule (binds have no name).
fn check_volume_uniqueness(volumes: &[VolumeEntry], problems: &mut Vec<String>) {
    let mut by_mount: Vec<(&str, usize)> = Vec::new();
    let mut by_name: Vec<(&str, usize)> = Vec::new();
    for (i, v) in volumes.iter().enumerate() {
        match by_mount.iter().find(|(m, _)| *m == v.mount) {
            Some((_, first)) => problems.push(format!(
                "volumes[{i}].mount duplicates volumes[{first}].mount ('{}')",
                v.mount
            )),
            None => by_mount.push((&v.mount, i)),
        }
        if v.kind == VolumeKind::Volume {
            match by_name.iter().find(|(n, _)| *n == v.name) {
                Some((_, first)) => problems.push(format!(
                    "volumes[{i}].name duplicates volumes[{first}].name ('{}')",
                    v.name
                )),
                None => by_name.push((&v.name, i)),
            }
        }
    }
}

/// Optional resources block: `{ cpus, memory }` — reported per-field.
fn check_resources(body: &Map<String, Value>, problems: &mut Vec<String>) -> (Option<u64>, Option<String>) {
    let raw = match body.get("resources") {
        None | Some(Value::Null) => return (None, None),
        Some(v) => v,
    };
    let obj = match raw.as_object() {
        Some(o) => o,
        None => {
            problems.push("resources must be an object".into());
            return (None, None);
        }
    };
    let extra = unknown_fields(obj, &["cpus", "memory"]);
    if !extra.is_empty() {
        problems.push(format!("resources has unknown field(s): {}", extra.join(", ")));
    }
    let cpus = match obj.get("cpus") {
        None | Some(Value::Null) => None,
        Some(v) => match v.as_u64() {
            Some(n) if v.is_i64() || v.is_u64() => {
                if !(1..=32).contains(&n) {
                    problems.push("resources.cpus must be an integer between 1 and 32".into());
                    None
                } else {
                    Some(n)
                }
            }
            _ => {
                problems.push("resources.cpus must be an integer between 1 and 32".into());
                None
            }
        },
    };
    let memory = match obj.get("memory") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => match memory_mb(s) {
            Some(mb) if mb <= 65_536 => Some(s.clone()),
            _ => {
                problems.push(
                    "resources.memory must look like '2048M' or '2G' (max 65536M)".into(),
                );
                None
            }
        },
        Some(_) => {
            problems.push("resources.memory must look like '2048M' or '2G' (max 65536M)".into());
            None
        }
    };
    (cpus, memory)
}

/// Caller-owned `backref` (the AJCS-side run pointer): opaque to this plane —
/// validated for shape, stored verbatim, echoed verbatim, never acted on.
/// Every field is required; anything else inside the object is rejected.
fn check_backref(raw: &Value, problems: &mut Vec<String>) -> Option<Map<String, Value>> {
    let obj = match raw.as_object() {
        Some(o) => o,
        None => {
            problems.push("backref must be an object".into());
            return None;
        }
    };
    let extra = unknown_fields(obj, &["system", "kind", "id", "label", "url"]);
    if !extra.is_empty() {
        problems.push(format!("backref has unknown field(s): {}", extra.join(", ")));
    }
    let mut bad = Vec::new();
    for key in ["system", "kind"] {
        let ok = as_str(obj, key).map(is_backref_name).unwrap_or(false);
        if !ok {
            bad.push(format!(
                "backref.{key} must match /^[a-z][a-z0-9_-]*$/ (lower-case, max 32 chars)"
            ));
        }
    }
    let id_ok = as_str(obj, "id")
        .map(|v| (1..=128).contains(&v.len()) && !v.chars().any(char::is_whitespace))
        .unwrap_or(false);
    if !id_ok {
        bad.push("backref.id must be 1-128 characters without whitespace (opaque caller id)".into());
    }
    let label_ok = as_str(obj, "label").map(|v| (1..=128).contains(&v.len())).unwrap_or(false);
    if !label_ok {
        bad.push("backref.label must be 1-128 characters (the chip display text)".into());
    }
    let url_ok = as_str(obj, "url").map(is_http_url).unwrap_or(false);
    if !url_ok {
        bad.push("backref.url must be an http(s):// URL (max 2048 chars)".into());
    }
    if bad.is_empty() {
        Some(obj.clone())
    } else {
        problems.extend(bad);
        None
    }
}

/// Validate a create payload.
pub fn validate_create(body: &Value) -> Result<CreateInput, ValidationError> {
    let obj = match body.as_object() {
        Some(o) => o.clone(),
        None => Map::new(),
    };
    let allowed = ["repos", "volumes", "resources", "backref"];
    let unknown = unknown_fields(&obj, &allowed);
    if !unknown.is_empty() {
        return Err(ValidationError {
            code: "unknown_field",
            message: format!("Unknown field(s): {}", unknown.join(", ")),
            details: serde_json::json!({ "fields": unknown }),
        });
    }

    let mut problems: Vec<String> = Vec::new();
    let repos = match obj.get("repos") {
        None | Some(Value::Null) => Vec::new(),
        Some(v) => check_repos(v, &mut problems),
    };
    let volumes = match obj.get("volumes") {
        None | Some(Value::Null) => Vec::new(),
        Some(v) => check_volumes(v, &mut problems),
    };
    check_volume_uniqueness(&volumes, &mut problems);
    let (cpus, memory) = check_resources(&obj, &mut problems);
    let backref = match obj.get("backref") {
        None | Some(Value::Null) => None,
        Some(v) => check_backref(v, &mut problems),
    };

    if !problems.is_empty() {
        return Err(ValidationError {
            code: "invalid_field",
            message: "Invalid request body".into(),
            details: serde_json::json!({ "errors": problems }),
        });
    }
    Ok(CreateInput {
        repos,
        volumes,
        cpus,
        memory,
        backref,
    })
}
