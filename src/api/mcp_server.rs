//! The host-level MCP tool server — the forward-facing replacement for a
//! remote shell (SBOX_PLAN1 §3.1).
//!
//! One Streamable-HTTP MCP endpoint at `POST /mcp`, exposing a pool of
//! sandboxes and the three harness hands that act inside the active one:
//!
//! | tool | acts on |
//! |---|---|
//! | `sandbox_create` | the pool — builds and boots, blocks until ready |
//! | `sandbox_list` | the pool |
//! | `sandbox_use` | the pool — moves the active cursor |
//! | `sandbox_destroy` | the pool |
//! | `sandbox_screenshot` | a sandbox's desktop (headed only) |
//! | `read` / `write` / `bash` | the ACTIVE sandbox, through execd |
//!
//! This is deliberately the opposite shape to a remote shell: the host never
//! accepts a control channel and never echoes a shell. It serves an ordinary
//! application protocol, and every side effect lands inside a container whose
//! reachability into the host is a mount the operator declared at create.
//!
//! **Auth.** Every call requires `Authorization: Bearer <token>` against the
//! LAN token, including on loopback. The control plane can create containers
//! with host mounts and run shell commands in them; that is not something to
//! leave open because the socket happens to be local today.
//!
//! Tool calls are journalled (see `journal`) so the web UI can show the
//! operator exactly what each client did, which is the whole point of putting
//! an agent's hands on your work laptop.

use std::time::Duration;

use serde_json::{json, Map, Value};

use super::containers;
use super::images::Kind;
use super::journal;
use super::mcp_driver;
use super::orchestration;
use super::orchestration_store::Record;
use super::orchestration_validate::validate_create;
use crate::http::{Request, Response};
use crate::lan_token;

const PROTOCOL_VERSION: &str = "2025-03-26";
const SERVER_NAME: &str = "sbox";
const SERVER_VERSION: &str = "1.0.0";

/// How long `sandbox_create` waits for a sandbox to settle before giving up.
/// A headed box boots in ~20-30s; a headless one in about one.
fn create_timeout() -> Duration {
    std::env::var("SBOX_CREATE_TIMEOUT_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|ms| *ms > 0)
        .map(Duration::from_millis)
        .unwrap_or(Duration::from_secs(150))
}

// ── transport ───────────────────────────────────────────────────────────────

pub async fn handle(req: Request) -> Response {
    if req.method != "POST" {
        return Response::json(
            405,
            json!({ "error": { "code": "method_not_allowed", "message": "Use POST" } }),
        )
        .with_header("allow", "POST");
    }

    // Auth before parsing: an unauthenticated caller learns nothing about the
    // protocol, not even whether its JSON was well-formed.
    if let Err(res) = authorize(&req) {
        return res;
    }

    let message: Value = match serde_json::from_slice(&req.body) {
        Ok(v) => v,
        Err(_) => return rpc_error(Value::Null, -32700, "Parse error"),
    };

    let id = message.get("id").cloned().unwrap_or(Value::Null);
    let method = message.get("method").and_then(Value::as_str).unwrap_or("");
    let params = message.get("params").cloned().unwrap_or_else(|| json!({}));

    match method {
        "initialize" => rpc_ok(
            id,
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": SERVER_NAME, "version": SERVER_VERSION },
                "instructions": INSTRUCTIONS,
            }),
        ),
        // Notifications carry no id and get an empty 202.
        m if m.starts_with("notifications/") => Response::bytes(202, "application/json", Vec::new()),
        "ping" => rpc_ok(id, json!({})),
        "tools/list" => rpc_ok(id, json!({ "tools": tool_schemas() })),
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            let args = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            let started = std::time::Instant::now();
            let outcome = call_tool(name, &args).await;
            journal::record(name, &args, &outcome, started.elapsed());
            match outcome {
                Ok(result) => rpc_ok(id, result),
                Err(ToolError::Protocol { code, message }) => rpc_error(id, code, &message),
                // A TOOL that failed is a successful CALL carrying isError —
                // the model should see the error text, not a transport fault.
                Err(ToolError::Tool(text)) => rpc_ok(
                    id,
                    json!({
                        "content": [{ "type": "text", "text": text }],
                        "isError": true,
                    }),
                ),
            }
        }
        "" => rpc_error(id, -32600, "Invalid Request"),
        other => rpc_error(id, -32601, &format!("Method not found: {other}")),
    }
}

