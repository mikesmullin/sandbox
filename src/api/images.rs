use serde::{Deserialize, Serialize};

const DEFAULT_HEADED: &str = "alpine-desktop:spacesd";
const DEFAULT_HEADLESS: &str = "alpine-sandbox:headless";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    #[default]
    Headed,
    Headless,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Headed => "headed",
            Kind::Headless => "headless",
        }
    }

    pub fn image(self) -> String {
        match self {
            Kind::Headed => {
                std::env::var("SANDBOX_IMAGE").unwrap_or_else(|_| DEFAULT_HEADED.into())
            }
            Kind::Headless => std::env::var("SANDBOX_IMAGE_HEADLESS")
                .unwrap_or_else(|_| DEFAULT_HEADLESS.into()),
        }
    }

    pub fn has_desktop(self) -> bool {
        matches!(self, Kind::Headed)
    }

    pub fn parse_ref(name: &str) -> Result<(Kind, String), String> {
        if let Some(k) = match name {
            "headed" => Some(Kind::Headed),
            "headless" => Some(Kind::Headless),
            _ => None,
        } {
            return Ok((k, k.image()));
        }
        if is_image_reference(name) {
            return Ok((Kind::Headless, name.to_string()));
        }
        Err(format!(
            "image must be 'headed' or 'headless' (a kind), or an admin-built reference like sbox-video:latest (got {name:?})"
        ))
    }

    pub fn of_image(reference: &str) -> Kind {
        if reference == Kind::Headless.image() {
            Kind::Headless
        } else {
            Kind::Headed
        }
    }
}

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

pub fn all_images() -> Vec<String> {
    vec![Kind::Headed.image(), Kind::Headless.image()]
}
