use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};

use super::container_cli as cli;
use super::containers::{self, container_token, GUEST_EXEC_PORT, GUEST_MCP_PORT, GUEST_QUIC_PORT};
use super::orchestration_store::{state_file, Record, Transition};
use super::orchestration_validate::{validate_create, CreateInput};
use super::orchestration_volumes::{
    to_volume_after_delete, to_volume_detail, volume_create_args, VolumeKind,
};
use crate::http::{Request, Response};
use crate::util;

const READY_TTL: Duration = Duration::from_secs(30);
const BOOT_DEADLINE: Duration = Duration::from_secs(120);
const BOOT_POLL: Duration = Duration::from_millis(500);
const EXEC_RETRIES: u32 = 3;
const EXEC_TIMEOUT: Duration = Duration::from_secs(180);
const EXEC_RETRY: Duration = Duration::from_secs(1);
const PIPELINE_JOIN_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_TRANSITIONS: usize = 50;


#[derive(Default)]
struct Store {
    records: BTreeMap<String, Record>,
    in_flight: HashSet<String>,
    aborted: HashSet<String>,
    known_good: HashMap<String, Instant>,
    active_id: Option<String>,
    loaded: bool,
}

fn store() -> &'static Mutex<Store> {
    static STORE: OnceLock<Mutex<Store>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(Store::default()))
}

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
    st.active_id = doc
        .get("activeId")
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|id| st.records.contains_key(id));
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
    let body = json!({
        "version": 1,
        "sandboxes": Value::Object(sandboxes),
        "activeId": st.active_id,
    });
    if let Ok(text) = serde_json::to_string_pretty(&body) {
        std::fs::write(&path, text).ok();
    }
}

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


pub fn active_id() -> Option<String> {
    let mut st = store().lock().unwrap();
    ensure_loaded(&mut st);
    st.active_id
        .clone()
        .filter(|id| st.records.contains_key(id))
}

pub fn set_active(id: &str) -> Result<(), String> {
    let mut st = store().lock().unwrap();
    ensure_loaded(&mut st);
    if !st.records.contains_key(id) {
        return Err(format!("No such sandbox: {id}"));
    }
    st.active_id = Some(id.to_string());
    save(&st);
    Ok(())
}

fn clear_active_if(st: &mut Store, id: &str) {
    if st.active_id.as_deref() == Some(id) {
        st.active_id = None;
    }
}


async fn is_serving(record: &Record) -> bool {
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
        "execPort": if record.exec_port == 0 { Value::Null } else { json!(record.exec_port) },
        "execUrl": port_url(record.exec_port),
        "image": record.image.clone(),
        "repos": repos,
        "volumes": record.volumes.iter().map(to_volume_detail).collect::<Vec<_>>(),
        "createdAt": record.created_at,
    });
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
    out["token"] = json!(container_token(&record.id));
    out["transitions"] = serde_json::to_value(&record.transitions).unwrap_or(Value::Null);
    out["updatedAt"] = json!(record.updated_at);
    out["error"] = record.error.clone().unwrap_or(Value::Null);
    out
}


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

async fn reconcile_row(record: &Record, rows: Option<&Vec<containers::Row>>) -> Option<Record> {
    let rows = match rows {
        None => return Some(record.clone()),
        Some(r) => r,
    };
    let row = rows
        .iter()
        .find(|c| c.id == record.id && c.image == record.image);
    if row.map(|r| r.state.as_str()) == Some("running") {
        if is_serving(record).await {
            if record.state != "ready" {
                set_state(&record.id, "ready", None);
            }
        } else if record.state != "starting" {
            set_state(&record.id, "starting", None);
        }
        return get_record(&record.id);
    }

    match inspect_state(&record.id).await.as_deref() {
        Some("running") => return get_record(&record.id),
        Some("stopped") | Some("exited") | Some("created") => {
            if record.state != "stopped" {
                set_state(&record.id, "stopped", None);
            }
            return get_record(&record.id);
        }
        _ => {}
    }
    if record.state == "error" {
        return get_record(&record.id);
    }
    let mut st = store().lock().unwrap();
    ensure_loaded(&mut st);
    st.records.remove(&record.id);
    clear_active_if(&mut st, &record.id);
    save(&st);
    None
}