const INSTRUCTIONS: &str = "\
A pool of sandboxes (isolated containers) and the hands to work inside one.

Create or pick a sandbox first: `sandbox_create` builds and boots one and \
makes it active; `sandbox_use` points at an existing one. `read`, `write` and \
`bash` then act INSIDE that active sandbox, never on the host. \
`image: \"headless\"` is a fast shell-only sandbox; `image: \"headed\"` adds a \
desktop you can screenshot.";

fn authorize(req: &Request) -> Result<(), Response> {
    let expected = lan_token::token();
    let presented = req
        .header("authorization")
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("");
    if lan_token::constant_time_eq(presented, &expected) {
        return Ok(());
    }
    Err(Response::json(
        401,
        json!({ "error": { "code": "unauthorized", "message": "Bearer token required" } }),
    )
    .with_header("www-authenticate", "Bearer"))
}

fn rpc_ok(id: Value, result: Value) -> Response {
    Response::ok(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}

fn rpc_error(id: Value, code: i64, message: &str) -> Response {
    Response::ok(json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message },
    }))
}

// ── tool outcomes ───────────────────────────────────────────────────────────

pub enum ToolError {
    /// The request was malformed — a JSON-RPC error.
    Protocol { code: i64, message: String },
    /// The tool ran and failed — `isError: true` with text for the model.
    Tool(String),
}

fn invalid(message: impl Into<String>) -> ToolError {
    ToolError::Protocol {
        code: -32602,
        message: message.into(),
    }
}

type ToolResult = Result<Value, ToolError>;

/// `{ content: [{type:"text", text}], structuredContent }` — the shape every
/// MCP client knows how to render, with the machine-readable copy beside it.
fn ok_text(text: impl Into<String>, structured: Value) -> Value {
    json!({
        "content": [{ "type": "text", "text": text.into() }],
        "structuredContent": structured,
        "isError": false,
    })
}

// ── schemas ─────────────────────────────────────────────────────────────────

fn tool_schemas() -> Value {
    json!([
        {
            "name": "sandbox_create",
            "description": "Create and boot a sandbox, then make it the active one. Blocks until it is ready (a headless sandbox takes ~1s, a headed one ~30s). Returns its id.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "image": {
                        "type": "string",
                        "enum": ["headed", "headless"],
                        "description": "headless = shell only (fast, small). headed = full desktop you can screenshot. Default headed."
                    },
                    "mounts": {
                        "type": "array",
                        "description": "Host directories to expose inside the sandbox. This is the ONLY way the sandbox can see the host filesystem.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "path": { "type": "string", "description": "Absolute host path" },
                                "target": { "type": "string", "description": "Absolute path inside the sandbox (default: same as path)" },
                                "mode": { "type": "string", "enum": ["ro", "rw"], "description": "Default ro" }
                            },
                            "required": ["path"]
                        }
                    },
                    "network": { "type": "boolean", "description": "Container network connectivity. Only true is supported today (false would also cut the published ports the sandbox is driven through)." },
                    "repos": {
                        "type": "array",
                        "description": "Git repositories to clone into /home/desktop/repos at boot.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "url": { "type": "string" },
                                "ref": { "type": "string", "description": "Branch or tag" }
                            },
                            "required": ["url"]
                        }
                    }
                }
            }
        },
        {
            "name": "sandbox_list",
            "description": "List every sandbox: id, image kind, state, mounts, and which one is active.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "sandbox_use",
            "description": "Make a sandbox the active one. read/write/bash/screenshot act on the active sandbox.",
            "inputSchema": {
                "type": "object",
                "properties": { "id": { "type": "string" } },
                "required": ["id"]
            }
        },
        {
            "name": "sandbox_destroy",
            "description": "Stop and delete a sandbox. Named volumes persist; host mount paths are never touched.",
            "inputSchema": {
                "type": "object",
                "properties": { "id": { "type": "string", "description": "Defaults to the active sandbox." } }
            }
        },
        {
            "name": "sandbox_screenshot",
            "description": "Capture the sandbox desktop as a PNG image. Headed sandboxes only.",
            "inputSchema": {
                "type": "object",
                "properties": { "id": { "type": "string", "description": "Defaults to the active sandbox." } }
            }
        },
        {
            "name": "read",
            "description": "Read a file inside the active sandbox.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "offset": { "type": "integer" },
                    "limit": { "type": "integer" }
                },
                "required": ["path"]
            }
        },
        {
            "name": "write",
            "description": "Write a file inside the active sandbox, creating parent directories as needed.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "content": { "type": "string" }
                },
                "required": ["path", "content"]
            }
        },
        {
            "name": "bash",
            "description": "Run a shell command inside the active sandbox. Returns combined stdout and stderr.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "command": { "type": "string" },
                    "timeout": { "type": "integer", "description": "Seconds." },
                    "cwd": { "type": "string" }
                },
                "required": ["command"]
            }
        }
    ])
}

