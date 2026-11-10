//! sbox MCP driver — deterministic tool execution for AJCS (batch 2.2).
//!
//! ONE driver mechanism, TWO sibling facades (one per upstream daemon):
//!
//!   GUI  (spacesd, host port = record.mcpPort):
//!   GET  /api/orchestration/sandboxes/:id/mcp/tools        proxy `tools/list`
//!   POST /api/orchestration/sandboxes/:id/mcp/tools/:name  proxy `tools/call`
//!   POST /api/orchestration/sandboxes/:id/mcp/rpc          JSON-RPC passthrough
//!
//!   EXEC (execd, guest :3213, host port = record.execPort):
//!   GET  /api/orchestration/sandboxes/:id/exec/tools       proxy `tools/list`
//!   POST /api/orchestration/sandboxes/:id/exec/tools/bash  proxy `tools/call`
//!   POST /api/orchestration/sandboxes/:id/exec/rpc         JSON-RPC passthrough
//!
//! ONE driver mechanism, two callers (plan §7.1): an agent session drives a
//! sandbox's /mcp with LLM-decided calls; AJCS drives it THROUGH this endpoint
//! with Jobfile-decided calls. No LLM, no sampling, no conversation: one HTTP
//! request = one MCP request. The driver holds NO session state beyond the
//! HTTP request — the MCP initialize handshake runs per request.
//!
//! Contract: docs/mcp-driver-contract.md.

use std::time::Duration;

use serde_json::{json, Map, Value};

use super::containers::container_token;
use super::orchestration_store::{state_file, Record};
use crate::http::{client, Request, Response};
use crate::util;

const MAX_BODY_BYTES: usize = 256 * 1024;
/// Same probe semantics as the orchestration health check.
const HEALTH_TIMEOUT: Duration = Duration::from_millis(1000);
const PROTOCOL_VERSION: &str = "2025-03-26";
const CLIENT_NAME: &str = "sandbox2-mcp-driver";
const CLIENT_VERSION: &str = "1";
/// Methods the caller may drive itself through /mcp/rpc — skip the handshake.
const HANDSHAKE_METHODS: [&str; 2] = ["initialize", "notifications/initialized"];

/// Upstream surfaces: same JSON-RPC transport, different daemon + host port.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Surface {
    Gui,
    Exec,
}

impl Surface {
    fn daemon(self) -> &'static str {
        match self {
            Surface::Gui => "spacesd",
            Surface::Exec => "execd",
        }
    }

    fn port_of(self, record: &Record) -> u16 {
        match self {
            Surface::Gui => record.mcp_port,
            Surface::Exec => record.exec_port,
        }
    }
}

/// Per-call upstream budget, env-configurable; read per request.
fn driver_timeout() -> Duration {
    std::env::var("MCP_DRIVER_TIMEOUT_MS")
        .ok()
        .and_then(|raw| raw.parse::<u64>().ok())
        .filter(|ms| *ms > 0)
        .map(Duration::from_millis)
        .unwrap_or(Duration::from_secs(30))
}

/// URL-expressible tool names; anything else goes through /mcp/rpc.
fn is_tool_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
}

// ── sandbox record + readiness gate ─────────────────────────────────────────

/// Read one sandbox record from the shared state file; `None` when untracked.
///
/// Deliberately reads the file rather than the orchestration module's
/// in-memory map: the driver must see exactly what was persisted, and a read
/// here must never take the orchestration lock while a pipeline holds it.
fn load_record(id: &str) -> Option<Record> {
    let raw = std::fs::read_to_string(state_file()).ok()?;
    let doc: Value = serde_json::from_str(&raw).ok()?;
    let entry = doc.get("sandboxes")?.get(id)?;
    serde_json::from_value(entry.clone()).ok()
}

/// spacesd `/health` → 2xx once serving.
async fn probe_health(port: u16) -> bool {
    client::request("127.0.0.1", port, "GET", "/health", &[], None, HEALTH_TIMEOUT)
        .await
        .map(|r| r.ok())
        .unwrap_or(false)
}

