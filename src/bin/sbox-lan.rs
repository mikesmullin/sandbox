//! `sbox-lan` — the LAN gateway (SBOX_PLAN1 §5.4, §7).
//!
//! A deliberately boring reverse proxy that exposes **exactly one path** —
//! `POST /mcp` — from the loopback backend to the local network, and nothing
//! else. `sbox-b`'s REST API, its journal and its health endpoint stay where
//! they are: on loopback, unreachable from the LAN.
//!
//! Why a separate process rather than binding `sbox-b` wider: binding the
//! backend to the LAN would publish its entire unauthenticated `/api/*`
//! surface along with the authenticated `/mcp`. The split is the whole point —
//! one address exposes one authenticated path.
//!
//! What this means for endpoint protection on a work machine: the host never
//! dials out and never echoes a shell. It listens on the LAN for an ordinary
//! HTTP application protocol, the same artifact class as any other MCP server,
//! and every side effect lands inside a container whose reachability into the
//! host is a mount the operator declared.
//!
//! ```text
//!   harness (another host) ──POST /mcp──► sbox-lan :7777 ──► 127.0.0.1:3000/mcp
//!                             Bearer         (LAN)              (loopback)
//! ```
//!
//! Usage:
//! ```sh
//! sbox-lan                      # 127.0.0.1:7777 (default; safe to leave running)
//! sbox-lan --lan                # 0.0.0.0:7777 — reachable from the network
//! sbox-lan --bind 10.0.0.5:9000 # an explicit address
//! sbox-lan --upstream 127.0.0.1:3000
//! ```

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::time::Duration;

/// A create can legitimately block for the full sandbox boot, so the gateway
/// must not be the component that gives up first.
const UPSTREAM_TIMEOUT: Duration = Duration::from_secs(300);
const MAX_BODY: usize = 1024 * 1024;

struct Options {
    bind: String,
    upstream: String,
}

fn parse_args() -> Options {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let mut bind = std::env::var("SBOX_LAN_BIND").unwrap_or_else(|_| "127.0.0.1:7777".into());
    let mut upstream =
        std::env::var("SBOX_UPSTREAM").unwrap_or_else(|_| "127.0.0.1:3000".into());
    let mut i = 0;
    while i < argv.len() {
        match argv[i].as_str() {
            "--lan" => bind = "0.0.0.0:7777".into(),
            "--bind" => {
                i += 1;
                if let Some(v) = argv.get(i) {
                    bind = v.clone();
                }
            }
            "--upstream" => {
                i += 1;
                if let Some(v) = argv.get(i) {
                    upstream = v.clone();
                }
            }
            "-h" | "--help" => {
                eprintln!(
                    "sbox-lan — expose only POST /mcp to the LAN\n\n\
                     --lan                bind 0.0.0.0:7777\n\
                     --bind <addr:port>   bind an explicit address\n\
                     --upstream <a:p>     the sbox-b backend (default 127.0.0.1:3000)"
                );
                std::process::exit(0);
            }
            _ => {}
        }
        i += 1;
    }
    Options { bind, upstream }
}

fn main() {
    let opts = parse_args();
    let listener = match TcpListener::bind(&opts.bind) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("sbox-lan: cannot bind {}: {e}", opts.bind);
            std::process::exit(1);
        }
    };
    let public = !opts.bind.starts_with("127.") && !opts.bind.starts_with("localhost");
    println!(
        "sbox-lan  {}  →  {}/mcp   [{}]",
        opts.bind,
        opts.upstream,
        if public { "LAN-REACHABLE" } else { "loopback only" }
    );
    if public {
        println!("sbox-lan  only POST /mcp is exposed; it requires Authorization: Bearer <token>");
    }

    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        let upstream = opts.upstream.clone();
        std::thread::spawn(move || {
            if let Err(e) = serve(stream, &upstream) {
                if e.kind() != std::io::ErrorKind::UnexpectedEof {
                    eprintln!("sbox-lan: {e}");
                }
            }
        });
    }
}

