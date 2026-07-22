#[cfg(windows)]
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{mpsc, Arc},
    thread,
};

#[cfg(windows)]
use windows_061::Win32::{
    Foundation::{LPARAM, POINT, WPARAM},
    System::{
        Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED},
        Threading::GetCurrentThreadId,
    },
    UI::{
        Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON},
        WindowsAndMessaging::{
            DispatchMessageW, GetCursorPos, GetMessageW, KillTimer, PeekMessageW,
            PostThreadMessageW, SetTimer, TranslateMessage, MSG, PM_NOREMOVE, WM_APP, WM_TIMER,
        },
    },
};

#[cfg(windows)]
use super::{
    contract::{BrowserAppearanceTheme, BrowserRgbaColor},
    geometry::{
        interactive_resize_rect, BrowserGeometryFrame, GeometryMailbox,
        NativeInteractiveResizeRequest,
    },
    windowed_surface::WindowedBrowserSurface,
};

#[cfg(windows)]
const WM_KEYDEX_BROWSER_WAKE: u32 = WM_APP + 0x3B1;
#[cfg(windows)]
const INTERACTIVE_RESIZE_TIMER_ID: usize = 0x4B_52_53;
#[cfg(windows)]
const INTERACTIVE_RESIZE_INTERVAL_MS: u32 = 8;

#[cfg(windows)]
struct ActiveInteractiveResize {
    request: NativeInteractiveResizeRequest,
    last_delta: Option<i32>,
}

#[cfg(windows)]
pub(crate) enum BrowserUiCommand {
    CreateSurface {
        surface_id: String,
        generation: u64,
        profile_directory: PathBuf,
        initial_url: String,
        theme: BrowserAppearanceTheme,
        background_color: BrowserRgbaColor,
        response: mpsc::Sender<Result<(), String>>,
    },
    Navigate {
        surface_id: String,
        generation: u64,
        url: String,
        response: mpsc::Sender<Result<(), String>>,
    },
    DestroySurface {
        surface_id: String,
        generation: u64,
        response: mpsc::Sender<Result<(), String>>,
    },
    RunSurface {
        surface_id: String,
        generation: u64,
        task: Box<dyn BrowserSurfaceTask>,
    },
    BeginInteractiveResize {
        request: NativeInteractiveResizeRequest,
        response: mpsc::Sender<Result<(), String>>,
    },
    EndInteractiveResize {
        session_id: u64,
        final_frames: Vec<BrowserGeometryFrame>,
        response: mpsc::Sender<Result<(), String>>,
    },
    Shutdown,
}

#[cfg(windows)]
pub(crate) trait BrowserSurfaceTask: Send {
    fn run(self: Box<Self>, surface: Result<&mut WindowedBrowserSurface, String>);
}

#[cfg(windows)]
struct TypedBrowserSurfaceTask<F, R>
where
    F: FnOnce(&mut WindowedBrowserSurface) -> Result<R, String> + Send + 'static,
    R: Send + 'static,
{
    operation: F,
    response: mpsc::Sender<Result<R, String>>,
}

#[cfg(windows)]
impl<F, R> BrowserSurfaceTask for TypedBrowserSurfaceTask<F, R>
where
    F: FnOnce(&mut WindowedBrowserSurface) -> Result<R, String> + Send + 'static,
    R: Send + 'static,
{
    fn run(self: Box<Self>, surface: Result<&mut WindowedBrowserSurface, String>) {
        let result = surface.and_then(self.operation);
        let _ = self.response.send(result);
    }
}

#[cfg(windows)]
#[derive(Clone)]
pub(crate) struct BrowserUiActorHandle {
    command_tx: mpsc::Sender<BrowserUiCommand>,
    geometry: Arc<GeometryMailbox>,
    thread_id: u32,
}

