use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
};

use serde::Serialize;
use serde_json::{Map, Value};
use tauri::Url;

use super::config::{
    BROWSER_BRIDGE_MAX_MESSAGE_BYTES, BROWSER_RESOLVE_BATCH_SIZE,
    BROWSER_RESOLVE_MUTATION_DEBOUNCE_MS, BROWSER_RESOLVE_MUTATION_MAX_DELAY_MS,
    BROWSER_RESOLVE_SLICE_BUDGET_MS, WEB_ANNOTATION_BRIDGE_SCHEMA_VERSION,
};
use super::contract::BrowserSurfaceRef;
use super::ui_actor::NativeBrowserSurface;

pub(crate) const WEB_ANNOTATION_BRIDGE_PROTOCOL: &str = "keydex.web-annotation.v1";
const MAX_ID_LENGTH: usize = 128;
const MAIN_FRAME_CHANNEL: &str = "main";
const PAGE_BRIDGE_BUNDLE: &str = concat!(
    "(() => {\n",
    "const __KEYDEX_BRIDGE_COMMAND_TARGET__ = new EventTarget();\n",
    "let __KEYDEX_BRIDGE_RESPONSE_HANDLER__ = null;\n",
    "let __KEYDEX_BRIDGE_DIAGNOSTICS_POST__ = null;\n",
    "const __KEYDEX_BRIDGE_RESPONSE_TARGET__ = new class extends EventTarget {\n",
    "  dispatchEvent(event) {\n",
    "    if (typeof __KEYDEX_BRIDGE_RESPONSE_HANDLER__ === 'function') {\n",
    "      __KEYDEX_BRIDGE_RESPONSE_HANDLER__(event);\n",
    "    }\n",
    "    return super.dispatchEvent(event);\n",
    "  }\n",
    "}();\n",
    include_str!("page_bridge.js"),
    "\n",
    include_str!("page_bridge_frame.js"),
    "\n",
    include_str!("page_bridge_overlay.js"),
    "\n",
    include_str!("page_bridge_text.js"),
    "\n",
    include_str!("page_bridge_element.js"),
    "\n",
    include_str!("page_bridge_region.js"),
    "\n",
    include_str!("page_bridge_mutation.js"),
    "\n__KEYDEX_BRIDGE_COMMAND_TARGET__.dispatchEvent(new Event(\"keydex:web-annotation-bootstrap-complete\"));\n",
    "\n})();"
);
const PAGE_BRIDGE_BOOTSTRAP_TOKEN: &str = "__KEYDEX_BRIDGE_BOOTSTRAP__";
const WEB_ANNOTATION_SCORING_POLICY_V1: &str = include_str!(
    "../../../src/renderer/features/browser/annotations/anchoring/scoringPolicyV1.json"
);

pub(crate) const HOST_TO_PAGE_KINDS: &[&str] = &[
    "selection.start",
    "selection.cancel",
    "overlay.configure",
    "annotation.resolve",
    "highlight.render",
    "highlight.clear",
    "navigate.toTarget",
];

