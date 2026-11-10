//! sbox orchestration API — machine-facing lifecycle for AJCS (job controller).
//!
//!   POST   /api/orchestration/sandboxes       create + boot (async: 202, then poll)
//!   GET    /api/orchestration/sandboxes       list tracked sandboxes (no tokens)
//!   GET    /api/orchestration/sandboxes/:id   detail (includes per-sandbox token)
//!   DELETE /api/orchestration/sandboxes/:id   stop + delete (named volumes persist;
//!                                             host bind paths never touched)
//!   GET    /api/orchestration/healthz         service health
//!
//! Reuses the `containers` primitives (CLI runner, HMAC token scheme, image
//! name); create mirrors `create_container` plus volume binds, clones and
//! readiness. Volumes are typed (named | host-path bind — idea #22/RCA-1).
//! Contract: docs/orchestration-contract.md.
//!
//! State lives in one `Mutex<Store>` rather than the Node version's module
//! globals: the record map, the in-flight set and the readiness stamps are
//! mutated from request handlers and from background pipeline tasks at the
//! same time, so they are one lock, taken briefly and never held across an
//! await.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};

use super::container_cli as cli;
use super::containers::{self, container_token, GUEST_EXEC_PORT, GUEST_MCP_PORT, GUEST_QUIC_PORT};
use super::images::Kind;
use super::orchestration_store::{state_file, Record, Transition};
use super::orchestration_validate::validate_create;
use super::orchestration_volumes::{
    to_volume_after_delete, to_volume_detail, volume_create_args, VolumeKind,
};
use crate::http::{Request, Response};
use crate::util;

/// Once confirmed-up, trust the probe this long without re-fetching.
const READY_TTL: Duration = Duration::from_secs(30);
/// Boot deadline before the pipeline gives up (state → error).
const BOOT_DEADLINE: Duration = Duration::from_secs(120);
const BOOT_POLL: Duration = Duration::from_millis(500);
/// `container start` returns before init accepts execs — retry briefly.
const EXEC_RETRIES: u32 = 3;
/// A guest exec (git clone being the long pole) must never wedge the pipeline.
const EXEC_TIMEOUT: Duration = Duration::from_secs(180);
const EXEC_RETRY: Duration = Duration::from_secs(1);
/// DELETE join timeout before force-cleaning a wedged pipeline.
const PIPELINE_JOIN_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_TRANSITIONS: usize = 50;

// ── shared state ────────────────────────────────────────────────────────────

#[derive(Default)]
struct Store {
    /// id → record. Ordered so list output is stable across reads.
    records: BTreeMap<String, Record>,
    /// ids with a live background pipeline (create→start→clone→ready).
    in_flight: HashSet<String>,
    /// ids a DELETE has asked to stand down.
    aborted: HashSet<String>,
    /// id → last confirmed-good readiness probe.
    known_good: HashMap<String, Instant>,
    loaded: bool,
}

fn store() -> &'static Mutex<Store> {
    static STORE: OnceLock<Mutex<Store>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(Store::default()))
}

/// Load the persisted records once per process. A missing or corrupt file
/// reads as empty — the CLI reconcile re-derives container state anyway.
fn ensure_loaded(st: &mut Store) {
    if st.loaded {
        return;
    }
    st.loaded = true;
    let raw = match std::fs::read_to_string(state_file()) {
        Ok(r) => r,
        Err(_) => return,
    };
    let doc: Value = match serde_json::from_str(&raw) {
        Ok(d) => d,
        Err(_) => return,
    };
    if let Some(map) = doc.get("sandboxes").and_then(Value::as_object) {
        for (id, value) in map {
            if let Ok(record) = serde_json::from_value::<Record>(value.clone()) {
                st.records.insert(id.clone(), record);
            }
        }
    }
}

fn save(st: &Store) {
    let path = state_file();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    let sandboxes: Map<String, Value> = st
        .records
        .iter()
        .filter_map(|(id, r)| serde_json::to_value(r).ok().map(|v| (id.clone(), v)))
        .collect();
    let body = json!({ "version": 1, "sandboxes": Value::Object(sandboxes) });
    if let Ok(text) = serde_json::to_string_pretty(&body) {
        std::fs::write(&path, text).ok();
    }
}

