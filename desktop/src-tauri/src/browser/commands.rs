use std::sync::Arc;

use tauri::{Webview, Wry};

use super::contract::{BrowserEvent, BrowserShortcut, ShortcutRequestedPayload};

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
    webview: &Webview<Wry>,
    action: NativeHistoryAction,
) -> tauri::Result<()> {
    webview.with_webview(move |platform| unsafe {
        let Ok(core) = platform.controller().CoreWebView2() else {
            return;
        };
        let _ = match action {
            NativeHistoryAction::Back => core.GoBack(),
            NativeHistoryAction::Forward => core.GoForward(),
            NativeHistoryAction::Stop => core.Stop(),
        };
    })
}

#[cfg(windows)]
pub(crate) fn set_native_zoom(webview: &Webview<Wry>, factor: f64) -> tauri::Result<()> {
    webview.with_webview(move |platform| unsafe {
        let _ = platform.controller().SetZoomFactor(factor);
    })
}

#[cfg(not(windows))]
pub(crate) fn set_native_zoom(_webview: &Webview<Wry>, _factor: f64) -> tauri::Result<()> {
    Err(tauri::Error::Anyhow(
        "DirectWebView2 BrowserHost requires Windows".into(),
    ))
}

#[cfg(windows)]
pub(crate) fn dispatch_native_find(
    webview: &Webview<Wry>,
    surface_key: String,
    query: String,
    match_case: bool,
    backwards: bool,
) -> tauri::Result<()> {
    use webview2_com::FindStartCompletedHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Environment15, ICoreWebView2_2, ICoreWebView2_28,
    };
    use windows_061::core::{Interface, HSTRING};

    webview.with_webview(move |platform| unsafe {
        FIND_SESSIONS.with(|sessions| {
            let mut sessions = sessions.borrow_mut();
            if let Some(session) = sessions.get(&surface_key) {
                if session.query == query && session.match_case == match_case {
                    let _ = if backwards {
                        session.find.FindPrevious()
                    } else {
                        session.find.FindNext()
                    };
                    return;
                }
            }

            if let Some(previous) = sessions.remove(&surface_key) {
                let _ = previous.find.Stop();
            }
            let Ok(core) = platform.controller().CoreWebView2() else {
                return;
            };
            let Ok(find) = core.cast::<ICoreWebView2_28>().and_then(|core| core.Find()) else {
                return;
            };
            let Ok(options) = core
                .cast::<ICoreWebView2_2>()
                .and_then(|core| core.Environment())
                .and_then(|environment| environment.cast::<ICoreWebView2Environment15>())
                .and_then(|environment| environment.CreateFindOptions())
            else {
                return;
            };
            let term = HSTRING::from(&query);
            if options.SetFindTerm(&term).is_err()
                || options.SetIsCaseSensitive(match_case).is_err()
                || options.SetShouldHighlightAllMatches(true).is_err()
                || options.SetShouldMatchWord(false).is_err()
                || options.SetSuppressDefaultFindDialog(true).is_err()
            {
                return;
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
        });
    })
}

#[cfg(not(windows))]
pub(crate) fn dispatch_native_find(
    _webview: &Webview<Wry>,
    _surface_key: String,
    _query: String,
    _match_case: bool,
    _backwards: bool,
) -> tauri::Result<()> {
    Err(tauri::Error::Anyhow(
        "DirectWebView2 BrowserHost requires Windows".into(),
    ))
}

#[cfg(windows)]
pub(crate) fn stop_native_find(webview: &Webview<Wry>, surface_key: String) -> tauri::Result<()> {
    webview.with_webview(move |_| {
        FIND_SESSIONS.with(|sessions| {
            if let Some(session) = sessions.borrow_mut().remove(&surface_key) {
                unsafe {
                    let _ = session.find.Stop();
                }
            }
        });
    })
}

#[cfg(not(windows))]
pub(crate) fn stop_native_find(_webview: &Webview<Wry>, _surface_key: String) -> tauri::Result<()> {
    Ok(())
}

pub(crate) fn native_find_surface_key(panel_id: &str, surface_id: &str, generation: u64) -> String {
    format!("{panel_id}\u{1f}{surface_id}\u{1f}{generation}")
}

#[cfg(windows)]
pub(crate) fn attach_native_shortcuts(
    webview: &Webview<Wry>,
    emit: Arc<dyn Fn(BrowserEvent) + Send + Sync>,
) -> tauri::Result<()> {
    use webview2_com::AcceleratorKeyPressedEventHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN, COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN,
    };
    use windows_061::Win32::UI::Input::KeyboardAndMouse::{GetKeyState, VK_CONTROL};

    webview.with_webview(move |platform| unsafe {
        let controller = platform.controller();
        let mut token = 0_i64;
        let _ = controller.add_AcceleratorKeyPressed(
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
        );
    })
}

#[cfg(not(windows))]
pub(crate) fn attach_native_shortcuts(
    _webview: &Webview<Wry>,
    _emit: Arc<dyn Fn(BrowserEvent) + Send + Sync>,
) -> tauri::Result<()> {
    Ok(())
}

#[cfg(not(windows))]
pub(crate) fn dispatch_native_history(
    _webview: &Webview<Wry>,
    _action: NativeHistoryAction,
) -> tauri::Result<()> {
    Err(tauri::Error::Anyhow(
        "DirectWebView2 BrowserHost requires Windows".into(),
    ))
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