pub(crate) const PAGE_TO_HOST_KINDS: &[&str] = &[
    "bridge.ready",
    "selection.candidate",
    "selection.result",
    "selection.cancelled",
    "annotation.submit",
    "annotation.cancelled",
    "highlight.action",
    "resolution.result",
    "geometry.changed",
    "page.changed",
    "page.interaction",
    "bridge.error",
];

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserBridgeEnvelope {
    pub(crate) protocol: String,
    pub(crate) kind: String,
    pub(crate) panel_id: String,
    pub(crate) surface_id: String,
    pub(crate) generation: u64,
    pub(crate) navigation_id: String,
    pub(crate) frame_key: String,
    pub(crate) request_id: String,
    pub(crate) sequence: u64,
    pub(crate) payload: Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum BrowserBridgeError {
    InvalidJson,
    Oversize,
    InvalidFields,
    UnsupportedProtocol,
    UnsupportedKind,
    InvalidValue(&'static str),
    StaleSurface,
    StaleNavigation,
    StaleFrame,
    ChannelMismatch,
    SourceMismatch,
    OutOfOrder,
}

impl BrowserBridgeError {
    pub(crate) fn code(&self) -> &'static str {
        match self {
            Self::InvalidJson => "invalid_json",
            Self::Oversize => "oversize",
            Self::InvalidFields => "invalid_fields",
            Self::UnsupportedProtocol => "unsupported_protocol",
            Self::UnsupportedKind => "unsupported_kind",
            Self::InvalidValue(_) => "invalid_value",
            Self::StaleSurface => "stale_surface",
            Self::StaleNavigation => "stale_navigation",
            Self::StaleFrame => "stale_frame",
            Self::ChannelMismatch => "channel_mismatch",
            Self::SourceMismatch => "source_mismatch",
            Self::OutOfOrder => "out_of_order",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BrowserBridgeDirection {
    HostToPage,
    PageToHost,
}

#[derive(Debug, Clone)]
struct BrowserBridgeFrameCursor {
    navigation_id: String,
    channel_id: String,
    last_page_sequence: u64,
    last_host_sequence: u64,
}

#[derive(Debug, Clone)]
struct PendingBridgeRequest {
    frame_key: String,
    kind: String,
}

#[derive(Debug, Clone)]
struct BrowserBridgeCursor {
    surface: BrowserSurfaceRef,
    host_navigation_id: String,
    frames: HashMap<String, BrowserBridgeFrameCursor>,
    pending_requests: HashMap<String, PendingBridgeRequest>,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct BrowserBridgeBroker {
    cursors: Arc<Mutex<HashMap<String, BrowserBridgeCursor>>>,
}

impl BrowserBridgeBroker {
    pub(crate) fn register_surface(&self, surface: BrowserSurfaceRef, navigation_id: String) {
        if let Ok(mut cursors) = self.cursors.lock() {
            cursors.insert(
                surface.panel_id.clone(),
                BrowserBridgeCursor {
                    surface,
                    host_navigation_id: navigation_id,
                    frames: HashMap::new(),
                    pending_requests: HashMap::new(),
                },
            );
        }
    }

    pub(crate) fn begin_navigation(
        &self,
        surface: &BrowserSurfaceRef,
        navigation_id: String,
    ) -> bool {
        let Ok(mut cursors) = self.cursors.lock() else {
            return false;
        };
        let Some(cursor) = cursors.get_mut(&surface.panel_id) else {
            return false;
        };
        if cursor.surface != *surface {
            return false;
        }
        cursor.host_navigation_id = navigation_id;
        cursor.frames.clear();
        cursor.pending_requests.clear();
        true
    }

    pub(crate) fn unregister_channel(&self, surface: &BrowserSurfaceRef, channel_id: &str) -> bool {
        let Ok(mut cursors) = self.cursors.lock() else {
            return false;
        };
        let Some(cursor) = cursors.get_mut(&surface.panel_id) else {
            return false;
        };
        if cursor.surface != *surface {
            return false;
        }
        let frame_keys = cursor
            .frames
            .iter()
            .filter_map(|(frame_key, frame)| {
                (frame.channel_id == channel_id).then_some(frame_key.clone())
            })
            .collect::<Vec<_>>();
        if frame_keys.is_empty() {
            return false;
        }
        for frame_key in &frame_keys {
            cursor.frames.remove(frame_key);
        }
        cursor
            .pending_requests
            .retain(|_, request| !frame_keys.contains(&request.frame_key));
        true
    }

    fn unregister_channel_for_any_surface(&self, channel_id: &str) -> bool {
        let Ok(mut cursors) = self.cursors.lock() else {
            return false;
        };
        let mut removed = false;
        for cursor in cursors.values_mut() {
            let frame_keys = cursor
                .frames
                .iter()
                .filter_map(|(frame_key, frame)| {
                    (frame.channel_id == channel_id).then_some(frame_key.clone())
                })
                .collect::<Vec<_>>();
            if frame_keys.is_empty() {
                continue;
            }
            removed = true;
            for frame_key in &frame_keys {
                cursor.frames.remove(frame_key);
            }
            cursor
                .pending_requests
                .retain(|_, request| !frame_keys.contains(&request.frame_key));
        }
        removed
    }

    pub(crate) fn unregister_surface(&self, surface: &BrowserSurfaceRef) {
        let Ok(mut cursors) = self.cursors.lock() else {
            return;
        };
        if cursors
            .get(&surface.panel_id)
            .is_some_and(|cursor| cursor.surface == *surface)
        {
            cursors.remove(&surface.panel_id);
        }
    }

    pub(crate) fn receive(&self, raw: &str) -> Result<BrowserBridgeEnvelope, BrowserBridgeError> {
        self.receive_on_channel(MAIN_FRAME_CHANNEL, None, raw)
    }

    pub(crate) fn receive_on_channel(
        &self,
        channel_id: &str,
        source: Option<&str>,
        raw: &str,
    ) -> Result<BrowserBridgeEnvelope, BrowserBridgeError> {
        let envelope = parse_browser_bridge_envelope(raw)?;
        let mut cursors = self
            .cursors
            .lock()
            .map_err(|_| BrowserBridgeError::StaleSurface)?;
        let cursor = cursors
            .get_mut(&envelope.panel_id)
            .ok_or(BrowserBridgeError::StaleSurface)?;
        if cursor.surface.surface_id != envelope.surface_id
            || cursor.surface.generation != envelope.generation
        {
            return Err(BrowserBridgeError::StaleSurface);
        }
        if envelope.kind == "bridge.ready" {
            validate_ready_channel(channel_id, source, &envelope)?;
            if let Some(frame) = cursor.frames.get_mut(&envelope.frame_key) {
                if frame.channel_id == channel_id && frame.navigation_id == envelope.navigation_id {
                    if envelope.sequence <= frame.last_page_sequence {
                        return Err(BrowserBridgeError::OutOfOrder);
                    }
                    frame.last_page_sequence = envelope.sequence;
                    return Ok(envelope);
                }
            }
            if envelope.frame_key == "main" {
                cursor.frames.clear();
                cursor.pending_requests.clear();
            } else {
                cursor
                    .pending_requests
                    .retain(|_, request| request.frame_key != envelope.frame_key);
                cursor.frames.retain(|frame_key, frame| {
                    frame_key == &envelope.frame_key || frame.channel_id != channel_id
                });
            }
            cursor.frames.insert(
                envelope.frame_key.clone(),
                BrowserBridgeFrameCursor {
                    navigation_id: envelope.navigation_id.clone(),
                    channel_id: channel_id.to_string(),
                    last_page_sequence: envelope.sequence,
                    last_host_sequence: 0,
                },
            );
            return Ok(envelope);
        }
        let frame = cursor
            .frames
            .get_mut(&envelope.frame_key)
            .ok_or(BrowserBridgeError::StaleFrame)?;
        if frame.channel_id != channel_id {
            return Err(BrowserBridgeError::ChannelMismatch);
        }
        if frame.navigation_id != envelope.navigation_id {
            return Err(BrowserBridgeError::StaleNavigation);
        }
        if envelope.sequence <= frame.last_page_sequence {
            return Err(BrowserBridgeError::OutOfOrder);
        }
        frame.last_page_sequence = envelope.sequence;
        if matches!(
            envelope.kind.as_str(),
            "selection.cancelled"
                | "annotation.submit"
                | "annotation.cancelled"
                | "resolution.result"
                | "bridge.error"
        ) {
            cursor.pending_requests.remove(&pending_request_key(
                &envelope.frame_key,
                &envelope.request_id,
            ));
        }
        Ok(envelope)
    }

    pub(crate) fn prepare_host_envelope(
        &self,
        surface: &BrowserSurfaceRef,
        frame_key: &str,
        request_id: &str,
        kind: &str,
        payload: Value,
    ) -> Result<BrowserBridgeEnvelope, BrowserBridgeError> {
        if !is_valid_id(request_id) {
            return Err(BrowserBridgeError::InvalidValue("requestId"));
        }
        let mut cursors = self
            .cursors
            .lock()
            .map_err(|_| BrowserBridgeError::StaleSurface)?;
        let cursor = cursors
            .get_mut(&surface.panel_id)
            .filter(|cursor| cursor.surface == *surface)
            .ok_or(BrowserBridgeError::StaleSurface)?;
        let frame = cursor
            .frames
            .get_mut(frame_key)
            .ok_or(BrowserBridgeError::StaleFrame)?;
        frame.last_host_sequence = frame
            .last_host_sequence
            .checked_add(1)
            .ok_or(BrowserBridgeError::OutOfOrder)?;
        let envelope = BrowserBridgeEnvelope {
            protocol: WEB_ANNOTATION_BRIDGE_PROTOCOL.to_string(),
            kind: kind.to_string(),
            panel_id: surface.panel_id.clone(),
            surface_id: surface.surface_id.clone(),
            generation: surface.generation,
            navigation_id: frame.navigation_id.clone(),
            frame_key: frame_key.to_string(),
            request_id: request_id.to_string(),
            sequence: frame.last_host_sequence,
            payload,
        };
        let raw = serde_json::to_string(&envelope).map_err(|_| BrowserBridgeError::InvalidJson)?;
        parse_browser_bridge_envelope_for_direction(&raw, BrowserBridgeDirection::HostToPage)?;
        if matches!(
            kind,
            "selection.start" | "annotation.resolve" | "navigate.toTarget"
        ) {
            cursor.pending_requests.insert(
                pending_request_key(frame_key, request_id),
                PendingBridgeRequest {
                    frame_key: frame_key.to_string(),
                    kind: kind.to_string(),
                },
            );
        } else if kind == "selection.cancel" {
            cursor
                .pending_requests
                .remove(&pending_request_key(frame_key, request_id));
        }
        Ok(envelope)
    }

    pub(crate) fn pending_selection_requests(
        &self,
        surface: &BrowserSurfaceRef,
    ) -> Vec<(String, String)> {
        let mut requests: Vec<(String, String)> = self
            .cursors
            .lock()
            .map(|cursors| {
                cursors
                    .get(&surface.panel_id)
                    .filter(|cursor| cursor.surface == *surface)
                    .map(|cursor| {
                        cursor
                            .pending_requests
                            .iter()
                            .filter_map(|(key, request)| {
                                (request.kind == "selection.start").then_some((
                                    request.frame_key.clone(),
                                    pending_request_id(key).to_string(),
                                ))
                            })
                            .collect()
                    })
                    .unwrap_or_default()
            })
            .unwrap_or_default();
        requests.sort();
        requests
    }

    pub(crate) fn ready_frame_keys(&self, surface: &BrowserSurfaceRef) -> Vec<String> {
        let mut keys = self
            .cursors
            .lock()
            .ok()
            .and_then(|cursors| {
                cursors
                    .get(&surface.panel_id)
                    .filter(|cursor| cursor.surface == *surface)
                    .map(|cursor| cursor.frames.keys().cloned().collect::<Vec<_>>())
            })
            .unwrap_or_default();
        keys.sort_by(|left, right| {
            let left_main = left == MAIN_FRAME_CHANNEL;
            let right_main = right == MAIN_FRAME_CHANNEL;
            right_main.cmp(&left_main).then_with(|| left.cmp(right))
        });
        keys
    }

    #[cfg(test)]
    fn pending_request_count(&self, surface: &BrowserSurfaceRef) -> usize {
        self.cursors
            .lock()
            .ok()
            .and_then(|cursors| cursors.get(&surface.panel_id).cloned())
            .filter(|cursor| cursor.surface == *surface)
            .map(|cursor| cursor.pending_requests.len())
            .unwrap_or(0)
    }
}

fn pending_request_key(frame_key: &str, request_id: &str) -> String {
    format!("{frame_key}\u{1f}{request_id}")
}

fn pending_request_id(key: &str) -> &str {
    key.rsplit_once('\u{1f}')
        .map(|(_, request_id)| request_id)
        .unwrap_or(key)
}

pub(crate) fn parse_browser_bridge_envelope(
    raw: &str,
) -> Result<BrowserBridgeEnvelope, BrowserBridgeError> {
    parse_browser_bridge_envelope_for_direction(raw, BrowserBridgeDirection::PageToHost)
}

pub(crate) fn parse_browser_bridge_envelope_for_direction(
    raw: &str,
    direction: BrowserBridgeDirection,
) -> Result<BrowserBridgeEnvelope, BrowserBridgeError> {
    if raw.len() > BROWSER_BRIDGE_MAX_MESSAGE_BYTES {
        return Err(BrowserBridgeError::Oversize);
    }
    let value: Value = serde_json::from_str(raw).map_err(|_| BrowserBridgeError::InvalidJson)?;
    let object = exact_object(
        &value,
        &[
            "protocol",
            "kind",
            "panelId",
            "surfaceId",
            "generation",
            "navigationId",
            "frameKey",
            "requestId",
            "sequence",
            "payload",
        ],
    )?;
    let protocol = read_id(object, "protocol", 64)?;
    if protocol != WEB_ANNOTATION_BRIDGE_PROTOCOL || WEB_ANNOTATION_BRIDGE_SCHEMA_VERSION != 1 {
        return Err(BrowserBridgeError::UnsupportedProtocol);
    }
    let kind = read_id(object, "kind", 64)?;
    let kinds = match direction {
        BrowserBridgeDirection::HostToPage => HOST_TO_PAGE_KINDS,
        BrowserBridgeDirection::PageToHost => PAGE_TO_HOST_KINDS,
    };
    if !kinds.contains(&kind.as_str()) {
        return Err(BrowserBridgeError::UnsupportedKind);
    }
    let generation = read_positive_u64(object, "generation")?;
    let sequence = read_positive_u64(object, "sequence")?;
    let payload = object
        .get("payload")
        .filter(|value| value.is_object())
        .cloned()
        .ok_or(BrowserBridgeError::InvalidValue("payload"))?;
    validate_bridge_payload(&kind, &payload)?;
    Ok(BrowserBridgeEnvelope {
        protocol,
        kind,
        panel_id: read_id(object, "panelId", MAX_ID_LENGTH)?,
        surface_id: read_id(object, "surfaceId", MAX_ID_LENGTH)?,
        generation,
        navigation_id: read_id(object, "navigationId", MAX_ID_LENGTH)?,
        frame_key: read_id(object, "frameKey", MAX_ID_LENGTH)?,
        request_id: read_id(object, "requestId", MAX_ID_LENGTH)?,
        sequence,
        payload,
    })
}

pub(crate) fn bridge_initialization_script(surface: &BrowserSurfaceRef) -> String {
    let scoring_policy: Value = serde_json::from_str(WEB_ANNOTATION_SCORING_POLICY_V1)
        .expect("web annotation scoring policy fixture must be valid JSON");
    let bootstrap = serde_json::json!({
        "panelId": surface.panel_id,
        "surfaceId": surface.surface_id,
        "generation": surface.generation,
        "diagnostics": cfg!(debug_assertions),
        "scoringPolicy": scoring_policy,
        "resolverPolicy": {
            "batchSize": BROWSER_RESOLVE_BATCH_SIZE,
            "mutationDebounceMs": BROWSER_RESOLVE_MUTATION_DEBOUNCE_MS,
            "mutationMaxDelayMs": BROWSER_RESOLVE_MUTATION_MAX_DELAY_MS,
            "sliceBudgetMs": BROWSER_RESOLVE_SLICE_BUDGET_MS,
        },
    });
    PAGE_BRIDGE_BUNDLE.replacen(PAGE_BRIDGE_BOOTSTRAP_TOKEN, &bootstrap.to_string(), 1)
}

pub(crate) type BrowserBridgeRouteHandler =
    Arc<dyn Fn(Result<BrowserBridgeEnvelope, BrowserBridgeError>) + Send + Sync>;

#[cfg(windows)]
pub(crate) fn attach_windows_web_message_broker(
    webview: &NativeBrowserSurface,
    broker: BrowserBridgeBroker,
    route: BrowserBridgeRouteHandler,
) -> Result<(), String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_4;
    use webview2_com::{FrameCreatedEventHandler, WebMessageReceivedEventHandler};
    use windows_061::core::Interface;

    webview.run(move |surface| unsafe {
        let core = surface.core();
        let main_broker = broker.clone();
        let main_route = route.clone();
        let mut token = 0_i64;
        core.add_WebMessageReceived(
            &WebMessageReceivedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else {
                    return Ok(());
                };
                receive_windows_message(&args, MAIN_FRAME_CHANNEL, &main_broker, &main_route)
            })),
            &mut token,
        )
        .map_err(|error| format!("Failed to attach browser bridge broker: {error}"))?;

        if let Ok(core4) = core.cast::<ICoreWebView2_4>() {
            let frame_broker = broker.clone();
            let frame_route = route.clone();
            let mut frame_token = 0_i64;
            core4
                .add_FrameCreated(
                    &FrameCreatedEventHandler::create(Box::new(move |_, args| {
                        if let Some(args) = args {
                            if let Ok(frame) = args.Frame() {
                                let _ = attach_windows_frame_channel(
                                    frame,
                                    frame_broker.clone(),
                                    frame_route.clone(),
                                );
                            }
                        }
                        Ok(())
                    })),
                    &mut frame_token,
                )
                .map_err(|error| format!("Failed to attach browser frame broker: {error}"))?;
        }
        Ok(())
    })
}

#[cfg(windows)]
unsafe fn attach_windows_frame_channel(
    frame: webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Frame,
    broker: BrowserBridgeBroker,
    route: BrowserBridgeRouteHandler,
) -> windows_061::core::Result<()> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2Frame2, ICoreWebView2Frame7};
    use webview2_com::{
        FrameChildFrameCreatedEventHandler, FrameDestroyedEventHandler,
        FrameWebMessageReceivedEventHandler,
    };
    use windows_061::core::Interface;

    let channel_id = format!("frame-native:{}", uuid::Uuid::new_v4());
    if let Ok(frame2) = frame.cast::<ICoreWebView2Frame2>() {
        let message_broker = broker.clone();
        let message_route = route.clone();
        let message_channel = channel_id.clone();
        let mut message_token = 0_i64;
        frame2.add_WebMessageReceived(
            &FrameWebMessageReceivedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else {
                    return Ok(());
                };
                receive_windows_message(&args, &message_channel, &message_broker, &message_route)
            })),
            &mut message_token,
        )?;
    }

    let destroyed_broker = broker.clone();
    let destroyed_channel = channel_id.clone();
    let mut destroyed_token = 0_i64;
    frame.add_Destroyed(
        &FrameDestroyedEventHandler::create(Box::new(move |_, _| {
            destroyed_broker.unregister_channel_for_any_surface(&destroyed_channel);
            Ok(())
        })),
        &mut destroyed_token,
    )?;

    if let Ok(frame7) = frame.cast::<ICoreWebView2Frame7>() {
        let child_broker = broker;
        let child_route = route;
        let mut child_token = 0_i64;
        frame7.add_FrameCreated(
            &FrameChildFrameCreatedEventHandler::create(Box::new(move |_, args| {
                if let Some(args) = args {
                    if let Ok(child) = args.Frame() {
                        let _ = attach_windows_frame_channel(
                            child,
                            child_broker.clone(),
                            child_route.clone(),
                        );
                    }
                }
                Ok(())
            })),
            &mut child_token,
        )?;
    }
    Ok(())
}

