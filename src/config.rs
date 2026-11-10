//! App-config loader.
//!
//! Reads `config.yaml` (a small YAML subset — nested `key: value` mappings,
//! `#` comments, and simple scalars) at startup and exposes it as JSON. The
//! SPA gets it via `GET /api/config`.
//!
//! The subset is deliberate, and ported rather than replaced by a real YAML
//! crate: the file it reads is a handful of nested scalars, and matching the
//! Node parser's exact behaviour keeps an existing config.yaml working.

use std::sync::OnceLock;

use serde_json::{Map, Value};

use crate::util;

fn config_path() -> std::path::PathBuf {
    if let Ok(p) = std::env::var("SANDBOX2_CONFIG_FILE") {
        return std::path::PathBuf::from(p);
    }
    util::project_root().join("config.yaml")
}

/// Coerce a YAML scalar string to a JSON value.
fn scalar(s: &str) -> Value {
    let t = s.trim();
    if t.is_empty() || t == "null" || t == "Null" || t == "NULL" {
        return Value::Null;
    }
    if t == "true" || t == "on" {
        return Value::Bool(true);
    }
    if t == "false" || t == "off" {
        return Value::Bool(false);
    }
    if is_integer(t) {
        if let Ok(n) = t.parse::<i64>() {
            return Value::from(n);
        }
    }
    if is_float(t) {
        if let Ok(n) = t.parse::<f64>() {
            return Value::from(n);
        }
    }
    let bytes = t.as_bytes();
    if bytes.len() >= 2 {
        let (first, last) = (bytes[0], bytes[bytes.len() - 1]);
        if (first == b'"' && last == b'"') || (first == b'\'' && last == b'\'') {
            return Value::String(t[1..t.len() - 1].to_string());
        }
    }
    Value::String(t.to_string())
}

fn is_integer(t: &str) -> bool {
    let body = t.strip_prefix(['+', '-']).unwrap_or(t);
    !body.is_empty() && body.chars().all(|c| c.is_ascii_digit())
}

fn is_float(t: &str) -> bool {
    let body = t.strip_prefix(['+', '-']).unwrap_or(t);
    match body.split_once('.') {
        Some((whole, frac)) => {
            !frac.is_empty()
                && frac.chars().all(|c| c.is_ascii_digit())
                && whole.chars().all(|c| c.is_ascii_digit())
        }
        None => false,
    }
}

/// Strip a trailing comment from a line (respecting quotes).
fn strip_comment(s: &str) -> &str {
    let bytes = s.as_bytes();
    let mut quote: Option<u8> = None;
    for (i, &ch) in bytes.iter().enumerate() {
        if ch == b'"' || ch == b'\'' {
            quote = match quote {
                None => Some(ch),
                Some(_) => None,
            };
        } else if ch == b'#' && quote.is_none() {
            return &s[..i];
        }
    }
    s
}

/// Parse a YAML subset: nested mappings, comments, simple scalars.
pub fn parse_yaml(text: &str) -> Value {
    let lines: Vec<&str> = text.split('\n').map(|l| l.trim_end_matches('\r')).collect();
    let mut pos = 0usize;
    Value::Object(parse_map(&lines, &mut pos, -1))
}

/// Parse a mapping whose keys live at an indent strictly greater than `indent`.
fn parse_map(lines: &[&str], pos: &mut usize, indent: i32) -> Map<String, Value> {
    let mut obj = Map::new();
    loop {
        if *pos >= lines.len() {
            break;
        }
        let full = lines[*pos];
        let raw = strip_comment(full).trim_start().to_string();
        let line_pad = (full.len() - full.trim_start().len()) as i32;
        if raw.is_empty() || raw.starts_with('#') {
            *pos += 1;
            continue;
        }
        if line_pad < indent + 1 {
            break; // de-indent => parent block
        }
        let (key, val) = match split_key(&raw) {
            Some(parts) => parts,
            None => {
                *pos += 1;
                continue;
            }
        };
        *pos += 1;
        if val.is_empty() {
            let nested = parse_map(lines, pos, line_pad);
            obj.insert(key, Value::Object(nested));
        } else {
            obj.insert(key, scalar(&val));
        }
    }
    obj
}

/// `key: value` where key matches `[A-Za-z_$][A-Za-z0-9_$-]*`.
fn split_key(raw: &str) -> Option<(String, String)> {
    let colon = raw.find(':')?;
    let key = raw[..colon].trim();
    if key.is_empty() {
        return None;
    }
    let mut chars = key.chars();
    let first = chars.next()?;
    if !(first.is_ascii_alphabetic() || first == '_' || first == '$') {
        return None;
    }
    if !chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$' || c == '-') {
        return None;
    }
    Some((key.to_string(), raw[colon + 1..].trim().to_string()))
}

pub fn app_config() -> &'static Value {
    static CACHED: OnceLock<Value> = OnceLock::new();
    CACHED.get_or_init(|| match std::fs::read_to_string(config_path()) {
        Ok(text) => parse_yaml(&text),
        Err(_) => Value::Object(Map::new()),
    })
}