async fn reconcile_all() -> Vec<Record> {
    let snapshot: Vec<Record> = {
        let mut st = store().lock().unwrap();
        ensure_loaded(&mut st);
        let mut v: Vec<Record> = st.records.values().cloned().collect();
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


struct PipelineError {
    code: &'static str,
    message: String,
}

fn fresh_id() -> String {
    loop {
        let id = util::random_hex(6);
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

async fn exec_bounded(argv: &[String]) -> cli::Output {
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
    if !record.network {
        argv.extend(["--network".into(), "none".into()]);
    }
    argv.extend(volume_create_args(&record.volumes));
    for dev in &record.devices {
        argv.extend(["--device".into(), dev.clone()]);
    }
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
        force_cleanup(id).await;
        return Err(PipelineError {
            code: "start_failed",
            message: util::first_line(started.message()),
        });
    }

    clone_repos(id).await;
    if is_aborted(id) {
        return Ok(());
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


fn fail(status: u16, code: &str, message: &str) -> Response {
    Response::json(status, json!({ "error": { "code": code, "message": message } }))
}

fn fail_with(status: u16, code: &str, message: &str, details: Value) -> Response {
    Response::json(
        status,
        json!({ "error": { "code": code, "message": message, "details": details } }),
    )
}

pub fn start_create(input: CreateInput) -> Result<Record, String> {
    let id = fresh_id();
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
            return Err("could not allocate host ports".into());
        }
    };

    let now = util::now_iso();
    let record = Record {
        id: id.clone(),
        image: input.image,
        kind: input.kind,
        cpus: input.cpus.unwrap_or(4),
        memory: input.memory.unwrap_or_else(|| "2048M".into()),
        volumes: input.volumes,
        repos: input.repos,
        backref: input.backref,
        devices: input.devices,
        network: input.network,
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

    {
        let mut st = store().lock().unwrap();
        st.records.insert(id.clone(), record.clone());
        save(&st);
    }

    tokio::spawn(run_pipeline(id));
    Ok(record)
}

pub async fn wait_until_settled(id: &str, timeout: Duration) -> Option<Record> {
    let deadline = Instant::now() + timeout;
    loop {
        let record = get_record(id)?;
        match record.state.as_str() {
            "ready" | "error" | "stopped" => return Some(record),
            _ => {}
        }
        if Instant::now() >= deadline {
            return None;
        }
        tokio::time::sleep(BOOT_POLL).await;
    }
}

pub fn record_of(id: &str) -> Option<Record> {
    get_record(id)
}

pub async fn destroy(id: &str) -> Result<Vec<Value>, String> {
    let record = get_record(id).ok_or_else(|| format!("No such sandbox: {id}"))?;
    match handle_delete(id).await {
        res if res.status == 200 => Ok(record
            .volumes
            .iter()
            .map(to_volume_after_delete)
            .collect()),
        res => {
            let body: Value = serde_json::from_slice(&res.body).unwrap_or(Value::Null);
            Err(body
                .pointer("/error/message")
                .and_then(Value::as_str)
                .unwrap_or("delete failed")
                .to_string())
        }
    }
}

pub async fn list_records() -> Vec<Record> {
    reconcile_all().await
}

pub fn detail_of(record: &Record) -> Value {
    to_detail(record)
}

pub fn list_item_of(record: &Record) -> Value {
    to_list_item(record)
}

async fn handle_create(req: &Request) -> Response {
    let body: Value = if req.body.is_empty() {
        json!({})
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

    match start_create(input) {
        Ok(record) => Response::json(202, to_detail(&record)),
        Err(e) => fail(500, "internal_error", &e),
    }
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
    let removed_stderr = removed.stderr.to_lowercase();
    if removed.failed() && !removed_stderr.contains("not found") && !removed_stderr.contains("no such container") {
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
        clear_active_if(&mut st, id);
        save(&st);
    }
    containers::forget_readiness(id);

    Response::ok(json!({
        "id": id,
        "state": "deleted",
        "volumes": record.volumes.iter().map(to_volume_after_delete).collect::<Vec<_>>(),
    }))
}

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

pub async fn tracked_for_driver(id: &str) -> Option<Record> {
    find_tracked(id).await
}

pub async fn record_is_serving(record: &Record) -> bool {
    is_serving(record).await
}

#[allow(dead_code)]
type _Unused = Arc<()>;
