//! HTTP/1.1 server: parse a request, hand it to a route, write the response.
//!
//! Scope is deliberately narrow — this serves a JSON API on loopback. It
//! understands `Content-Length` bodies, keep-alive, and nothing else: no
//! chunked request bodies (no caller sends them), no TLS, no compression.
//! A request over `MAX_BODY` is refused with 413 instead of being buffered.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use tokio::io::{AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};

/// Largest request body a route is handed. AJCS payloads are small JSON;
/// anything bigger is a client bug, so it is refused rather than buffered.
const MAX_BODY: usize = 256 * 1024;
/// Largest request head (request line + headers) accepted before giving up.
const MAX_HEAD: usize = 64 * 1024;

/// One parsed request.
#[derive(Clone, Debug)]
pub struct Request {
    pub method: String,
    /// Path with the query string removed, percent-decoded.
    pub path: String,
    pub query: HashMap<String, String>,
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
}

impl Request {
    /// Path split on `/` with empty segments dropped.
    pub fn segments(&self) -> Vec<&str> {
        self.path.split('/').filter(|s| !s.is_empty()).collect()
    }

    /// The body parsed as JSON, or `None` when it is absent or malformed.
    pub fn json(&self) -> Option<serde_json::Value> {
        if self.body.is_empty() {
            return None;
        }
        serde_json::from_slice(&self.body).ok()
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(&name.to_ascii_lowercase()).map(|s| s.as_str())
    }
}

/// One response to write back.
#[derive(Clone, Debug)]
pub struct Response {
    pub status: u16,
    pub content_type: String,
    pub body: Vec<u8>,
    pub headers: Vec<(String, String)>,
}

impl Response {
    pub fn json(status: u16, value: serde_json::Value) -> Response {
        Response {
            status,
            content_type: "application/json; charset=utf-8".into(),
            body: serde_json::to_vec(&value).unwrap_or_else(|_| b"{}".to_vec()),
            headers: Vec::new(),
        }
    }

    pub fn ok(value: serde_json::Value) -> Response {
        Response::json(200, value)
    }

    /// `{ "error": "<message>" }` — the shape every error path in the Node
    /// backend produced, which the SPA reads straight into `store.error`.
    pub fn error(status: u16, message: impl std::fmt::Display) -> Response {
        Response::json(status, serde_json::json!({ "error": message.to_string() }))
    }

    pub fn bytes(status: u16, content_type: &str, body: Vec<u8>) -> Response {
        Response {
            status,
            content_type: content_type.into(),
            body,
            headers: Vec::new(),
        }
    }

    pub fn with_header(mut self, name: &str, value: &str) -> Response {
        self.headers.push((name.into(), value.into()));
        self
    }
}

type Fut = Pin<Box<dyn Future<Output = Response> + Send>>;
type Handler = Box<dyn Fn(Request) -> Fut + Send + Sync>;

/// Routes are matched in registration order by path prefix — the same
/// discipline `server.mjs` used (`registerRoutes` dispatches in order, so the
/// orchestration entries have to precede the `/api/` catch-all).
pub struct Server {
    routes: Vec<(String, Handler)>,
}

impl Default for Server {
    fn default() -> Self {
        Self::new()
    }
}

impl Server {
    pub fn new() -> Server {
        Server { routes: Vec::new() }
    }

    /// Register a handler for every path starting with `prefix`.
    pub fn route<F, R>(mut self, prefix: &str, handler: F) -> Server
    where
        F: Fn(Request) -> R + Send + Sync + 'static,
        R: Future<Output = Response> + Send + 'static,
    {
        self.routes
            .push((prefix.to_string(), Box::new(move |req| Box::pin(handler(req)))));
        self
    }

    pub async fn run(self, host: &str, port: u16) -> std::io::Result<()> {
        let listener = TcpListener::bind((host, port)).await?;
        let routes = Arc::new(self.routes);
        println!(
            "{}",
            serde_json::json!({
                "event": "listening",
                "app": "sbox-b",
                "host": host,
                "port": port,
            })
        );
        loop {
            let (socket, _peer) = match listener.accept().await {
                Ok(pair) => pair,
                Err(e) => {
                    eprintln!("[sbox-b] accept: {e}");
                    continue;
                }
            };
            let routes = routes.clone();
            tokio::spawn(async move {
                if let Err(e) = serve_connection(socket, routes).await {
                    // A client that hangs up mid-request is normal, not news.
                    if e.kind() != std::io::ErrorKind::UnexpectedEof
                        && e.kind() != std::io::ErrorKind::BrokenPipe
                    {
                        eprintln!("[sbox-b] connection: {e}");
                    }
                }
            });
        }
    }
}