/// Apply a state transition and persist. Takes the lock itself, so callers
/// must not already hold it.
fn set_state(id: &str, state: &str, error: Option<Value>) {
    let mut st = store().lock().unwrap();
    ensure_loaded(&mut st);
    let now = util::now_iso();
    if let Some(record) = st.records.get_mut(id) {
        record.state = state.to_string();
        record.error = error;
        record.updated_at = now.clone();
        record.transitions.push(Transition {
            state: state.to_string(),
            at: now,
        });
        if record.transitions.len() > MAX_TRANSITIONS {
            let drop = record.transitions.len() - MAX_TRANSITIONS;
            record.transitions.drain(0..drop);
        }
    }
    save(&st);
}

fn get_record(id: &str) -> Option<Record> {
    let mut st = store().lock().unwrap();
    ensure_loaded(&mut st);
    st.records.get(id).cloned()
}

fn is_aborted(id: &str) -> bool {
    store().lock().unwrap().aborted.contains(id)
}

// ── readiness ───────────────────────────────────────────────────────────────

/// Same readiness probe as `containers`: spacesd `/health` → 2xx once serving;
/// `/mcp` lives behind the same port.
async fn is_serving(record: &Record) -> bool {
    // A headless sandbox has no spacesd: its readiness is execd's /healthz on
    // the exec port, so probing mcp_port would simply never answer.
    let port = if record.kind.has_desktop() {
        record.mcp_port
    } else {
        record.exec_port
    };
    if port == 0 {
        return false;
    }
    {
        let st = store().lock().unwrap();
        if let Some(at) = st.known_good.get(&record.id) {
            if at.elapsed() < READY_TTL {
                return true;
            }
        }
    }
    let serving = containers::probe_serving("127.0.0.1", port, record.kind).await;
    let mut st = store().lock().unwrap();
    if serving {
        st.known_good.insert(record.id.clone(), Instant::now());
    } else {
        st.known_good.remove(&record.id);
    }
    serving
}

// ── response shapes ─────────────────────────────────────────────────────────

/// List item. The token is deliberately omitted — detail endpoint only.
fn to_list_item(record: &Record) -> Value {
    let repos: Vec<Value> = record
        .repos
        .iter()
        .map(|r| {
            json!({
                "url": r.url,
                "ref": r.r#ref,
                "cloned": r.cloned,
                "path": r.path,
                "error": r.error,
            })
        })
        .collect();
    let mut out = json!({
        "id": record.id,
        "state": record.state,
        "kind": record.kind.as_str(),
        "mcpPort": if record.kind.has_desktop() { json!(record.mcp_port) } else { Value::Null },
        "quicPort": if record.kind.has_desktop() { json!(record.quic_port) } else { Value::Null },
        "mcpUrl": if record.kind.has_desktop() { port_url(record.mcp_port) } else { Value::Null },
        // pre-execd records have no exec surface
        "execPort": if record.exec_port == 0 { Value::Null } else { json!(record.exec_port) },
        "execUrl": port_url(record.exec_port),
        "repos": repos,
        // Volumes ride list items too (RCA-1): bind entries must be visible
        // without a detail round-trip — additive, contract §15.
        "volumes": record.volumes.iter().map(to_volume_detail).collect::<Vec<_>>(),
        "createdAt": record.created_at,
    });
    // Caller-owned backref rides list items too (non-secret label, verbatim);
    // the key is absent entirely when the record carries none.
    if let Some(b) = &record.backref {
        out["backref"] = Value::Object(b.clone());
    }
    out
}

fn port_url(port: u16) -> Value {
    if port == 0 {
        Value::Null
    } else {
        Value::String(format!("http://127.0.0.1:{port}/mcp"))
    }
}