#[cfg(windows)]
unsafe fn receive_windows_message(
    args: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2WebMessageReceivedEventArgs,
    channel_id: &str,
    broker: &BrowserBridgeBroker,
    route: &BrowserBridgeRouteHandler,
) -> windows_061::core::Result<()> {
    use windows_061::core::PWSTR;

    let mut message = PWSTR::null();
    let (raw, is_string_message) =
        if args.TryGetWebMessageAsString(&mut message).is_ok() && !message.is_null() {
            (take_windows_string(message)?, true)
        } else {
            let mut json = PWSTR::null();
            args.WebMessageAsJson(&mut json)?;
            if json.is_null() {
                return Ok(());
            }
            (take_windows_string(json)?, false)
        };
    // Tauri's IPC transport uses WebView2 string messages. The browser bridge
    // owns only JSON object messages from child-frame channels, so leave every
    // string exclusively to Tauri instead of emitting a second, false bridge
    // error after the command handler accepts it.
    if is_string_message {
        return Ok(());
    }
    let mut source = PWSTR::null();
    let source = if args.Source(&mut source).is_ok() && !source.is_null() {
        Some(take_windows_string(source)?)
    } else {
        None
    };
    if write_debug_page_trace(channel_id, &raw) {
        return Ok(());
    }
    let result = broker.receive_on_channel(channel_id, source.as_deref(), &raw);
    write_debug_bridge_trace(channel_id, &raw, &result);
    route(result);
    Ok(())
}

#[cfg(all(windows, debug_assertions))]
fn write_debug_page_trace(channel_id: &str, raw: &str) -> bool {
    use std::io::Write;

    let Ok(value) = serde_json::from_str::<Value>(raw) else {
        return false;
    };
    if value.get("protocol").and_then(Value::as_str) != Some("keydex.web-annotation.debug.v1") {
        return false;
    }
    let Some(stage) = value.get("stage").and_then(Value::as_str) else {
        return true;
    };
    if stage.is_empty() || stage.len() > 128 {
        return true;
    }
    let frame_key = value.get("frameKey").and_then(Value::as_str).unwrap_or("-");
    let detail = value
        .get("detail")
        .filter(|value| value.is_object())
        .map(Value::to_string)
        .unwrap_or_else(|| "{}".to_string());
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_millis())
        .unwrap_or_default();
    let path = std::env::temp_dir().join("keydex-browser-bridge-debug.log");
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = writeln!(
            file,
            "{timestamp} pid={} channel={channel_id} frame={frame_key} stage={stage} detail={detail}",
            std::process::id(),
        );
    }
    true
}

#[cfg(any(not(windows), not(debug_assertions)))]
fn write_debug_page_trace(_channel_id: &str, _raw: &str) -> bool {
    false
}

#[cfg(all(windows, debug_assertions))]
fn write_debug_bridge_trace(
    channel_id: &str,
    raw: &str,
    result: &Result<BrowserBridgeEnvelope, BrowserBridgeError>,
) {
    use std::io::Write;

    let parsed = serde_json::from_str::<Value>(raw).ok();
    let kind = parsed
        .as_ref()
        .and_then(|value| value.get("kind"))
        .and_then(Value::as_str)
        .unwrap_or("unparsed");
    if !matches!(
        kind,
        "bridge.ready" | "annotation.submit" | "annotation.cancelled"
    ) && result.is_ok()
    {
        return;
    }
    let request_id = parsed
        .as_ref()
        .and_then(|value| value.get("requestId"))
        .and_then(Value::as_str)
        .unwrap_or("-");
    let sequence = parsed
        .as_ref()
        .and_then(|value| value.get("sequence"))
        .and_then(Value::as_u64)
        .map(|value| value.to_string())
        .unwrap_or_else(|| "-".to_string());
    let outcome = match result {
        Ok(envelope) => format!("accepted:{}", envelope.kind),
        Err(error) => format!("rejected:{}", error.code()),
    };
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_millis())
        .unwrap_or_default();
    let path = std::env::temp_dir().join("keydex-browser-bridge-debug.log");
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = writeln!(
            file,
            "{timestamp} pid={} channel={channel_id} kind={kind} request={request_id} sequence={sequence} outcome={outcome}",
            std::process::id(),
        );
    }
}

#[cfg(any(not(windows), not(debug_assertions)))]
fn write_debug_bridge_trace(
    _channel_id: &str,
    _raw: &str,
    _result: &Result<BrowserBridgeEnvelope, BrowserBridgeError>,
) {
}

#[cfg(windows)]
unsafe fn take_windows_string(
    value: windows_061::core::PWSTR,
) -> windows_061::core::Result<String> {
    let result = value.to_string().unwrap_or_default();
    windows_061::Win32::System::Com::CoTaskMemFree(Some(value.0.cast()));
    Ok(result)
}

#[cfg(windows)]
pub(crate) fn post_windows_bridge_envelope(
    webview: &NativeBrowserSurface,
    envelope: &BrowserBridgeEnvelope,
) -> Result<(), String> {
    use windows_061::core::HSTRING;

    let message = HSTRING::from(
        serde_json::to_string(envelope).expect("validated browser bridge envelope serializes"),
    );
    webview.run(move |surface| unsafe {
        surface
            .core()
            .PostWebMessageAsJson(&message)
            .map_err(|error| format!("Failed to post browser bridge message: {error}"))
    })
}

#[cfg(not(windows))]
pub(crate) fn attach_windows_web_message_broker(
    _webview: &NativeBrowserSurface,
    _broker: BrowserBridgeBroker,
    _route: BrowserBridgeRouteHandler,
) -> Result<(), String> {
    Ok(())
}

#[cfg(not(windows))]
pub(crate) fn post_windows_bridge_envelope(
    _webview: &NativeBrowserSurface,
    _envelope: &BrowserBridgeEnvelope,
) -> Result<(), String> {
    Err("Windowed WebView2 BrowserHost requires Windows".to_string())
}

fn validate_ready_channel(
    channel_id: &str,
    source: Option<&str>,
    envelope: &BrowserBridgeEnvelope,
) -> Result<(), BrowserBridgeError> {
    let payload = envelope
        .payload
        .as_object()
        .ok_or(BrowserBridgeError::InvalidValue("payload"))?;
    let top = payload
        .get("top")
        .and_then(Value::as_bool)
        .ok_or(BrowserBridgeError::InvalidValue("top"))?;
    let is_main_channel = channel_id == MAIN_FRAME_CHANNEL;
    if is_main_channel != top
        || (is_main_channel && envelope.frame_key != "main")
        || (!is_main_channel && !envelope.frame_key.starts_with("frame:"))
    {
        return Err(BrowserBridgeError::ChannelMismatch);
    }
    if let Some(source) = source {
        let href = payload
            .get("href")
            .and_then(Value::as_str)
            .ok_or(BrowserBridgeError::InvalidValue("href"))?;
        if !same_document_url(source, href) {
            return Err(BrowserBridgeError::SourceMismatch);
        }
    }
    Ok(())
}

fn same_document_url(left: &str, right: &str) -> bool {
    let (Ok(mut left), Ok(mut right)) = (Url::parse(left), Url::parse(right)) else {
        return left == right;
    };
    left.set_fragment(None);
    right.set_fragment(None);
    left == right
}

