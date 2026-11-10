//! The store: everything the wall reads, and the fetches that fill it.
//!
//! A store lives in m-js's bucket on `window`, so a wasm swap merges new
//! methods and **keeps the values** — the container list, the minted viewer
//! URLs and the current selection all survive editing a template. Anything
//! held in a Rust thread-local instead would reset on every rebuild.
//!
//! Nothing here deserializes into Rust structs. The server answers JSON,
//! `api::get` hands back a `JsValue`, and that value goes straight into the
//! store for m-js to read with `x-for` / `x-text`. A serde round trip on the
//! wasm side would buy nothing and cost the whole schema in generated code.

use js_sys::Array;
use rustex1_kit::{api, js, mjs, mjs::Def};
use wasm_bindgen::prelude::*;

/// The one store. Named `sandbox2` for continuity with the records and the
/// console helpers that already say so.
pub const STORE: &str = "sandbox2";

pub fn register() {
    let mut d = Def::new();
    d
        // ── container state ──────────────────────────────────────────────
        .val("containers", &js::new_array().into())
        .bool("loading", true)
        .bool("initialized", false)
        .str("containerSignature", "")
        .str("error", "")
        .bool("busy", false)
        // ── view state ───────────────────────────────────────────────────
        .val("selectedContainer", &JsValue::NULL)
        .bool("fullView", false)
        // Wall multi-select: ids picked on the wall — the batch-remove
        // surface. Distinct from selectedContainer (the DRILLED box).
        .val("selectedIds", &js::new_array().into())
        // Server connectivity (the brand logomark IS the indicator):
        // 'ok' | 'down' — the last /api poll's outcome.
        .str("connState", "down")
        // Viewer URLs per container (id -> minted /viewer/#ticket=… URL).
        .val("viewerUrls", &js::new_object().into())
        .val("viewerFetching", &js::new_object().into())
        // AJCS run state per backref id (backref.id -> 'queued'|'running'|…).
        .val("runStates", &js::new_object().into())
        // ── the tool-call journal (SBOX_PLAN1 §3.3) ──────────────────────
        // Every host MCP call any client made, oldest first. The operator's
        // single source of truth for what an agent did on this machine.
        .val("journal", &js::new_array().into())
        // Tail cursor: the highest seq already pulled.
        .num("journalSeq", 0.0)
        .bool("logOpen", false)
        // Sticky scroll: stay pinned to the newest entry unless the operator
        // has scrolled up to read something, which un-sticks it.
        .bool("logStick", true);

    getters(&mut d);
    methods(&mut d);
    mjs::store(STORE, &d.finish());
}

fn store_ref() -> JsValue {
    mjs::store_ref(STORE)
}

fn containers() -> Array {
    Array::from(&js::get(&store_ref(), "containers"))
}

fn selected_ids() -> Array {
    Array::from(&js::get(&store_ref(), "selectedIds"))
}

fn id_of(container: &JsValue) -> String {
    js::get_str(container, "id")
}

fn has_id(list: &Array, id: &str) -> bool {
    list.iter().any(|v| {
        v.as_string()
            .map(|s| s == id)
            .unwrap_or_else(|| id_of(&v) == id)
    })
}

// ── computed views ──────────────────────────────────────────────────────────

