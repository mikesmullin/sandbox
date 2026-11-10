//! Container CLI port — one `run()` entry, two backends.
//!
//! The codebase speaks ONE dialect: Apple Containers' `container` argv
//! (`ls`, `inspect <id>`, `create -p h:g -c N -m MEM --name ID -e K=V IMAGE`,
//! `start|stop|rm <id>`, `volume create <name>`, `exec [-u u] [-e K=V] <id> …`).
//! On macOS that argv is handed to the real CLI untouched. On Linux there is no
//! `container` binary, so this module translates the same argv to podman/docker
//! and translates the OUTPUT BACK into the Apple shapes the callers parse
//! (`ls` table columns; `inspect` → `[{ status.state, configuration.publishedPorts }]`).
//!
//! Translating at the argv boundary — rather than teaching every call site about
//! two runtimes — is what keeps the rest of this crate runtime-agnostic.
//!
//! Override detection with `SANDBOX_RUNTIME=container|podman|docker`.

use std::path::Path;
use std::process::Stdio;
use std::sync::OnceLock;

use serde_json::Value;
use tokio::process::Command;

/// Columns the `ls` parsers index into (0=id, 1=image, 4=state, 5=addr),
/// padded to the 9 fields the parser requires before it accepts a row.
const LS_HEADER: [&str; 9] = [
    "ID", "IMAGE", "OS", "ARCH", "STATE", "ADDR", "CPUS", "MEMORY", "CREATED",
];
/// Placeholder for a column this runtime does not report — never empty, or the
/// whitespace split would shift every column after it.
const NONE: &str = "-";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Apple,
    Oci,
}

#[derive(Clone, Debug)]
pub struct Runtime {
    pub kind: Kind,
    pub bin: String,
}

static RUNTIME: OnceLock<Option<Runtime>> = OnceLock::new();

/// Resolve the container runtime once per process.
pub fn runtime() -> Result<&'static Runtime, String> {
    let found = RUNTIME.get_or_init(|| {
        let forced = std::env::var("SANDBOX_RUNTIME").ok();
        let candidates: Vec<String> = match &forced {
            Some(bin) => vec![bin.clone()],
            None => vec!["container".into(), "podman".into(), "docker".into()],
        };
        for bin in candidates {
            if on_path(&bin) {
                let kind = if bin == "container" { Kind::Apple } else { Kind::Oci };
                return Some(Runtime { kind, bin });
            }
        }
        None
    });
    found
        .as_ref()
        .ok_or_else(|| "no container runtime on PATH (tried: container, podman, docker)".to_string())
}

fn on_path(bin: &str) -> bool {
    if bin.contains('/') {
        return is_executable(Path::new(bin));
    }
    std::env::var("PATH")
        .unwrap_or_default()
        .split(':')
        .filter(|d| !d.is_empty())
        .any(|dir| is_executable(&Path::new(dir).join(bin)))
}

fn is_executable(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path)
            .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        path.is_file()
    }
}

/// What a CLI invocation produced.
#[derive(Clone, Debug, Default)]
pub struct Output {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

impl Output {
    pub fn failed(&self) -> bool {
        self.exit_code != 0
    }

