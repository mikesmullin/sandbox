use std::collections::HashMap;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;

use super::server::percent_decode;

#[derive(Debug, Clone)]
pub struct ClientResponse {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
}

impl ClientResponse {
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }

    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).to_string()
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(&name.to_ascii_lowercase()).map(|s| s.as_str())
    }
}

pub async fn request(
    host: &str,
    port: u16,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: Option<&[u8]>,
    timeout: Duration,
) -> std::io::Result<ClientResponse> {
    tokio::time::timeout(timeout, exchange(host, port, method, path, headers, body))
        .await
        .map_err(|_| {
            std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                format!("{method} http://{host}:{port}{path} timed out"),
            )
        })?
}

async fn exchange(
    host: &str,
    port: u16,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: Option<&[u8]>,
) -> std::io::Result<ClientResponse> {
    let stream = TcpStream::connect((host, port)).await?;
    stream.set_nodelay(true).ok();
    let mut reader = BufReader::new(stream);

    let mut head = format!("{method} {path} HTTP/1.1\r\nhost: {host}:{port}\r\n");
    for (k, v) in headers {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str(&format!(
        "content-length: {}\r\nconnection: close\r\n\r\n",
        body.map(|b| b.len()).unwrap_or(0)
    ));

    {
        let sock = reader.get_mut();
        sock.write_all(head.as_bytes()).await?;
        if let Some(b) = body {
            sock.write_all(b).await?;
        }
        sock.flush().await?;
    }

    read_response(&mut reader).await
}

async fn read_response(reader: &mut BufReader<TcpStream>) -> std::io::Result<ClientResponse> {
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        let n = reader.read(&mut byte).await?;
        if n == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "no response head",
            ));
        }
        head.push(byte[0]);
        if head.ends_with(b"\r\n\r\n") {
            break;
        }
        if head.len() > 64 * 1024 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "response head too large",
            ));
        }
    }

    let text = String::from_utf8_lossy(&head).to_string();
    let mut lines = text.split("\r\n");
    let status_line = lines.next().unwrap_or("");
    let status: u16 = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);

    let mut headers = HashMap::new();
    for line in lines {
        if line.is_empty() {
            continue;
        }
        if let Some((k, v)) = line.split_once(':') {
            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
        }
    }

    let chunked = headers
        .get("transfer-encoding")
        .map(|v| v.to_ascii_lowercase().contains("chunked"))
        .unwrap_or(false);

    let body = if chunked {
        read_chunked(reader).await?
    } else if let Some(len) = headers.get("content-length").and_then(|v| v.parse::<usize>().ok()) {
        let mut buf = vec![0u8; len];
        reader.read_exact(&mut buf).await?;
        buf
    } else {
        let mut buf = Vec::new();
        reader.read_to_end(&mut buf).await?;
        buf
    };

    Ok(ClientResponse {
        status,
        headers,
        body,
    })
}

async fn read_chunked(reader: &mut BufReader<TcpStream>) -> std::io::Result<Vec<u8>> {
    let mut out = Vec::new();
    loop {
        let line = read_line(reader).await?;
        let size_text = line.split(';').next().unwrap_or("").trim();
        let size = usize::from_str_radix(size_text, 16).map_err(|_| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("bad chunk size {size_text:?}"),
            )
        })?;
        if size == 0 {
            loop {
                let t = read_line(reader).await?;
                if t.is_empty() {
                    break;
                }
            }
            return Ok(out);
        }
        let mut chunk = vec![0u8; size];
        reader.read_exact(&mut chunk).await?;
        out.extend_from_slice(&chunk);
        let mut crlf = [0u8; 2];
        reader.read_exact(&mut crlf).await?;
    }
}

async fn read_line(reader: &mut BufReader<TcpStream>) -> std::io::Result<String> {
    let mut line = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        let n = reader.read(&mut byte).await?;
        if n == 0 {
            break;
        }
        if byte[0] == b'\n' {
            break;
        }
        line.push(byte[0]);
        if line.len() > 8192 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "chunk header too long",
            ));
        }
    }
    while line.last() == Some(&b'\r') {
        line.pop();
    }
    Ok(String::from_utf8_lossy(&line).to_string())
}

pub fn with_query(path: &str, query: &HashMap<String, String>) -> String {
    if query.is_empty() {
        return path.to_string();
    }
    let pairs: Vec<String> = query
        .iter()
        .map(|(k, v)| format!("{}={}", super::server::percent_encode(k), super::server::percent_encode(v)))
        .collect();
    format!("{path}?{}", pairs.join("&"))
}

pub fn decode(s: &str) -> String {
    percent_decode(s)
}
