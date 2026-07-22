use std::sync::Arc;

use super::contract::{BrowserEvent, BrowserShortcut, ShortcutRequestedPayload};
use super::ui_actor::NativeBrowserSurface;

#[cfg(windows)]
use std::{cell::RefCell, collections::HashMap};

#[cfg(windows)]
use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Find;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NativeHistoryAction {
    Back,
    Forward,
    Stop,
}

#[cfg(windows)]
struct NativeFindSession {
    find: ICoreWebView2Find,
    query: String,
    match_case: bool,
}

#[cfg(windows)]
thread_local! {
    // WebView2 interfaces are apartment-bound. Keeping find sessions on the WebView UI
    // thread avoids crossing Send/Sync boundaries while still preserving next/previous state.
    static FIND_SESSIONS: RefCell<HashMap<String, NativeFindSession>> = RefCell::new(HashMap::new());
}

#[cfg(windows)]
pub(crate) fn dispatch_native_history(
    webview: &NativeBrowserSurface,
    action: NativeHistoryAction,
) -> Result<(), String> {
    webview.run(move |surface| unsafe {
        let core = surface.core();
        match action {
            NativeHistoryAction::Back => core.GoBack(),
            NativeHistoryAction::Forward => core.GoForward(),
            NativeHistoryAction::Stop => core.Stop(),
        }
        .map_err(|error| format!("Failed to update browser history: {error}"))
    })
}

#[cfg(windows)]
pub(crate) fn set_native_zoom(webview: &NativeBrowserSurface, factor: f64) -> Result<(), String> {
    webview.run(move |surface| unsafe {
        surface
            .controller()
            .SetZoomFactor(factor)
            .map_err(|error| format!("Failed to set browser zoom: {error}"))
    })
}

#[cfg(not(windows))]
pub(crate) fn set_native_zoom(_webview: &NativeBrowserSurface, _factor: f64) -> Result<(), String> {
    Err("Windowed WebView2 BrowserHost requires Windows".to_string())
}

#[cfg(windows)]
pub(crate) fn dispatch_native_find(
    webview: &NativeBrowserSurface,
    surface_key: String,
    query: String,
    match_case: bool,
    backwards: bool,
) -> Result<(), String> {
    use webview2_com::FindStartCompletedHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Environment15, ICoreWebView2_2, ICoreWebView2_28,
    };
    use windows_061::core::{Interface, HSTRING};

    webview.run(move |surface| unsafe {
        FIND_SESSIONS.with(|sessions| {
            let mut sessions = sessions.borrow_mut();
            if let Some(session) = sessions.get(&surface_key) {
                if session.query == query && session.match_case == match_case {
                    let _ = if backwards {
                        session.find.FindPrevious()
                    } else {
                        session.find.FindNext()
                    };
                    return Ok(());
                }
            }

            if let Some(previous) = sessions.remove(&surface_key) {
                let _ = previous.find.Stop();
            }
            let core = surface.core();
            let Ok(find) = core.cast::<ICoreWebView2_28>().and_then(|core| core.Find()) else {
                return Err("Native WebView2 find is unavailable".to_string());
            };
            let Ok(options) = core
                .cast::<ICoreWebView2_2>()
                .and_then(|core| core.Environment())
                .and_then(|environment| environment.cast::<ICoreWebView2Environment15>())
                .and_then(|environment| environment.CreateFindOptions())
            else {
                return Err("Native WebView2 find options are unavailable".to_string());
            };
            let term = HSTRING::from(&query);
            if options.SetFindTerm(&term).is_err()
                || options.SetIsCaseSensitive(match_case).is_err()
                || options.SetShouldHighlightAllMatches(true).is_err()
                || options.SetShouldMatchWord(false).is_err()
                || options.SetSuppressDefaultFindDialog(true).is_err()
            {
                return Err("Failed to configure native WebView2 find".to_string());
            }
            let completion = FindStartCompletedHandler::create(Box::new(|_| Ok(())));
            if find.Start(&options, &completion).is_ok() {
                sessions.insert(
                    surface_key,
                    NativeFindSession {
                        find,
                        query,
                        match_case,
                    },
                );
            }
            Ok(())
        })
    })
}