fn getters(d: &mut Def) {
    d.getter("liveCount", |_this, _args| {
        let n = containers()
            .iter()
            .filter(|c| js::get_bool(c, "ready"))
            .count();
        JsValue::from_f64(n as f64)
    })
    .getter("empty", |_this, _args| {
        let s = store_ref();
        let loading = js::get_bool(&s, "loading");
        JsValue::from_bool(!loading && containers().length() == 0)
    })
    .getter("pickedCount", |_this, _args| {
        JsValue::from_f64(selected_ids().length() as f64)
    })
    // Wall-level selection (not fullView) — any picked tiles at all.
    .getter("pickedContainer", |_this, _args| {
        let full = js::get_bool(&store_ref(), "fullView");
        JsValue::from_bool(!full && selected_ids().length() > 0)
    })
    .getter("inFull", |_this, _args| {
        JsValue::from_bool(js::get_bool(&store_ref(), "fullView"))
    })
    .getter("selectedId", |_this, _args| {
        js::get(&store_ref(), "selectedContainer")
    })
    // In full view the wall renders only the drilled box.
    .getter("visibleContainers", |_this, _args| {
        let s = store_ref();
        let all = containers();
        let full = js::get_bool(&s, "fullView");
        let selected = js::get_str(&s, "selectedContainer");
        if !full || selected.is_empty() {
            return all.into();
        }
        let filtered = Array::new();
        for c in all.iter() {
            if id_of(&c) == selected {
                filtered.push(&c);
            }
        }
        filtered.into()
    })
    // Fill-tiling: ceil(sqrt(n)) columns — 1 tile = full, 2 = half/half,
    // 4 = 2×2, then rows grow; capped at 4 columns (grid-auto-rows: 1fr
    // keeps every row equal).
    .getter("wallCols", |_this, _args| {
        let s = store_ref();
        let full = js::get_bool(&s, "fullView");
        let n = if full {
            1
        } else {
            containers().length().max(1) as usize
        };
        let cols = (n as f64).sqrt().ceil() as usize;
        JsValue::from_f64(cols.min(4) as f64)
    });
}

// ── actions the template calls ──────────────────────────────────────────────

