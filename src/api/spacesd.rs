use std::collections::HashMap;
use std::time::Duration;

use crate::http::client;

const GRPC_WEB: &str = "application/grpc-web+proto";
const CALL_TIMEOUT: Duration = Duration::from_secs(10);

pub struct ViewerTicket {
    pub ticket: String,
    pub viewer_path: String,
}

fn grpc_frame(message: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(5 + message.len());
    out.push(0u8);
    out.extend_from_slice(&(message.len() as u32).to_be_bytes());
    out.extend_from_slice(message);
    out
}

fn parse_grpc_web(buf: &[u8]) -> (Vec<u8>, String) {
    let mut pos = 0usize;
    let mut data = Vec::new();
    let mut trailers = String::new();
    while pos + 5 <= buf.len() {
        let flag = buf[pos];
        let len = u32::from_be_bytes([buf[pos + 1], buf[pos + 2], buf[pos + 3], buf[pos + 4]]) as usize;
        let start = pos + 5;
        let end = (start + len).min(buf.len());
        let frame = &buf[start..end];
        if flag & 0x80 != 0 {
            trailers.push_str(&String::from_utf8_lossy(frame));
        } else {
            data.extend_from_slice(frame);
        }
        pos = start + len;
    }
    (data, trailers)
}

fn parse_proto_fields(buf: &[u8]) -> HashMap<u32, Vec<u8>> {
    let mut fields = HashMap::new();
    let mut pos = 0usize;
    while pos < buf.len() {
        let tag = buf[pos];
        pos += 1;
        let wire_type = tag & 0x07;
        let field_number = (tag >> 3) as u32;
        match wire_type {
            0 => {
                while pos < buf.len() && buf[pos] & 0x80 != 0 {
                    pos += 1;
                }
                pos += 1;
            }
            1 => pos += 8,
            2 => {
                let mut len = 0usize;
                let mut shift = 0u32;
                loop {
                    if pos >= buf.len() {
                        return fields;
                    }
                    let b = buf[pos];
                    pos += 1;
                    len |= ((b & 0x7f) as usize) << shift;
                    shift += 7;
                    if b & 0x80 == 0 {
                        break;
                    }
                }
                let end = (pos + len).min(buf.len());
                fields.insert(field_number, buf[pos..end].to_vec());
                pos = end;
            }
            5 => pos += 4,
            _ => break,
        }
    }
    fields
}

fn grpc_error(trailers: &str) -> Result<(), String> {
    let status = capture_after(trailers, "grpc-status:");
    let message = capture_after(trailers, "grpc-message:");
    match status {
        Some(s) if s != "0" => Err(format!(
            "spacesd grpc error {s}: {}",
            message.unwrap_or_else(|| "unknown".into())
        )),
        _ => Ok(()),
    }
}

fn capture_after(text: &str, key: &str) -> Option<String> {
    let idx = text.find(key)?;
    let rest = &text[idx + key.len()..];
    let line = rest.split(['\r', '\n']).next().unwrap_or("").trim();
    if line.is_empty() {
        None
    } else {
        Some(client::decode(line))
    }
}

pub async fn mint_viewer_ticket(
    port: u16,
    token: &str,
    ttl_seconds: Option<u64>,
) -> Result<ViewerTicket, String> {
    let mut message: Vec<u8> = Vec::new();
    if let Some(ttl) = ttl_seconds {
        let seconds = ttl.clamp(1, 86_400);
        let mut duration = vec![0x08u8];
        let mut v = seconds;
        while v > 0x7f {
            duration.push(((v & 0x7f) as u8) | 0x80);
            v >>= 7;
        }
        duration.push(v as u8);
        message.push(0x0a);
        message.push(duration.len() as u8);
        message.extend_from_slice(&duration);
    }

    let auth = format!("Bearer {token}");
    let res = client::request(
        "127.0.0.1",
        port,
        "POST",
        "/cua.env.v1.SystemService/CreateViewerTicket",
        &[("content-type", GRPC_WEB), ("x-cua-env-authorization", &auth)],
        Some(&grpc_frame(&message)),
        CALL_TIMEOUT,
    )
    .await
    .map_err(|e| format!("spacesd CreateViewerTicket: {e}"))?;

    let (data, trailers) = parse_grpc_web(&res.body);
    let trailer_text = if trailers.is_empty() {
        res.header("grpc-status")
            .map(|s| format!("grpc-status: {s}"))
            .unwrap_or_default()
    } else {
        trailers
    };
    grpc_error(&trailer_text)?;
    if !res.ok() {
        return Err(format!("spacesd CreateViewerTicket HTTP {}", res.status));
    }

    let fields = parse_proto_fields(&data);
    let ticket = fields
        .get(&1)
        .map(|b| String::from_utf8_lossy(b).to_string())
        .unwrap_or_default();
    let viewer_path = fields
        .get(&3)
        .map(|b| String::from_utf8_lossy(b).to_string())
        .unwrap_or_default();
    if ticket.is_empty() || viewer_path.is_empty() {
        return Err("spacesd CreateViewerTicket: malformed response".into());
    }
    Ok(ViewerTicket { ticket, viewer_path })
}
