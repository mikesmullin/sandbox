//! The one page: the wall, which becomes the detail view when a box is
//! drilled into.
//!
//! The tree is an `m()` expression handed to `Def::tree`. It compiles to an
//! m-js template string, so the directives (`x-for`, `x-text`, `:class`,
//! `@click`) are the same ones a hand-written template would use — the gain is
//! that the structure is a Rust expression the compiler checks, and the kit's
//! linter checks the directives before anything paints.
//!
//! Layout contract, unchanged from the JS original:
//!   * the tile head selects (builds the batch) — it never drills down;
//!   * the screen overlay is a BARRIER: it selects an unpicked tile, and
//!     drills into an already-picked one;
//!   * a box without a `backref` renders NO chip, not a placeholder.

use rustex1_kit::h::{lit, m, Node};
use rustex1_kit::mjs::Def;
use rustex1_kit::{mjs, Runtime};

use crate::store::STORE;

pub fn register(rt: &mut Runtime) {
    mjs::router_set_mode("path");
    rt.route("/", "Sandbox", |_params| {
        let mut d = Def::new().named("route /");
        d.tree(shell());
        d.finish()
    });
}

fn shell() -> Node {
    m("div").class("shell").kids(vec![top_bar(), stage()])
}

// ── chrome ──────────────────────────────────────────────────────────────────

fn top_bar() -> Node {
    m("header").class("top").kids(vec![
        m("div").class("brand").kids(vec![
            // The logomark IS the server-health indicator: the poll's last
            // outcome drives the class, so a dead backend is visible without
            // reading the error text.
            m("span")
                .class("brand-status")
                .bind(
                    "class",
                    &format!("$store.{STORE}.connState === 'ok' ? 'brand-status ws-ok' : 'brand-status ws-down'"),
                )
                .bind(
                    "title",
                    &format!(
                        "$store.{STORE}.connState === 'ok' \
                         ? 'server reachable — polls succeeding' \
                         : 'server unreachable — polls failing'"
                    ),
                )
                .child(Node::icon("cube")),
            m("span").class("brand-name").child(lit("SANDBOX")),
            m("span")
                .class("brand-sub")
                .child(lit("agentic sandbox orchestration")),
        ]),
        m("div").class("spacer"),
        m("span")
            .class("status")
            .show(&format!("!$store.{STORE}.inFull"))
            .child(m("span").text(&format!("$store.{STORE}.liveCount + ' boxes'"))),
        m("span")
            .class("err")
            .show(&format!("$store.{STORE}.error"))
            .text(&format!("$store.{STORE}.error")),
        m("div").class("actions").kids(vec![
            // The tool-call feed: always reachable, on every view.
            m("button")
                .class("btn ghost log-toggle")
                .attr("type", "button")
                .bind("class", &format!("{{ 'is-on': $store.{STORE}.logOpen }}"))
                .attr("title", "Tool-call log — what every client did")
                .on("click", &format!("$store.{STORE}.toggleLog()"))
                .kids(vec![Node::icon("list-dashes")]),
            // Wall, nothing picked → create.
            m("button")
                .class("btn")
                .attr("type", "button")
                .show(&format!(
                    "!$store.{STORE}.pickedContainer && !$store.{STORE}.inFull"
                ))
                .bind("disabled", &format!("$store.{STORE}.busy"))
                .on("click", &format!("$store.{STORE}.onAdd()"))
                .child(lit("+ new box")),
            // Wall, tiles picked → batch remove.
            m("button")
                .class("btn")
                .attr("type", "button")
                .show(&format!("$store.{STORE}.pickedContainer"))
                .bind("disabled", &format!("$store.{STORE}.busy"))
                .on("click", &format!("$store.{STORE}.onRemove()"))
                .kids(vec![
                    lit("− remove"),
                    m("span")
                        .show(&format!("$store.{STORE}.pickedCount > 1"))
                        .kids(vec![
                            lit(" ("),
                            m("span").text(&format!("$store.{STORE}.pickedCount")),
                            lit(")"),
                        ]),
                ]),
            // Detail view → back to the wall.
            m("button")
                .class("btn ghost")
                .attr("type", "button")
                .show(&format!("$store.{STORE}.inFull"))
                .on("click", &format!("$store.{STORE}.onToggle()"))
                .child(lit("← wall")),
        ]),
    ])
}

// ── the wall ────────────────────────────────────────────────────────────────

fn stage() -> Node {
    m("main")
        .class("stage")
        .on("click", &format!("$store.{STORE}.onStageBlank($event)"))
        .kids(vec![wall(), empty_state(), journal()])
}