fn methods(d: &mut Def) {
    d.method("toggleLog", |_this, _args| {
        let s = store_ref();
        let open = !js::get_bool(&s, "logOpen");
        js::set_bool(&s, "logOpen", open);
        if open {
            js::set_bool(&s, "logStick", true);
        }
        mjs::redraw();
        JsValue::UNDEFINED
    })
    // Un-stick as soon as the operator scrolls away from the bottom, and
    // re-stick when they come back — the behaviour a log pane should have.
    .method("onLogScroll", |_this, args| {
        let el = js::get(&js::arg(&args, 0), "target");
        if el.is_falsy() {
            return JsValue::UNDEFINED;
        }
        let top = js::get_num(&el, "scrollTop");
        let height = js::get_num(&el, "scrollHeight");
        let view = js::get_num(&el, "clientHeight");
        let at_bottom = height - (top + view) < 24.0;
        js::set_bool(&store_ref(), "logStick", at_bottom);
        JsValue::UNDEFINED
    })
    .method("entryClass", |_this, args| {
        let e = js::arg(&args, 0);
        JsValue::from_str(if js::get_bool(&e, "ok") { "jr ok" } else { "jr bad" })
    })
    .method("argsOf", |_this, args| {
        let e = js::arg(&args, 0);
        let json = js::call_global("JSON", &[]);
        let _ = json;
        JsValue::from_str(&stringify(&js::get(&e, "args")))
    });

    d.method("isSelected", |_this, args| {
        let id = js::arg_str(&args, 0);
        JsValue::from_bool(has_id(&selected_ids(), &id))
    })
    .method("badgeClass", |_this, args| {
        let c = js::arg(&args, 0);
        JsValue::from_str(if js::get_bool(&c, "ready") { "live" } else { "wait" })
    })
    .method("badgeText", |_this, args| {
        let c = js::arg(&args, 0);
        JsValue::from_str(if js::get_bool(&c, "ready") {
            "live"
        } else {
            "booting"
        })
    })
    // The minted viewer URL for a ready box; mints one on first ask.
    .method("vncUrl", |_this, args| {
        let c = js::arg(&args, 0);
        if !js::get_bool(&c, "ready") {
            return JsValue::from_str("");
        }
        let id = id_of(&c);
        let urls = js::get(&store_ref(), "viewerUrls");
        let url = js::get_str(&urls, &id);
        if url.is_empty() {
            load_viewer_url(&id);
        }
        JsValue::from_str(&url)
    })
    .method("onAdd", |_this, _args| {
        add_container();
        JsValue::UNDEFINED
    })
    .method("onRemove", |_this, _args| {
        // Batch remove: every picked tile; falls back to the single drilled
        // box when detail-view remove is wired through the same button.
        let ids = selected_ids();
        if ids.length() > 0 {
            remove_selected();
        } else {
            let selected = js::get_str(&store_ref(), "selectedContainer");
            if !selected.is_empty() {
                remove_container(&selected);
            }
        }
        JsValue::UNDEFINED
    })
    // Blank-stage click: clear the wall selection (the escape hatch).
    .method("onStageBlank", |_this, args| {
        let ev = js::arg(&args, 0);
        let target = js::get(&ev, "target");
        if !target.is_falsy() {
            let tile = js::call(&target, "closest", &[JsValue::from_str(".tile")]);
            if !tile.is_falsy() {
                return JsValue::UNDEFINED; // a tile click — not blank
            }
        }
        let s = store_ref();
        if selected_ids().length() == 0 && !js::get_bool(&s, "fullView") {
            return JsValue::UNDEFINED;
        }
        js::set(&s, "selectedIds", &js::new_array().into());
        js::set(&s, "selectedContainer", &JsValue::NULL);
        js::set_bool(&s, "fullView", false);
        sync_permalink();
        mjs::redraw();
        JsValue::UNDEFINED
    })
    // Heading click: TOGGLE the multi-select set — plain head-clicks build
    // the batch, they never drill down.
    .method("pickContainer", |_this, args| {
        let id = js::arg_str(&args, 0);
        let ev = js::arg(&args, 1);
        stop_propagation(&ev);
        let s = store_ref();
        lock_frame_if_full();
        js::set_bool(&s, "fullView", false);
        let next = Array::new();
        let mut removed = false;
        for v in selected_ids().iter() {
            let existing = v.as_string().unwrap_or_default();
            if existing == id {
                removed = true;
            } else {
                next.push(&v);
            }
        }
        if !removed {
            next.push(&JsValue::from_str(&id));
        }
        js::set(&s, "selectedIds", &next.into());
        // last-box-touched invariant (the drill / onToggle source)
        js::set_str(&s, "selectedContainer", &id);
        sync_permalink();
        mjs::redraw();
        JsValue::UNDEFINED
    })
    // BARRIER handles every wall-screen click: select first (into the SET),
    // drill down second (click an ALREADY-selected tile's screen).
    .method("barrierClick", |_this, args| {
        let id = js::arg_str(&args, 0);
        let ev = js::arg(&args, 1);
        stop_propagation(&ev);
        let s = store_ref();
        if has_id(&selected_ids(), &id) {
            // Wall → detail: unlock the iframe so CSS 100%×100% fills the view.
            unlock_frame(&ev);
            js::set_bool(&s, "fullView", true);
            js::set_str(&s, "selectedContainer", &id);
        } else {
            js::set_bool(&s, "fullView", false);
            let next = selected_ids();
            next.push(&JsValue::from_str(&id));
            js::set(&s, "selectedIds", &next.into());
            js::set_str(&s, "selectedContainer", &id);
        }
        sync_permalink();
        mjs::redraw();
        JsValue::UNDEFINED
    })
    .method("onToggle", |_this, _args| {
        let s = store_ref();
        let selected = js::get_str(&s, "selectedContainer");
        if selected.is_empty() {
            return JsValue::UNDEFINED; // nothing drilled — nothing to unfreeze
        }
        // Freeze the current DETAIL dimensions before returning to WALL.
        lock_frame_if_full();
        let full = js::get_bool(&s, "fullView");
        if full {
            js::set_bool(&s, "fullView", false);
            js::set(&s, "selectedContainer", &JsValue::NULL);
        } else {
            js::set_bool(&s, "fullView", true);
            js::set_str(&s, "selectedContainer", &selected);
        }
        sync_permalink();
        mjs::redraw();
        JsValue::UNDEFINED
    })
    // The iframe's load handler: cover-scale on the wall, native fill in detail.
    .method("fitTile", |_this, args| {
        let ev = js::arg(&args, 0);
        let frame = js::get(&ev, "target");
        if frame.is_falsy() {
            return JsValue::UNDEFINED;
        }
        let screen = js::call(&frame, "closest", &[JsValue::from_str(".screen")]);
        if screen.is_falsy() {
            return JsValue::UNDEFINED;
        }
        fit_frame(&frame, &screen);
        JsValue::UNDEFINED
    })
    // The chip click opens the run page — the tile-head's select handler
    // must not fire underneath it.
    .method("chipClick", |_this, args| {
        stop_propagation(&js::arg(&args, 0));
        JsValue::UNDEFINED
    })
    // Run chip (backref) — state class + state icon, neutral when unknown.
    .method("runChipClass", |_this, args| {
        JsValue::from_str(&run_chip_class(&js::arg(&args, 0)))
    })
    .method("runChipIcon", |_this, args| {
        let class = run_chip_class(&js::arg(&args, 0));
        JsValue::from_str(match class.as_str() {
            "chip-run-active" => "<i class=\"ph ph-circle-notch ph-spinner\"></i>",
            "chip-run-success" => "<i class=\"ph ph-seal-check\"></i>",
            "chip-run-failed" => "<i class=\"ph ph-prohibit\"></i>",
            _ => "",
        })
    });
}