// ── dispatch ────────────────────────────────────────────────────────────────

async fn call_tool(name: &str, args: &Value) -> ToolResult {
    match name {
        "sandbox_create" => sandbox_create(args).await,
        "sandbox_list" => sandbox_list().await,
        "sandbox_use" => sandbox_use(args),
        "sandbox_destroy" => sandbox_destroy(args).await,
        "sandbox_screenshot" => sandbox_screenshot(args).await,
        "read" | "write" | "bash" => guest_tool(name, args).await,
        other => Err(invalid(format!("Unknown tool: {other}"))),
    }
}

/// Translate the MCP-facing create payload into the orchestration one and
/// reuse its validator — one set of rules for both front doors.
fn to_create_payload(args: &Value) -> Result<Value, ToolError> {
    let obj = args.as_object().cloned().unwrap_or_default();
    let mut payload = Map::new();
    if let Some(image) = obj.get("image") {
        payload.insert("image".into(), image.clone());
    }
    if let Some(network) = obj.get("network") {
        payload.insert("network".into(), network.clone());
    }
    if let Some(repos) = obj.get("repos") {
        payload.insert("repos".into(), repos.clone());
    }
    // `mounts` is the ergonomic spelling of a host bind volume.
    if let Some(mounts) = obj.get("mounts") {
        let list = mounts
            .as_array()
            .ok_or_else(|| invalid("mounts must be an array"))?;
        let mut volumes = Vec::new();
        for m in list {
            let path = m
                .get("path")
                .and_then(Value::as_str)
                .ok_or_else(|| invalid("each mount needs a 'path'"))?;
            let target = m.get("target").and_then(Value::as_str).unwrap_or(path);
            let mode = m.get("mode").and_then(Value::as_str).unwrap_or("ro");
            volumes.push(json!({
                "type": "bind",
                "path": path,
                "mount": target,
                "mode": mode,
            }));
        }
        payload.insert("volumes".into(), Value::Array(volumes));
    }
    Ok(Value::Object(payload))
}

async fn sandbox_create(args: &Value) -> ToolResult {
    let payload = to_create_payload(args)?;
    let input = validate_create(&payload).map_err(|e| {
        // Report every problem at once — the agent fixes its call in one turn.
        let detail = e
            .details
            .get("errors")
            .and_then(Value::as_array)
            .map(|errs| {
                errs.iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join("; ")
            })
            .unwrap_or_else(|| e.message.clone());
        invalid(detail)
    })?;

    let kind = input.kind;
    let record = orchestration::start_create(input).map_err(ToolError::Tool)?;
    let id = record.id.clone();

    match orchestration::wait_until_settled(&id, create_timeout()).await {
        Some(settled) if settled.state == "ready" => {
            // Creating a sandbox is how you start working in one.
            let _ = orchestration::set_active(&id);
            Ok(ok_text(
                format!(
                    "Sandbox {id} is ready ({}) and is now the active sandbox.",
                    kind.as_str()
                ),
                orchestration::detail_of(&settled),
            ))
        }
        Some(settled) => Err(ToolError::Tool(format!(
            "Sandbox {id} did not become ready (state: {}){}. It still exists — inspect it with sandbox_list or remove it with sandbox_destroy.",
            settled.state,
            settled
                .error
                .as_ref()
                .and_then(|e| e.get("message"))
                .and_then(Value::as_str)
                .map(|m| format!(": {m}"))
                .unwrap_or_default()
        ))),
        None => Err(ToolError::Tool(format!(
            "Sandbox {id} was still booting after {}s. It still exists — poll it with sandbox_list, or remove it with sandbox_destroy.",
            create_timeout().as_secs()
        ))),
    }
}

