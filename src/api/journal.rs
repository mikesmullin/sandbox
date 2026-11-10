//! The tool-call journal — what every client did, in order (SBOX_PLAN1 §3.3).
//!
//! The operator's single source of truth for "what did the agent do on my
//! work laptop." Every host MCP tool call is recorded with its arguments, its
//! outcome and how long it took, and the web UI tails it.
//!
//! In memory and bounded: this is a live feed, not an audit log. It survives
//! as long as the process does, and the newest `CAPACITY` entries push the
//! oldest out — an agent in a loop must not be able to exhaust host memory.
//!
//! Arguments and outputs are truncated per entry for the same reason: a
//! `read` of a 50MB file should cost the journal a preview, not 50MB.

use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};

use super::mcp_server::ToolError;
use crate::util;

/// Entries kept. At ~2KB each this is a few megabytes at worst.
const CAPACITY: usize = 2_000;
/// Longest argument or output blob stored per entry.
const MAX_FIELD: usize = 4_000;

#[derive(Clone, Debug)]
pub struct Entry {
    pub seq: u64,
    pub at: String,
    pub tool: String,
    pub args: Value,
    pub ok: bool,
    pub summary: String,
    pub duration_ms: u64,
}

impl Entry {
    pub fn to_json(&self) -> Value {
        json!({
            "seq": self.seq,
            "at": self.at,
            "tool": self.tool,
            "args": self.args,
            "ok": self.ok,
            "summary": self.summary,
            "durationMs": self.duration_ms,
        })
    }
}

struct Log {
    entries: VecDeque<Entry>,
    next_seq: u64,
}

fn log() -> &'static Mutex<Log> {
    static LOG: std::sync::OnceLock<Mutex<Log>> = std::sync::OnceLock::new();
    LOG.get_or_init(|| {
        Mutex::new(Log {
            entries: VecDeque::new(),
            next_seq: 1,
        })
    })
}

/// Record one completed tool call.
pub fn record(tool: &str, args: &Value, outcome: &Result<Value, ToolError>, took: Duration) {
    let (ok, summary) = match outcome {
        Ok(result) => (true, summarize_result(result)),
        Err(ToolError::Tool(text)) => (false, truncate(text)),
        Err(ToolError::Protocol { message, .. }) => (false, truncate(message)),
    };
    let mut l = log().lock().unwrap();
    let seq = l.next_seq;
    l.next_seq += 1;
    l.entries.push_back(Entry {
        seq,
        at: util::now_iso(),
        tool: tool.to_string(),
        args: redact(args),
        ok,
        summary,
        duration_ms: took.as_millis() as u64,
    });
    while l.entries.len() > CAPACITY {
        l.entries.pop_front();
    }
}

/// Entries newer than `after`, oldest first — the web UI's tail cursor.
pub fn since(after: u64, limit: usize) -> Vec<Value> {
    let l = log().lock().unwrap();
    l.entries
        .iter()
        .filter(|e| e.seq > after)
        .take(limit)
        .map(Entry::to_json)
        .collect()
}

/// The highest sequence number issued — a client's starting cursor.
pub fn head() -> u64 {
    log().lock().unwrap().next_seq.saturating_sub(1)
}

/// The human-readable gist of a tool result.
///
/// Image content is named, not inlined: a base64 PNG in the feed would be
/// megabytes of noise where "image/png (142KB)" is the whole story.
fn summarize_result(result: &Value) -> String {
    let blocks = match result.get("content").and_then(Value::as_array) {
        Some(b) => b,
        None => return truncate(&result.to_string()),
    };
    let mut parts = Vec::new();
    for block in blocks {
        match block.get("type").and_then(Value::as_str) {
            Some("text") => parts.push(
                block
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
            ),
            Some("image") => {
                let bytes = block
                    .get("data")
                    .and_then(Value::as_str)
                    .map(|d| d.len() * 3 / 4)
                    .unwrap_or(0);
                parts.push(format!("[image/png, {} KB]", bytes / 1024));
            }
            _ => parts.push("[content]".into()),
        }
    }
    truncate(&parts.join("\n"))
}

/// Arguments are shown verbatim except for size — the operator wants to read
/// the command that ran. Nothing here is secret: the sandbox token never
/// appears in a tool argument, it is minted host-side per call.
fn redact(args: &Value) -> Value {
    match args {
        Value::Object(map) => {
            let mut out = serde_json::Map::new();
            for (k, v) in map {
                out.insert(
                    k.clone(),
                    match v {
                        Value::String(s) => Value::String(truncate(s)),
                        other => other.clone(),
                    },
                );
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

fn truncate(s: &str) -> String {
    if s.len() <= MAX_FIELD {
        return s.to_string();
    }
    let mut cut = MAX_FIELD;
    while cut > 0 && !s.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}… [{} bytes truncated]", &s[..cut], s.len() - cut)
}