/// Sandbox-level gate, shared by both facades: 404 unknown id; 409 (with the
/// record's state in error.details) when the lifecycle has not reached ready.
fn gate_core(id: &str) -> Result<Record, Response> {
    let record = load_record(id)
        .ok_or_else(|| fail(404, "not_found", &format!("No such sandbox: {id}"), None))?;
    if record.state != "ready" || record.mcp_port == 0 {
        return Err(fail(
            409,
            "sandbox_not_ready",
            &format!("Sandbox {id} is not ready (state: {})", record.state),
            Some(json!({ "sandboxId": id, "state": record.state })),
        ));
    }
    Ok(record)
}

/// A ready-recorded sandbox must still answer /health (stale record check).
async fn gate_health(id: &str, record: Record) -> Result<Record, Response> {
    if probe_health(record.mcp_port).await {
        return Ok(record);
    }
    Err(fail(
        409,
        "sandbox_not_ready",
        &format!(
            "Sandbox {id} is recorded ready but /health is not serving; poll GET detail for reconciled state"
        ),
        Some(json!({ "sandboxId": id, "state": record.state, "healthOk": false })),
    ))
}

/// GUI facade gate: readiness + liveness (spacesd /health).
async fn gate_sandbox(id: &str) -> Result<Record, Response> {
    let record = gate_core(id)?;
    gate_health(id, record).await
}

/// Exec facade gate: the GUI gate PLUS the exec surface itself — records
/// persisted before execd carry no exec port and have nothing to drive.
async fn gate_exec(id: &str) -> Result<Record, Response> {
    let record = gate_core(id)?;
    if record.exec_port == 0 {
        return Err(fail(
            409,
            "sandbox_not_ready",
            &format!("Sandbox {id} has no exec surface (pre-execd record or execd-disabled image)"),
            Some(json!({ "sandboxId": id, "state": record.state, "execUnavailable": true })),
        ));
    }
    gate_health(id, record).await
}

// ── MCP client (per-request handshake, then one operation) ──────────────────

enum UpstreamError {
    Error(String),
    Timeout(String),
}

struct Session {
    port: u16,
    daemon: &'static str,
    token: String,
    session_id: Option<String>,
    deadline: std::time::Instant,
}

impl Session {
    fn remaining(&self) -> Result<Duration, UpstreamError> {
        let now = std::time::Instant::now();
        if now >= self.deadline {
            return Err(UpstreamError::Timeout(format!(
                "MCP call exceeded {}ms",
                driver_timeout().as_millis()
            )));
        }
        Ok(self.deadline - now)
    }
}

struct Reply {
    status: u16,
    message: Option<Value>,
}

/// Defensive SSE extraction: Streamable-HTTP servers may answer with
/// `data:` lines rather than a bare JSON body.
fn parse_sse(text: &str) -> Option<Value> {
    let mut parsed = None;
    for line in text.split('\n') {
        if let Some(payload) = line.strip_prefix("data:") {
            if let Ok(v) = serde_json::from_str::<Value>(payload.trim()) {
                parsed = Some(v);
            }
        }
    }
    parsed
}

fn is_valid_reply(message: &Value) -> bool {
    if message.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return false;
    }
    match message.get("error") {
        Some(Value::Null) | None => message.get("result").is_some(),
        Some(e) => {
            e.get("code").map(Value::is_number).unwrap_or(false)
                && e.get("message").map(Value::is_string).unwrap_or(false)
        }
    }
}