    /// The message to surface for a failure: stderr if there is any, else stdout.
    pub fn message(&self) -> &str {
        if self.stderr.is_empty() {
            &self.stdout
        } else {
            &self.stderr
        }
    }
}

/// Run one container-CLI command in the Apple `container` dialect.
pub async fn run(argv: &[String]) -> Result<Output, String> {
    let rt = runtime()?;
    match rt.kind {
        Kind::Apple => spawn(&rt.bin, argv).await,
        Kind::Oci => run_oci(&rt.bin, argv).await,
    }
}

/// Convenience for the many call sites that build argv from &str literals.
pub async fn run_str(argv: &[&str]) -> Result<Output, String> {
    let owned: Vec<String> = argv.iter().map(|s| s.to_string()).collect();
    run(&owned).await
}

/// Dispatch one Apple-dialect argv onto podman/docker.
async fn run_oci(bin: &str, argv: &[String]) -> Result<Output, String> {
    let verb = argv.first().map(String::as_str).unwrap_or("");
    match verb {
        "ls" => oci_ls(bin, &argv[1..]).await,
        "inspect" => oci_inspect(bin, &argv[1..]).await,
        "create" => {
            let mut args = vec!["create".to_string()];
            args.extend(translate_create(&argv[1..]));
            spawn(bin, &args).await
        }
        // start / stop / rm / exec / volume create: argv is already compatible.
        _ => spawn(bin, argv).await,
    }
}

/// `container ls` → `podman ps --format json`, re-emitted as the Apple table.
/// Both runtimes list only RUNNING containers by default, which the reconciler
/// relies on (it tells "stopped" from "deleted" with a follow-up inspect).
async fn oci_ls(bin: &str, rest: &[String]) -> Result<Output, String> {
    let mut args = vec!["ps".to_string(), "--format".to_string(), "json".to_string()];
    args.extend_from_slice(rest);
    let out = spawn(bin, &args).await?;
    if out.failed() {
        return Ok(out);
    }
    let rows: Vec<Value> = match serde_json::from_str(if out.stdout.is_empty() {
        "[]"
    } else {
        &out.stdout
    }) {
        Ok(v) => v,
        Err(e) => {
            return Ok(Output {
                stdout: out.stdout,
                stderr: format!("unparsable ps output: {e}"),
                exit_code: 1,
            })
        }
    };

    let mut lines = vec![LS_HEADER.join("  ")];
    for row in rows {
        // The app addresses containers by the --name it created them with;
        // podman's own 64-hex Id would match nothing in the store.
        let id = row
            .get("Names")
            .and_then(|n| n.get(0))
            .and_then(Value::as_str)
            .or_else(|| row.get("Id").and_then(Value::as_str))
            .unwrap_or(NONE)
            .to_string();
        let image = normalize_image(row.get("Image").and_then(Value::as_str));
        let state = row.get("State").and_then(Value::as_str).unwrap_or(NONE);
        lines.push(
            [
                id.as_str(),
                image.as_str(),
                "linux",
                NONE,
                state,
                NONE, // rootless podman gives the container no host-visible address
                NONE,
                NONE,
                NONE,
            ]
            .join("  "),
        );
    }

    Ok(Output {
        stdout: lines.join("\n"),
        ..out
    })
}

/// `container inspect <id>` → `podman inspect <id>`, reshaped to the two fields
/// the callers read: `[0].status.state` and `[0].configuration.publishedPorts`.
async fn oci_inspect(bin: &str, rest: &[String]) -> Result<Output, String> {
    let mut args = vec!["inspect".to_string()];
    args.extend_from_slice(rest);
    let out = spawn(bin, &args).await?;
    if out.failed() {
        return Ok(out);
    }
    let docs: Vec<Value> = match serde_json::from_str(if out.stdout.is_empty() {
        "[]"
    } else {
        &out.stdout
    }) {
        Ok(v) => v,
        Err(e) => {
            return Ok(Output {
                stdout: out.stdout,
                stderr: format!("unparsable inspect output: {e}"),
                exit_code: 1,
            })
        }
    };

    let mapped: Vec<Value> = docs
        .iter()
        .map(|doc| {
            serde_json::json!({
                "configuration": {
                    "id": doc.get("Name").or_else(|| doc.get("Id")).cloned().unwrap_or(Value::Null),
                    "image": { "reference": normalize_image(
                        doc.get("ImageName").and_then(Value::as_str)
                           .or_else(|| doc.pointer("/Config/Image").and_then(Value::as_str))
                    )},
                    "publishedPorts": published_ports(doc),
                },
                "status": { "state": doc.pointer("/State/Status").cloned().unwrap_or(Value::Null) },
            })
        })
        .collect();

    Ok(Output {
        stdout: serde_json::to_string(&mapped).unwrap_or_else(|_| "[]".into()),
        ..out
    })
}

/// `HostConfig.PortBindings` (`{"3211/tcp":[{HostIp,HostPort}]}`) → Apple's
/// `publishedPorts` (`[{containerPort,hostPort,proto}]`). HostConfig is used
/// rather than NetworkSettings because it is populated for a CREATED container
/// too, not only a running one.
fn published_ports(doc: &Value) -> Vec<Value> {
    let bindings = doc
        .pointer("/HostConfig/PortBindings")
        .or_else(|| doc.pointer("/NetworkSettings/Ports"));
    let map = match bindings.and_then(Value::as_object) {
        Some(m) => m,
        None => return Vec::new(),
    };
    let mut out = Vec::new();
    for (spec, binds) in map {
        let mut halves = spec.split('/');
        let port_text = halves.next().unwrap_or("");
        let proto = halves.next().unwrap_or("tcp");
        let container_port: u32 = match port_text.parse() {
            Ok(p) => p,
            Err(_) => continue,
        };
        for bind in binds.as_array().map(Vec::as_slice).unwrap_or(&[]) {
            let host_port: u32 = bind
                .get("HostPort")
                .and_then(Value::as_str)
                .and_then(|s| s.parse().ok())
                .unwrap_or(0);
            if host_port == 0 {
                continue;
            }
            out.push(serde_json::json!({
                "containerPort": container_port,
                "hostPort": host_port,
                "proto": proto,
            }));
        }
    }
    out
}

/// podman reports a locally built image as `localhost/<name>:<tag>`; the app
/// filters on the bare `<name>:<tag>` it was configured with (SANDBOX_IMAGE),
/// so strip the implicit local registry. A reference the caller fully qualified
/// is left alone.
fn normalize_image(reference: Option<&str>) -> String {
    match reference {
        None | Some("") => NONE.to_string(),
        Some(r) => r.strip_prefix("localhost/").unwrap_or(r).to_string(),
    }
}

/// Apple `create` flags → podman/docker `create` flags.
///   `-c N`   → `--cpus N`         (podman's `-c` is cpu-shares, a different knob)
///   `-p h:g` → `-p 127.0.0.1:h:g` (Apple publishes on host loopback ONLY; the
///                                  app assumes 127.0.0.1 reachability and
///                                  nothing should be exposed on 0.0.0.0)
/// `-m`, `-e`, `-v`, `--mount`, `--name` and the image pass through unchanged.
fn translate_create(rest: &[String]) -> Vec<String> {
    let mut out = Vec::with_capacity(rest.len());
    let mut i = 0;
    while i < rest.len() {
        let arg = rest[i].as_str();
        if arg == "-c" && i + 1 < rest.len() {
            out.push("--cpus".to_string());
            out.push(rest[i + 1].clone());
            i += 2;
        } else if arg == "-p" && i + 1 < rest.len() {
            out.push("-p".to_string());
            out.push(loopback_publish(&rest[i + 1]));
            i += 2;
        } else {
            out.push(rest[i].clone());
            i += 1;
        }
    }
    out
}

/// `8080:3211[/udp]` → `127.0.0.1:8080:3211[/udp]`; an explicit host IP wins.
fn loopback_publish(spec: &str) -> String {
    let mut parts = spec.splitn(2, ':');
    let host = parts.next().unwrap_or("");
    let rest = parts.next().unwrap_or("");
    let guest = rest.split('/').next().unwrap_or("");
    let bare = !host.is_empty()
        && !guest.is_empty()
        && host.chars().all(|c| c.is_ascii_digit())
        && guest.chars().all(|c| c.is_ascii_digit());
    if bare {
        format!("127.0.0.1:{spec}")
    } else {
        spec.to_string()
    }
}

/// Spawn a CLI and capture its output.
async fn spawn(bin: &str, args: &[String]) -> Result<Output, String> {
    let out = Command::new(bin)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|e| format!("spawn {bin}: {e}"))?;
    Ok(Output {
        stdout: String::from_utf8_lossy(&out.stdout).trim().to_string(),
        stderr: String::from_utf8_lossy(&out.stderr).trim().to_string(),
        exit_code: out.status.code().unwrap_or(-1),
    })
}
