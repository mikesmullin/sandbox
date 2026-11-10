//! A-side API forwards — one streamed round trip per upstream prefix.
//!
//! `/api/*`  → the b-side backend (headless sandbox core, default
//!             `http://127.0.0.1:3000`, env `SANDBOX_API_ORIGIN`).
//! `/ajcs/*` → the AJCS core (default `http://127.0.0.1:4482`, env
//!             `SANDBOX_AJCS_ORIGIN`) with the path mapping
//!             `/ajcs/<rest>` => `<origin>/v1/<rest>` — `/ajcs/runs/54` hits
//!             `/v1/runs/54`.
//!
//! The sandbox split: the SPA does not share a process with the API. The dev
//! server owns HTTP + static + HMR here; every forwarded request goes through
//! to its backend with its method, headers and body, and the response comes
//! back with its status, headers and body. The browser never knows the API
//! moved.
//!
//! Hop-by-hop headers never cross a proxy (RFC 7230 §6.1), and the dev
//! server's `Stream` adds its own framing, so `content-length` and
//! `transfer-encoding` from the upstream are dropped rather than forwarded —
//! passing either along beside chunked framing is how a response arrives
//! truncated or double-framed.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::time::Duration;

use rustex1_devserver::{Request, State, Stream};
use serde_json::json;
use std::sync::Arc;

const DEFAULT_API_ORIGIN: &str = "127.0.0.1:3000";
const DEFAULT_AJCS_ORIGIN: &str = "127.0.0.1:4482";
/// A driver tool call can legitimately run for a while (execd's bash has its
/// own 180s ceiling upstream), so the proxy must not be the thing that gives up.
const UPSTREAM_TIMEOUT: Duration = Duration::from_secs(240);

/// Hop-by-hop headers must never cross the proxy (RFC 7230 §6.1).
const HOP_HEADERS: [&str; 8] = [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
];

/// Headers the dev server's `Stream` re-derives; forwarding them would
/// conflict with its own chunked framing.
const FRAMING_HEADERS: [&str; 2] = ["content-length", "transfer-encoding"];

struct Upstream {
    addr: String,
    label: &'static str,
}

fn api_origin() -> Upstream {
    Upstream {
        addr: std::env::var("SANDBOX_API_ORIGIN")
            .map(strip_scheme)
            .unwrap_or_else(|_| DEFAULT_API_ORIGIN.to_string()),
        label: "sandbox backend",
    }
}

fn ajcs_origin() -> Upstream {
    Upstream {
        addr: std::env::var("SANDBOX_AJCS_ORIGIN")
            .map(strip_scheme)
            .unwrap_or_else(|_| DEFAULT_AJCS_ORIGIN.to_string()),
        label: "ajcs core",
    }
}

/// The env vars carry a full origin (`http://host:port`) for parity with the
/// Node version; this layer dials a host:port.
fn strip_scheme(origin: String) -> String {
    origin
        .trim_start_matches("http://")
        .trim_start_matches("https://")
        .trim_end_matches('/')
        .to_string()
}

/// `/api/*` rides to the b-side verbatim.
pub fn handle_api(_state: &Arc<State>, req: &Request, out: &mut Stream<'_>) {
    let target = with_query(&req.path, &req.query);
    forward(&api_origin(), &target, req, out);
}

/// `/ajcs/<rest>` → `/v1/<rest>` on the AJCS core (query rides along).
pub fn handle_ajcs(_state: &Arc<State>, req: &Request, out: &mut Stream<'_>) {
    let rest = req.path.strip_prefix("/ajcs/").unwrap_or("");
    let target = with_query(&format!("/v1/{rest}"), &req.query);
    forward(&ajcs_origin(), &target, req, out);
}

fn with_query(path: &str, query: &str) -> String {
    if query.is_empty() {
        path.to_string()
    } else {
        format!("{path}?{query}")
    }
}

fn forward(upstream: &Upstream, target: &str, req: &Request, out: &mut Stream<'_>) {
    match round_trip(upstream, target, req) {
        Ok((status, headers, body)) => {
            let header_refs: Vec<(&str, &str)> = headers
                .iter()
                .map(|(k, v)| (k.as_str(), v.as_str()))
                .collect();
            if out.start(status, &header_refs).is_ok() {
                let _ = out.chunk(&body);
                let _ = out.finish();
            }
        }
        Err(e) => {
            let _ = out.json(
                502,
                &json!({
                    "ok": false,
                    "error": {
                        "code": "proxy_unreachable",
                        "message": format!("{} unreachable at {}: {e}", upstream.label, upstream.addr),
                    }
                }),
            );
        }
    }
}