fn serve(mut client: TcpStream, upstream: &str) -> std::io::Result<()> {
    client.set_read_timeout(Some(Duration::from_secs(30)))?;
    let (method, path, headers, body) = {
        let mut reader = BufReader::new(client.try_clone()?);
        read_request(&mut reader)?
    };

    // The allowlist IS the security boundary: one method, one path. Anything
    // else is refused here and never reaches the backend.
    if path != "/mcp" {
        return refuse(&mut client, 404, "not_found", "Only /mcp is exposed");
    }
    if method != "POST" {
        return refuse(&mut client, 405, "method_not_allowed", "Use POST");
    }
    // The token itself is checked by the backend, which owns it; the gateway
    // only insists that one was offered, so an unauthenticated scan stops here.
    let authorized = headers
        .iter()
        .any(|(k, v)| k == "authorization" && v.starts_with("Bearer "));
    if !authorized {
        return refuse(&mut client, 401, "unauthorized", "Bearer token required");
    }

    let (status, up_headers, up_body) = match forward(upstream, &headers, &body) {
        Ok(r) => r,
        Err(e) => {
            return refuse(
                &mut client,
                502,
                "upstream_unreachable",
                &format!("sbox-b unreachable at {upstream}: {e}"),
            )
        }
    };

    let mut head = format!("HTTP/1.1 {status} {}\r\n", reason(status));
    for (k, v) in &up_headers {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str(&format!(
        "content-length: {}\r\nconnection: close\r\n\r\n",
        up_body.len()
    ));
    client.write_all(head.as_bytes())?;
    client.write_all(&up_body)?;
    client.flush()
}

type Head = (String, String, Vec<(String, String)>, Vec<u8>);

fn read_request(reader: &mut BufReader<TcpStream>) -> std::io::Result<Head> {
    let mut start = String::new();
    reader.read_line(&mut start)?;
    let mut parts = start.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let target = parts.next().unwrap_or("/").to_string();
    let path = target.split('?').next().unwrap_or("/").to_string();

    let mut headers = Vec::new();
    let mut length = 0usize;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            break;
        }
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        if let Some((k, v)) = line.split_once(':') {
            let name = k.trim().to_ascii_lowercase();
            let value = v.trim().to_string();
            if name == "content-length" {
                length = value.parse().unwrap_or(0);
            }
            headers.push((name, value));
        }
    }
    if length > MAX_BODY {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "body too large",
        ));
    }
    let mut body = vec![0u8; length];
    if length > 0 {
        reader.read_exact(&mut body)?;
    }
    Ok((method, path, headers, body))
}

fn forward(
    upstream: &str,
    headers: &[(String, String)],
    body: &[u8],
) -> std::io::Result<(u16, Vec<(String, String)>, Vec<u8>)> {
    let mut sock = TcpStream::connect(upstream)?;
    sock.set_read_timeout(Some(UPSTREAM_TIMEOUT))?;
    sock.set_write_timeout(Some(UPSTREAM_TIMEOUT))?;

    let mut head = format!("POST /mcp HTTP/1.1\r\nhost: {upstream}\r\n");
    for (k, v) in headers {
        // `host` is the upstream's own authority; framing and hop-by-hop
        // headers are re-derived below.
        if matches!(
            k.as_str(),
            "host" | "content-length" | "connection" | "transfer-encoding" | "keep-alive" | "upgrade"
        ) {
            continue;
        }
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str(&format!(
        "content-length: {}\r\nconnection: close\r\n\r\n",
        body.len()
    ));
    sock.write_all(head.as_bytes())?;
    sock.write_all(body)?;
    sock.flush()?;

    let mut raw = Vec::new();
    sock.read_to_end(&mut raw)?;
    parse_response(&raw)
}

fn parse_response(raw: &[u8]) -> std::io::Result<(u16, Vec<(String, String)>, Vec<u8>)> {
    let split = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidData, "no response head"))?;
    let head = String::from_utf8_lossy(&raw[..split]).to_string();
    let body = raw[split + 4..].to_vec();

    let mut lines = head.split("\r\n");
    let status: u16 = lines
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|s| s.parse().ok())
        .unwrap_or(502);
    let mut headers = Vec::new();
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            let name = k.trim().to_ascii_lowercase();
            if matches!(
                name.as_str(),
                "content-length" | "connection" | "transfer-encoding" | "keep-alive"
            ) {
                continue;
            }
            headers.push((name, v.trim().to_string()));
        }
    }
    Ok((status, headers, body))
}

fn refuse(client: &mut TcpStream, status: u16, code: &str, message: &str) -> std::io::Result<()> {
    let body = format!(r#"{{"error":{{"code":"{code}","message":"{message}"}}}}"#);
    let head = format!(
        "HTTP/1.1 {status} {}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
        reason(status),
        body.len()
    );
    client.write_all(head.as_bytes())?;
    client.write_all(body.as_bytes())?;
    client.flush()
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        202 => "Accepted",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        405 => "Method Not Allowed",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        _ => "OK",
    }
}