fn run_chip_class(backref: &JsValue) -> String {
    if backref.is_falsy() {
        return String::new();
    }
    let id = js::get_str(backref, "id");
    let states = js::get(&store_ref(), "runStates");
    match js::get_str(&states, &id).as_str() {
        "queued" => "chip-run-queued",
        "running" | "provisioning" | "posting" | "stopping" | "blocked" => "chip-run-active",
        "success" => "chip-run-success",
        "failure" | "aborted" => "chip-run-failed",
        _ => "",
    }
    .to_string()
}

// ── DOM helpers the tile layout needs ───────────────────────────────────────

fn stop_propagation(ev: &JsValue) {
    if !ev.is_falsy() {
        js::call(ev, "stopPropagation", &[]);
    }
}

/// Freeze the drilled iframe's pixel size before leaving detail view, so the
/// tile does not visibly resize while the grid re-lays out.
fn lock_frame_if_full() {
    if !js::get_bool(&store_ref(), "fullView") {
        return;
    }
    if let Some(frame) = js::query(".tile-vnc") {
        let rect = js::call(&frame, "getBoundingClientRect", &[]);
        let (w, h) = (js::get_num(&rect, "width"), js::get_num(&rect, "height"));
        let style = js::get(&frame, "style");
        js::set_str(&style, "width", &format!("{w}px"));
        js::set_str(&style, "height", &format!("{h}px"));
    }
}

fn unlock_frame(ev: &JsValue) {
    let target = js::get(ev, "currentTarget");
    if target.is_falsy() {
        return;
    }
    let tile = js::call(&target, "closest", &[JsValue::from_str(".tile")]);
    if tile.is_falsy() {
        return;
    }
    if let Some(frame) = js::query_within(&tile, ".tile-vnc") {
        let style = js::get(&frame, "style");
        js::set_str(&style, "width", "");
        js::set_str(&style, "height", "");
    }
}

/// Wall view: cover-scale the 1280×800 guest into the tile with a transform.
/// Detail view: no transform — the iframe fills the viewport natively.
fn fit_frame(frame: &JsValue, screen: &JsValue) {
    let detail = !js::call(screen, "closest", &[JsValue::from_str(".detail-wall")]).is_falsy();
    let style = js::get(frame, "style");
    if detail {
        js::set_str(&style, "transform", "");
        return;
    }
    let (sw, sh) = (
        js::get_num(screen, "clientWidth"),
        js::get_num(screen, "clientHeight"),
    );
    let (fw, fh) = (
        js::get_num(frame, "clientWidth"),
        js::get_num(frame, "clientHeight"),
    );
    if fw <= 0.0 || fh <= 0.0 {
        return;
    }
    let scale = (sw / fw).max(sh / fh).max(0.01);
    js::set_str(&style, "transform", &format!("scale({scale})"));
}

