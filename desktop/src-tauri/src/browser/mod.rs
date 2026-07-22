// The native browser uses one windowed WebView2 implementation. There is
// deliberately no composition proxy or Wry fallback during development.
#[allow(dead_code)]
pub(crate) mod bridge;
#[allow(dead_code)]
pub(crate) mod capture;
#[allow(dead_code)]
pub(crate) mod commands;
#[allow(dead_code)]
pub(crate) mod config;
#[allow(dead_code)]
pub(crate) mod contract;
#[allow(dead_code)]
pub(crate) mod devtools_inspector;
#[allow(dead_code)]
pub(crate) mod downloads;
#[allow(dead_code)]
pub(crate) mod failures;
#[allow(dead_code)]
pub(crate) mod file_chooser;
#[allow(dead_code)]
pub(crate) mod geometry;
pub(crate) mod host;
#[allow(dead_code)]
pub(crate) mod navigation;
#[allow(dead_code)]
pub(crate) mod permissions;
#[allow(dead_code)]
pub(crate) mod profiles;
#[allow(dead_code)]
pub(crate) mod resources;
#[allow(dead_code)]
pub(crate) mod security;
#[allow(dead_code)]
pub(crate) mod surface;
#[allow(dead_code)]
pub(crate) mod ui_actor;
#[allow(dead_code)]
pub(crate) mod window_host;
#[allow(dead_code)]
pub(crate) mod windowed_surface;