fn exact_object<'a>(
    value: &'a Value,
    required: &[&str],
) -> Result<&'a Map<String, Value>, BrowserBridgeError> {
    let object = value.as_object().ok_or(BrowserBridgeError::InvalidFields)?;
    if object.len() != required.len() || required.iter().any(|key| !object.contains_key(*key)) {
        return Err(BrowserBridgeError::InvalidFields);
    }
    Ok(object)
}

fn read_id(
    object: &Map<String, Value>,
    key: &'static str,
    max_length: usize,
) -> Result<String, BrowserBridgeError> {
    let value = object
        .get(key)
        .and_then(Value::as_str)
        .ok_or(BrowserBridgeError::InvalidValue(key))?;
    if value.is_empty()
        || value.chars().count() > max_length
        || (max_length == MAX_ID_LENGTH && !is_valid_id(value))
    {
        return Err(BrowserBridgeError::InvalidValue(key));
    }
    Ok(value.to_string())
}

fn read_positive_u64(
    object: &Map<String, Value>,
    key: &'static str,
) -> Result<u64, BrowserBridgeError> {
    match object.get(key).and_then(Value::as_u64) {
        Some(value) if value > 0 => Ok(value),
        _ => Err(BrowserBridgeError::InvalidValue(key)),
    }
}

fn validate_bridge_payload(kind: &str, value: &Value) -> Result<(), BrowserBridgeError> {
    let object = value
        .as_object()
        .ok_or(BrowserBridgeError::InvalidValue("payload"))?;
    match kind {
        "selection.start" => {
            exact_keys(object, &["selectionId", "mode"], &[])?;
            read_id(object, "selectionId", MAX_ID_LENGTH)?;
            read_enum(object, "mode", &["text", "element", "region"])?;
        }
        "selection.cancel" => {
            exact_keys(object, &["selectionId", "reason"], &[])?;
            read_id(object, "selectionId", MAX_ID_LENGTH)?;
            read_enum(
                object,
                "reason",
                &["user", "navigation", "surface_destroyed"],
            )?;
        }
        "overlay.configure" => {
            exact_keys(
                object,
                &["theme", "tokens", "radiusPx", "motionMs", "reducedMotion"],
                &[],
            )?;
            read_enum(object, "theme", &["light", "dark"])?;
            let tokens = required(object, "tokens")?
                .as_object()
                .ok_or(BrowserBridgeError::InvalidValue("tokens"))?;
            let color_names = [
                "accent", "surface", "text", "border", "focus", "warning", "danger",
            ];
            exact_keys(tokens, &color_names, &[])?;
            for color_name in color_names {
                validate_css_color(read_string(tokens, color_name, 128, false)?, color_name)?;
            }
            let radius = read_non_negative_f64(object, "radiusPx")?;
            let motion = read_non_negative_f64(object, "motionMs")?;
            if radius > 32.0 {
                return Err(BrowserBridgeError::InvalidValue("radiusPx"));
            }
            if motion > 2_000.0 {
                return Err(BrowserBridgeError::InvalidValue("motionMs"));
            }
            read_bool(object, "reducedMotion")?;
        }
        "annotation.resolve" => {
            exact_keys(object, &["annotationId", "target"], &["binding"])?;
            read_id(object, "annotationId", MAX_ID_LENGTH)?;
            validate_target(required(object, "target")?)?;
            if let Some(binding) = object.get("binding") {
                validate_live_node_binding(binding)?;
            }
        }
        "navigate.toTarget" => {
            exact_keys(object, &["annotationId", "target"], &[])?;
            read_id(object, "annotationId", MAX_ID_LENGTH)?;
            validate_target(required(object, "target")?)?;
        }
        "highlight.render" => {
            exact_keys(
                object,
                &["annotationId", "target", "state"],
                &["bodyMarkdown"],
            )?;
            read_id(object, "annotationId", MAX_ID_LENGTH)?;
            validate_target(required(object, "target")?)?;
            read_enum(
                object,
                "state",
                &["resolved", "changed", "ambiguous", "orphaned"],
            )?;
            if object.contains_key("bodyMarkdown") {
                read_string(object, "bodyMarkdown", 32 * 1024, true)?;
            }
        }
        "highlight.clear" | "geometry.changed" => {
            exact_keys(object, &["annotationIds"], &[])?;
            validate_id_array(required(object, "annotationIds")?, 50)?;
        }
        "page.changed" => {
            exact_keys(object, &["reason", "revision", "annotationIds"], &[])?;
            read_enum(object, "reason", &["dom"])?;
            read_non_negative_u64(object, "revision")?;
            validate_id_array(required(object, "annotationIds")?, 50)?;
        }
        "page.interaction" => {
            exact_keys(object, &[], &[])?;
        }
        "bridge.ready" => {
            exact_keys(object, &["href", "top"], &[])?;
            validate_page_url(read_string(object, "href", 4_096, false)?)?;
            read_bool(object, "top")?;
        }
        "selection.candidate" => {
            exact_keys(
                object,
                &[
                    "selectionId",
                    "mode",
                    "candidateId",
                    "label",
                    "rect",
                    "depth",
                ],
                &[],
            )?;
            read_id(object, "selectionId", MAX_ID_LENGTH)?;
            read_enum(object, "mode", &["text", "element", "region"])?;
            read_id(object, "candidateId", MAX_ID_LENGTH)?;
            read_string(object, "label", 1_024, false)?;
            validate_rect(required(object, "rect")?, false)?;
            read_non_negative_u64(object, "depth")?;
        }
        "selection.result" => {
            exact_keys(
                object,
                &["selectionId", "target"],
                &["captureGeometry", "binding"],
            )?;
            read_id(object, "selectionId", MAX_ID_LENGTH)?;
            let target = required(object, "target")?;
            validate_target(target)?;
            if let Some(binding) = object.get("binding") {
                validate_live_node_binding(binding)?;
            }
            if let Some(geometry) = object.get("captureGeometry") {
                if target.get("type").and_then(Value::as_str) != Some("region") {
                    return Err(BrowserBridgeError::InvalidValue("captureGeometry"));
                }
                validate_capture_geometry(geometry)?;
            }
        }
        "selection.cancelled" => {
            exact_keys(object, &["selectionId", "reason"], &[])?;
            read_id(object, "selectionId", MAX_ID_LENGTH)?;
            read_enum(
                object,
                "reason",
                &[
                    "user",
                    "navigation",
                    "unsupported_frame",
                    "invalid_selection",
                ],
            )?;
        }
        "annotation.submit" => {
            exact_keys(object, &["selectionId", "bodyMarkdown"], &[])?;
            read_id(object, "selectionId", MAX_ID_LENGTH)?;
            read_string(object, "bodyMarkdown", 32 * 1024, false)?;
        }
        "annotation.cancelled" => {
            exact_keys(object, &["selectionId"], &[])?;
            read_id(object, "selectionId", MAX_ID_LENGTH)?;
        }
        "highlight.action" => {
            exact_keys(object, &["annotationId", "action"], &[])?;
            read_id(object, "annotationId", MAX_ID_LENGTH)?;
            read_enum(
                object,
                "action",
                &["add_to_composer", "delete_annotation", "resume_selection"],
            )?;
        }
        "resolution.result" => {
            exact_keys(
                object,
                &["annotationId", "status"],
                &["target", "candidateIds", "evidence"],
            )?;
            read_id(object, "annotationId", MAX_ID_LENGTH)?;
            let status = read_enum(
                object,
                "status",
                &["resolved", "changed", "ambiguous", "orphaned"],
            )?;
            if let Some(target) = object.get("target") {
                validate_target(target)?;
            }
            if let Some(candidate_ids) = object.get("candidateIds") {
                validate_id_array(candidate_ids, 20)?;
            }
            if let Some(evidence) = object.get("evidence") {
                validate_resolution_evidence(evidence)?;
            }
            if matches!(status, "resolved" | "changed") && !object.contains_key("target") {
                return Err(BrowserBridgeError::InvalidValue("target"));
            }
            if status == "ambiguous" && !object.contains_key("candidateIds") {
                return Err(BrowserBridgeError::InvalidValue("candidateIds"));
            }
        }
        "bridge.error" => {
            exact_keys(object, &["code", "message", "retryable"], &[])?;
            read_enum(
                object,
                "code",
                &[
                    "unsupported_frame",
                    "invalid_selection",
                    "navigation_changed",
                    "protocol_mismatch",
                    "internal",
                ],
            )?;
            read_string(object, "message", 512, true)?;
            read_bool(object, "retryable")?;
        }
        _ => return Err(BrowserBridgeError::UnsupportedKind),
    }
    Ok(())
}

fn validate_resolution_evidence(value: &Value) -> Result<(), BrowserBridgeError> {
    let object = value
        .as_object()
        .ok_or(BrowserBridgeError::InvalidValue("evidence"))?;
    exact_keys(
        object,
        &[
            "strategy",
            "score",
            "rects",
            "candidateCount",
            "truncated",
            "changedSignals",
        ],
        &["currentQuote", "candidateSummaries", "binding"],
    )?;
    read_enum(
        object,
        "strategy",
        &[
            "dom_range",
            "text_position",
            "exact_quote",
            "fuzzy_quote",
            "node_handle",
            "stable_dom_path",
            "unique_id",
            "image_src_alt",
            "role_name",
            "stable_attributes",
            "text_context",
            "relative_region",
            "region_semantic_search",
            "coordinate_only_region",
            "frame_unavailable",
        ],
    )?;
    let score = read_non_negative_f64(object, "score")?;
    if score > 1.0 {
        return Err(BrowserBridgeError::InvalidValue("score"));
    }
    if object.contains_key("currentQuote") {
        read_string(object, "currentQuote", 8_192, false)?;
    }
    let rects = required(object, "rects")?
        .as_array()
        .ok_or(BrowserBridgeError::InvalidValue("rects"))?;
    if rects.len() > 128 {
        return Err(BrowserBridgeError::InvalidValue("rects"));
    }
    for rect in rects {
        validate_rect(rect, false)?;
    }
    if read_non_negative_u64(object, "candidateCount")? > 256 {
        return Err(BrowserBridgeError::InvalidValue("candidateCount"));
    }
    read_bool(object, "truncated")?;
    let changed_signals = required(object, "changedSignals")?
        .as_array()
        .ok_or(BrowserBridgeError::InvalidValue("changedSignals"))?;
    if changed_signals.len() > 8 {
        return Err(BrowserBridgeError::InvalidValue("changedSignals"));
    }
    for signal in changed_signals {
        signal
            .as_str()
            .filter(|value| !value.is_empty() && value.chars().count() <= 64)
            .ok_or(BrowserBridgeError::InvalidValue("changedSignals"))?;
    }
    if let Some(binding) = object.get("binding") {
        validate_live_node_binding(binding)?;
    }
    if let Some(summaries) = object.get("candidateSummaries") {
        let summaries = summaries
            .as_array()
            .filter(|values| values.len() <= 20)
            .ok_or(BrowserBridgeError::InvalidValue("candidateSummaries"))?;
        for summary in summaries {
            let summary = summary
                .as_object()
                .ok_or(BrowserBridgeError::InvalidValue("candidateSummaries"))?;
            exact_keys(summary, &["candidateId", "label", "tag"], &["role"])?;
            read_id(summary, "candidateId", MAX_ID_LENGTH)?;
            read_string(summary, "label", 256, false)?;
            read_string(summary, "tag", 64, false)?;
            if summary.contains_key("role") {
                read_string(summary, "role", 128, false)?;
            }
        }
    }
    Ok(())
}