fn stringify(v: &JsValue) -> String {
    let global = js::global();
    let json = js::get(&global, "JSON");
    js::call(&json, "stringify", &[v.clone()])
        .as_string()
        .unwrap_or_default()
}

/// Pull journal entries newer than the cursor and append them.
///
/// Append rather than replace: the feed is a log, and re-rendering the whole
/// list every second would fight the scroll position the operator is holding.
pub fn refresh_journal() {
    let s = store_ref();
    if !js::get_bool(&s, "logOpen") {
        return;
    }
    let after = js::get_num(&s, "journalSeq") as u64;
    api::get(&format!("/api/journal?after={after}"), None, move |v| {
        let s = store_ref();
        let incoming = Array::from(&js::get(&v, "entries"));
        if incoming.length() == 0 {
            return;
        }
        let existing = Array::from(&js::get(&s, "journal"));
        for e in incoming.iter() {
            existing.push(&e);
        }
        // Bounded on the client too — a long session should not grow the DOM
        // without limit.
        while existing.length() > 500 {
            existing.shift();
        }
        js::set(&s, "journal", &existing.clone().into());
        let head = js::get_num(&v, "head");
        js::set_num(&s, "journalSeq", head);
        mjs::redraw();
        if js::get_bool(&s, "logStick") {
            scroll_log_to_bottom();
        }
    });
}

/// Pin the feed to the newest entry after a render.
fn scroll_log_to_bottom() {
    if let Some(el) = js::query(".journal-body") {
        let height = js::get_num(&el, "scrollHeight");
        js::set_num(&el, "scrollTop", height);
    }
}

// ── fetches ─────────────────────────────────────────────────────────────────

/// Mint a viewer URL for one box. Guarded by `viewerFetching` so a tile that
/// re-renders while the mint is in flight does not fire a second one —
/// tickets are single-flow and a racing pair makes the viewer retry-loop.
pub fn load_viewer_url(id: &str) {
    let s = store_ref();
    let fetching = js::get(&s, "viewerFetching");
    if js::get_bool(&fetching, id) {
        return;
    }
    js::set_bool(&fetching, id, true);
    let owned = id.to_string();
    api::get(
        &format!("/api/containers/{}/viewer", encode(id)),
        None,
        move |v| {
            let s = store_ref();
            let url = js::get_str(&v, "url");
            js::set_bool(&js::get(&s, "viewerFetching"), &owned, false);
            if url.is_empty() {
                return;
            }
            js::set_str(&js::get(&s, "viewerUrls"), &owned, &url);
            mjs::redraw();
        },
    );
}

/// Re-mint and reload one tile's viewer — called when a box transitions to
/// ready, so the iframe connects now that spacesd is actually serving.
pub fn reload_viewer(id: &str) {
    let s = store_ref();
    js::set_str(&js::get(&s, "viewerUrls"), id, "");
    js::set_bool(&js::get(&s, "viewerFetching"), id, false);
    load_viewer_url(id);
}

fn encode(id: &str) -> String {
    js::call_global("encodeURIComponent", &[JsValue::from_str(id)])
        .as_string()
        .unwrap_or_else(|| id.to_string())
}

/// One poll cycle. Only redraws when something actually changed — the list is
/// fetched once a second and a redraw per tick would fight the iframes.
pub fn refresh() {
    api::get("/api/containers", None, move |v| {
        let s = store_ref();
        let list = Array::from(&js::get(&v, "containers"));
        let previously_down = js::get_str(&s, "connState") != "ok";
        let first_load = !js::get_bool(&s, "initialized");

        let signature = signature_of(&list);
        let changed = signature != js::get_str(&s, "containerSignature");

        // Boxes that transitioned to ready need their viewer re-minted. Skipped
        // on the very first refresh so a page reload does not force a
        // re-connect on iframes that are already mounting cleanly.
        let became_ready: Vec<String> = if first_load {
            Vec::new()
        } else {
            newly_ready(&s, &list)
        };

        js::set_str(&s, "connState", "ok");
        js::set_bool(&s, "initialized", true);
        js::set_bool(&s, "loading", false);
        js::set_str(&s, "error", "");
        js::set_str(&s, "containerSignature", &signature);
        if changed {
            js::set(&s, "containers", &list.clone().into());
        }

        // Prune selections whose container vanished — the poll is the
        // reconciler for the drilled box and the picked set alike.
        let pruned = prune_selection(&s, &list);

        for id in &became_ready {
            reload_viewer(id);
        }

        if changed || first_load || pruned || previously_down || !became_ready.is_empty() {
            sync_permalink();
            mjs::redraw();
        }
    });
}