/// One JSON-RPC POST to the sandbox's /mcp. Threads the Mcp-Session-Id the
/// server issues (per POST) for the rest of this driver request, then the
/// session is dropped — the next request handshakes afresh.
async fn post_rpc(session: &mut Session, message: &Value) -> Result<Reply, UpstreamError> {
    let budget = session.remaining()?;
    let auth = format!("Bearer {}", session.token); // minted internally, never echoed
    let body = serde_json::to_vec(message).unwrap_or_else(|_| b"{}".to_vec());

    let mut headers: Vec<(&str, &str)> = vec![
        ("content-type", "application/json"),
        ("accept", "application/json, text/event-stream"),
        ("authorization", &auth),
    ];
    let session_header = session.session_id.clone();
    if let Some(sid) = &session_header {
        headers.push(("mcp-session-id", sid));
    }

    let res = client::request("127.0.0.1", session.port, "POST", "/mcp", &headers, Some(&body), budget)
        .await
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::TimedOut {
                UpstreamError::Timeout(format!("MCP call exceeded {}ms", driver_timeout().as_millis()))
            } else {
                UpstreamError::Error(format!(
                    "{} unreachable: {}",
                    session.daemon,
                    util::first_line(&e.to_string())
                ))
            }
        })?;

    if res.status == 401 {
        return Err(UpstreamError::Error(format!(
            "{} rejected the driver token (401) — token/secret mismatch; recreate the sandbox",
            session.daemon
        )));
    }
    if !res.ok() {
        return Err(UpstreamError::Error(format!(
            "{} HTTP {}",
            session.daemon, res.status
        )));
    }
    if let Some(sid) = res.header("mcp-session-id") {
        session.session_id = Some(sid.to_string());
    }

    let text = res.text();
    if text.trim().is_empty() {
        // notifications answer empty (202)
        return Ok(Reply {
            status: res.status,
            message: None,
        });
    }
    let reply = serde_json::from_str::<Value>(&text)
        .ok()
        .or_else(|| parse_sse(&text));
    let reply = match reply {
        Some(r) if is_valid_reply(&r) => r,
        _ => {
            return Err(UpstreamError::Error(format!(
                "{} returned an unparseable MCP response",
                session.daemon
            )))
        }
    };
    if let Some(sent) = message.get("id") {
        if !sent.is_null() && reply.get("id") != Some(sent) {
            return Err(UpstreamError::Error(format!(
                "MCP response id mismatch (sent {sent}, got {})",
                reply.get("id").cloned().unwrap_or(Value::Null)
            )));
        }
    }
    Ok(Reply {
        status: res.status,
        message: Some(reply),
    })
}

/// Spec-correct client opening for one driver request: initialize → (session
/// issued) notifications/initialized. Per-request, not cached per sandbox:
/// cached sessions die with daemon restarts and caching would hold state
/// beyond the HTTP request.
async fn handshake(session: &mut Session) -> Result<(), UpstreamError> {
    let init = post_rpc(
        session,
        &json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": { "name": CLIENT_NAME, "version": CLIENT_VERSION },
            },
        }),
    )
    .await?;
    if let Some(err) = init.message.as_ref().and_then(|m| m.get("error")) {
        if !err.is_null() {
            return Err(UpstreamError::Error(format!(
                "{} rejected initialize: {}",
                session.daemon,
                err.get("message").and_then(Value::as_str).unwrap_or("unknown")
            )));
        }
    }
    if session.session_id.is_some() {
        post_rpc(session, &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).await?;
    }
    Ok(())
}

fn new_session(record: &Record, surface: Surface) -> Session {
    Session {
        port: surface.port_of(record),
        daemon: surface.daemon(),
        token: container_token(&record.id),
        session_id: None,
        deadline: std::time::Instant::now() + driver_timeout(),
    }
}

/// Standard operation: handshake, then `{ id: 2, method, params }`.
///
/// One driver request = one operation upstream — no internal retries:
/// tools/call is not idempotent and a silent retry could double-fire.
async fn run_operation(
    record: &Record,
    method: &str,
    params: Value,
    surface: Surface,
) -> Result<Reply, UpstreamError> {
    let mut session = new_session(record, surface);
    handshake(&mut session).await?;
    post_rpc(
        &mut session,
        &json!({ "jsonrpc": "2.0", "id": 2, "method": method, "params": params }),
    )
    .await
}

/// /mcp/rpc passthrough: exact caller message (id/notification semantics kept).
async fn run_passthrough(
    record: &Record,
    message: &Value,
    skip_handshake: bool,
    surface: Surface,
) -> Result<Reply, UpstreamError> {
    let mut session = new_session(record, surface);
    if !skip_handshake {
        handshake(&mut session).await?;
    }
    post_rpc(&mut session, message).await
}

/// Map an UpstreamError to the 502/504 envelope.
fn upstream_failure(err: UpstreamError, record: &Record, method: &str) -> Response {
    let details = json!({ "sandboxId": record.id, "state": record.state, "method": method });
    match err {
        UpstreamError::Timeout(message) => fail(
            504,
            "upstream_timeout",
            &format!("{message} (the tool may still have executed; outcome unknown)"),
            Some(details),
        ),
        UpstreamError::Error(message) => {
            fail(502, "upstream_error", &message, Some(details))
        }
    }
}