pub(crate) fn validate_live_node_binding(value: &Value) -> Result<(), BrowserBridgeError> {
    let object = value
        .as_object()
        .ok_or(BrowserBridgeError::InvalidValue("binding"))?;
    exact_keys(object, &["documentId", "nodeHandleId"], &[])?;
    read_id(object, "documentId", MAX_ID_LENGTH)?;
    read_id(object, "nodeHandleId", MAX_ID_LENGTH)?;
    Ok(())
}

pub(crate) fn validate_web_annotation_target(value: &Value) -> Result<(), BrowserBridgeError> {
    validate_target(value)
}

fn validate_target(value: &Value) -> Result<(), BrowserBridgeError> {
    let object = value
        .as_object()
        .ok_or(BrowserBridgeError::InvalidValue("target"))?;
    let target_type = read_string(object, "type", 32, false)?;
    match target_type {
        "text" => validate_text_target(object),
        "element" => validate_element_target(object),
        "region" => validate_region_target(object),
        _ => Err(BrowserBridgeError::InvalidValue("type")),
    }
}

fn validate_text_target(object: &Map<String, Value>) -> Result<(), BrowserBridgeError> {
    exact_keys(
        object,
        &["type", "quote", "context", "rects", "frame"],
        &["position", "domRange"],
    )?;
    let quote = required(object, "quote")?
        .as_object()
        .ok_or(BrowserBridgeError::InvalidValue("quote"))?;
    exact_keys(quote, &["exact", "prefix", "suffix"], &[])?;
    read_string(quote, "exact", 8_192, false)?;
    read_string(quote, "prefix", 256, true)?;
    read_string(quote, "suffix", 256, true)?;

    let context = required(object, "context")?
        .as_object()
        .ok_or(BrowserBridgeError::InvalidValue("context"))?;
    exact_keys(
        context,
        &["headingPath"],
        &["containerRole", "containerTextDigest"],
    )?;
    validate_string_array(required(context, "headingPath")?, 16, 256)?;
    read_optional_string(context, "containerRole", 128)?;
    read_optional_string(context, "containerTextDigest", 128)?;

    if let Some(position) = object.get("position") {
        let position = position
            .as_object()
            .ok_or(BrowserBridgeError::InvalidValue("position"))?;
        exact_keys(position, &["start", "end", "textModelVersion"], &[])?;
        let start = read_non_negative_u64(position, "start")?;
        let end = read_non_negative_u64(position, "end")?;
        if end < start || position.get("textModelVersion").and_then(Value::as_u64) != Some(1) {
            return Err(BrowserBridgeError::InvalidValue("position"));
        }
    }
    if let Some(range) = object.get("domRange") {
        let range = range
            .as_object()
            .ok_or(BrowserBridgeError::InvalidValue("domRange"))?;
        exact_keys(
            range,
            &["startPath", "startOffset", "endPath", "endOffset"],
            &[],
        )?;
        validate_dom_path(required(range, "startPath")?)?;
        validate_dom_path(required(range, "endPath")?)?;
        read_non_negative_u64(range, "startOffset")?;
        read_non_negative_u64(range, "endOffset")?;
    }
    validate_rect_array(required(object, "rects")?)?;
    validate_frame(required(object, "frame")?)
}

fn validate_element_target(object: &Map<String, Value>) -> Result<(), BrowserBridgeError> {
    exact_keys(
        object,
        &[
            "type",
            "tag",
            "stableAttributes",
            "path",
            "context",
            "rect",
            "frame",
        ],
        &["role", "accessibleName", "textSummary", "shadowHostPath"],
    )?;
    let tag = read_string(object, "tag", 64, false)?;
    if tag != tag.to_ascii_lowercase() {
        return Err(BrowserBridgeError::InvalidValue("tag"));
    }
    read_optional_string(object, "role", 128)?;
    read_optional_string(object, "accessibleName", 1_024)?;
    read_optional_string(object, "textSummary", 1_024)?;
    let frame = required(object, "frame")?;
    validate_frame(frame)?;
    let frame_url = frame_url(frame)?;
    validate_stable_attributes(required(object, "stableAttributes")?, Some(frame_url))?;
    validate_dom_path(required(object, "path")?)?;
    if let Some(path) = object.get("shadowHostPath") {
        validate_dom_path(path)?;
    }
    let context = required(object, "context")?
        .as_object()
        .ok_or(BrowserBridgeError::InvalidValue("context"))?;
    exact_keys(context, &["headingPath"], &[])?;
    validate_string_array(required(context, "headingPath")?, 16, 256)?;
    validate_rect(required(object, "rect")?, false)?;
    Ok(())
}

fn validate_region_target(object: &Map<String, Value>) -> Result<(), BrowserBridgeError> {
    exact_keys(
        object,
        &["type", "rect", "viewport", "scroll", "frame"],
        &["relativeElement", "visual"],
    )?;
    validate_rect(required(object, "rect")?, true)?;
    let viewport = required(object, "viewport")?
        .as_object()
        .ok_or(BrowserBridgeError::InvalidValue("viewport"))?;
    exact_keys(viewport, &["width", "height"], &[])?;
    read_positive_f64(viewport, "width")?;
    read_positive_f64(viewport, "height")?;
    let scroll = required(object, "scroll")?
        .as_object()
        .ok_or(BrowserBridgeError::InvalidValue("scroll"))?;
    exact_keys(scroll, &["x", "y"], &[])?;
    read_f64(scroll, "x")?;
    read_f64(scroll, "y")?;
    let frame = required(object, "frame")?;
    validate_frame(frame)?;
    let frame_url = frame_url(frame)?;
    if let Some(relative) = object.get("relativeElement") {
        let relative = relative
            .as_object()
            .ok_or(BrowserBridgeError::InvalidValue("relativeElement"))?;
        exact_keys(
            relative,
            &["path", "rect"],
            &[
                "tag",
                "role",
                "accessibleName",
                "textSummary",
                "stableAttributes",
            ],
        )?;
        validate_dom_path(required(relative, "path")?)?;
        validate_rect(required(relative, "rect")?, false)?;
        if let Some(tag) = relative.get("tag") {
            let tag = tag
                .as_str()
                .filter(|value| {
                    !value.is_empty() && value.len() <= 64 && *value == value.to_ascii_lowercase()
                })
                .ok_or(BrowserBridgeError::InvalidValue("tag"))?;
            if tag.contains(char::is_whitespace) {
                return Err(BrowserBridgeError::InvalidValue("tag"));
            }
        }
        read_optional_string(relative, "role", 128)?;
        read_optional_string(relative, "accessibleName", 1_024)?;
        read_optional_string(relative, "textSummary", 1_024)?;
        if let Some(attributes) = relative.get("stableAttributes") {
            validate_stable_attributes(attributes, Some(frame_url))?;
        }
    }
    if let Some(visual) = object.get("visual") {
        let visual = visual
            .as_object()
            .ok_or(BrowserBridgeError::InvalidValue("visual"))?;
        exact_keys(
            visual,
            &["fingerprintVersion", "localDigest"],
            &["perceptualHash"],
        )?;
        if visual.get("fingerprintVersion").and_then(Value::as_u64) != Some(1) {
            return Err(BrowserBridgeError::InvalidValue("fingerprintVersion"));
        }
        let local_digest = read_string(visual, "localDigest", 17, false)?;
        if !valid_prefixed_hex(local_digest, "fnv1a32:", 8) {
            return Err(BrowserBridgeError::InvalidValue("localDigest"));
        }
        if let Some(perceptual_hash) = visual.get("perceptualHash") {
            let perceptual_hash = perceptual_hash
                .as_str()
                .ok_or(BrowserBridgeError::InvalidValue("perceptualHash"))?;
            if !valid_prefixed_hex(perceptual_hash, "dhash64:", 16) {
                return Err(BrowserBridgeError::InvalidValue("perceptualHash"));
            }
        }
    }
    Ok(())
}

fn validate_stable_attributes(
    value: &Value,
    frame_url: Option<&str>,
) -> Result<(), BrowserBridgeError> {
    let attributes = value
        .as_array()
        .ok_or(BrowserBridgeError::InvalidValue("stableAttributes"))?;
    if attributes.len() > 20 {
        return Err(BrowserBridgeError::InvalidValue("stableAttributes"));
    }
    for attribute in attributes {
        let attribute = attribute
            .as_object()
            .ok_or(BrowserBridgeError::InvalidValue("stableAttributes"))?;
        exact_keys(attribute, &["name", "value"], &[])?;
        let name = read_enum(
            attribute,
            "name",
            &[
                "id",
                "name",
                "type",
                "href",
                "src",
                "alt",
                "title",
                "aria-label",
                "role",
            ],
        )?;
        let value = read_string(attribute, "value", 2_048, true)?;
        if matches!(name, "href" | "src") {
            let value_kind = parse_page_url_kind(value)?;
            let frame_kind = frame_url.map(parse_page_url_kind).transpose()?;
            if value_kind == PageUrlKind::Blank
                || (value_kind == PageUrlKind::File && frame_kind != Some(PageUrlKind::File))
            {
                return Err(BrowserBridgeError::InvalidValue("stableAttributes"));
            }
        }
    }
    Ok(())
}

