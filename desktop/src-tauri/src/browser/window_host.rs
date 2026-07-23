#[cfg(windows)]
use std::{ffi::c_void, mem::size_of, sync::OnceLock};

#[cfg(windows)]
use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller;
#[cfg(windows)]
use windows_061::{
    core::{w, Free, PCWSTR},
    Win32::{
        Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, RECT, WPARAM},
        Graphics::Gdi::{CombineRgn, CreateRectRgn, SetWindowRgn, RGN_DIFF},
        System::LibraryLoader::GetModuleHandleW,
        UI::{
            Input::KeyboardAndMouse::SetFocus,
            WindowsAndMessaging::{
                CreateWindowExW, DefWindowProcW, DestroyWindow, GetClientRect, GetWindowLongPtrW,
                RegisterClassExW, SetWindowLongPtrW, SetWindowPos, ShowWindow, CREATESTRUCTW,
                CS_DBLCLKS, GWLP_USERDATA, HWND_TOP, SWP_NOACTIVATE, SWP_NOOWNERZORDER, SW_HIDE,
                SW_SHOWNA, WM_NCCREATE, WM_NCDESTROY, WM_SIZE, WNDCLASSEXW, WS_CHILD,
                WS_CLIPCHILDREN, WS_CLIPSIBLINGS,
            },
        },
    },
};

#[cfg(windows)]
use super::geometry::BrowserPhysicalRect;

#[cfg(windows)]
const BROWSER_WINDOW_CLASS: PCWSTR = w!("KeydexBrowserWindowHost");

#[cfg(windows)]
struct WindowContext {
    controller: Option<ICoreWebView2Controller>,
}

#[cfg(windows)]
pub(crate) struct BrowserWindowHost {
    hwnd: HWND,
    context: Box<WindowContext>,
}

#[cfg(windows)]
impl BrowserWindowHost {
    pub(crate) fn create(parent_hwnd: isize) -> Result<Self, String> {
        register_window_class()?;
        let mut context = Box::new(WindowContext { controller: None });
        let parent = HWND(parent_hwnd as *mut c_void);
        let instance = module_instance()?;
        let hwnd = unsafe {
            CreateWindowExW(
                Default::default(),
                BROWSER_WINDOW_CLASS,
                w!(""),
                WS_CHILD | WS_CLIPCHILDREN | WS_CLIPSIBLINGS,
                0,
                0,
                1,
                1,
                Some(parent),
                None,
                Some(instance),
                Some((&mut *context as *mut WindowContext).cast()),
            )
        }
        .map_err(|error| format!("Failed to create browser window host: {error}"))?;
        Ok(Self { hwnd, context })
    }

    pub(crate) fn hwnd(&self) -> isize {
        self.hwnd.0 as isize
    }

    pub(crate) fn attach_controller(
        &mut self,
        controller: &ICoreWebView2Controller,
    ) -> Result<(), String> {
        self.context.controller = Some(controller.clone());
        resize_controller(self.hwnd, &self.context)
    }

    pub(crate) fn apply_geometry(
        &self,
        rect: BrowserPhysicalRect,
        visible: bool,
        occlusions: &[BrowserPhysicalRect],
    ) -> Result<(), String> {
        unsafe {
            // SetWindowPos synchronously emits WM_SIZE on this actor thread.
            // The window procedure updates WebView2.Bounds from that native
            // size event, so browser layout and the host edge share one clock.
            SetWindowPos(
                self.hwnd,
                Some(HWND_TOP),
                rect.left,
                rect.top,
                rect.width.max(1),
                rect.height.max(1),
                SWP_NOACTIVATE | SWP_NOOWNERZORDER,
            )
            .map_err(|error| format!("Failed to position browser window host: {error}"))?;
            apply_window_occlusions(self.hwnd, rect.width.max(1), rect.height.max(1), occlusions)?;
            let _ = ShowWindow(
                self.hwnd,
                if visible && rect.width > 0 && rect.height > 0 {
                    SW_SHOWNA
                } else {
                    SW_HIDE
                },
            );
        }
        Ok(())
    }

    pub(crate) fn focus(&self) {
        unsafe {
            let _ = SetFocus(Some(self.hwnd));
        }
    }

    pub(crate) fn set_visible(&self, visible: bool) {
        unsafe {
            let _ = ShowWindow(self.hwnd, if visible { SW_SHOWNA } else { SW_HIDE });
        }
    }
}

