#[cfg(windows)]
use std::{ffi::OsStr, os::windows::ffi::OsStrExt, path::Path, sync::mpsc};

#[cfg(windows)]
use webview2_com::{
    CreateCoreWebView2ControllerCompletedHandler, CreateCoreWebView2EnvironmentCompletedHandler,
    Microsoft::Web::WebView2::Win32::{
        CreateCoreWebView2EnvironmentWithOptions, ICoreWebView2, ICoreWebView2Controller,
        ICoreWebView2Controller2, ICoreWebView2Environment, ICoreWebView2EnvironmentOptions,
        ICoreWebView2_13, COREWEBVIEW2_COLOR, COREWEBVIEW2_PREFERRED_COLOR_SCHEME_DARK,
        COREWEBVIEW2_PREFERRED_COLOR_SCHEME_LIGHT,
    },
};
#[cfg(windows)]
use windows_061::core::{Interface, HSTRING, PCWSTR};

#[cfg(windows)]
use super::{
    contract::{BrowserAppearanceTheme, BrowserRgbaColor},
    geometry::{BrowserGeometryFrame, BrowserPhysicalRect},
    window_host::BrowserWindowHost,
};

#[cfg(windows)]
pub(crate) struct WindowedBrowserSurface {
    pub(crate) surface_id: String,
    pub(crate) generation: u64,
    environment: ICoreWebView2Environment,
    controller: ICoreWebView2Controller,
    core: ICoreWebView2,
    window_host: BrowserWindowHost,
    applied_geometry_revision: u64,
    overlay_occlusions: Vec<BrowserPhysicalRect>,
}

#[cfg(windows)]
impl WindowedBrowserSurface {
    pub(crate) fn create(
        parent_hwnd: isize,
        surface_id: String,
        generation: u64,
        profile_directory: &Path,
        initial_url: &str,
        theme: BrowserAppearanceTheme,
        background_color: BrowserRgbaColor,
    ) -> Result<Self, String> {
        let environment = create_environment(profile_directory)?;
        let mut window_host = BrowserWindowHost::create(parent_hwnd)?;
        let controller = create_windowed_controller(&environment, window_host.hwnd())?;
        window_host.attach_controller(&controller)?;
        let core = unsafe { controller.CoreWebView2() }
            .map_err(|error| format!("Failed to acquire CoreWebView2: {error}"))?;

        set_webview_appearance(&controller, &core, theme, background_color)?;

        unsafe {
            controller
                .SetIsVisible(false)
                .map_err(|error| format!("Failed to hide initial WebView2 surface: {error}"))?;
            let url = wide(initial_url);
            core.Navigate(PCWSTR(url.as_ptr()))
                .map_err(|error| format!("Failed to navigate WebView2 surface: {error}"))?;
        }

        Ok(Self {
            surface_id,
            generation,
            environment,
            controller,
            core,
            window_host,
            applied_geometry_revision: 0,
            overlay_occlusions: Vec::new(),
        })
    }

    pub(crate) fn apply_geometry(&mut self, frame: &BrowserGeometryFrame) -> Result<bool, String> {
        if frame.generation != self.generation || frame.revision <= self.applied_geometry_revision {
            return Ok(false);
        }
        let occlusions = frame.physical_occlusions();
        self.apply_physical_geometry(frame.physical_rect(), frame.visible, &occlusions)?;
        self.overlay_occlusions = occlusions;
        self.applied_geometry_revision = frame.revision;
        Ok(true)
    }

    pub(crate) fn apply_interactive_geometry(
        &self,
        rect: BrowserPhysicalRect,
        visible: bool,
    ) -> Result<(), String> {
        self.apply_physical_geometry(rect, visible, &self.overlay_occlusions)
    }

    fn apply_physical_geometry(
        &self,
        rect: BrowserPhysicalRect,
        visible: bool,
        occlusions: &[BrowserPhysicalRect],
    ) -> Result<(), String> {
        // BrowserWindowHost turns this SetWindowPos into WM_SIZE, and WM_SIZE
        // synchronously updates controller.Bounds before returning.
        self.window_host.apply_geometry(rect, visible, occlusions)?;
        unsafe { self.controller.NotifyParentWindowPositionChanged() }
            .map_err(|error| format!("Failed to notify WebView2 parent geometry: {error}"))?;
        unsafe {
            self.controller
                .SetIsVisible(visible && rect.width > 0 && rect.height > 0)
        }
        .map_err(|error| format!("Failed to update windowed WebView2 visibility: {error}"))
    }

    pub(crate) fn navigate(&self, url: &str) -> Result<(), String> {
        let url = wide(url);
        unsafe { self.core.Navigate(PCWSTR(url.as_ptr())) }
            .map_err(|error| format!("Failed to navigate WebView2 surface: {error}"))
    }

    pub(crate) fn set_appearance(
        &self,
        theme: BrowserAppearanceTheme,
        background_color: BrowserRgbaColor,
    ) -> Result<(), String> {
        set_webview_appearance(&self.controller, &self.core, theme, background_color)
    }

    pub(crate) fn reload(&self) -> Result<(), String> {
        unsafe { self.core.Reload() }
            .map_err(|error| format!("Failed to reload WebView2 surface: {error}"))
    }