fn valid_prefixed_hex(value: &str, prefix: &str, digits: usize) -> bool {
    value.strip_prefix(prefix).is_some_and(|suffix| {
        suffix.len() == digits
            && suffix
                .chars()
                .all(|value| value.is_ascii_hexdigit() && !value.is_ascii_uppercase())
    })
}

fn validate_capture_geometry(value: &Value) -> Result<(), BrowserBridgeError> {
    let object = value
        .as_object()
        .ok_or(BrowserBridgeError::InvalidValue("captureGeometry"))?;
    exact_keys(object, &["rect", "viewport"], &[])?;
    validate_rect(required(object, "rect")?, true)?;
    let viewport = required(object, "viewport")?
        .as_object()
        .ok_or(BrowserBridgeError::InvalidValue("viewport"))?;
    exact_keys(viewport, &["width", "height"], &[])?;
    read_positive_f64(viewport, "width")?;
    read_positive_f64(viewport, "height")?;
    Ok(())
}

fn validate_frame(value: &Value) -> Result<(), BrowserBridgeError> {
    let object = value
        .as_object()
        .ok_or(BrowserBridgeError::InvalidValue("frame"))?;
    exact_keys(
        object,
        &["url", "indexPath"],
        &["name", "parentElementPath"],
    )?;
    validate_page_url(read_string(object, "url", 4_096, false)?)?;
    read_optional_string(object, "name", 256)?;
    let indices = required(object, "indexPath")?
        .as_array()
        .ok_or(BrowserBridgeError::InvalidValue("indexPath"))?;
    if indices.len() > 32 || indices.iter().any(|value| value.as_u64().is_none()) {
        return Err(BrowserBridgeError::InvalidValue("indexPath"));
    }
    if let Some(path) = object.get("parentElementPath") {
        validate_dom_path(path)?;
    }
    Ok(())
}

fn frame_url(value: &Value) -> Result<&str, BrowserBridgeError> {
    value
        .as_object()
        .and_then(|frame| frame.get("url"))
        .and_then(Value::as_str)
        .ok_or(BrowserBridgeError::InvalidValue("frame"))
}

fn validate_dom_path(value: &Value) -> Result<(), BrowserBridgeError> {
    let path = value
        .as_array()
        .ok_or(BrowserBridgeError::InvalidValue("path"))?;
    if path.is_empty() || path.len() > 128 {
        return Err(BrowserBridgeError::InvalidValue("path"));
    }
    for segment in path {
        let segment = segment
            .as_object()
            .ok_or(BrowserBridgeError::InvalidValue("path"))?;
        exact_keys(segment, &["childIndex", "shadowRoot"], &[])?;
        read_non_negative_u64(segment, "childIndex")?;
        read_bool(segment, "shadowRoot")?;
    }
    Ok(())
}

fn validate_rect_array(value: &Value) -> Result<(), BrowserBridgeError> {
    let rects = value
        .as_array()
        .ok_or(BrowserBridgeError::InvalidValue("rects"))?;
    if rects.is_empty() || rects.len() > 128 {
        return Err(BrowserBridgeError::InvalidValue("rects"));
    }
    for rect in rects {
        validate_rect(rect, false)?;
    }
    Ok(())
}

fn validate_rect(value: &Value, require_area: bool) -> Result<(), BrowserBridgeError> {
    let object = value
        .as_object()
        .ok_or(BrowserBridgeError::InvalidValue("rect"))?;
    exact_keys(object, &["x", "y", "width", "height"], &[])?;
    read_f64(object, "x")?;
    read_f64(object, "y")?;
    let width = read_non_negative_f64(object, "width")?;
    let height = read_non_negative_f64(object, "height")?;
    if require_area && (width == 0.0 || height == 0.0) {
        return Err(BrowserBridgeError::InvalidValue("rect"));
    }
    Ok(())
}

fn validate_id_array(value: &Value, max: usize) -> Result<(), BrowserBridgeError> {
    let values = value
        .as_array()
        .ok_or(BrowserBridgeError::InvalidValue("ids"))?;
    if values.is_empty() || values.len() > max {
        return Err(BrowserBridgeError::InvalidValue("ids"));
    }
    let mut seen = HashSet::new();
    for value in values {
        let id = value
            .as_str()
            .filter(|value| is_valid_id(value))
            .ok_or(BrowserBridgeError::InvalidValue("ids"))?;
        if !seen.insert(id) {
            return Err(BrowserBridgeError::InvalidValue("ids"));
        }
    }
    Ok(())
}

fn validate_string_array(
    value: &Value,
    max_items: usize,
    max_length: usize,
) -> Result<(), BrowserBridgeError> {
    let values = value
        .as_array()
        .ok_or(BrowserBridgeError::InvalidValue("strings"))?;
    if values.len() > max_items
        || values.iter().any(|value| {
            value
                .as_str()
                .is_none_or(|value| value.chars().count() > max_length)
        })
    {
        return Err(BrowserBridgeError::InvalidValue("strings"));
    }
    Ok(())
}

fn validate_page_url(value: &str) -> Result<(), BrowserBridgeError> {
    parse_page_url_kind(value).map(|_| ())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PageUrlKind {
    Blank,
    Remote,
    File,
}

fn parse_page_url_kind(value: &str) -> Result<PageUrlKind, BrowserBridgeError> {
    if value == "about:blank" {
        return Ok(PageUrlKind::Blank);
    }
    let url = super::host::parse_browser_url(value, false)
        .map_err(|_| BrowserBridgeError::InvalidValue("url"))?;
    match url.scheme() {
        "http" | "https" => Ok(PageUrlKind::Remote),
        "file" => Ok(PageUrlKind::File),
        _ => Err(BrowserBridgeError::InvalidValue("url")),
    }
}

fn exact_keys(
    object: &Map<String, Value>,
    required: &[&str],
    optional: &[&str],
) -> Result<(), BrowserBridgeError> {
    if required.iter().any(|key| !object.contains_key(*key))
        || object
            .keys()
            .any(|key| !required.contains(&key.as_str()) && !optional.contains(&key.as_str()))
    {
        return Err(BrowserBridgeError::InvalidFields);
    }
    Ok(())
}

fn required<'a>(
    object: &'a Map<String, Value>,
    key: &'static str,
) -> Result<&'a Value, BrowserBridgeError> {
    object.get(key).ok_or(BrowserBridgeError::InvalidValue(key))
}

fn read_string<'a>(
    object: &'a Map<String, Value>,
    key: &'static str,
    max_length: usize,
    allow_empty: bool,
) -> Result<&'a str, BrowserBridgeError> {
    let value = object
        .get(key)
        .and_then(Value::as_str)
        .ok_or(BrowserBridgeError::InvalidValue(key))?;
    if (!allow_empty && value.is_empty()) || value.chars().count() > max_length {
        return Err(BrowserBridgeError::InvalidValue(key));
    }
    Ok(value)
}

fn read_optional_string(
    object: &Map<String, Value>,
    key: &'static str,
    max_length: usize,
) -> Result<(), BrowserBridgeError> {
    if object.contains_key(key) {
        read_string(object, key, max_length, true)?;
    }
    Ok(())
}

fn read_enum<'a>(
    object: &'a Map<String, Value>,
    key: &'static str,
    allowed: &[&str],
) -> Result<&'a str, BrowserBridgeError> {
    let value = read_string(object, key, 64, false)?;
    if allowed.contains(&value) {
        Ok(value)
    } else {
        Err(BrowserBridgeError::InvalidValue(key))
    }
}

fn read_bool(object: &Map<String, Value>, key: &'static str) -> Result<bool, BrowserBridgeError> {
    object
        .get(key)
        .and_then(Value::as_bool)
        .ok_or(BrowserBridgeError::InvalidValue(key))
}

fn read_non_negative_u64(
    object: &Map<String, Value>,
    key: &'static str,
) -> Result<u64, BrowserBridgeError> {
    object
        .get(key)
        .and_then(Value::as_u64)
        .ok_or(BrowserBridgeError::InvalidValue(key))
}

fn read_f64(object: &Map<String, Value>, key: &'static str) -> Result<f64, BrowserBridgeError> {
    object
        .get(key)
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .ok_or(BrowserBridgeError::InvalidValue(key))
}

fn read_non_negative_f64(
    object: &Map<String, Value>,
    key: &'static str,
) -> Result<f64, BrowserBridgeError> {
    read_f64(object, key).and_then(|value| {
        if value >= 0.0 {
            Ok(value)
        } else {
            Err(BrowserBridgeError::InvalidValue(key))
        }
    })
}

fn read_positive_f64(
    object: &Map<String, Value>,
    key: &'static str,
) -> Result<f64, BrowserBridgeError> {
    read_f64(object, key).and_then(|value| {
        if value > 0.0 {
            Ok(value)
        } else {
            Err(BrowserBridgeError::InvalidValue(key))
        }
    })
}

fn is_valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.chars().count() <= MAX_ID_LENGTH
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric()
                || matches!(character, '.' | '_' | ':' | '@' | '/' | '-')
        })
}

