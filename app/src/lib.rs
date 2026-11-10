//! sbox's wall frontend — Rust, compiled to wasm, rendering through m-js.
//!
//! This is the whole client. There is no JavaScript in this repository except
//! the two bridge files the rustex1 kit provides (`app.mjs` boots the wasm,
//! `hot.mjs` speaks m-js's hot-reload protocol). Components, templates, state,
//! routes and networking are all Rust, so editing a tile is `cargo`'s problem
//! and not a second toolchain's.
//!
//! What the UI is: a wall of live desktops. One tile per sandbox, each an
//! iframe onto that box's spacesd viewer; click a tile's head to pick it for
//! batch removal, click its screen to drill into the detail view. The backend
//! (sbox-b) is reached entirely through the server's `/api/` forward.

use rustex1_kit::{self as kit, js, App, Runtime};
use wasm_bindgen::prelude::*;

mod pages;
mod store;

/// How often the wall re-reads `/api/containers`. The boxes change state on
/// their own (a boot finishes, an agent deletes one), so the poll is the only
/// reconciler — this app has no websocket of its own.
const POLL_MS: f64 = 1000.0;

struct Sbox;

impl App for Sbox {
    fn register_stores(&self, _rt: &mut Runtime) {
        store::register();
    }

    fn register_routes(&self, rt: &mut Runtime) {
        pages::register(rt);
    }

    /// No boot toast. The page already says the wasm came back by rendering at
    /// all, and "sbox wasm is up", every boot, forever, is not information.
    fn boot_toast(&self) -> Option<(String, String)> {
        None
    }

    fn started(&self, rt: &mut Runtime) {
        // A permalink may name a box the first fetch has not returned yet, so
        // it stays pending and is re-checked on every poll until it lands.
        let pending = store::permalink_id().unwrap_or_default();
        store::refresh();

        let mut pending = pending;
        rt.every(POLL_MS, move || {
            store::refresh();
            if !pending.is_empty() && store::apply_permalink(&pending) {
                pending.clear();
            }
            store::sync_title();
        });

        // The fetch helper reports a transport failure by never calling back,
        // so connectivity is judged on a slower beat: if no successful poll
        // has landed since the last check, the brand goes red.
        let mut last_seen = String::new();
        rt.every(POLL_MS * 3.0, move || {
            let signature = js::get_str(&rustex1_kit::mjs::store_ref(store::STORE), "containerSignature");
            let stamp = format!("{signature}|{}", js::get_str(&rustex1_kit::mjs::store_ref(store::STORE), "error"));
            if stamp == last_seen {
                store::mark_down();
            }
            last_seen = stamp;
        });
    }
}

/// Called by the kit's `app.mjs` — on first load and after every wasm rebuild.
#[wasm_bindgen]
pub fn boot(m: JsValue, router: JsValue, hooks: JsValue, opts: JsValue) -> Result<(), JsValue> {
    kit::boot(m, router, hooks, opts, &Sbox)
}

// ── console surface ─────────────────────────────────────────────────────────

#[wasm_bindgen(js_name = buildInfo)]
pub fn build_info() -> String {
    kit::build_info()
}

#[wasm_bindgen(js_name = debugState)]
pub fn debug_state() -> String {
    kit::debug_state()
}

#[wasm_bindgen(js_name = dumpTemplate)]
pub fn dump_template(name: &str) -> String {
    kit::template_of(name)
}

#[wasm_bindgen(js_name = lintReport)]
pub fn lint_report() -> String {
    kit::lint_report()
}
