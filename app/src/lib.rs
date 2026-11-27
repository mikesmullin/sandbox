use rustex1_kit::{self as kit, js, App, Runtime};
use wasm_bindgen::prelude::*;

mod pages;
mod store;

const POLL_MS: f64 = 1000.0;

struct Sbox;

impl App for Sbox {
    fn register_stores(&self, _rt: &mut Runtime) {
        store::register();
    }

    fn register_routes(&self, rt: &mut Runtime) {
        pages::register(rt);
    }

    fn boot_toast(&self) -> Option<(String, String)> {
        None
    }

    fn started(&self, rt: &mut Runtime) {
        let pending = store::permalink_id().unwrap_or_default();
        store::refresh();

        let mut pending = pending;
        rt.every(POLL_MS, move || {
            store::refresh();
            store::refresh_journal();
            if !pending.is_empty() && store::apply_permalink(&pending) {
                pending.clear();
            }
            store::sync_title();
        });

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

#[wasm_bindgen]
pub fn boot(m: JsValue, router: JsValue, hooks: JsValue, opts: JsValue) -> Result<(), JsValue> {
    kit::boot(m, router, hooks, opts, &Sbox)
}


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