fn validate_css_color(value: &str, key: &'static str) -> Result<(), BrowserBridgeError> {
    if value
        .chars()
        .any(|character| matches!(character, ';' | '{' | '}' | '\'' | '"' | '\\'))
        || value.to_ascii_lowercase().contains("url(")
    {
        return Err(BrowserBridgeError::InvalidValue(key));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    const SHARED_FIXTURE: &str = include_str!(
        "../../../../test-fixtures/sidebar-browser/contracts/web-annotation-bridge-v1.json"
    );

    fn surface() -> BrowserSurfaceRef {
        BrowserSurfaceRef {
            panel_id: "panel-1".to_string(),
            surface_id: "surface-1".to_string(),
            generation: 2,
        }
    }

    fn message(sequence: u64) -> Value {
        json!({
            "protocol": WEB_ANNOTATION_BRIDGE_PROTOCOL,
            "kind": "bridge.ready",
            "panelId": "panel-1",
            "surfaceId": "surface-1",
            "generation": 2,
            "navigationId": "navigation-2",
            "frameKey": "main",
            "requestId": "ready-1",
            "sequence": sequence,
            "payload": { "href": "https://example.test/article", "top": true }
        })
    }

    fn frame_ready(frame_key: &str, navigation_id: &str, href: &str) -> Value {
        json!({
            "protocol": WEB_ANNOTATION_BRIDGE_PROTOCOL,
            "kind": "bridge.ready",
            "panelId": "panel-1",
            "surfaceId": "surface-1",
            "generation": 2,
            "navigationId": navigation_id,
            "frameKey": frame_key,
            "requestId": "bridge-ready",
            "sequence": 1,
            "payload": { "href": href, "top": false }
        })
    }

    fn geometry_message(frame_key: &str, navigation_id: &str, sequence: u64) -> Value {
        json!({
            "protocol": WEB_ANNOTATION_BRIDGE_PROTOCOL,
            "kind": "geometry.changed",
            "panelId": "panel-1",
            "surfaceId": "surface-1",
            "generation": 2,
            "navigationId": navigation_id,
            "frameKey": frame_key,
            "requestId": "geometry-1",
            "sequence": sequence,
            "payload": { "annotationIds": ["annotation-1"] }
        })
    }

    #[test]
    fn shared_fixture_matches_both_rust_direction_allowlists_and_validators() {
        let fixture: Value = serde_json::from_str(SHARED_FIXTURE).unwrap();
        assert_eq!(fixture["protocol"], WEB_ANNOTATION_BRIDGE_PROTOCOL);
        assert_eq!(
            fixture["hostToPageKinds"],
            serde_json::to_value(HOST_TO_PAGE_KINDS).unwrap()
        );
        assert_eq!(
            fixture["pageToHostKinds"],
            serde_json::to_value(PAGE_TO_HOST_KINDS).unwrap()
        );
        for envelope in fixture["hostToPage"].as_array().unwrap() {
            assert!(parse_browser_bridge_envelope_for_direction(
                &envelope.to_string(),
                BrowserBridgeDirection::HostToPage,
            )
            .is_ok());
            assert_eq!(
                parse_browser_bridge_envelope_for_direction(
                    &envelope.to_string(),
                    BrowserBridgeDirection::PageToHost,
                ),
                Err(BrowserBridgeError::UnsupportedKind)
            );
        }
        for envelope in fixture["pageToHost"].as_array().unwrap() {
            assert!(parse_browser_bridge_envelope_for_direction(
                &envelope.to_string(),
                BrowserBridgeDirection::PageToHost,
            )
            .is_ok());
            assert_eq!(
                parse_browser_bridge_envelope_for_direction(
                    &envelope.to_string(),
                    BrowserBridgeDirection::HostToPage,
                ),
                Err(BrowserBridgeError::UnsupportedKind)
            );
        }
    }

    #[test]
    fn fixed_envelope_roundtrips_and_rejects_fake_fields_or_kinds() {
        let value = message(1);
        let parsed = parse_browser_bridge_envelope(&value.to_string()).unwrap();
        assert_eq!(parsed.kind, "bridge.ready");

        let mut fake = value.clone();
        fake["kind"] = json!("native.execute");
        assert_eq!(
            parse_browser_bridge_envelope(&fake.to_string()),
            Err(BrowserBridgeError::UnsupportedKind)
        );
        let mut extra = value;
        extra["selector"] = json!("button.submit");
        assert_eq!(
            parse_browser_bridge_envelope(&extra.to_string()),
            Err(BrowserBridgeError::InvalidFields)
        );
    }

    #[test]
    fn resolution_evidence_is_bounded_and_structurally_validated() {
        let value = json!({
            "protocol": WEB_ANNOTATION_BRIDGE_PROTOCOL,
            "kind": "resolution.result",
            "panelId": "panel-1",
            "surfaceId": "surface-1",
            "generation": 2,
            "navigationId": "navigation-2",
            "frameKey": "main",
            "requestId": "resolve-1",
            "sequence": 1,
            "payload": {
                "annotationId": "annotation-1",
                "status": "orphaned",
                "evidence": {
                    "strategy": "fuzzy_quote",
                    "score": 0.81,
                    "rects": [],
                    "candidateCount": 2,
                    "truncated": false,
                    "changedSignals": []
                }
            }
        });
        assert!(parse_browser_bridge_envelope(&value.to_string()).is_ok());

        let mut invalid_score = value.clone();
        invalid_score["payload"]["evidence"]["score"] = json!(1.01);
        assert_eq!(
            parse_browser_bridge_envelope(&invalid_score.to_string()),
            Err(BrowserBridgeError::InvalidValue("score"))
        );

        let mut leaked_field = value;
        leaked_field["payload"]["evidence"]["selector"] = json!("input[type=password]");
        assert_eq!(
            parse_browser_bridge_envelope(&leaked_field.to_string()),
            Err(BrowserBridgeError::InvalidFields)
        );
    }

    #[test]
    fn navigation_generation_frame_and_sequence_are_correlated() {
        let broker = BrowserBridgeBroker::default();
        broker.register_surface(surface(), "navigation-2".to_string());
        assert!(broker
            .receive_on_channel(
                MAIN_FRAME_CHANNEL,
                Some("https://example.test/article"),
                &message(1).to_string(),
            )
            .is_ok());
        assert_eq!(
            broker.receive(&message(1).to_string()),
            Err(BrowserBridgeError::OutOfOrder)
        );

        let old_navigation = geometry_message("main", "navigation-1", 2);
        assert_eq!(
            broker.receive(&old_navigation.to_string()),
            Err(BrowserBridgeError::StaleNavigation)
        );
        let mut old_generation = geometry_message("main", "navigation-2", 2);
        old_generation["generation"] = json!(1);
        assert_eq!(
            broker.receive(&old_generation.to_string()),
            Err(BrowserBridgeError::StaleSurface)
        );
        let child_frame = frame_ready(
            "frame:0",
            "navigation:frame-1",
            "https://frame.example.test/article",
        );
        assert_eq!(
            broker.receive(&child_frame.to_string()),
            Err(BrowserBridgeError::ChannelMismatch)
        );
        assert!(broker
            .receive_on_channel(
                "frame-native:1",
                Some("https://frame.example.test/article"),
                &child_frame.to_string(),
            )
            .is_ok());
        assert!(broker
            .receive_on_channel(
                "frame-native:1",
                None,
                &geometry_message("frame:0", "navigation:frame-1", 2).to_string(),
            )
            .is_ok());
        assert_eq!(
            broker.receive_on_channel(
                "frame-native:forged",
                None,
                &geometry_message("frame:0", "navigation:frame-1", 3).to_string(),
            ),
            Err(BrowserBridgeError::ChannelMismatch)
        );
    }

    #[test]
    fn frame_navigation_rapid_reload_and_destroy_cancel_pending_requests() {
        let broker = BrowserBridgeBroker::default();
        broker.register_surface(surface(), "host-navigation-1".to_string());
        broker.receive(&message(1).to_string()).unwrap();
        broker
            .prepare_host_envelope(
                &surface(),
                "main",
                "selection-1",
                "selection.start",
                json!({ "selectionId": "selection-1", "mode": "text" }),
            )
            .unwrap();
        assert_eq!(broker.pending_request_count(&surface()), 1);
        assert_eq!(
            broker.pending_selection_requests(&surface()),
            vec![("main".to_string(), "selection-1".to_string())]
        );
        let cancel = broker
            .prepare_host_envelope(
                &surface(),
                "main",
                "selection-1",
                "selection.cancel",
                json!({ "selectionId": "selection-1", "reason": "user" }),
            )
            .unwrap();
        assert_eq!(cancel.kind, "selection.cancel");
        assert_eq!(broker.pending_request_count(&surface()), 0);
        broker
            .prepare_host_envelope(
                &surface(),
                "main",
                "selection-1b",
                "selection.start",
                json!({ "selectionId": "selection-1b", "mode": "text" }),
            )
            .unwrap();

        let mut reloaded = message(1);
        reloaded["navigationId"] = json!("navigation-3");
        broker.receive(&reloaded.to_string()).unwrap();
        assert_eq!(broker.pending_request_count(&surface()), 0);
        assert_eq!(
            broker.receive(&geometry_message("main", "navigation-2", 2).to_string()),
            Err(BrowserBridgeError::StaleNavigation)
        );

        let child = frame_ready(
            "frame:0",
            "navigation:frame-1",
            "https://frame.example.test/article",
        );
        broker
            .receive_on_channel(
                "frame-native:1",
                Some("https://frame.example.test/article"),
                &child.to_string(),
            )
            .unwrap();
        broker
            .prepare_host_envelope(
                &surface(),
                "frame:0",
                "selection-2",
                "selection.start",
                json!({ "selectionId": "selection-2", "mode": "element" }),
            )
            .unwrap();
        assert_eq!(broker.pending_request_count(&surface()), 1);
        assert!(broker.unregister_channel(&surface(), "frame-native:1"));
        assert_eq!(broker.pending_request_count(&surface()), 0);
        assert_eq!(
            broker.receive_on_channel(
                "frame-native:1",
                None,
                &geometry_message("frame:0", "navigation:frame-1", 2).to_string(),
            ),
            Err(BrowserBridgeError::StaleFrame)
        );

        broker
            .prepare_host_envelope(
                &surface(),
                "main",
                "selection-3",
                "selection.start",
                json!({ "selectionId": "selection-3", "mode": "region" }),
            )
            .unwrap();
        assert_eq!(broker.pending_request_count(&surface()), 1);
        broker.unregister_surface(&surface());
        assert_eq!(broker.pending_request_count(&surface()), 0);
    }

    #[test]
    fn one_selection_request_is_brokered_per_ready_frame_and_settles_independently() {
        let broker = BrowserBridgeBroker::default();
        broker.register_surface(surface(), "host-navigation-1".to_string());
        broker.receive(&message(1).to_string()).unwrap();
        let child = frame_ready(
            "frame:0",
            "navigation:frame-1",
            "https://frame.example.test/article",
        );
        broker
            .receive_on_channel(
                "frame-native:1",
                Some("https://frame.example.test/article"),
                &child.to_string(),
            )
            .unwrap();
        let nested = frame_ready(
            "frame:0.1",
            "navigation:nested-1",
            "https://nested.example.test/article",
        );
        broker
            .receive_on_channel(
                "frame-native:2",
                Some("https://nested.example.test/article"),
                &nested.to_string(),
            )
            .unwrap();
        assert_eq!(
            broker.ready_frame_keys(&surface()),
            vec![
                "main".to_string(),
                "frame:0".to_string(),
                "frame:0.1".to_string()
            ]
        );
        for frame_key in broker.ready_frame_keys(&surface()) {
            broker
                .prepare_host_envelope(
                    &surface(),
                    &frame_key,
                    "selection-shared",
                    "selection.start",
                    json!({ "selectionId": "selection-shared", "mode": "element" }),
                )
                .unwrap();
        }
        assert_eq!(broker.pending_request_count(&surface()), 3);

        let fixture: Value = serde_json::from_str(SHARED_FIXTURE).unwrap();
        let mut result = fixture["pageToHost"][2].clone();
        result["panelId"] = json!("panel-1");
        result["surfaceId"] = json!("surface-1");
        result["generation"] = json!(2);
        result["navigationId"] = json!("navigation:frame-1");
        result["frameKey"] = json!("frame:0");
        result["requestId"] = json!("selection-shared");
        result["sequence"] = json!(2);
        result["payload"]["selectionId"] = json!("selection-shared");
        broker
            .receive_on_channel("frame-native:1", None, &result.to_string())
            .unwrap();
        assert_eq!(
            broker.pending_selection_requests(&surface()),
            vec![
                ("frame:0".to_string(), "selection-shared".to_string()),
                ("frame:0.1".to_string(), "selection-shared".to_string()),
                ("main".to_string(), "selection-shared".to_string())
            ]
        );
        let mut submission = fixture["pageToHost"][3].clone();
        submission["panelId"] = json!("panel-1");
        submission["surfaceId"] = json!("surface-1");
        submission["generation"] = json!(2);
        submission["navigationId"] = json!("navigation:frame-1");
        submission["frameKey"] = json!("frame:0");
        submission["requestId"] = json!("selection-shared");
        submission["sequence"] = json!(3);
        submission["payload"]["selectionId"] = json!("selection-shared");
        broker
            .receive_on_channel("frame-native:1", None, &submission.to_string())
            .unwrap();
        assert_eq!(
            broker.pending_selection_requests(&surface()),
            vec![
                ("frame:0.1".to_string(), "selection-shared".to_string()),
                ("main".to_string(), "selection-shared".to_string())
            ]
        );
        for frame_key in ["main", "frame:0.1"] {
            broker
                .prepare_host_envelope(
                    &surface(),
                    frame_key,
                    "selection-shared",
                    "selection.cancel",
                    json!({ "selectionId": "selection-shared", "reason": "user" }),
                )
                .unwrap();
        }
        assert_eq!(broker.pending_request_count(&surface()), 0);
    }

    #[test]
    fn ready_source_and_top_frame_channel_are_native_bound() {
        let broker = BrowserBridgeBroker::default();
        broker.register_surface(surface(), "host-navigation-1".to_string());
        assert_eq!(
            broker.receive_on_channel(
                MAIN_FRAME_CHANNEL,
                Some("https://spoofed.example.test"),
                &message(1).to_string(),
            ),
            Err(BrowserBridgeError::SourceMismatch)
        );
        let child = frame_ready(
            "frame:0",
            "navigation:frame-1",
            "https://frame.example.test/article#selection",
        );
        assert!(broker
            .receive_on_channel(
                "frame-native:1",
                Some("https://frame.example.test/article"),
                &child.to_string(),
            )
            .is_ok());
    }

    #[test]
    fn file_ready_channels_are_native_bound_for_main_and_child_frames() {
        let broker = BrowserBridgeBroker::default();
        broker.register_surface(surface(), "navigation-2".to_string());
        let mut main = message(1);
        main["payload"]["href"] = json!("file:///D:/workspace/index.html#selection");
        assert!(broker
            .receive_on_channel(
                MAIN_FRAME_CHANNEL,
                Some("file:///D:/workspace/index.html"),
                &main.to_string(),
            )
            .is_ok());

        let child = frame_ready(
            "frame:0",
            "navigation:file-frame-1",
            "file:///D:/workspace/frame.html#selection",
        );
        assert!(broker
            .receive_on_channel(
                "frame-native:file-1",
                Some("file:///D:/workspace/frame.html"),
                &child.to_string(),
            )
            .is_ok());

        let forged = BrowserBridgeBroker::default();
        forged.register_surface(surface(), "navigation-2".to_string());
        assert_eq!(
            forged.receive_on_channel(
                MAIN_FRAME_CHANNEL,
                Some("https://spoofed.example.test/article"),
                &main.to_string(),
            ),
            Err(BrowserBridgeError::SourceMismatch)
        );
    }

    #[test]
    fn file_frame_and_stable_url_attributes_are_scheme_and_origin_context_safe() {
        let fixture: Value = serde_json::from_str(SHARED_FIXTURE).unwrap();
        let mut selection = fixture["pageToHost"][2].clone();
        selection["payload"]["target"]["frame"]["url"] = json!("file:///D:/workspace/index.html");
        selection["payload"]["target"]["stableAttributes"] = json!([{
            "name": "href",
            "value": "file:///D:/workspace/nested/page.html"
        }]);
        assert!(parse_browser_bridge_envelope_for_direction(
            &selection.to_string(),
            BrowserBridgeDirection::PageToHost,
        )
        .is_ok());
        let mut blank = message(1);
        blank["payload"]["href"] = json!("about:blank");
        assert!(parse_browser_bridge_envelope_for_direction(
            &blank.to_string(),
            BrowserBridgeDirection::PageToHost,
        )
        .is_ok());

        let mut remote_claim = selection.clone();
        remote_claim["payload"]["target"]["frame"]["url"] = json!("https://example.test/article");
        assert_eq!(
            parse_browser_bridge_envelope_for_direction(
                &remote_claim.to_string(),
                BrowserBridgeDirection::PageToHost,
            ),
            Err(BrowserBridgeError::InvalidValue("stableAttributes"))
        );

        for invalid in [
            "file:///D:/workspace/folder/",
            "file:///tmp/index.html",
            "javascript:alert(1)",
        ] {
            let mut ready = message(1);
            ready["payload"]["href"] = json!(invalid);
            assert_eq!(
                parse_browser_bridge_envelope_for_direction(
                    &ready.to_string(),
                    BrowserBridgeDirection::PageToHost,
                ),
                Err(BrowserBridgeError::InvalidValue("url")),
                "{invalid}",
            );
        }
    }

    #[test]
    fn repeated_ready_recovers_a_missed_bootstrap_before_annotation_submit() {
        let broker = BrowserBridgeBroker::default();
        broker.register_surface(surface(), "navigation-2".to_string());

        let repeated_ready = message(7);
        assert!(broker
            .receive_on_channel(
                MAIN_FRAME_CHANNEL,
                Some("https://example.test/article"),
                &repeated_ready.to_string(),
            )
            .is_ok());

        let submission = json!({
            "protocol": WEB_ANNOTATION_BRIDGE_PROTOCOL,
            "kind": "annotation.submit",
            "panelId": "panel-1",
            "surfaceId": "surface-1",
            "generation": 2,
            "navigationId": "navigation-2",
            "frameKey": "main",
            "requestId": "selection-native",
            "sequence": 8,
            "payload": {
                "selectionId": "selection-native",
                "bodyMarkdown": "Native inspector annotation"
            }
        });
        assert_eq!(
            broker
                .receive_on_channel(
                    MAIN_FRAME_CHANNEL,
                    Some("https://example.test/article"),
                    &submission.to_string(),
                )
                .unwrap()
                .kind,
            "annotation.submit"
        );
    }

    #[test]
    fn strict_payloads_reject_arbitrary_selector_html_and_password_values() {
        let mut selector = message(1);
        selector["payload"]["selector"] = json!("button.submit");
        assert_eq!(
            parse_browser_bridge_envelope(&selector.to_string()),
            Err(BrowserBridgeError::InvalidFields)
        );

        let fixture: Value = serde_json::from_str(SHARED_FIXTURE).unwrap();
        let mut element = fixture["pageToHost"][2].clone();
        element["payload"]["target"]["outerHTML"] = json!("<button>secret</button>");
        assert_eq!(
            parse_browser_bridge_envelope(&element.to_string()),
            Err(BrowserBridgeError::InvalidFields)
        );
        let mut password = fixture["pageToHost"][2].clone();
        password["payload"]["target"]["value"] = json!("not-a-real-password");
        assert_eq!(
            parse_browser_bridge_envelope(&password.to_string()),
            Err(BrowserBridgeError::InvalidFields)
        );
        let mut hostile_color = fixture["hostToPage"][2].clone();
        hostile_color["payload"]["tokens"]["accent"] =
            json!("red; background: url(https://hostile.test/)");
        assert_eq!(
            parse_browser_bridge_envelope_for_direction(
                &hostile_color.to_string(),
                BrowserBridgeDirection::HostToPage,
            ),
            Err(BrowserBridgeError::InvalidValue("accent"))
        );
    }

    #[test]
    fn oversize_is_rejected_before_json_parsing() {
        let raw = "x".repeat(BROWSER_BRIDGE_MAX_MESSAGE_BYTES + 1);
        assert_eq!(
            parse_browser_bridge_envelope(&raw),
            Err(BrowserBridgeError::Oversize)
        );
    }

    #[test]
    fn initialization_script_is_fixed_and_has_no_generic_automation_surface() {
        let script = bridge_initialization_script(&surface());
        assert!(script.contains(WEB_ANNOTATION_BRIDGE_PROTOCOL));
        assert!(script.contains("keydex.web-annotation.scoring.v1"));
        assert!(script.contains("window.chrome?.webview"));
        assert!(script.contains("postNativeMessage"));
        assert!(script.contains("addEventListener(\"message\""));
        assert!(script.contains("removeEventListener(\"message\""));
        assert!(script.contains("pagehide"));
        assert!(script.contains("frame-relay.v1"));
        assert!(!script.contains(PAGE_BRIDGE_BOOTSTRAP_TOKEN));
        for forbidden in ["eval(", "new Function", ".click(", ".submit(", "outerHTML"] {
            assert!(!script.contains(forbidden), "{forbidden}");
        }
    }
}