#[cfg(windows)]
impl BrowserUiActorHandle {
    pub(crate) fn start(parent_hwnd: isize) -> Result<Self, String> {
        let (command_tx, command_rx) = mpsc::channel();
        let geometry = GeometryMailbox::shared();
        let actor_geometry = geometry.clone();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        thread::Builder::new()
            .name("keydex-browser-ui".to_string())
            .spawn(move || run_actor(parent_hwnd, command_rx, actor_geometry, ready_tx))
            .map_err(|error| format!("Failed to spawn browser UI actor: {error}"))?;
        let thread_id = ready_rx
            .recv()
            .map_err(|_| "Browser UI actor exited during startup".to_string())??;
        Ok(Self {
            command_tx,
            geometry,
            thread_id,
        })
    }

    pub(crate) fn send(&self, command: BrowserUiCommand) -> Result<(), String> {
        self.command_tx
            .send(command)
            .map_err(|_| "Browser UI actor is unavailable".to_string())?;
        self.wake()
    }

    pub(crate) fn create_surface(
        &self,
        surface_id: String,
        generation: u64,
        profile_directory: PathBuf,
        initial_url: String,
        theme: BrowserAppearanceTheme,
        background_color: BrowserRgbaColor,
    ) -> Result<NativeBrowserSurface, String> {
        let (response, result) = mpsc::channel();
        self.send(BrowserUiCommand::CreateSurface {
            surface_id: surface_id.clone(),
            generation,
            profile_directory,
            initial_url,
            theme,
            background_color,
            response,
        })?;
        result
            .recv()
            .map_err(|_| "Browser surface creation callback was dropped".to_string())??;
        Ok(NativeBrowserSurface {
            surface_id,
            generation,
            actor: self.clone(),
        })
    }

    pub(crate) fn publish_geometry(&self, frame: BrowserGeometryFrame) -> Result<bool, String> {
        let published = self.geometry.publish(frame);
        if published {
            self.wake()?;
        }
        Ok(published)
    }

    pub(crate) fn shutdown(&self) -> Result<(), String> {
        self.send(BrowserUiCommand::Shutdown)
    }

    pub(crate) fn begin_interactive_resize(
        &self,
        request: NativeInteractiveResizeRequest,
    ) -> Result<(), String> {
        let (response, result) = mpsc::channel();
        self.send(BrowserUiCommand::BeginInteractiveResize { request, response })?;
        result
            .recv()
            .map_err(|_| "Browser resize start callback was dropped".to_string())?
    }

    pub(crate) fn end_interactive_resize(
        &self,
        session_id: u64,
        final_frames: Vec<BrowserGeometryFrame>,
    ) -> Result<(), String> {
        let (response, result) = mpsc::channel();
        self.send(BrowserUiCommand::EndInteractiveResize {
            session_id,
            final_frames,
            response,
        })?;
        result
            .recv()
            .map_err(|_| "Browser resize end callback was dropped".to_string())?
    }

    fn wake(&self) -> Result<(), String> {
        unsafe { PostThreadMessageW(self.thread_id, WM_KEYDEX_BROWSER_WAKE, WPARAM(0), LPARAM(0)) }
            .map_err(|error| format!("Failed to wake browser UI actor: {error}"))
    }
}

#[cfg(windows)]
#[derive(Clone)]
pub(crate) struct NativeBrowserSurface {
    surface_id: String,
    generation: u64,
    actor: BrowserUiActorHandle,
}

#[cfg(windows)]
impl std::fmt::Debug for NativeBrowserSurface {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("NativeBrowserSurface")
            .field("surface_id", &self.surface_id)
            .field("generation", &self.generation)
            .finish_non_exhaustive()
    }
}

#[cfg(windows)]
impl NativeBrowserSurface {
    pub(crate) fn surface_id(&self) -> &str {
        &self.surface_id
    }

    pub(crate) fn generation(&self) -> u64 {
        self.generation
    }

    pub(crate) fn run<R, F>(&self, operation: F) -> Result<R, String>
    where
        F: FnOnce(&mut WindowedBrowserSurface) -> Result<R, String> + Send + 'static,
        R: Send + 'static,
    {
        let (response, result) = mpsc::channel();
        self.actor.send(BrowserUiCommand::RunSurface {
            surface_id: self.surface_id.clone(),
            generation: self.generation,
            task: Box::new(TypedBrowserSurfaceTask {
                operation,
                response,
            }),
        })?;
        result
            .recv()
            .map_err(|_| "Browser surface task callback was dropped".to_string())?
    }

