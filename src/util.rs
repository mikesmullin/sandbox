//! Small shared helpers: randomness, ephemeral port allocation, paths.

use std::io::Read;
use std::net::TcpListener;
use std::path::{Path, PathBuf};

/// The directory the process treats as its own root — where `.cua-secret` and
/// `tmp/orchestration-state.json` live. The binary may be run from `target/`,
/// so this prefers an explicit override, then the working directory.
pub fn project_root() -> PathBuf {
    if let Ok(dir) = std::env::var("SBOX_ROOT") {
        return PathBuf::from(dir);
    }
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

/// `length` random bytes rendered as lowercase hex (so the string is twice as
/// long as `length`).
pub fn random_hex(length: usize) -> String {
    let mut buf = vec![0u8; length];
    match std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut buf)) {
        Ok(()) => hex::encode(buf),
        Err(_) => {
            // No /dev/urandom (which on these hosts means something is very
            // wrong) — fall back to the clock rather than returning a constant.
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let mut s = format!("{nanos:032x}");
            s.truncate(length * 2);
            s
        }
    }
}

/// Ask the OS for a free loopback port by binding :0 and closing again.
///
/// This is the same inherently racy trick the Node version used: the port is
/// free when we look, and the container runtime binds it a moment later. The
/// window is small and the alternative (a reserved range we track ourselves)
/// trades a rare race for a permanent bookkeeping problem.
pub fn allocate_host_port() -> Result<u16, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|e| format!("could not allocate host port: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("could not read allocated port: {e}"))?
        .port();
    drop(listener);
    Ok(port)
}

/// Write a file that only the owner can read (used for the token secret).
pub fn write_private(path: &Path, contents: &str) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    if std::fs::write(path, contents).is_err() {
        return;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).ok();
    }
}

/// An RFC 3339 timestamp in UTC, to the millisecond — the shape the Node
/// backend wrote into every record (`new Date().toISOString()`), which the SPA
/// and AJCS both sort lexicographically.
pub fn now_iso() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    iso_from_millis(now.as_millis() as i64)
}

/// Civil-time conversion from a Unix millisecond stamp (days-from-epoch
/// algorithm, Howard Hinnant's `civil_from_days`). Avoids a date dependency
/// for the one format this crate emits.
pub fn iso_from_millis(ms: i64) -> String {
    let (secs, millis) = (ms.div_euclid(1000), ms.rem_euclid(1000));
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (hh, mm, ss) = (rem / 3600, (rem % 3600) / 60, rem % 60);

    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };

    format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}.{millis:03}Z")
}

/// The first line of a multi-line CLI error, trimmed — what the Node backend
/// recorded in `record.error` so a wall of podman output never lands in state.
pub fn first_line(text: &str) -> String {
    text.split('\n').next().unwrap_or("").trim().to_string()
}