fn to_detail(record: &Record) -> Value {
    let mut out = to_list_item(record);
    out["image"] = json!(record.image);
    out["cpus"] = json!(record.cpus);
    out["memory"] = json!(record.memory);
    // Authorization: Bearer <token> on the data plane.
    out["token"] = json!(container_token(&record.id));
    out["transitions"] = serde_json::to_value(&record.transitions).unwrap_or(Value::Null);
    out["updatedAt"] = json!(record.updated_at);
    out["error"] = record.error.clone().unwrap_or(Value::Null);
    out
}

// ── reconcile (the CLI is the source of truth for existence/state) ──────────

/// `container ls` for reconciliation; `None` on CLI outage so callers serve
/// last-known state instead of pruning records on a failed lookup.
async fn safe_rows() -> Option<Vec<containers::Row>> {
    match containers::list_containers().await {
        Ok(rows) => Some(rows),
        Err(e) => {
            eprintln!("[orchestration] container ls failed; serving last-known state: {e}");
            None
        }
    }
}

async fn inspect_state(id: &str) -> Option<String> {
    let out = cli::run_str(&["inspect", id]).await.ok()?;
    if out.failed() {
        return None;
    }
    let docs: Value = serde_json::from_str(&out.stdout).ok()?;
    docs.pointer("/0/status/state")
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// Reconcile one record against an `ls` snapshot. Returns `None` when the
/// record was pruned (its container vanished externally).
async fn reconcile_row(record: &Record, rows: Option<&Vec<containers::Row>>) -> Option<Record> {
    let rows = match rows {
        // CLI outage → last-known state; never prune on a failed lookup.
        None => return Some(record.clone()),
        Some(r) => r,
    };
    let row = rows
        .iter()
        .find(|c| c.id == record.id && c.image == record.image);
    if row.map(|r| r.state.as_str()) == Some("running") {
        if is_serving(record).await {
            if record.state != "ready" {
                // also heals 'error' after a late boot
                set_state(&record.id, "ready", None);
            }
        } else if record.state != "starting" {
            // running but not serving yet (booting, or the daemon died)
            set_state(&record.id, "starting", None);
        }
        return get_record(&record.id);
    }

    // `container ls` omits stopped containers — inspect tells stopped from deleted.
    match inspect_state(&record.id).await.as_deref() {
        Some("running") => return get_record(&record.id), // ls/inspect race — trust the next read
        Some("stopped") | Some("exited") | Some("created") => {
            if record.state != "stopped" {
                set_state(&record.id, "stopped", None);
            }
            return get_record(&record.id);
        }
        _ => {}
    }
    if record.state == "error" {
        // boot-failure diagnostics stay visible until DELETE
        return get_record(&record.id);
    }
    let mut st = store().lock().unwrap();
    ensure_loaded(&mut st);
    st.records.remove(&record.id);
    save(&st);
    None
}

/// Reconcile every persisted record against one `container ls`. Skips
/// in-flight pipelines (they own their transitions).
async fn reconcile_all() -> Vec<Record> {
    let snapshot: Vec<Record> = {
        let mut st = store().lock().unwrap();
        ensure_loaded(&mut st);
        let mut v: Vec<Record> = st.records.values().cloned().collect();
        // Newest first, by creation time.
        v.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        v
    };
    let rows = safe_rows().await;
    let mut out = Vec::new();
    for record in snapshot {
        let in_flight = store().lock().unwrap().in_flight.contains(&record.id);
        if in_flight {
            out.push(record);
            continue;
        }
        if let Some(r) = reconcile_row(&record, rows.as_ref()).await {
            out.push(r);
        }
    }
    out
}

async fn find_tracked(id: &str) -> Option<Record> {
    let record = get_record(id)?;
    let in_flight = store().lock().unwrap().in_flight.contains(id);
    if in_flight {
        return Some(record);
    }
    let rows = safe_rows().await;
    reconcile_row(&record, rows.as_ref()).await
}

// ── create pipeline (background) ────────────────────────────────────────────

struct PipelineError {
    code: &'static str,
    message: String,
}

fn fresh_id() -> String {
    loop {
        let id = format!("sandbox2-{}", util::random_hex(4));
        let taken = {
            let mut st = store().lock().unwrap();
            ensure_loaded(&mut st);
            st.records.contains_key(&id)
        };
        if !taken {
            return id;
        }
    }
}

/// Idempotent (the CLI errors "already exists" for existing); `created` = we
/// made it. Bind entries are skipped entirely: a host path is NOT a volume we
/// own — `container volume create` would be nonsense and `created` stays false
/// forever (idea #22/RCA-1).
async fn ensure_volumes(id: &str) -> Result<(), PipelineError> {
    let volumes = match get_record(id) {
        Some(r) => r.volumes,
        None => return Ok(()),
    };
    for (index, vol) in volumes.iter().enumerate() {
        if is_aborted(id) {
            return Ok(());
        }
        if vol.kind == VolumeKind::Bind {
            continue;
        }
        let res = cli::run_str(&["volume", "create", &vol.name])
            .await
            .map_err(|e| PipelineError {
                code: "volume_failed",
                message: util::first_line(&e),
            })?;
        if res.exit_code == 0 {
            let mut st = store().lock().unwrap();
            if let Some(r) = st.records.get_mut(id) {
                if let Some(v) = r.volumes.get_mut(index) {
                    v.created = true;
                }
            }
            save(&st);
        } else if !res.stderr.contains("already exists") {
            return Err(PipelineError {
                code: "volume_failed",
                message: util::first_line(res.message()),
            });
        }
    }
    Ok(())
}

/// One bounded guest exec: a hard wall-clock so a hung guest process (a git
/// credential prompt on the console, a wedged download) records as a FAILED
/// exec instead of wedging the pipeline forever. Git clones additionally run
/// as the DESKTOP USER (`-u desktop` + HOME=/home/desktop, so git finds its
/// global config) and with GIT_TERMINAL_PROMPT=0 + a null askpass — an auth
/// challenge becomes an immediate failure instead of a hidden console prompt.
async fn exec_bounded(argv: &[String]) -> cli::Output {
    // OPTIONS BEFORE THE ID: `container exec [<options>] <container-id> <args>`
    // — env flags after the id are parsed as the target executable.
    let is_git = argv.get(2).map(String::as_str) == Some("git");
    let full: Vec<String> = if is_git {
        let mut v: Vec<String> = vec![
            "exec".into(),
            "-u".into(),
            "desktop".into(),
            "-e".into(),
            "GIT_TERMINAL_PROMPT=0".into(),
            "-e".into(),
            "GIT_ASKPASS=/bin/true".into(),
            "-e".into(),
            "HOME=/home/desktop".into(),
        ];
        v.extend_from_slice(&argv[1..]);
        v
    } else {
        argv.to_vec()
    };
    match tokio::time::timeout(EXEC_TIMEOUT, cli::run(&full)).await {
        Ok(Ok(out)) => out,
        Ok(Err(e)) => cli::Output {
            stdout: String::new(),
            stderr: e,
            exit_code: 1,
        },
        Err(_) => cli::Output {
            stdout: String::new(),
            stderr: format!(
                "exec timed out after {}ms (guest process likely hung)",
                EXEC_TIMEOUT.as_millis()
            ),
            exit_code: 124,
        },
    }
}

async fn exec_with_retry(argv: &[String]) -> cli::Output {
    let mut res = cli::Output::default();
    for attempt in 1..=EXEC_RETRIES {
        res = exec_bounded(argv).await;
        if res.exit_code == 0 || !res.stderr.contains("not running") {
            return res;
        }
        if attempt < EXEC_RETRIES {
            tokio::time::sleep(EXEC_RETRY).await;
        }
    }
    res
}

fn repo_dest(url: &str, used: &mut Vec<String>) -> String {
    let base: String = url
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or("repo")
        .trim_end_matches(".git")
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' {
                c
            } else {
                '-'
            }
        })
        .take(64)
        .collect();
    let base = if base.is_empty() { "repo".to_string() } else { base };
    let mut name = base.clone();
    let mut n = 2;
    while used.contains(&name) {
        name = format!("{base}-{n}");
        n += 1;
    }
    used.push(name.clone());
    format!("/home/desktop/repos/{name}")
}

