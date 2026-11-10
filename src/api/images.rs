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

    /// Parse the `image` field of a create request. Accepts the two kind names
    /// and nothing else — a free-form image reference is a different feature
    /// (and a much larger trust decision) than picking a row of the matrix.
    pub fn parse(name: &str) -> Option<Kind> {
        match name {
            "headed" => Some(Kind::Headed),
            "headless" => Some(Kind::Headless),
            _ => None,
        }
    }

    /// The image reference this kind builds from.
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

    /// Which kind an image reference belongs to. Used to classify a container
    /// found through the CLI rather than created through the API.
    pub fn of_image(reference: &str) -> Kind {
        if reference == Kind::Headless.image() {
            Kind::Headless
        } else {
            Kind::Headed
        }
    }

    /// Does this kind serve the GUI plane — spacesd's tools, the viewer, and
    /// screenshots?
    pub fn has_desktop(self) -> bool {
        matches!(self, Kind::Headed)
    }
}

/// Every image reference the wall should show, in matrix order.
pub fn all_images() -> Vec<String> {
    vec![Kind::Headed.image(), Kind::Headless.image()]
}