/// JSON-RPC error → 400 upstream_rejected with the protocol error passed through.
fn rejected_by_upstream(rpc_error: &Value, extra: Value) -> Response {
    let mut jsonrpc = json!({
        "code": rpc_error.get("code").cloned().unwrap_or(Value::Null),
        "message": rpc_error.get("message").cloned().unwrap_or(Value::Null),
    });
    if let Some(data) = rpc_error.get("data") {
        jsonrpc["data"] = data.clone();
    }
    let mut details = json!({ "jsonrpc": jsonrpc });
    if let Some(obj) = extra.as_object() {
        for (k, v) in obj {
            details[k] = v.clone();
        }
    }
    fail(
        400,
        "upstream_rejected",
        rpc_error.get("message").and_then(Value::as_str).unwrap_or("upstream rejected the call"),
        Some(details),
    )
}

// ── route handlers ──────────────────────────────────────────────────────────

/// GET /sandboxes/:id/{mcp,exec}/tools — proxy tools/list.
async fn handle_tools_list(record: &Record, surface: Surface) -> Response {
    match run_operation(record, "tools/list", json!({}), surface).await {
        Ok(reply) => {
            let message = reply.message.unwrap_or(Value::Null);
            if let Some(err) = non_null(message.get("error")) {
                return fail(
                    502,
                    "upstream_error",
                    &format!(
                        "{} rejected tools/list: {}",
                        surface.daemon(),
                        err.get("message").and_then(Value::as_str).unwrap_or("unknown")
                    ),
                    Some(json!({ "sandboxId": record.id, "state": record.state, "method": "tools/list" })),
                );
            }
            let tools = message
                .pointer("/result/tools")
                .cloned()
                .unwrap_or_else(|| json!([]));
            Response::ok(json!({ "ok": true, "tools": tools }))
        }
        Err(e) => upstream_failure(e, record, "tools/list"),
    }
}

/// POST /sandboxes/:id/{mcp,exec}/tools/:name — proxy tools/call.
/// Tool errors stay HTTP 200: `isError` means the TOOL failed, the CALL did not.
async fn handle_tool_call(
    req: &Request,
    record: &Record,
    raw_name: &str,
    surface: Surface,
) -> Response {
    let name = crate::http::server::percent_decode(raw_name);
    if !is_tool_name(&name) {
        return fail(
            400,
            "invalid_field",
            "Invalid request path",
            Some(json!({ "errors": [
                "tool name must match /^[A-Za-z0-9._-]{1,128}$/ (use /mcp/rpc for exotic names)"
            ] })),
        );
    }
    let body = match parse_body(req) {
        Ok(b) => b,
        Err(r) => return r,
    };
    let arguments = match validate_tool_call(&body) {
        Ok(a) => a,
        Err(r) => return r,
    };

    match run_operation(
        record,
        "tools/call",
        json!({ "name": name, "arguments": arguments }),
        surface,
    )
    .await
    {
        Ok(reply) => {
            let message = reply.message.unwrap_or(Value::Null);
            if let Some(err) = non_null(message.get("error")) {
                return rejected_by_upstream(err, json!({ "tool": name })); // JSON-RPC refusal
            }
            Response::ok(json!({
                "ok": true,
                "result": message.get("result").cloned().unwrap_or(Value::Null),
            }))
        }
        Err(e) => upstream_failure(e, record, "tools/call"),
    }
}