    pub(crate) fn set_visible(&self, visible: bool) -> Result<(), String> {
        if !visible {
            self.window_host.apply_geometry(
                BrowserPhysicalRect {
                    left: 0,
                    top: 0,
                    width: 0,
                    height: 0,
                },
                false,
                &[],
            )?;
        }
        unsafe { self.controller.SetIsVisible(visible) }
            .map_err(|error| format!("Failed to update WebView2 visibility: {error}"))
    }

    pub(crate) fn focus(&self) -> Result<(), String> {
        use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC;
        self.window_host.focus();
        unsafe {
            self.controller
                .MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC)
        }
        .map_err(|error| format!("Failed to focus WebView2 surface: {error}"))
    }

    pub(crate) fn install_document_script(&self, script: String) -> Result<(), String> {
        use webview2_com::AddScriptToExecuteOnDocumentCreatedCompletedHandler;

        let core = self.core.clone();
        AddScriptToExecuteOnDocumentCreatedCompletedHandler::wait_for_async_operation(
            Box::new(move |handler| unsafe {
                core.AddScriptToExecuteOnDocumentCreated(&HSTRING::from(script), &handler)
                    .map_err(webview2_com::Error::WindowsError)
            }),
            Box::new(|status, _script_id| {
                status?;
                Ok(())
            }),
        )
        .map_err(|error| format!("Failed to install browser document script: {error}"))
    }

    pub(crate) fn close(self) -> Result<(), String> {
        unsafe {
            self.controller
                .Close()
                .map_err(|error| format!("Failed to close WebView2 surface: {error}"))
        }
    }

    pub(crate) fn core(&self) -> &ICoreWebView2 {
        &self.core
    }

    pub(crate) fn controller(&self) -> &ICoreWebView2Controller {
        &self.controller
    }

    pub(crate) fn environment(&self) -> &ICoreWebView2Environment {
        &self.environment
    }
}

#[cfg(windows)]
fn set_webview_appearance(
    controller: &ICoreWebView2Controller,
    core: &ICoreWebView2,
    theme: BrowserAppearanceTheme,
    background_color: BrowserRgbaColor,
) -> Result<(), String> {
    unsafe {
        let controller2: ICoreWebView2Controller2 = controller.cast().map_err(|error| {
            format!("Failed to acquire WebView2 background controller: {error}")
        })?;
        controller2
            .SetDefaultBackgroundColor(COREWEBVIEW2_COLOR {
                R: background_color.red,
                G: background_color.green,
                B: background_color.blue,
                A: background_color.alpha,
            })
            .map_err(|error| format!("Failed to set WebView2 background color: {error}"))?;

        let profile = core
            .cast::<ICoreWebView2_13>()
            .and_then(|webview| webview.Profile())
            .map_err(|error| format!("Failed to acquire WebView2 profile: {error}"))?;
        profile
            .SetPreferredColorScheme(match theme {
                BrowserAppearanceTheme::Light => COREWEBVIEW2_PREFERRED_COLOR_SCHEME_LIGHT,
                BrowserAppearanceTheme::Dark => COREWEBVIEW2_PREFERRED_COLOR_SCHEME_DARK,
            })
            .map_err(|error| format!("Failed to set WebView2 preferred color scheme: {error}"))
    }
}

#[cfg(windows)]
fn create_environment(profile_directory: &Path) -> Result<ICoreWebView2Environment, String> {
    let profile = wide(profile_directory.as_os_str());
    let (tx, rx) = mpsc::channel();
    CreateCoreWebView2EnvironmentCompletedHandler::wait_for_async_operation(
        Box::new(move |handler| unsafe {
            CreateCoreWebView2EnvironmentWithOptions(
                PCWSTR::null(),
                PCWSTR(profile.as_ptr()),
                None::<&ICoreWebView2EnvironmentOptions>,
                &handler,
            )
            .map_err(webview2_com::Error::WindowsError)
        }),
        Box::new(move |error, environment| {
            error?;
            let _ = tx.send(environment);
            Ok(())
        }),
    )
    .map_err(|error| format!("Failed to create WebView2 environment: {error}"))?;
    rx.recv()
        .map_err(|_| "WebView2 environment callback was dropped".to_string())?
        .ok_or_else(|| "WebView2 environment callback returned no environment".to_string())
}

#[cfg(windows)]
fn create_windowed_controller(
    environment: &ICoreWebView2Environment,
    parent_hwnd: isize,
) -> Result<ICoreWebView2Controller, String> {
    use std::ffi::c_void;
    use windows_061::Win32::Foundation::HWND;

    let (tx, rx) = mpsc::channel();
    let hwnd = HWND(parent_hwnd as *mut c_void);
    let environment = environment.clone();
    CreateCoreWebView2ControllerCompletedHandler::wait_for_async_operation(
        Box::new(move |handler| unsafe {
            environment
                .CreateCoreWebView2Controller(hwnd, &handler)
                .map_err(webview2_com::Error::WindowsError)
        }),
        Box::new(move |error, controller| {
            error?;
            let _ = tx.send(controller);
            Ok(())
        }),
    )
    .map_err(|error| format!("Failed to create windowed WebView2 controller: {error}"))?;
    rx.recv()
        .map_err(|_| "WebView2 controller callback was dropped".to_string())?
        .ok_or_else(|| "WebView2 controller callback returned no controller".to_string())
}

#[cfg(windows)]
fn wide(value: impl AsRef<OsStr>) -> Vec<u16> {
    value.as_ref().encode_wide().chain(Some(0)).collect()
}

#[cfg(not(windows))]
pub(crate) struct WindowedBrowserSurface;