/// Clone repos inside the guest, sequentially, recording per-repo status.
/// A failed clone does NOT fail the sandbox — AJCS decides per-repo. Repos
/// land in /home/desktop/repos (the desktop user's own home) so the session
/// user — not root — owns and sees them.
async fn clone_repos(id: &str) {
    let repos = match get_record(id) {
        Some(r) if !r.repos.is_empty() => r.repos,
        _ => return,
    };
    set_state(id, "cloning", None);
    let mut used: Vec<String> = Vec::new();
    for (index, repo) in repos.iter().enumerate() {
        if is_aborted(id) {
            return;
        }
        let dest = repo_dest(&repo.url, &mut used);
        let mut argv: Vec<String> = vec![
            "exec".into(),
            id.to_string(),
            "git".into(),
            "clone".into(),
        ];
        if let Some(r) = &repo.r#ref {
            argv.push("-b".into());
            argv.push(r.clone());
        }
        // `--` stops a hostile URL from parsing as a git option.
        argv.push("--".into());
        argv.push(repo.url.clone());
        argv.push(dest.clone());

        let res = exec_with_retry(&argv).await;
        let mut st = store().lock().unwrap();
        if let Some(record) = st.records.get_mut(id) {
            if let Some(entry) = record.repos.get_mut(index) {
                entry.path = Some(dest);
                entry.cloned = res.exit_code == 0;
                entry.error = if entry.cloned {
                    None
                } else {
                    let msg = if res.message().is_empty() {
                        "git clone failed".to_string()
                    } else {
                        res.message().to_string()
                    };
                    Some(msg.chars().take(500).collect())
                };
            }
        }
        save(&st);
    }
}

