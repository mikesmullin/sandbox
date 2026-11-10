//! The control-plane bearer token.
//!
//! The host MCP server can create containers with host mounts and run shell
//! commands inside them. That is worth a token even on loopback, and it is
//! required unconditionally — there is no "trusted interface" switch, because
//! the interface a service is reachable on is exactly the thing that changes
//! without anyone revisiting the auth decision.
//!
//! The token is generated once into `.sbox-lan-token` (0600, gitignored) and
//! printed on first creation so it can be pasted into a client's MCP config.
//! `SBOX_LAN_TOKEN` overrides the file.

use std::sync::OnceLock;

use crate::util;

pub fn token() -> String {
    static TOKEN: OnceLock<String> = OnceLock::new();
    TOKEN
        .get_or_init(|| {
            if let Ok(t) = std::env::var("SBOX_LAN_TOKEN") {
                let t = t.trim().to_string();
                if !t.is_empty() {
                    return t;
                }
            }
            let path = util::project_root().join(".sbox-lan-token");
            if let Ok(existing) = std::fs::read_to_string(&path) {
                let trimmed = existing.trim();
                if !trimmed.is_empty() {
                    return trimmed.to_string();
                }
            }
            let fresh = util::random_hex(32);
            util::write_private(&path, &format!("{fresh}\n"));
            eprintln!(
                "[sbox] generated a control-plane token at {}\n\
                 [sbox]   clients send:  Authorization: Bearer {fresh}",
                path.display()
            );
            fresh
        })
        .clone()
}

/// Compare without leaking the match position through timing.
///
/// The comparison runs over the whole of both strings: returning early on the
/// first mismatched byte is what turns a secret into something guessable one
/// byte at a time.
pub fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    // Fold the length difference into the result rather than returning on it,
    // so the loop below always runs.
    let mut diff = (a.len() ^ b.len()) as u8;
    let n = a.len().max(b.len());
    for i in 0..n {
        let x = a.get(i).copied().unwrap_or(0);
        let y = b.get(i).copied().unwrap_or(0);
        diff |= x ^ y;
    }
    diff == 0 && a.len() == b.len()
}