#[cfg(not(windows))]
pub(crate) fn dispatch_native_find(
    _webview: &NativeBrowserSurface,
    _surface_key: String,
    _query: String,
    _match_case: bool,
    _backwards: bool,
) -> Result<(), String> {
    Err("Windowed WebView2 BrowserHost requires Windows".to_string())
}

#[cfg(windows)]
pub(crate) fn stop_native_find(
    webview: &NativeBrowserSurface,
    surface_key: String,
) -> Result<(), String> {
    webview.run(move |_| {
        FIND_SESSIONS.with(|sessions| {
            if let Some(session) = sessions.borrow_mut().remove(&surface_key) {
                unsafe {
                    let _ = session.find.Stop();
                }
            }
        });
        Ok(())
    })
}

#[cfg(not(windows))]
pub(crate) fn stop_native_find(
    _webview: &NativeBrowserSurface,
    _surface_key: String,
) -> Result<(), String> {
    Ok(())
}

pub(crate) fn native_find_surface_key(panel_id: &str, surface_id: &str, generation: u64) -> String {
    format!("{panel_id}\u{1f}{surface_id}\u{1f}{generation}")
}

#[cfg(windows)]
pub(crate) fn attach_native_shortcuts(
    webview: &NativeBrowserSurface,
    emit: Arc<dyn Fn(BrowserEvent) + Send + Sync>,
) -> Result<(), String> {
    use webview2_com::AcceleratorKeyPressedEventHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN, COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN,
    };
    use windows_061::Win32::UI::Input::KeyboardAndMouse::{GetKeyState, VK_CONTROL};

    webview.run(move |surface| unsafe {
        let controller = surface.controller();
        let mut token = 0_i64;
        controller
            .add_AcceleratorKeyPressed(
                &AcceleratorKeyPressedEventHandler::create(Box::new(move |_, args| {
                    let Some(args) = args else {
                        return Ok(());
                    };
                    let mut kind = COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN;
                    let mut virtual_key = 0_u32;
                    if args.KeyEventKind(&mut kind).is_err()
                        || args.VirtualKey(&mut virtual_key).is_err()
                        || (kind != COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN
                            && kind != COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN)
                    {
                        return Ok(());
                    }
                    let control = GetKeyState(VK_CONTROL.0 as i32) < 0;
                    let shortcut = match (control, virtual_key) {
                        (true, 0x46) => Some(BrowserShortcut::Find),
                        (true, 0x4c) => Some(BrowserShortcut::FocusAddress),
                        (true, 0x52) | (false, 0x74) => Some(BrowserShortcut::Reload),
                        (true, 0x57) => Some(BrowserShortcut::ClosePanel),
                        _ => None,
                    };
                    if let Some(shortcut) = shortcut {
                        args.SetHandled(true)?;
                        emit(BrowserEvent::ShortcutRequested(ShortcutRequestedPayload {
                            shortcut,
                        }));
                    }
                    Ok(())
                })),
                &mut token,
            )
            .map_err(|error| format!("Failed to attach browser shortcuts: {error}"))?;
        Ok(())
    })
}

#[cfg(not(windows))]
pub(crate) fn attach_native_shortcuts(
    _webview: &NativeBrowserSurface,
    _emit: Arc<dyn Fn(BrowserEvent) + Send + Sync>,
) -> Result<(), String> {
    Ok(())
}

#[cfg(not(windows))]
pub(crate) fn dispatch_native_history(
    _webview: &NativeBrowserSurface,
    _action: NativeHistoryAction,
) -> Result<(), String> {
    Err("Windowed WebView2 BrowserHost requires Windows".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_actions_are_a_closed_named_set() {
        assert_ne!(NativeHistoryAction::Back, NativeHistoryAction::Forward);
        assert_ne!(NativeHistoryAction::Forward, NativeHistoryAction::Stop);
    }

    #[test]
    fn find_session_key_separates_surface_generations() {
        assert_ne!(
            native_find_surface_key("panel", "surface", 1),
            native_find_surface_key("panel", "surface", 2)
        );
    }
}