/// Poll the health probe until serving or deadline (spacesd boots ~10–30s).
async fn await_readiness(id: &str) -> bool {
    let deadline = Instant::now() + BOOT_DEADLINE;
    loop {
        if let Some(record) = get_record(id) {
            if is_serving(&record).await {
                return true;
            }
        }
        if is_aborted(id) || Instant::now() > deadline {
            return false;
        }
        tokio::time::sleep(BOOT_POLL).await;
    }
}

async fn force_cleanup(id: &str) {
    let _ = cli::run_str(&["stop", id]).await;
    let _ = cli::run_str(&["rm", id]).await;
}

/// Background lifecycle: volumes → create → start → clone → ready.
async fn run_pipeline(id: String) {
    let result = pipeline_body(&id).await;
    if let Err(e) = result {
        set_state(
            &id,
            "error",
            Some(json!({ "code": e.code, "message": e.message })),
        );
    }
    let mut st = store().lock().unwrap();
    st.in_flight.remove(&id);
}

async fn pipeline_body(id: &str) -> Result<(), PipelineError> {
    ensure_volumes(id).await?;
    if is_aborted(id) {
        return Ok(());
    }

    let record = match get_record(id) {
        Some(r) => r,
        None => return Ok(()),
    };

    // A headless sandbox binds only execd, so publishing spacesd's TCP port
    // and its QUIC media port would map host ports at nothing.
    let mut argv: Vec<String> = vec!["create".into()];
    if record.kind.has_desktop() {
        argv.extend([
            "-p".into(),
            format!("{}:{}", record.mcp_port, GUEST_MCP_PORT),
            "-p".into(),
            format!("{}:{}/udp", record.quic_port, GUEST_QUIC_PORT),
        ]);
    }
    argv.extend(["-p".into(), format!("{}:{}", record.exec_port, GUEST_EXEC_PORT)]);
    // Named volumes → `-v name:mount:mode`; host binds → `--mount
    // type=bind,…`. All of it rides BEFORE the image — OPTIONS-BEFORE-TARGET.
    argv.extend(volume_create_args(&record.volumes));
    argv.extend([
        "-c".into(),
        record.cpus.to_string(),
        "-m".into(),
        record.memory.clone(),
        "--name".into(),
        record.id.clone(),
        "-e".into(),
        format!("CUA_ENV_TOKEN={}", container_token(&record.id)),
        record.image.clone(),
    ]);

    let created = cli::run(&argv).await.map_err(|e| PipelineError {
        code: "create_failed",
        message: util::first_line(&e),
    })?;
    if created.failed() {
        return Err(PipelineError {
            code: "create_failed",
            message: util::first_line(created.message()),
        });
    }

    set_state(id, "starting", None);
    let started = cli::run_str(&["start", id]).await.map_err(|e| PipelineError {
        code: "start_failed",
        message: util::first_line(&e),
    })?;
    if started.failed() {
        // mirror create_container: no dead containers left behind
        force_cleanup(id).await;
        return Err(PipelineError {
            code: "start_failed",
            message: util::first_line(started.message()),
        });
    }

    clone_repos(id).await;
    if is_aborted(id) {
        return Ok(()); // DELETE owns the outcome from here
    }
    if await_readiness(id).await {
        set_state(id, "ready", None);
        Ok(())
    } else if is_aborted(id) {
        Ok(())
    } else {
        Err(PipelineError {
            code: "readiness_timeout",
            message: format!(
                "spacesd did not serve /health within {}s",
                BOOT_DEADLINE.as_secs()
            ),
        })
    }
}