async fn serve_connection(
    socket: TcpStream,
    routes: Arc<Vec<(String, Handler)>>,
) -> std::io::Result<()> {
    socket.set_nodelay(true).ok();
    let mut reader = BufReader::new(socket);
    loop {
        let req = match read_request(&mut reader).await? {
            Some(r) => r,
            None => return Ok(()), // clean keep-alive close
        };

        // A client that asked to close gets one response and a closed socket.
        // Without this a proxy that reads to EOF — the ordinary way to read a
        // `connection: close` exchange — waits for an EOF that never arrives.
        let wants_close = req
            .header("connection")
            .map(|v| v.to_ascii_lowercase().contains("close"))
            .unwrap_or(false);

        let res = match routes.iter().find(|(prefix, _)| req.path.starts_with(prefix.as_str())) {
            Some((_, handler)) => handler(req.clone()).await,
            None => Response::error(404, "API not found"),
        };

        write_response(reader.get_mut(), &res, wants_close).await?;
        if wants_close {
            return Ok(());
        }
    }
}

/// Read one request. `Ok(None)` means the peer closed between requests.
async fn read_request(
    reader: &mut BufReader<TcpStream>,
) -> std::io::Result<Option<Request>> {
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    // Read until CRLFCRLF. Byte-at-a-time is fine here: heads are a few hundred
    // bytes and BufReader is doing the real syscalls.
    loop {
        let n = reader.read(&mut byte).await?;
        if n == 0 {
            return if head.is_empty() {
                Ok(None)
            } else {
                Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "truncated request head",
                ))
            };
        }
        head.push(byte[0]);
        if head.len() > MAX_HEAD {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "request head too large",
            ));
        }
        if head.ends_with(b"\r\n\r\n") || head.ends_with(b"\n\n") {
            break;
        }
    }

    let text = String::from_utf8_lossy(&head).to_string();
    let mut lines = text.split(|c| c == '\n').map(|l| l.trim_end_matches('\r'));
    let start = lines.next().unwrap_or("");
    let mut parts = start.split_whitespace();
    let method = parts.next().unwrap_or("GET").to_string();
    let target = parts.next().unwrap_or("/").to_string();

    let mut headers = HashMap::new();
    for line in lines {
        if line.is_empty() {
            continue;
        }
        if let Some((k, v)) = line.split_once(':') {
            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
        }
    }

    let (raw_path, query) = match target.split_once('?') {
        Some((p, q)) => (p.to_string(), parse_query(q)),
        None => (target.clone(), HashMap::new()),
    };
    let path = percent_decode(&raw_path);

    let len: usize = headers
        .get("content-length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    if len > MAX_BODY {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "request body too large",
        ));
    }
    let mut body = vec![0u8; len];
    if len > 0 {
        reader.read_exact(&mut body).await?;
    }

    Ok(Some(Request {
        method,
        path,
        query,
        headers,
        body,
    }))
}

async fn write_response(
    socket: &mut TcpStream,
    res: &Response,
    close: bool,
) -> std::io::Result<()> {
    let mut head = format!(
        "HTTP/1.1 {} {}\r\ncontent-type: {}\r\ncontent-length: {}\r\n",
        res.status,
        reason(res.status),
        res.content_type,
        res.body.len()
    );
    for (k, v) in &res.headers {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str(if close {
        "connection: close\r\n\r\n"
    } else {
        "connection: keep-alive\r\n\r\n"
    });
    socket.write_all(head.as_bytes()).await?;
    socket.write_all(&res.body).await?;
    socket.flush().await
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        201 => "Created",
        202 => "Accepted",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        413 => "Payload Too Large",
        422 => "Unprocessable Entity",
        500 => "Internal Server Error",
        501 => "Not Implemented",
        503 => "Service Unavailable",
        _ => "OK",
    }
}

fn parse_query(q: &str) -> HashMap<String, String> {
    q.split('&')
        .filter(|p| !p.is_empty())
        .map(|pair| match pair.split_once('=') {
            Some((k, v)) => (percent_decode(k), percent_decode(v)),
            None => (percent_decode(pair), String::new()),
        })
        .collect()
}

/// Percent-decoding for paths and query values. `+` is left alone: this decodes
/// URL paths, where `+` is a literal, not a space.
pub fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

/// Percent-encode one path segment (the inverse used when building upstream
/// URLs from ids that came off the wire).
pub fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}