/// POST /sandboxes/:id/{mcp,exec}/rpc — arbitrary method/params passthrough.
async fn handle_rpc(req: &Request, record: &Record, surface: Surface) -> Response {
    let body = match parse_body(req) {
        Ok(b) => b,
        Err(r) => return r,
    };
    let rpc = match validate_rpc(&body) {
        Ok(v) => v,
        Err(r) => return r,
    };

    let is_notification = rpc.id_is_null || rpc.method.starts_with("notifications/");
    let mut message = if is_notification {
        json!({ "jsonrpc": "2.0", "method": rpc.method })
    } else {
        json!({ "jsonrpc": "2.0", "id": rpc.id.clone().unwrap_or(json!(1)), "method": rpc.method })
    };
    // params verbatim passthrough: omitted stays omitted.
    if let Some(params) = rpc.params {
        message["params"] = params;
    }
    let skip_handshake = HANDSHAKE_METHODS.contains(&rpc.method.as_str());

    match run_passthrough(record, &message, skip_handshake, surface).await {
        Ok(reply) => {
            if is_notification {
                return match reply.message {
                    Some(_) => upstream_failure(
                        UpstreamError::Error(format!(
                            "{} answered a notification with a response body",
                            surface.daemon()
                        )),
                        record,
                        &rpc.method,
                    ),
                    None => Response::json(202, json!({ "ok": true })),
                };
            }
            let message = reply.message.unwrap_or(Value::Null);
            if let Some(err) = non_null(message.get("error")) {
                return rejected_by_upstream(err, json!({ "method": rpc.method }));
            }
            Response::ok(json!({
                "ok": true,
                "result": message.get("result").cloned().unwrap_or(Value::Null),
            }))
        }
        Err(e) => upstream_failure(e, record, &rpc.method),
    }
}

fn non_null(v: Option<&Value>) -> Option<&Value> {
    match v {
        Some(Value::Null) | None => None,
        Some(other) => Some(other),
    }
}

// ── dispatch ────────────────────────────────────────────────────────────────

/// Claims only `sandboxes/:id/{mcp,exec}/*`; everything else under
/// `/api/orchestration` falls through to the 2.1 handler.
pub fn claims(path: &str) -> bool {
    parse_path(path).is_some()
}

/// `/api/orchestration/sandboxes/<id>/<mcp|exec>[/<sub>]`
fn parse_path(path: &str) -> Option<(String, bool, String)> {
    let rest = path.strip_prefix("/api/orchestration/sandboxes/")?;
    let mut parts = rest.splitn(3, '/');
    let id = parts.next().filter(|s| !s.is_empty())?;
    let facade = parts.next()?;
    let is_exec = match facade {
        "exec" => true,
        "mcp" => false,
        _ => return None,
    };
    let sub = parts.next().unwrap_or("").trim_end_matches('/').to_string();
    Some((crate::http::server::percent_decode(id), is_exec, sub))
}

pub async fn handle(req: Request) -> Response {
    let (id, is_exec, sub) = match parse_path(&req.path) {
        Some(p) => p,
        None => return fail(404, "not_found", "Unknown MCP-driver resource", None),
    };
    let surface = if is_exec { Surface::Exec } else { Surface::Gui };

    // `tools` (list)
    if sub == "tools" {
        if req.method != "GET" {
            return fail(405, "method_not_allowed", "Use GET", None).with_header("allow", "GET");
        }
        let record = match gate(&id, is_exec).await {
            Ok(r) => r,
            Err(res) => return res,
        };
        return handle_tools_list(&record, surface).await;
    }

    // execd v0 serves only bash through the named proxy.
    if is_exec && sub == "tools/bash" {
        if req.method != "POST" {
            return fail(405, "method_not_allowed", "Use POST", None).with_header("allow", "POST");
        }
        let record = match gate_exec(&id).await {
            Ok(r) => r,
            Err(res) => return res,
        };
        return handle_tool_call(&req, &record, "bash", surface).await;
    }
    if is_exec && sub.starts_with("tools/") {
        return fail(
            404,
            "not_found",
            &format!("Unknown exec-driver resource: {sub} (execd v0 serves only bash)"),
            None,
        );
    }

    if sub == "rpc" {
        if req.method != "POST" {
            return fail(405, "method_not_allowed", "Use POST", None).with_header("allow", "POST");
        }
        let record = match gate(&id, is_exec).await {
            Ok(r) => r,
            Err(res) => return res,
        };
        return handle_rpc(&req, &record, surface).await;
    }

    if !is_exec && sub.starts_with("tools/") {
        if req.method != "POST" {
            return fail(405, "method_not_allowed", "Use POST", None).with_header("allow", "POST");
        }
        let record = match gate_sandbox(&id).await {
            Ok(r) => r,
            Err(res) => return res,
        };
        return handle_tool_call(&req, &record, &sub["tools/".len()..], surface).await;
    }

    let facade = if is_exec { "exec" } else { "MCP" };
    let name = if sub.is_empty() { "(none)" } else { &sub };
    fail(
        404,
        "not_found",
        &format!("Unknown {facade}-driver resource: {name}"),
        None,
    )
}