    pub(crate) fn publish_geometry(&self, frame: BrowserGeometryFrame) -> Result<bool, String> {
        if frame.surface_id != self.surface_id || frame.generation != self.generation {
            return Err("Browser geometry targets a different surface generation".to_string());
        }
        self.actor.publish_geometry(frame)
    }

    pub(crate) fn destroy(&self) -> Result<(), String> {
        let (response, result) = mpsc::channel();
        self.actor.send(BrowserUiCommand::DestroySurface {
            surface_id: self.surface_id.clone(),
            generation: self.generation,
            response,
        })?;
        result
            .recv()
            .map_err(|_| "Browser surface destroy callback was dropped".to_string())?
    }

    pub(crate) fn begin_interactive_resize(
        &self,
        request: NativeInteractiveResizeRequest,
    ) -> Result<(), String> {
        self.actor.begin_interactive_resize(request)
    }

    pub(crate) fn end_interactive_resize(
        &self,
        session_id: u64,
        final_frames: Vec<BrowserGeometryFrame>,
    ) -> Result<(), String> {
        self.actor.end_interactive_resize(session_id, final_frames)
    }
}

#[cfg(windows)]
fn run_actor(
    parent_hwnd: isize,
    command_rx: mpsc::Receiver<BrowserUiCommand>,
    geometry: Arc<GeometryMailbox>,
    ready_tx: mpsc::SyncSender<Result<u32, String>>,
) {
    let initialized = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
    if let Err(error) = initialized.ok() {
        let _ = ready_tx.send(Err(format!(
            "Failed to initialize browser COM apartment: {error}"
        )));
        return;
    }

    // Force creation of the thread message queue before publishing thread_id;
    // otherwise an early PostThreadMessageW can be lost.
    let mut message = MSG::default();
    unsafe {
        let _ = PeekMessageW(&mut message, None, 0, 0, PM_NOREMOVE);
    }
    let thread_id = unsafe { GetCurrentThreadId() };
    if ready_tx.send(Ok(thread_id)).is_err() {
        unsafe { CoUninitialize() };
        return;
    }

    let mut surfaces = HashMap::<String, WindowedBrowserSurface>::new();
    let mut interactive_resize: Option<ActiveInteractiveResize> = None;
    let mut interactive_resize_timer_id: Option<usize> = None;
    let mut interactive_resize_epoch = 0_u64;
    let mut running = true;
    while running {
        let result = unsafe { GetMessageW(&mut message, None, 0, 0) };
        if result.0 <= 0 {
            break;
        }
        if message.message == WM_KEYDEX_BROWSER_WAKE {
            while let Ok(command) = command_rx.try_recv() {
                running = apply_command(
                    command,
                    parent_hwnd,
                    &mut surfaces,
                    &mut interactive_resize,
                    &mut interactive_resize_timer_id,
                    &mut interactive_resize_epoch,
                );
                if !running {
                    break;
                }
            }
            apply_latest_geometry(&mut surfaces, &geometry);
            continue;
        }
        if message.message == WM_TIMER
            && interactive_resize_timer_id.is_some_and(|timer_id| message.wParam.0 == timer_id)
        {
            if !left_mouse_button_pressed() {
                if let Some(mut resize) = interactive_resize.take() {
                    let _ = apply_interactive_resize(&mut surfaces, &mut resize);
                    let _ = settle_interactive_resize(&mut surfaces, &resize);
                }
                stop_interactive_resize_timer(&mut interactive_resize_timer_id);
                continue;
            }
            if let Some(resize) = interactive_resize.as_mut() {
                let _ = apply_interactive_resize(&mut surfaces, resize);
            }
            continue;
        }
        unsafe {
            let _ = TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }

    for (_, surface) in surfaces.drain() {
        let _ = surface.close();
    }
    stop_interactive_resize_timer(&mut interactive_resize_timer_id);
    unsafe { CoUninitialize() };
}

#[cfg(windows)]
fn apply_command(
    command: BrowserUiCommand,
    parent_hwnd: isize,
    surfaces: &mut HashMap<String, WindowedBrowserSurface>,
    interactive_resize: &mut Option<ActiveInteractiveResize>,
    interactive_resize_timer_id: &mut Option<usize>,
    interactive_resize_epoch: &mut u64,
) -> bool {
    match command {
        BrowserUiCommand::CreateSurface {
            surface_id,
            generation,
            profile_directory,
            initial_url,
            theme,
            background_color,
            response,
        } => {
            if let Some(existing) = surfaces.remove(&surface_id) {
                let _ = existing.close();
            }
            let result = WindowedBrowserSurface::create(
                parent_hwnd,
                surface_id.clone(),
                generation,
                &profile_directory,
                &initial_url,
                theme,
                background_color,
            )
            .map(|surface| {
                surfaces.insert(surface_id, surface);
            });
            let _ = response.send(result);
            true
        }
        BrowserUiCommand::Navigate {
            surface_id,
            generation,
            url,
            response,
        } => {
            let result = exact_surface_mut(surfaces, &surface_id, generation)
                .and_then(|surface| surface.navigate(&url));
            let _ = response.send(result);
            true
        }
        BrowserUiCommand::DestroySurface {
            surface_id,
            generation,
            response,
        } => {
            let result = match surfaces.get(&surface_id) {
                Some(surface) if surface.generation != generation => Err(format!(
                    "Stale browser surface generation: requested {generation}, current {}",
                    surface.generation
                )),
                Some(_) => surfaces
                    .remove(&surface_id)
                    .expect("surface checked above")
                    .close(),
                None => Ok(()),
            };
            let _ = response.send(result);
            true
        }
        BrowserUiCommand::RunSurface {
            surface_id,
            generation,
            task,
        } => {
            task.run(exact_surface_mut(surfaces, &surface_id, generation));
            true
        }
        BrowserUiCommand::BeginInteractiveResize { request, response } => {
            let result = if request.session_id <= *interactive_resize_epoch {
                Ok(())
            } else {
                *interactive_resize_epoch = request.session_id;
                stop_interactive_resize_timer(interactive_resize_timer_id);
                start_interactive_resize_timer().and_then(|timer_id| {
                    let mut resize = ActiveInteractiveResize {
                        request,
                        last_delta: None,
                    };
                    let result = apply_interactive_resize(surfaces, &mut resize);
                    if result.is_ok() {
                        *interactive_resize_timer_id = Some(timer_id);
                        *interactive_resize = Some(resize);
                    } else {
                        let mut timer = Some(timer_id);
                        stop_interactive_resize_timer(&mut timer);
                    }
                    result
                })
            };
            let _ = response.send(result);
            true
        }
        BrowserUiCommand::EndInteractiveResize {
            session_id,
            final_frames,
            response,
        } => {
            let result = if session_id < *interactive_resize_epoch {
                Ok(())
            } else {
                *interactive_resize_epoch = session_id;
                if interactive_resize
                    .as_ref()
                    .is_some_and(|resize| resize.request.session_id == session_id)
                {
                    stop_interactive_resize_timer(interactive_resize_timer_id);
                    *interactive_resize = None;
                }
                apply_geometry_frames(surfaces, final_frames)
            };
            let _ = response.send(result);
            true
        }
        BrowserUiCommand::Shutdown => {
            stop_interactive_resize_timer(interactive_resize_timer_id);
            *interactive_resize = None;
            false
        }
    }
}

#[cfg(windows)]
fn apply_latest_geometry(
    surfaces: &mut HashMap<String, WindowedBrowserSurface>,
    geometry: &GeometryMailbox,
) {
    let _ = apply_geometry_frames(surfaces, geometry.drain_latest());
}

#[cfg(windows)]
fn apply_geometry_frames(
    surfaces: &mut HashMap<String, WindowedBrowserSurface>,
    frames: Vec<BrowserGeometryFrame>,
) -> Result<(), String> {
    for frame in frames {
        let Some(surface) = surfaces.get_mut(&frame.surface_id) else {
            continue;
        };
        surface.apply_geometry(&frame)?;
    }
    Ok(())
}

#[cfg(windows)]
fn apply_interactive_resize(
    surfaces: &mut HashMap<String, WindowedBrowserSurface>,
    resize: &mut ActiveInteractiveResize,
) -> Result<(), String> {
    let request = &resize.request;
    let mut cursor = POINT::default();
    unsafe { GetCursorPos(&mut cursor) }
        .map_err(|error| format!("Failed to sample resize pointer: {error}"))?;
    let delta = cursor
        .x
        .saturating_sub(request.start_screen_x)
        .clamp(request.min_delta, request.max_delta);
    if resize.last_delta == Some(delta) {
        return Ok(());
    }
    for baseline in &request.surfaces {
        let Some(surface) = surfaces.get_mut(&baseline.surface_id) else {
            continue;
        };
        if surface.generation != baseline.generation {
            continue;
        }
        surface.apply_interactive_geometry(
            interactive_resize_rect(baseline.baseline, request.placement, delta),
            baseline.visible,
        )?;
    }
    resize.last_delta = Some(delta);
    Ok(())
}

#[cfg(windows)]
fn settle_interactive_resize(
    surfaces: &mut HashMap<String, WindowedBrowserSurface>,
    resize: &ActiveInteractiveResize,
) -> Result<(), String> {
    let request = &resize.request;
    let delta = resize.last_delta.unwrap_or(0);
    for baseline in &request.surfaces {
        let Some(surface) = surfaces.get_mut(&baseline.surface_id) else {
            continue;
        };
        if surface.generation != baseline.generation {
            continue;
        }
        surface.apply_interactive_geometry(
            interactive_resize_rect(baseline.baseline, request.placement, delta),
            baseline.visible,
        )?;
    }
    Ok(())
}

#[cfg(windows)]
fn start_interactive_resize_timer() -> Result<usize, String> {
    let timer = unsafe {
        SetTimer(
            None,
            INTERACTIVE_RESIZE_TIMER_ID,
            INTERACTIVE_RESIZE_INTERVAL_MS,
            None,
        )
    };
    if timer == 0 {
        Err(format!(
            "Failed to start browser resize timer: {}",
            windows_061::core::Error::from_win32()
        ))
    } else {
        // With a thread timer (hWnd == NULL), Windows may replace the requested
        // identifier. WM_TIMER carries this returned identifier in wParam.
        Ok(timer)
    }
}

#[cfg(windows)]
fn stop_interactive_resize_timer(timer_id: &mut Option<usize>) {
    if let Some(timer_id) = timer_id.take() {
        unsafe {
            let _ = KillTimer(None, timer_id);
        }
    }
}

#[cfg(windows)]
fn left_mouse_button_pressed() -> bool {
    unsafe { (GetAsyncKeyState(VK_LBUTTON.0 as i32) as u16 & 0x8000) != 0 }
}

#[cfg(windows)]
fn exact_surface_mut<'a>(
    surfaces: &'a mut HashMap<String, WindowedBrowserSurface>,
    surface_id: &str,
    generation: u64,
) -> Result<&'a mut WindowedBrowserSurface, String> {
    let surface = surfaces
        .get_mut(surface_id)
        .ok_or_else(|| "Browser surface is unavailable".to_string())?;
    if surface.generation != generation {
        return Err(format!(
            "Stale browser surface generation: requested {generation}, current {}",
            surface.generation
        ));
    }
    Ok(surface)
}

#[cfg(not(windows))]
#[derive(Clone)]
pub(crate) struct BrowserUiActorHandle;

#[cfg(not(windows))]
#[derive(Clone, Debug)]
pub(crate) struct NativeBrowserSurface;