async fn sandbox_list() -> ToolResult {
    let active = orchestration::active_id();
    let records = orchestration::list_records().await;
    let items: Vec<Value> = records
        .iter()
        .map(|r| {
            let mut item = orchestration::list_item_of(r);
            item["active"] = json!(active.as_deref() == Some(r.id.as_str()));
            item
        })
        .collect();

    let summary = if items.is_empty() {
        "No sandboxes. Create one with sandbox_create.".to_string()
    } else {
        records
            .iter()
            .map(|r| {
                format!(
                    "{}{}  {}  {}",
                    if active.as_deref() == Some(r.id.as_str()) { "* " } else { "  " },
                    r.id,
                    r.kind.as_str(),
                    r.state
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    };
    Ok(ok_text(
        summary,
        json!({ "sandboxes": items, "activeId": active }),
    ))
}

fn sandbox_use(args: &Value) -> ToolResult {
    let id = args
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("id is required"))?;
    orchestration::set_active(id).map_err(ToolError::Tool)?;
    Ok(ok_text(
        format!("Active sandbox is now {id}."),
        json!({ "activeId": id }),
    ))
}

async fn sandbox_destroy(args: &Value) -> ToolResult {
    let id = resolve_id(args)?;
    let response = orchestration::destroy(&id).await;
    match response {
        Ok(volumes) => Ok(ok_text(
            format!("Sandbox {id} destroyed."),
            json!({ "id": id, "state": "deleted", "volumes": volumes }),
        )),
        Err(e) => Err(ToolError::Tool(e)),
    }
}

async fn sandbox_screenshot(args: &Value) -> ToolResult {
    let id = resolve_id(args)?;
    let record = require_record(&id)?;
    if !record.kind.has_desktop() {
        return Err(ToolError::Tool(format!(
            "Sandbox {id} is a '{}' sandbox: it has no desktop to capture. Create one with image: \"headed\" if you need a screen.",
            record.kind.as_str()
        )));
    }
    let png = containers::capture_screen(&record)
        .await
        .map_err(ToolError::Tool)?;
    // An image content block: the model sees the screen, not a file path.
    Ok(json!({
        "content": [{
            "type": "image",
            "data": png,
            "mimeType": "image/png",
        }],
        "isError": false,
    }))
}

/// `read` / `write` / `bash` — forwarded verbatim to execd in the active
/// sandbox. The names and argument shapes are execd's own, so the tool an
/// agent calls here is the tool that runs in there.
async fn guest_tool(name: &str, args: &Value) -> ToolResult {
    let id = orchestration::active_id().ok_or_else(|| {
        ToolError::Tool(
            "No active sandbox. Create one with sandbox_create, or pick one with sandbox_use."
                .into(),
        )
    })?;
    let record = require_record(&id)?;
    if record.state != "ready" {
        return Err(ToolError::Tool(format!(
            "Sandbox {id} is not ready (state: {}).",
            record.state
        )));
    }

    let reply = mcp_driver::call_exec_tool(&record, name, args.clone())
        .await
        .map_err(ToolError::Tool)?;

    // execd already answers in MCP's content shape; pass it through so the
    // model sees exactly what the guest produced, truncation markers and all.
    Ok(reply)
}

fn resolve_id(args: &Value) -> Result<String, ToolError> {
    match args.get("id").and_then(Value::as_str) {
        Some(id) if !id.is_empty() => Ok(id.to_string()),
        _ => orchestration::active_id().ok_or_else(|| {
            ToolError::Tool(
                "No sandbox given and no active sandbox. Pass an id, or pick one with sandbox_use."
                    .into(),
            )
        }),
    }
}

fn require_record(id: &str) -> Result<Record, ToolError> {
    orchestration::record_of(id)
        .ok_or_else(|| ToolError::Tool(format!("No such sandbox: {id}")))
}

/// Which `Kind` an image name maps to — re-exported for the journal's labels.
pub fn kind_name(record: &Record) -> &'static str {
    Kind::as_str(record.kind)
}