// ── route handlers ──────────────────────────────────────────────────────────

fn fail(status: u16, code: &str, message: &str) -> Response {
    Response::json(status, json!({ "error": { "code": code, "message": message } }))
}

fn fail_with(status: u16, code: &str, message: &str, details: Value) -> Response {
    Response::json(
        status,
        json!({ "error": { "code": code, "message": message, "details": details } }),
    )
}

async fn handle_create(req: &Request) -> Response {
    let body: Value = if req.body.is_empty() {
        json!({}) // empty body = defaults
    } else {
        match serde_json::from_slice(&req.body) {
            Ok(v) => v,
            Err(_) => return fail(400, "invalid_json", "Request body must be valid JSON"),
        }
    };
    if !body.is_object() {
        return fail(400, "invalid_body", "Request body must be a JSON object");
    }
    let input = match validate_create(&body) {
        Ok(v) => v,
        Err(e) => return fail_with(400, e.code, &e.message, e.details),
    };

    let id = fresh_id();
    // Registered before any await — a concurrent GET must not reconcile-prune
    // a half-created record.
    {
        let mut st = store().lock().unwrap();
        ensure_loaded(&mut st);
        st.in_flight.insert(id.clone());
    }

    let ports = (
        util::allocate_host_port(),
        util::allocate_host_port(),
        util::allocate_host_port(),
    );
    let (mcp_port, quic_port, exec_port) = match ports {
        (Ok(a), Ok(b), Ok(c)) => (a, b, c),
        _ => {
            store().lock().unwrap().in_flight.remove(&id);
            return fail(500, "internal_error", "could not allocate host ports");
        }
    };

    let now = util::now_iso();
    let record = Record {
        id: id.clone(),
        image: input.kind.image(),
        kind: input.kind,
        cpus: input.cpus.unwrap_or(4),
        memory: input.memory.unwrap_or_else(|| "2048M".into()),
        volumes: input.volumes,
        repos: input.repos,
        backref: input.backref,
        mcp_port,
        quic_port,
        exec_port,
        created_at: now.clone(),
        updated_at: now.clone(),
        state: "creating".into(),
        transitions: vec![Transition {
            state: "creating".into(),
            at: now,
        }],
        error: None,
        aborted: false,
    };

    let detail = to_detail(&record);
    {
        let mut st = store().lock().unwrap();
        st.records.insert(id.clone(), record);
        save(&st);
    }

    tokio::spawn(run_pipeline(id));
    Response::json(202, detail)
}

async fn handle_list() -> Response {
    let records = reconcile_all().await;
    Response::ok(json!({
        "sandboxes": records.iter().map(to_list_item).collect::<Vec<_>>(),
    }))
}