async fn gate(id: &str, is_exec: bool) -> Result<Record, Response> {
    if is_exec {
        gate_exec(id).await
    } else {
        gate_sandbox(id).await
    }
}

// ── validation (polite: every problem reported in one response) ─────────────

fn parse_body(req: &Request) -> Result<Value, Response> {
    if req.body.len() > MAX_BODY_BYTES {
        return Err(fail(
            413,
            "body_too_large",
            &format!("Request body exceeds {MAX_BODY_BYTES} bytes"),
            None,
        ));
    }
    if req.body.is_empty() {
        return Ok(json!({}));
    }
    match serde_json::from_slice::<Value>(&req.body) {
        Ok(v) if v.is_object() => Ok(v),
        Ok(_) => Err(fail(400, "invalid_body", "Request body must be a JSON object", None)),
        Err(_) => Err(fail(400, "invalid_json", "Request body must be valid JSON", None)),
    }
}

/// POST /mcp/tools/:name body: `{ arguments?: object }` — nothing else.
fn validate_tool_call(body: &Value) -> Result<Value, Response> {
    let obj = body.as_object().cloned().unwrap_or_default();
    let extra: Vec<String> = obj.keys().filter(|k| *k != "arguments").cloned().collect();
    if !extra.is_empty() {
        return Err(fail(
            400,
            "unknown_field",
            &format!("Unknown field(s): {}", extra.join(", ")),
            Some(json!({ "fields": extra })),
        ));
    }
    match obj.get("arguments") {
        None | Some(Value::Null) => Ok(json!({})),
        Some(v) if v.is_object() => Ok(v.clone()),
        Some(_) => Err(fail(
            400,
            "invalid_field",
            "Invalid request body",
            Some(json!({ "errors": ["arguments must be a JSON object"] })),
        )),
    }
}

struct RpcCall {
    method: String,
    params: Option<Value>,
    id: Option<Value>,
    id_is_null: bool,
}

/// POST /mcp/rpc body: `{ method: string, params?: object, id?: number|string|null }`.
fn validate_rpc(body: &Value) -> Result<RpcCall, Response> {
    let obj = body.as_object().cloned().unwrap_or_default();
    let allowed = ["method", "params", "id"];
    let extra: Vec<String> = obj
        .keys()
        .filter(|k| !allowed.contains(&k.as_str()))
        .cloned()
        .collect();
    if !extra.is_empty() {
        return Err(fail(
            400,
            "unknown_field",
            &format!("Unknown field(s): {}", extra.join(", ")),
            Some(json!({ "fields": extra })),
        ));
    }

    let mut errors: Vec<String> = Vec::new();
    let method = obj.get("method").and_then(Value::as_str).unwrap_or("");
    if method.trim().is_empty() || method.len() > 200 || method.chars().any(char::is_whitespace) {
        errors.push("method must be a non-empty string (no whitespace, ≤200 chars)".into());
    }
    let params = match obj.get("params") {
        None | Some(Value::Null) => None,
        Some(v) if v.is_object() => Some(v.clone()),
        Some(_) => {
            errors.push("params must be a JSON object when present".into());
            None
        }
    };
    let raw_id = obj.get("id");
    let id_is_null = matches!(raw_id, Some(Value::Null));
    let id = match raw_id {
        None | Some(Value::Null) => None,
        Some(v) if v.is_number() || v.is_string() => Some(v.clone()),
        Some(_) => {
            errors.push(
                "id must be a number, string, or null (null / omitted-on-notifications/* = JSON-RPC notification)"
                    .into(),
            );
            None
        }
    };

    if !errors.is_empty() {
        return Err(fail(
            400,
            "invalid_field",
            "Invalid request body",
            Some(json!({ "errors": errors })),
        ));
    }
    Ok(RpcCall {
        method: method.to_string(),
        params,
        id,
        id_is_null,
    })
}

fn fail(status: u16, code: &str, message: &str, details: Option<Value>) -> Response {
    let mut error = Map::new();
    error.insert("code".into(), json!(code));
    error.insert("message".into(), json!(message));
    if let Some(d) = details {
        error.insert("details".into(), d);
    }
    Response::json(status, json!({ "error": Value::Object(error) }))
}