#[cfg(windows)]
unsafe fn apply_window_occlusions(
    hwnd: HWND,
    width: i32,
    height: i32,
    occlusions: &[BrowserPhysicalRect],
) -> Result<(), String> {
    if occlusions.is_empty() {
        if unsafe { SetWindowRgn(hwnd, None, true) } == 0 {
            return Err(format!(
                "Failed to clear browser overlay clipping: {}",
                windows_061::core::Error::from_win32()
            ));
        }
        return Ok(());
    }

    let mut visible_region = unsafe { CreateRectRgn(0, 0, width, height) };
    if visible_region.is_invalid() {
        return Err("Failed to allocate browser visible region".to_string());
    }
    for rect in occlusions {
        let left = rect.left.clamp(0, width);
        let top = rect.top.clamp(0, height);
        let right = rect.left.saturating_add(rect.width).clamp(0, width);
        let bottom = rect.top.saturating_add(rect.height).clamp(0, height);
        if right <= left || bottom <= top {
            continue;
        }
        let mut cutout = unsafe { CreateRectRgn(left, top, right, bottom) };
        if cutout.is_invalid() {
            unsafe { visible_region.free() };
            return Err("Failed to allocate browser overlay cutout".to_string());
        }
        unsafe {
            CombineRgn(
                Some(visible_region),
                Some(visible_region),
                Some(cutout),
                RGN_DIFF,
            );
            cutout.free();
        }
    }

    if unsafe { SetWindowRgn(hwnd, Some(visible_region), true) } == 0 {
        unsafe { visible_region.free() };
        return Err(format!(
            "Failed to apply browser overlay clipping: {}",
            windows_061::core::Error::from_win32()
        ));
    }
    Ok(())
}

#[cfg(windows)]
impl Drop for BrowserWindowHost {
    fn drop(&mut self) {
        unsafe {
            let _ = DestroyWindow(self.hwnd);
        }
    }
}

#[cfg(windows)]
fn register_window_class() -> Result<(), String> {
    static REGISTRATION: OnceLock<Result<(), String>> = OnceLock::new();
    REGISTRATION
        .get_or_init(|| {
            let instance = module_instance()?;
            let class = WNDCLASSEXW {
                cbSize: size_of::<WNDCLASSEXW>() as u32,
                style: CS_DBLCLKS,
                lpfnWndProc: Some(browser_window_proc),
                hInstance: instance,
                lpszClassName: BROWSER_WINDOW_CLASS,
                ..Default::default()
            };
            let atom = unsafe { RegisterClassExW(&class) };
            if atom == 0 {
                return Err(format!(
                    "Failed to register browser window host class: {}",
                    windows_061::core::Error::from_win32()
                ));
            }
            Ok(())
        })
        .clone()
}

#[cfg(windows)]
fn module_instance() -> Result<HINSTANCE, String> {
    unsafe { GetModuleHandleW(None) }
        .map(|module| HINSTANCE(module.0))
        .map_err(|error| format!("Failed to resolve application module: {error}"))
}

#[cfg(windows)]
fn resize_controller(hwnd: HWND, context: &WindowContext) -> Result<(), String> {
    let Some(controller) = &context.controller else {
        return Ok(());
    };
    let mut bounds = RECT::default();
    unsafe { GetClientRect(hwnd, &mut bounds) }
        .map_err(|error| format!("Failed to read browser host bounds: {error}"))?;
    bounds.right = bounds.right.max(1);
    bounds.bottom = bounds.bottom.max(1);
    unsafe { controller.SetBounds(bounds) }
        .map_err(|error| format!("Failed to resize windowed WebView2: {error}"))
}

#[cfg(windows)]
unsafe extern "system" fn browser_window_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if message == WM_NCCREATE {
        let create = lparam.0 as *const CREATESTRUCTW;
        if !create.is_null() {
            let context = unsafe { (*create).lpCreateParams as *mut WindowContext };
            unsafe { SetWindowLongPtrW(hwnd, GWLP_USERDATA, context as isize) };
        }
    }

    let context = unsafe { GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut WindowContext };
    if !context.is_null() && message == WM_SIZE {
        let _ = resize_controller(hwnd, unsafe { &*context });
    }
    if message == WM_NCDESTROY {
        unsafe { SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0) };
    }
    unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
}

#[cfg(not(windows))]
pub(crate) struct BrowserWindowHost;