async fn handle_detail(id: &str) -> Response {
    match find_tracked(id).await {
        Some(record) => Response::ok(to_detail(&record)),
        None => fail(404, "not_found", &format!("No such sandbox: {id}")),
    }
}

async fn handle_delete(id: &str) -> Response {
    let record = match get_record(id) {
        Some(r) => r,
        None => return fail(404, "not_found", &format!("No such sandbox: {id}")),
    };

    // The pipeline checks `aborted` between stages and stands down. Wait for
    // it to notice, but never longer than the join timeout — a wedged clone
    // must not hold the DELETE open.
    let in_flight = {
        let mut st = store().lock().unwrap();
        st.aborted.insert(id.to_string());
        st.in_flight.contains(id)
    };
    if in_flight {
        let deadline = Instant::now() + PIPELINE_JOIN_TIMEOUT;
        while Instant::now() < deadline {
            if !store().lock().unwrap().in_flight.contains(id) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    let _ = cli::run_str(&["stop", id]).await;
    let removed = match cli::run_str(&["rm", id]).await {
        Ok(out) => out,
        Err(e) => return fail(502, "upstream_error", &util::first_line(&e)),
    };
    // "not found" = already gone (deleted via CLI / legacy route) — success.
    if removed.failed() && !removed.stderr.to_lowercase().contains("not found") {
        let msg = if removed.stderr.is_empty() {
            "container rm failed".to_string()
        } else {
            util::first_line(&removed.stderr)
        };
        return fail(502, "upstream_error", &msg);
    }

    {
        let mut st = store().lock().unwrap();
        st.records.remove(id);
        st.known_good.remove(id);
        st.aborted.remove(id);
        save(&st);
    }
    containers::forget_readiness(id);

    Response::ok(json!({
        "id": id,
        "state": "deleted",
        "volumes": record.volumes.iter().map(to_volume_after_delete).collect::<Vec<_>>(),
    }))
}

/// Registered AHEAD of the `/api/` catch-all (dispatch is in registration
/// order; the catch-all would otherwise 404 these routes).
pub async fn handle(req: Request) -> Response {
    let rest: Vec<&str> = req
        .path
        .trim_start_matches("/api/orchestration")
        .split('/')
        .filter(|s| !s.is_empty())
        .collect();
    let resource = rest.first().copied().unwrap_or("");
    let id = rest.get(1).copied();

    if resource == "healthz" {
        if req.method != "GET" {
            return fail(405, "method_not_allowed", "Use GET").with_header("allow", "GET");
        }
        let tracked = {
            let mut st = store().lock().unwrap();
            ensure_loaded(&mut st);
            st.records.len()
        };
        return Response::ok(json!({
            "ok": true,
            "ready": true,
            "service": "sandbox2-orchestration",
            "tracked": tracked,
        }));
    }
    if resource != "sandboxes" {
        let name = if resource.is_empty() { "(none)" } else { resource };
        return fail(404, "not_found", &format!("Unknown orchestration resource: {name}"));
    }
    if id.is_some() && rest.len() > 2 {
        return fail(404, "not_found", "Unknown sub-resource");
    }

    match (id, req.method.as_str()) {
        (None, "POST") => handle_create(&req).await,
        (None, "GET") => handle_list().await,
        (None, _) => fail(405, "method_not_allowed", "Use GET or POST")
            .with_header("allow", "GET, POST"),
        (Some(id), "GET") => handle_detail(id).await,
        (Some(id), "DELETE") => handle_delete(id).await,
        (Some(_), _) => fail(405, "method_not_allowed", "Use GET or DELETE")
            .with_header("allow", "GET, DELETE"),
    }
}

/// Shared with the MCP/exec driver facade, which needs the tracked record and
/// its readiness without re-implementing reconcile.
pub async fn tracked_for_driver(id: &str) -> Option<Record> {
    find_tracked(id).await
}

pub async fn record_is_serving(record: &Record) -> bool {
    is_serving(record).await
}

/// Keep `Arc` in the import set honest: the pipeline spawns detached tasks and
/// shares nothing by handle, so this module never needs one.
#[allow(dead_code)]
type _Unused = Arc<()>;