/// The sticky tool-call log (SBOX_PLAN1 §3.3).
///
/// Every host MCP call, from every client, against every sandbox — the
/// operator's answer to "what did the agent just do on my machine". It is a
/// panel rather than a page because it is meant to be watched WHILE the
/// desktops are visible, not instead of them.
fn journal() -> Node {
    m("aside")
        .class("journal")
        .show(&format!("$store.{STORE}.logOpen"))
        .kids(vec![
            m("header").class("journal-head").kids(vec![
                Node::icon("list-dashes"),
                m("span").class("journal-title").child(lit("tool calls")),
                m("span")
                    .class("journal-count")
                    .text(&format!("$store.{STORE}.journal.length")),
                m("button")
                    .class("journal-close")
                    .attr("type", "button")
                    .on("click", &format!("$store.{STORE}.toggleLog()"))
                    .child(Node::icon("x")),
            ]),
            m("div")
                .class("journal-body")
                .on("scroll", &format!("$store.{STORE}.onLogScroll($event)"))
                .kids(vec![
                    m("div")
                        .class("journal-empty")
                        .show(&format!("!$store.{STORE}.journal.length"))
                        .child(lit("No tool calls yet.")),
                    m("article")
                        .bind("class", &format!("$store.{STORE}.entryClass(e)"))
                        .for_each(&format!("e in $store.{STORE}.journal"))
                        .key("e.seq")
                        .kids(vec![
                            m("div").class("jr-head").kids(vec![
                                m("span").class("jr-tool").text("e.tool"),
                                m("span").class("jr-ms").text("e.durationMs + 'ms'"),
                                m("span").class("jr-at").text("e.at.slice(11, 19)"),
                            ]),
                            m("pre")
                                .class("jr-args")
                                .text(&format!("$store.{STORE}.argsOf(e)")),
                            m("pre").class("jr-out").text("e.summary"),
                        ]),
                ]),
        ])
}

fn wall() -> Node {
    m("section")
        .class("wall")
        .show(&format!("$store.{STORE}.containers.length"))
        .bind(
            "class",
            &format!(
                "['cols-' + $store.{STORE}.wallCols, {{ 'detail-wall': $store.{STORE}.inFull }}]"
            ),
        )
        .child(tile())
}

fn tile() -> Node {
    m("article")
        .class("tile")
        .for_each(&format!("c in $store.{STORE}.visibleContainers"))
        .key("c.id")
        .bind("data-id", "c.id")
        .bind(
            "class",
            &format!(
                "{{ 'is-picked': $store.{STORE}.isSelected(c.id), \
                   'is-open': $store.{STORE}.inFull && $store.{STORE}.selectedId === c.id }}"
            ),
        )
        .kids(vec![tile_head(), tile_screen()])
}

fn tile_head() -> Node {
    m("div")
        .class("tile-head")
        .on("click", &format!("$store.{STORE}.pickContainer(c.id, $event)"))
        .kids(vec![
            Node::icon("monitor"),
            m("span").class("name").text("c.shortId"),
            m("span")
                .class("badge")
                .bind("class", &format!("$store.{STORE}.badgeClass(c)"))
                .text(&format!("$store.{STORE}.badgeText(c)")),
            // The ACTIVE sandbox: the one the host MCP tools act on when a
            // client names none. Absent on every other tile, not greyed out —
            // there is exactly one, and it should be findable at a glance.
            m("span")
                .class("badge active-badge")
                .iff("c.active")
                .attr("title", "Active sandbox — host MCP read/write/bash act here")
                .child(lit("active")),
            run_chip(),
        ])
}

/// Only when the record carries a backref — `x-if`, so an ordinary box
/// renders NOTHING here rather than an empty chip.
fn run_chip() -> Node {
    m("a")
        .class("run-chip")
        .iff("c.backref")
        .bind("href", "c.backref.url")
        .attr("target", "_blank")
        .attr("rel", "noopener")
        .on("click.stop", &format!("$store.{STORE}.chipClick($event)"))
        .bind("class", &format!("$store.{STORE}.runChipClass(c.backref)"))
        .bind("title", "'AJCS run #' + c.backref.id")
        .kids(vec![
            Node::icon("robot"),
            m("span").class("run-chip-label").text("c.backref.label"),
            m("span")
                .class("run-chip-state")
                .inner_html(&format!("$store.{STORE}.runChipIcon(c.backref)")),
        ])
}

fn tile_screen() -> Node {
    m("div").class("screen").kids(vec![
        // Only a headed sandbox has a viewer. Gating on kind as well as
        // readiness stops a headless tile from asking the backend to mint a
        // viewer ticket, once per render, against a daemon that is not there.
        m("div")
            .class("tile-vnc-viewport")
            .show("c.ready && c.kind !== 'headless'")
            .child(
                m("iframe")
                    .class("tile-vnc")
                    .bind("src", &format!("$store.{STORE}.vncUrl(c)"))
                    .attr("loading", "lazy")
                    .attr("allow", "fullscreen")
                    .on("load", &format!("$store.{STORE}.fitTile($event)")),
            ),
        // BARRIER: always blocks wall interaction; select, then drill down.
        m("div")
            .class("screen-overlay")
            .show(&format!("!$store.{STORE}.inFull"))
            .on("click", &format!("$store.{STORE}.barrierClick(c.id, $event)")),
        m("div")
            .class("placeholder")
            .show("!c.ready")
            .kids(vec![
                m("i").class("ph ph-circle-notch ph-spinner"),
                m("span").child(lit("waiting for box")),
            ]),
        // A headless sandbox is working fine; it simply has no screen. Saying
        // so beats a black rectangle that reads as a broken viewer.
        m("div")
            .class("placeholder headless-note")
            .show("c.ready && c.kind === 'headless'")
            .kids(vec![
                Node::icon("terminal-window"),
                m("span").child(lit("headless — shell only")),
                m("small").child(lit("read · write · bash over MCP")),
            ]),
    ])
}

fn empty_state() -> Node {
    m("div")
        .class("empty")
        .show(&format!("$store.{STORE}.empty"))
        .child(m("div").kids(vec![
            m("h2").child(lit("No boxes running")),
            m("p").kids(vec![
                lit("Click "),
                m("strong").child(lit("+ new box")),
                lit(" to boot one."),
            ]),
        ]))
}