fn round_trip(
    upstream: &Upstream,
    target: &str,
    req: &Request,
) -> std::io::Result<(u16, Vec<(String, String)>, Vec<u8>)> {
    let mut sock = TcpStream::connect(&upstream.addr)?;
    sock.set_read_timeout(Some(UPSTREAM_TIMEOUT))?;
    sock.set_write_timeout(Some(UPSTREAM_TIMEOUT))?;
    sock.set_nodelay(true).ok();

    let mut head = format!(
        "{} {} HTTP/1.1\r\nhost: {}\r\n",
        req.method, target, upstream.addr
    );
    for (name, value) in &req.headers {
        let lower = name.to_ascii_lowercase();
        // `host` is the upstream's own authority, not the client's.
        if lower == "host" || HOP_HEADERS.contains(&lower.as_str()) || FRAMING_HEADERS.contains(&lower.as_str()) {
            continue;
        }
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str(&format!(
        "content-length: {}\r\nconnection: close\r\n\r\n",
        req.body.len()
    ));

    sock.write_all(head.as_bytes())?;
    if !req.body.is_empty() {
        sock.write_all(&req.body)?;
    }
    sock.flush()?;

    // Framing is read explicitly rather than by slurping to EOF: an upstream
    // that keeps the connection alive (ours does, unless asked to close) never
    // sends one, and read-to-EOF would block until the socket timeout.
    let mut reader = BufReader::new(sock);
    read_response(&mut reader)
}

fn read_response(
    reader: &mut BufReader<TcpStream>,
) -> std::io::Result<(u16, Vec<(String, String)>, Vec<u8>)> {
    let mut head = Vec::new();
    loop {
        let mut line = Vec::new();
        if reader.read_until(b'\n', &mut line)? == 0 {
            break;
        }
        let blank = line == b"\r\n" || line == b"\n";
        head.extend_from_slice(&line);
        if blank {
            break;
        }
        if head.len() > 64 * 1024 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "response head too large",
            ));
        }
    }

    let (status, headers, chunked, length) = parse_head(&head)?;
    let body = if chunked {
        read_chunked(reader)?
    } else if let Some(n) = length {
        let mut buf = vec![0u8; n];
        reader.read_exact(&mut buf)?;
        buf
    } else {
        // No framing at all: the upstream said `connection: close`, so the
        // body runs to EOF.
        let mut buf = Vec::new();
        reader.read_to_end(&mut buf)?;
        buf
    };
    Ok((status, headers, body))
}

/// RFC 7230 chunked decoding, for an upstream that framed its answer that way.
fn read_chunked(reader: &mut BufReader<TcpStream>) -> std::io::Result<Vec<u8>> {
    let mut out = Vec::new();
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            return Ok(out);
        }
        let size_text = line.split(';').next().unwrap_or("").trim();
        let size = match usize::from_str_radix(size_text, 16) {
            Ok(s) => s,
            Err(_) => return Ok(out),
        };
        if size == 0 {
            // Consume trailers up to the terminating blank line.
            loop {
                let mut t = String::new();
                if reader.read_line(&mut t)? == 0 || t.trim().is_empty() {
                    break;
                }
            }
            return Ok(out);
        }
        let mut chunk = vec![0u8; size];
        reader.read_exact(&mut chunk)?;
        out.extend_from_slice(&chunk);
        let mut crlf = [0u8; 2];
        reader.read_exact(&mut crlf)?;
    }
}

/// Status line + headers → (status, forwardable headers, chunked?, length).
fn parse_head(
    head: &[u8],
) -> std::io::Result<(u16, Vec<(String, String)>, bool, Option<usize>)> {
    let text = String::from_utf8_lossy(head);
    let mut lines = text.split("\r\n").flat_map(|l| l.split('\n'));
    let status: u16 = lines
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidData, "no status line"))?;

    let mut headers = Vec::new();
    let mut chunked = false;
    let mut length = None;
    for line in lines {
        if line.trim().is_empty() {
            continue;
        }
        if let Some((k, v)) = line.split_once(':') {
            let name = k.trim().to_ascii_lowercase();
            let value = v.trim().to_string();
            if name == "transfer-encoding" && value.to_ascii_lowercase().contains("chunked") {
                chunked = true;
            }
            if name == "content-length" {
                length = value.parse().ok();
            }
            if HOP_HEADERS.contains(&name.as_str()) || FRAMING_HEADERS.contains(&name.as_str()) {
                continue;
            }
            headers.push((name, value));
        }
    }
    Ok((status, headers, chunked, length))
}
