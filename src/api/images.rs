//! The image matrix: which kind of sandbox a record is, and what that implies.
//!
//! Two kinds today (SBOX_PLAN1 §4):
//!
//! | kind | contents | ready when | agent planes |
//! |---|---|---|---|
//! | `headed` | full desktop: Xvfb, Openbox, Chromium, audio, cua-spacesd | spacesd answers `/health` on 3211 | GUI (spacesd) + exec (execd) |
//! | `headless` | shell + execd only — no X, no browser, no audio | execd answers `/healthz` on 3213 | exec (execd) only |
//!
//! The distinction is load-bearing in three places and nowhere else, which is
//! why it lives in one small module:
//!
//! 1. **Readiness.** A headless image never binds 3211, so probing spacesd's
//!    `/health` there would hang until the boot deadline and record a
//!    `readiness_timeout` on a sandbox that came up fine a second in.
//! 2. **The GUI agent plane.** `…/mcp/*` and screenshots have no meaning
//!    without a desktop; they answer a typed refusal rather than a timeout.
//! 3. **What to publish.** A headless sandbox has no QUIC media port to map.
//!
//! **Free-form image references (PLAN55).** Besides the two kind names — which
//! still select a row of the built image matrix (`headed` → `SANDBOX_IMAGE`,
//! `headless` → `SANDBOX_IMAGE_HEADLESS`) — the create payload also accepts an
//! admin-built reference such as `sbox-video:latest`. A reference that is not
//! a kind name is **always headless**: the GUI plane would need 3211/3212 that
//! the image does not serve, and these containers are tool runtimes with
//! execd only. Records store both the kind and the actual reference, so
//! reconciliation classifies by the stored kind, never by guessing from the
//! name.
//!
//! A record stores its kind, so a sandbox created before a config change keeps
//! behaving the way it was created.

use serde::{Deserialize, Serialize};

/// Default image for each kind, overridable per-process.
const DEFAULT_HEADED: &str = "alpine-desktop:spacesd";
const DEFAULT_HEADLESS: &str = "alpine-sandbox:headless";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    /// Full desktop + viewer + GUI tools.
    #[default]
    Headed,
    /// Shell sandbox: execd only.
    Headless,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Headed => "headed",
            Kind::Headless => "headless",
        }
    }

    /// The image reference this kind's **matrix row** builds from.
    ///
    /// `SANDBOX_IMAGE` / `SANDBOX_IMAGE_HEADLESS` override the defaults, so a
    /// host that tags its images differently does not need a rebuild.
    pub fn image(self) -> String {
        match self {
            Kind::Headed => {
                std::env::var("SANDBOX_IMAGE").unwrap_or_else(|_| DEFAULT_HEADED.into())
            }
            Kind::Headless => std::env::var("SANDBOX_IMAGE_HEADLESS")
                .unwrap_or_else(|_| DEFAULT_HEADLESS.into()),
        }
    }

    /// Does this kind serve the GUI plane — spacesd's tools, the viewer, and
    /// screenshots?
    pub fn has_desktop(self) -> bool {
        matches!(self, Kind::Headed)
    }

    /// Parse the `image` field of a create request.
    ///
    /// A kind name (`"headed"` / `"headless"`) selects a matrix row and resolves
    /// to it (legacy contract, unchanged). Anything else must be a legitimate
    /// local image reference — `name[:tag]` — and is used as-is. Such
    /// references classify **headless** (the GUI plane needs 3211/3212 the
    /// image does not own). Returns `(kind, reference)`; the caller stores both
    /// on the record.
    pub fn parse_ref(name: &str) -> Result<(Kind, String), String> {
        // Legacy: kind names are the matrix, nothing else.
        if let Some(k) = match name {
            "headed" => Some(Kind::Headed),
            "headless" => Some(Kind::Headless),
            _ => None,
        } {
            return Ok((k, k.image()));
        }
        if is_image_reference(name) {
            // Custom admin image: no desktop plane (see module doc).
            return Ok((Kind::Headless, name.to_string()));
        }
        Err(format!(
            "image must be 'headed' or 'headless' (a kind), or an admin-built reference like sbox-video:latest (got {name:?})"
        ))
    }

    /// Which kind an image reference belongs to, when it can be classified from
    /// the name. Used to classify a container found through the CLI rather than
    /// created through the API.
    ///
    /// Only the headless **matrix** image is guessable; every other reference
    /// reads as headed (the matrix default). For orchestration-tracked records
    /// this inference is moot — the stored kind wins and `of_image` is not the
    /// classifier there.
    pub fn of_image(reference: &str) -> Kind {
        if reference == Kind::Headless.image() {
            Kind::Headless
        } else {
            Kind::Headed
        }
    }
}

/// `^[a-z][a-z0-9._-]*(?::[a-z0-9._-]+)?$` — a **local** reference: no registry
/// host component, a repo name (lowercase letter start, `[a-z0-9._-]`), and an
/// optional tag (`[a-z0-9._-]`). The tag is legal because `sbox-video:latest`
/// is the house form.
pub fn is_image_reference(reference: &str) -> bool {
    let (name, tag) = match reference.split_once(':') {
        Some((n, t)) => {
            if !is_name_part(n) {
                return false;
            }
            (n, Some(t))
        }
        None => (reference, None),
    };
    is_name_part(name) && tag.map_or(true, is_tag)
}

fn is_name_part(s: &str) -> bool {
    (1..=128).contains(&s.len())
        && s
            .chars()
            .next()
            .map_or(false, |c| c.is_ascii_lowercase())
        && s
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '.' || c == '_')
        && !s.starts_with('.')
        && !s.ends_with('.')
}

fn is_tag(t: &str) -> bool {
    (1..=128).contains(&t.len())
        && t
            .chars()
            .next()
            .map_or(false, |c| c.is_ascii_alphanumeric())
        && t
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '.' || c == '_')
        && !t.starts_with('.')
        && !t.ends_with('.')
}

/// Every image reference the wall should show, in matrix order.
pub fn all_images() -> Vec<String> {
    vec![Kind::Headed.image(), Kind::Headless.image()]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds_still_resolve_to_matrix() {
        let (k, ref_) = Kind::parse_ref("headed").unwrap();
        assert_eq!(k, Kind::Headed);
        assert_eq!(ref_, Kind::Headed.image());
        let (k, ref_) = Kind::parse_ref("headless").unwrap();
        assert_eq!(k, Kind::Headless);
        assert_eq!(ref_, Kind::Headless.image());
    }

    #[test]
    fn free_reference_is_headless_and_verbatim() {
        let (k, ref_) = Kind::parse_ref("sbox-video:latest").unwrap();
        assert_eq!(k, Kind::Headless);
        assert_eq!(ref_, "sbox-video:latest");
        let (k, ref_) = Kind::parse_ref("sbox-video").unwrap();
        assert_eq!(k, Kind::Headless);
        assert_eq!(ref_, "sbox-video");
    }

    #[test]
    fn of_image_still_recognizes_the_matrix() {
        assert_eq!(Kind::of_image(&Kind::Headless.image()), Kind::Headless);
        assert_eq!(Kind::of_image(Kind::Headed.image().as_str()), Kind::Headed);
        assert_eq!(Kind::of_image("alpine-desktop:spacesd"), Kind::Headed);
    }

    #[test]
    fn bad_references_rejected() {
        for bad in ["", "sbox video", "SBOX-video:latest", "sbox-video:latest:extra", "http://x/y"] {
            assert!(Kind::parse_ref(bad).is_err());
            assert!(!is_image_reference(bad));
        }
    }
}
