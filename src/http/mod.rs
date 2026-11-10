//! A small HTTP/1.1 surface: a server for the API this process exposes, and a
//! client for the loopback services it calls.
//!
//! Hand-rolled rather than hyper/axum for the same reason brain's `serve.rs`
//! is: every peer is on 127.0.0.1 over plain HTTP, the route table is a dozen
//! entries, and the payloads are small JSON. A full HTTP stack would be more
//! dependency surface and more compile time than the problem needs.

pub mod client;
pub mod server;

pub use client::{request, ClientResponse};
pub use server::{Request, Response, Server};