/// `api::get` reports transport failures by never calling back, so the poll
/// marks the connection down on its own schedule — see `lib.rs`'s watchdog.
pub fn mark_down() {
    let s = store_ref();
    if js::get_str(&s, "connState") == "down" {
        return;
    }
    js::set_str(&s, "connState", "down");
    js::set_bool(&s, "initialized", true);
    js::set_bool(&s, "loading", false);
    mjs::redraw();
}

fn signature_of(list: &Array) -> String {
    list.iter()
        .map(|c| {
            let backref = js::get(&c, "backref");
            let b = if backref.is_falsy() {
                String::new()
            } else {
                [
                    js::get_str(&backref, "system"),
                    js::get_str(&backref, "kind"),
                    js::get_str(&backref, "id"),
                    js::get_str(&backref, "label"),
                    js::get_str(&backref, "url"),
                ]
                .join("/")
            };
            format!(
                "{}:{}:{}:{}:{}:{}:{}:{}",
                js::get_str(&c, "id"),
                js::get_str(&c, "shortId"),
                js::get_str(&c, "state"),
                js::get_str(&c, "ip"),
                js::get_str(&c, "mcpHost"),
                js::get_num(&c, "mcpPort"),
                js::get_bool(&c, "ready"),
                b
            )
        })
        .collect::<Vec<_>>()
        .join("|")
}

fn newly_ready(s: &JsValue, list: &Array) -> Vec<String> {
    let previous = Array::from(&js::get(s, "containers"));
    let mut out = Vec::new();
    for c in list.iter() {
        if !js::get_bool(&c, "ready") {
            continue;
        }
        let id = id_of(&c);
        let was_ready = previous
            .iter()
            .find(|p| id_of(p) == id)
            .map(|p| js::get_bool(&p, "ready"))
            .unwrap_or(false);
        if !was_ready {
            out.push(id);
        }
    }
    out
}

/// Drop picked ids (and the drilled box) whose container is gone.
fn prune_selection(s: &JsValue, list: &Array) -> bool {
    let mut changed = false;

    let kept = Array::new();
    for v in Array::from(&js::get(s, "selectedIds")).iter() {
        let id = v.as_string().unwrap_or_default();
        if has_id(list, &id) {
            kept.push(&v);
        } else {
            changed = true;
        }
    }
    if changed {
        js::set(s, "selectedIds", &kept.into());
    }

    let selected = js::get_str(s, "selectedContainer");
    if !selected.is_empty() && !has_id(list, &selected) {
        js::set(s, "selectedContainer", &JsValue::NULL);
        js::set_bool(s, "fullView", false);
        changed = true;
    }
    changed
}

fn add_container() {
    let s = store_ref();
    js::set_bool(&s, "busy", true);
    api::send("/api/containers", Some("POST"), None, move |v| {
        let s = store_ref();
        js::set_bool(&s, "busy", false);
        let err = js::get_str(&v, "error");
        if !err.is_empty() {
            js::set_str(&s, "error", &err);
        }
        refresh();
        mjs::redraw();
    });
}

fn remove_container(id: &str) {
    let s = store_ref();
    js::set_bool(&s, "busy", true);
    let owned = id.to_string();
    api::send(
        &format!("/api/containers/{}", encode(id)),
        Some("DELETE"),
        None,
        move |v| {
            let s = store_ref();
            js::set_bool(&s, "busy", false);
            let err = js::get_str(&v, "error");
            if !err.is_empty() {
                js::set_str(&s, "error", &format!("{owned}: {err}"));
            }
            js::set(&s, "selectedContainer", &JsValue::NULL);
            js::set_bool(&s, "fullView", false);
            refresh();
            mjs::redraw();
        },
    );
}

/// Delete every wall-selected box, sequentially: the DELETE handler stops then
/// deletes, and N parallel stops would stampede the container CLI.
fn remove_selected() {
    let s = store_ref();
    let ids: Vec<String> = selected_ids()
        .iter()
        .filter_map(|v| v.as_string())
        .collect();
    if ids.is_empty() {
        return;
    }
    js::set_bool(&s, "busy", true);
    js::set(&s, "selectedIds", &js::new_array().into());
    delete_next(ids, 0);
}

fn delete_next(ids: Vec<String>, index: usize) {
    if index >= ids.len() {
        let s = store_ref();
        js::set_bool(&s, "busy", false);
        refresh();
        mjs::redraw();
        return;
    }
    let id = ids[index].clone();
    api::send(
        &format!("/api/containers/{}", encode(&id)),
        Some("DELETE"),
        None,
        move |v| {
            let err = js::get_str(&v, "error");
            if !err.is_empty() {
                js::set_str(&store_ref(), "error", &format!("{id}: {err}"));
            }
            delete_next(ids.clone(), index + 1);
        },
    );
}

// ── permalinks ──────────────────────────────────────────────────────────────
//
// The detail view is addressable: `#/sandboxes/<id>` lands the box in full
// view directly (the wall is the default — no hash, no state). The hash is
// written with history.replaceState (no history spam — back stays sane) and
// reconciled by the poll, so a box vanishing mid-detail clears it.

const PERMALINK_PREFIX: &str = "#/sandboxes/";

pub fn permalink_id() -> Option<String> {
    let hash = js::get_str(&js::get(&js::global(), "location"), "hash");
    let rest = hash.strip_prefix(PERMALINK_PREFIX)?;
    let id = rest.split(['/', '?', '#']).next().unwrap_or("");
    if id.is_empty() {
        return None;
    }
    js::call_global("decodeURIComponent", &[JsValue::from_str(id)]).as_string()
}

/// State → hash. The sole writer: read-compare-write, replaceState on change.
pub fn sync_permalink() {
    let s = store_ref();
    let want = if js::get_bool(&s, "fullView") {
        let id = js::get_str(&s, "selectedContainer");
        if id.is_empty() {
            String::new()
        } else {
            format!("{PERMALINK_PREFIX}{}", encode(&id))
        }
    } else {
        String::new()
    };
    let location = js::get(&js::global(), "location");
    let current = js::get_str(&location, "hash");
    if current == want {
        return;
    }
    if want.is_empty() && permalink_id().is_none() {
        return; // never touch foreign hashes
    }
    let path = js::get_str(&location, "pathname");
    let search = js::get_str(&location, "search");
    let history = js::get(&js::global(), "history");
    js::call(
        &history,
        "replaceState",
        &[
            JsValue::NULL,
            JsValue::from_str(""),
            JsValue::from_str(&format!("{path}{search}{want}")),
        ],
    );
}

/// Hash → state: land the permalinked box in full view once it exists.
pub fn apply_permalink(pending: &str) -> bool {
    if pending.is_empty() || !has_id(&containers(), pending) {
        return false;
    }
    let s = store_ref();
    js::set_str(&s, "selectedContainer", pending);
    js::set_bool(&s, "fullView", true);
    true
}

/// `document.title` carries the box count — written ONLY when it changed.
pub fn sync_title() {
    let n = containers()
        .iter()
        .filter(|c| js::get_bool(c, "ready"))
        .count();
    let want = format!("Sandbox ({n})");
    let doc = js::document();
    if doc.title() != want {
        doc.set_title(&want);
    }
}
