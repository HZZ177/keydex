use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::AsRawHandle;
use std::process::{Child, Command, ExitStatus};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    OnceLock,
};

use uuid::Uuid;
use windows::core::PCWSTR;
#[cfg(test)]
use windows::Win32::Foundation::WAIT_FAILED;
use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, OpenJobObjectW,
    SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK,
};
#[cfg(test)]
use windows::Win32::System::JobObjects::{IsProcessInJob, QueryInformationJobObject};
use windows::Win32::System::SystemServices::JOB_OBJECT_SET_ATTRIBUTES;
use windows::Win32::System::Threading::{
    CreateEventW, OpenEventW, SetEvent, TerminateProcess, WaitForMultipleObjects,
    WaitForSingleObject, EVENT_MODIFY_STATE, INFINITE, SYNCHRONIZATION_ACCESS_RIGHTS,
};
#[cfg(test)]
use windows::Win32::System::Threading::{
    OpenProcess, PROCESS_ACCESS_RIGHTS, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE,
};

const SUPERVISED_CHILD_ENV: &str = "KEYDEX_SUPERVISED_CHILD";
const SUPERVISOR_JOB_ENV: &str = "KEYDEX_SUPERVISOR_JOB";
const SUPERVISOR_READY_EVENT_ENV: &str = "KEYDEX_SUPERVISOR_READY_EVENT";
const SUPERVISOR_EXIT_EVENT_ENV: &str = "KEYDEX_SUPERVISOR_EXIT_EVENT";
const SUPERVISOR_RESTART_EVENT_ENV: &str = "KEYDEX_SUPERVISOR_RESTART_EVENT";
const SYNCHRONIZE_ACCESS: SYNCHRONIZATION_ACCESS_RIGHTS =
    SYNCHRONIZATION_ACCESS_RIGHTS(0x0010_0000);
const CHILD_READY_TIMEOUT_MS: u32 = 10_000;
const GRACEFUL_EXIT_TIMEOUT_MS: u32 = 3_000;
const FORCE_EXIT_TIMEOUT_MS: u32 = 1_000;
const FORCED_EXIT_CODE: u32 = 0x4B44_5801;
const UPDATE_INSTALL_BREAKAWAY_LEASE_SECS: u64 = 30;

static SUPERVISOR_JOB_NAME: OnceLock<String> = OnceLock::new();
static SUPERVISOR_EXIT_EVENT_NAME: OnceLock<String> = OnceLock::new();
static SUPERVISOR_RESTART_EVENT_NAME: OnceLock<String> = OnceLock::new();
static UPDATE_INSTALL_BREAKAWAY_GENERATION: AtomicU64 = AtomicU64::new(0);

pub enum BootstrapOutcome {
    RunDesktop,
    SupervisorExited(i32),
}

pub fn bootstrap() -> Result<BootstrapOutcome, String> {
    if std::env::var_os(SUPERVISED_CHILD_ENV).is_some() {
        prepare_supervised_child()?;
        return Ok(BootstrapOutcome::RunDesktop);
    }

    run_supervisor().map(BootstrapOutcome::SupervisorExited)
}

pub fn notify_exit_requested() -> Result<(), String> {
    let Some(name) = SUPERVISOR_EXIT_EVENT_NAME.get() else {
        return Ok(());
    };
    let event = NamedEvent::open(name, EVENT_MODIFY_STATE)?;
    event.set()
}

pub fn notify_restart_requested() -> Result<(), String> {
    let name = SUPERVISOR_RESTART_EVENT_NAME
        .get()
        .ok_or_else(|| "desktop process is not connected to its restart supervisor".to_string())?;
    let event = NamedEvent::open(name, EVENT_MODIFY_STATE)?;
    event.set()
}

pub fn allow_update_installer_breakaway() -> Result<(), String> {
    let generation = UPDATE_INSTALL_BREAKAWAY_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    if let Err(error) = configure_managed_child_inheritance(true) {
        UPDATE_INSTALL_BREAKAWAY_GENERATION.fetch_add(1, Ordering::SeqCst);
        return Err(error);
    }

    let job_name = SUPERVISOR_JOB_NAME.get().cloned().ok_or_else(|| {
        "desktop process is not connected to its supervisor Job Object".to_string()
    })?;
    if let Err(error) = std::thread::Builder::new()
        .name("update-installer-breakaway-lease".to_string())
        .spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(
                UPDATE_INSTALL_BREAKAWAY_LEASE_SECS,
            ));
            if UPDATE_INSTALL_BREAKAWAY_GENERATION.load(Ordering::SeqCst) != generation {
                return;
            }
            if let Ok(job) = WindowsJob::open_for_configuration(&job_name) {
                let _ = job.set_limit_flags(managed_child_limit_flags());
            }
        })
    {
        UPDATE_INSTALL_BREAKAWAY_GENERATION.fetch_add(1, Ordering::SeqCst);
        let _ = configure_managed_child_inheritance(false);
        return Err(format!(
            "failed to start the update installer breakaway lease: {error}"
        ));
    }

    Ok(())
}

pub fn restore_managed_child_inheritance() -> Result<(), String> {
    UPDATE_INSTALL_BREAKAWAY_GENERATION.fetch_add(1, Ordering::SeqCst);
    configure_managed_child_inheritance(false)
}

fn configure_managed_child_inheritance(allow_update_installer: bool) -> Result<(), String> {
    let job_name = SUPERVISOR_JOB_NAME.get().ok_or_else(|| {
        "desktop process is not connected to its supervisor Job Object".to_string()
    })?;
    let job = WindowsJob::open_for_configuration(job_name)?;
    let flags = if allow_update_installer {
        update_installer_limit_flags()
    } else {
        managed_child_limit_flags()
    };
    job.set_limit_flags(flags)
}

fn managed_child_limit_flags() -> JOB_OBJECT_LIMIT {
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
}

fn update_installer_limit_flags() -> JOB_OBJECT_LIMIT {
    JOB_OBJECT_LIMIT(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE.0 | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK.0)
}

fn prepare_supervised_child() -> Result<(), String> {
    let job_name = std::env::var(SUPERVISOR_JOB_ENV)
        .map_err(|_| "supervisor Job Object is missing".to_string())?;
    let ready_event_name = std::env::var(SUPERVISOR_READY_EVENT_ENV)
        .map_err(|_| "supervisor ready event is missing".to_string())?;
    let exit_event_name = std::env::var(SUPERVISOR_EXIT_EVENT_ENV)
        .map_err(|_| "supervisor exit event is missing".to_string())?;
    let restart_event_name = std::env::var(SUPERVISOR_RESTART_EVENT_ENV)
        .map_err(|_| "supervisor restart event is missing".to_string())?;

    std::env::remove_var(SUPERVISED_CHILD_ENV);
    std::env::remove_var(SUPERVISOR_JOB_ENV);
    std::env::remove_var(SUPERVISOR_READY_EVENT_ENV);
    std::env::remove_var(SUPERVISOR_EXIT_EVENT_ENV);
    std::env::remove_var(SUPERVISOR_RESTART_EVENT_ENV);
    let _ = SUPERVISOR_JOB_NAME.set(job_name);
    let _ = SUPERVISOR_EXIT_EVENT_NAME.set(exit_event_name);
    let _ = SUPERVISOR_RESTART_EVENT_NAME.set(restart_event_name);

    let ready_event = NamedEvent::open(&ready_event_name, SYNCHRONIZE_ACCESS)?;
    match unsafe { WaitForSingleObject(ready_event.handle(), CHILD_READY_TIMEOUT_MS) } {
        WAIT_OBJECT_0 => Ok(()),
        WAIT_TIMEOUT => Err("supervisor did not release the desktop process in time".to_string()),
        result => Err(format!(
            "waiting for supervisor readiness failed with status {}",
            result.0
        )),
    }
}

fn run_supervisor() -> Result<i32, String> {
    crate::storage_layout::prepare_install_storage_layout()?;

    let token = Uuid::new_v4();
    let job_name = format!("Local\\KeydexSupervisorJob-{token}");
    let ready_event_name = format!("Local\\KeydexSupervisorReady-{token}");
    let exit_event_name = format!("Local\\KeydexSupervisorExit-{token}");
    let restart_event_name = format!("Local\\KeydexSupervisorRestart-{token}");
    let ready_event = NamedEvent::create(&ready_event_name)?;
    let exit_event = NamedEvent::create(&exit_event_name)?;
    let restart_event = NamedEvent::create(&restart_event_name)?;
    let job = WindowsJob::new_named_kill_on_close(&job_name)?;

    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let arguments = std::env::args_os().skip(1).collect::<Vec<_>>();
    let mut command = Command::new(executable);
    command
        .args(&arguments)
        .env(SUPERVISED_CHILD_ENV, "1")
        .env(SUPERVISOR_JOB_ENV, &job_name)
        .env(SUPERVISOR_READY_EVENT_ENV, &ready_event_name)
        .env(SUPERVISOR_EXIT_EVENT_ENV, &exit_event_name)
        .env(SUPERVISOR_RESTART_EVENT_ENV, &restart_event_name);
    let mut child = command.spawn().map_err(|error| error.to_string())?;

    if let Err(error) = job.assign(child_handle(&child)) {
        let _ = child.kill();
        return Err(format!(
            "failed to assign the desktop process to its Windows Job Object: {error}"
        ));
    }
    ready_event.set()?;

    let outcome = supervise_child(&mut child, &job, &exit_event, &restart_event)?;
    drop(job);
    if outcome.restart_requested {
        Command::new(
            std::env::current_exe()
                .map_err(|error| format!("failed to resolve restart path: {error}"))?,
        )
        .args(arguments)
        .env(super::UPDATE_RELAUNCH_ENV, "1")
        .spawn()
        .map_err(|error| format!("failed to relaunch Keydex after update: {error}"))?;
        return Ok(0);
    }
    if outcome.requested_shutdown {
        Ok(0)
    } else {
        Ok(outcome.child_exit_code)
    }
}

struct SupervisedExit {
    child_exit_code: i32,
    requested_shutdown: bool,
    restart_requested: bool,
}

fn supervise_child(
    child: &mut Child,
    job: &WindowsJob,
    exit_event: &NamedEvent,
    restart_event: &NamedEvent,
) -> Result<SupervisedExit, String> {
    supervise_child_with_timeouts(
        child,
        job,
        exit_event,
        restart_event,
        GRACEFUL_EXIT_TIMEOUT_MS,
        FORCE_EXIT_TIMEOUT_MS,
    )
}

fn supervise_child_with_timeouts(
    child: &mut Child,
    job: &WindowsJob,
    exit_event: &NamedEvent,
    restart_event: &NamedEvent,
    graceful_exit_timeout_ms: u32,
    force_exit_timeout_ms: u32,
) -> Result<SupervisedExit, String> {
    let process = child_handle(child);
    let handles = [process, exit_event.handle(), restart_event.handle()];
    let wait_result = unsafe { WaitForMultipleObjects(&handles, false, INFINITE) };

    if wait_result == WAIT_OBJECT_0 {
        return supervised_exit(child, false, false);
    }
    let exit_requested = wait_result.0 == WAIT_OBJECT_0.0 + 1;
    let restart_requested = wait_result.0 == WAIT_OBJECT_0.0 + 2;
    if !exit_requested && !restart_requested {
        let _ = job.terminate(FORCED_EXIT_CODE);
        return Err(format!(
            "supervisor wait failed with status {}",
            wait_result.0
        ));
    }

    match unsafe { WaitForSingleObject(process, graceful_exit_timeout_ms) } {
        WAIT_OBJECT_0 => return supervised_exit(child, true, restart_requested),
        WAIT_TIMEOUT => {}
        result => {
            eprintln!(
                "waiting for graceful desktop exit failed with status {}; forcing the process tree",
                result.0
            );
        }
    }

    if let Err(error) = job.terminate(FORCED_EXIT_CODE) {
        eprintln!("failed to terminate the Keydex Job Object: {error}");
        unsafe { TerminateProcess(process, FORCED_EXIT_CODE) }
            .map_err(|terminate_error| terminate_error.to_string())?;
    }

    match unsafe { WaitForSingleObject(process, force_exit_timeout_ms) } {
        WAIT_OBJECT_0 => supervised_exit(child, true, restart_requested),
        WAIT_TIMEOUT => {
            unsafe { TerminateProcess(process, FORCED_EXIT_CODE) }
                .map_err(|error| error.to_string())?;
            match unsafe { WaitForSingleObject(process, force_exit_timeout_ms) } {
                WAIT_OBJECT_0 => supervised_exit(child, true, restart_requested),
                result => Err(format!(
                    "desktop process did not terminate after the hard deadline (status {})",
                    result.0
                )),
            }
        }
        result => Err(format!(
            "waiting for forced desktop exit failed with status {}",
            result.0
        )),
    }
}

fn supervised_exit(
    child: &mut Child,
    requested_shutdown: bool,
    restart_requested: bool,
) -> Result<SupervisedExit, String> {
    wait_for_exit_status(child).map(|child_exit_code| SupervisedExit {
        child_exit_code,
        requested_shutdown,
        restart_requested,
    })
}

fn wait_for_exit_status(child: &mut Child) -> Result<i32, String> {
    child
        .wait()
        .map(exit_status_code)
        .map_err(|error| error.to_string())
}

fn exit_status_code(status: ExitStatus) -> i32 {
    status.code().unwrap_or(FORCED_EXIT_CODE as i32)
}

fn child_handle(child: &Child) -> HANDLE {
    HANDLE(child.as_raw_handle())
}

struct NamedEvent {
    handle: HANDLE,
}

impl NamedEvent {
    fn create(name: &str) -> Result<Self, String> {
        let wide_name = wide_null(name);
        let handle = unsafe { CreateEventW(None, true, false, PCWSTR(wide_name.as_ptr())) }
            .map_err(|error| error.to_string())?;
        Ok(Self { handle })
    }

    fn open(name: &str, access: SYNCHRONIZATION_ACCESS_RIGHTS) -> Result<Self, String> {
        let wide_name = wide_null(name);
        let handle = unsafe { OpenEventW(access, false, PCWSTR(wide_name.as_ptr())) }
            .map_err(|error| error.to_string())?;
        Ok(Self { handle })
    }

    fn set(&self) -> Result<(), String> {
        unsafe { SetEvent(self.handle) }.map_err(|error| error.to_string())
    }

    fn handle(&self) -> HANDLE {
        self.handle
    }
}

impl Drop for NamedEvent {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.handle);
        }
    }
}

struct WindowsJob {
    handle: HANDLE,
}

impl WindowsJob {
    #[cfg(test)]
    fn new_kill_on_close() -> Result<Self, String> {
        Self::create_kill_on_close(None)
    }

    fn new_named_kill_on_close(name: &str) -> Result<Self, String> {
        Self::create_kill_on_close(Some(name))
    }

    fn create_kill_on_close(name: Option<&str>) -> Result<Self, String> {
        let wide_name = name.map(wide_null);
        let name = wide_name
            .as_ref()
            .map_or(PCWSTR::null(), |value| PCWSTR(value.as_ptr()));
        let handle = unsafe { CreateJobObjectW(None, name) }.map_err(|error| error.to_string())?;
        let job = Self { handle };
        if let Err(error) = job.set_limit_flags(managed_child_limit_flags()) {
            drop(job);
            return Err(error);
        }
        Ok(job)
    }

    fn open_for_configuration(name: &str) -> Result<Self, String> {
        let wide_name = wide_null(name);
        let handle =
            unsafe { OpenJobObjectW(JOB_OBJECT_SET_ATTRIBUTES, false, PCWSTR(wide_name.as_ptr())) }
                .map_err(|error| error.to_string())?;
        Ok(Self { handle })
    }

    fn set_limit_flags(&self, flags: JOB_OBJECT_LIMIT) -> Result<(), String> {
        use std::ffi::c_void;
        use std::mem::size_of;

        let mut information = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        information.BasicLimitInformation.LimitFlags = flags;
        unsafe {
            SetInformationJobObject(
                self.handle,
                JobObjectExtendedLimitInformation,
                &information as *const _ as *const c_void,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        }
        .map_err(|error| error.to_string())
    }

    fn assign(&self, process: HANDLE) -> Result<(), String> {
        unsafe { AssignProcessToJobObject(self.handle, process) }.map_err(|error| error.to_string())
    }

    fn terminate(&self, exit_code: u32) -> Result<(), String> {
        unsafe { TerminateJobObject(self.handle, exit_code) }.map_err(|error| error.to_string())
    }

    #[cfg(test)]
    fn limit_flags(&self) -> Result<JOB_OBJECT_LIMIT, String> {
        use std::ffi::c_void;
        use std::mem::size_of;

        let mut information = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        unsafe {
            QueryInformationJobObject(
                Some(self.handle),
                JobObjectExtendedLimitInformation,
                &mut information as *mut _ as *mut c_void,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                None,
            )
        }
        .map_err(|error| error.to_string())?;
        Ok(information.BasicLimitInformation.LimitFlags)
    }
}

impl Drop for WindowsJob {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.handle);
        }
    }
}

fn wide_null(value: &str) -> Vec<u16> {
    OsStr::new(value).encode_wide().chain(Some(0)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exit_status_preserves_normal_process_codes() {
        let status = Command::new("cmd.exe")
            .args(["/C", "exit", "7"])
            .status()
            .unwrap();
        assert_eq!(exit_status_code(status), 7);
    }

    #[test]
    fn named_event_round_trip_is_signaled() {
        let name = format!("Local\\KeydexSupervisorTest-{}", Uuid::new_v4());
        let created = NamedEvent::create(&name).unwrap();
        let opened = NamedEvent::open(&name, EVENT_MODIFY_STATE).unwrap();
        opened.set().unwrap();
        assert_eq!(
            unsafe { WaitForSingleObject(created.handle(), 1_000) },
            WAIT_OBJECT_0
        );
    }

    #[test]
    fn named_job_temporarily_allows_only_future_children_to_break_away() {
        let name = format!("Local\\KeydexSupervisorJobTest-{}", Uuid::new_v4());
        let job = WindowsJob::new_named_kill_on_close(&name).unwrap();
        let controller = WindowsJob::open_for_configuration(&name).unwrap();

        controller
            .set_limit_flags(update_installer_limit_flags())
            .unwrap();
        assert_eq!(
            job.limit_flags().unwrap().0,
            update_installer_limit_flags().0
        );

        controller
            .set_limit_flags(managed_child_limit_flags())
            .unwrap();
        assert_eq!(job.limit_flags().unwrap().0, managed_child_limit_flags().0);
    }

    #[test]
    fn update_installer_child_survives_the_old_supervised_job() {
        let unique = Uuid::new_v4();
        let base = std::env::temp_dir().join(format!("keydex-update-breakaway-{unique}"));
        let go_path = base.join("go");
        let pid_path = base.join("child.pid");
        let parent_script_path = base.join("parent.ps1");
        let child_script_path = base.join("child.ps1");
        std::fs::create_dir_all(&base).unwrap();
        std::fs::write(&child_script_path, "Start-Sleep -Seconds 30\r\n").unwrap();
        std::fs::write(
            &parent_script_path,
            r#"param(
  [string]$GoPath,
  [string]$PidPath,
  [string]$ChildScriptPath
)
while (-not (Test-Path -LiteralPath $GoPath)) {
  Start-Sleep -Milliseconds 10
}
$child = Start-Process -FilePath "powershell.exe" -ArgumentList @(
  "-NoLogo",
  "-NoProfile",
  "-NonInteractive",
  "-File",
  $ChildScriptPath
) -PassThru
[System.IO.File]::WriteAllText($PidPath, [string]$child.Id)
Wait-Process -Id $child.Id
"#,
        )
        .unwrap();

        let name = format!("Local\\KeydexSupervisorBreakawayTest-{unique}");
        let job = WindowsJob::new_named_kill_on_close(&name).unwrap();
        let controller = WindowsJob::open_for_configuration(&name).unwrap();
        let mut parent = Command::new("powershell.exe")
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-File",
                parent_script_path.to_str().unwrap(),
                "-GoPath",
                go_path.to_str().unwrap(),
                "-PidPath",
                pid_path.to_str().unwrap(),
                "-ChildScriptPath",
                child_script_path.to_str().unwrap(),
            ])
            .spawn()
            .unwrap();
        job.assign(child_handle(&parent)).unwrap();
        controller
            .set_limit_flags(update_installer_limit_flags())
            .unwrap();
        std::fs::write(&go_path, b"go").unwrap();

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !pid_path.exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let child_pid = std::fs::read_to_string(&pid_path)
            .unwrap()
            .trim()
            .parse::<u32>()
            .unwrap();
        let process_access = PROCESS_ACCESS_RIGHTS(
            PROCESS_TERMINATE.0 | PROCESS_QUERY_LIMITED_INFORMATION.0 | SYNCHRONIZE_ACCESS.0,
        );
        let child = unsafe { OpenProcess(process_access, false, child_pid) }.unwrap();
        let mut child_in_job = windows::core::BOOL(0);
        unsafe { IsProcessInJob(child, Some(job.handle), &mut child_in_job) }.unwrap();
        assert!(!child_in_job.as_bool());

        drop(controller);
        drop(job);
        assert_eq!(unsafe { WaitForSingleObject(child, 200) }, WAIT_TIMEOUT);
        unsafe { TerminateProcess(child, 0) }.unwrap();
        assert_eq!(
            unsafe { WaitForSingleObject(child, FORCE_EXIT_TIMEOUT_MS) },
            WAIT_OBJECT_0
        );
        unsafe {
            let _ = CloseHandle(child);
        }
        let _ = parent.wait();
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn installer_hook_does_not_tree_kill_the_update_installer() {
        let hooks = include_str!("../installer-hooks.nsh");
        let desktop_taskkill = hooks
            .lines()
            .find(|line| line.contains("taskkill.exe") && line.contains("keydex-desktop.exe"))
            .expect("desktop taskkill command");

        assert!(desktop_taskkill.contains(" /F "));
        assert!(!desktop_taskkill.contains(" /T "));
    }

    #[test]
    fn installer_hook_preserves_install_owned_data_unless_user_requests_deletion() {
        let hooks = include_str!("../installer-hooks.nsh");

        assert!(hooks.contains("!macro NSIS_HOOK_POSTUNINSTALL"));
        assert!(hooks.contains("$DeleteAppDataCheckboxState = 1"));
        assert!(hooks.contains("$UpdateMode <> 1"));
        assert!(hooks.contains("RMDir /r \"$INSTDIR\\data\""));
    }

    #[test]
    fn exit_deadline_forces_the_supervised_process_to_terminate() {
        let event_name = format!("Local\\KeydexSupervisorExitTest-{}", Uuid::new_v4());
        let exit_event = NamedEvent::create(&event_name).unwrap();
        let restart_event = NamedEvent::create(&format!(
            "Local\\KeydexSupervisorRestartTest-{}",
            Uuid::new_v4()
        ))
        .unwrap();
        let job = WindowsJob::new_kill_on_close().unwrap();
        let mut child = Command::new("powershell.exe")
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Sleep -Seconds 30",
            ])
            .spawn()
            .unwrap();
        job.assign(child_handle(&child)).unwrap();
        exit_event.set().unwrap();

        let started = std::time::Instant::now();
        let outcome =
            supervise_child_with_timeouts(&mut child, &job, &exit_event, &restart_event, 25, 500)
                .unwrap();

        assert_eq!(outcome.child_exit_code, FORCED_EXIT_CODE as i32);
        assert!(outcome.requested_shutdown);
        assert!(!outcome.restart_requested);
        assert!(started.elapsed() < std::time::Duration::from_secs(2));
        assert!(child.try_wait().unwrap().is_some());
    }

    #[test]
    fn restart_intent_is_preserved_across_forced_shutdown() {
        let exit_event = NamedEvent::create(&format!(
            "Local\\KeydexSupervisorExitTest-{}",
            Uuid::new_v4()
        ))
        .unwrap();
        let restart_event = NamedEvent::create(&format!(
            "Local\\KeydexSupervisorRestartTest-{}",
            Uuid::new_v4()
        ))
        .unwrap();
        let job = WindowsJob::new_kill_on_close().unwrap();
        let mut child = Command::new("powershell.exe")
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Sleep -Seconds 30",
            ])
            .spawn()
            .unwrap();
        job.assign(child_handle(&child)).unwrap();
        restart_event.set().unwrap();

        let outcome =
            supervise_child_with_timeouts(&mut child, &job, &exit_event, &restart_event, 25, 500)
                .unwrap();

        assert_eq!(outcome.child_exit_code, FORCED_EXIT_CODE as i32);
        assert!(outcome.requested_shutdown);
        assert!(outcome.restart_requested);
    }

    #[test]
    fn wait_constants_are_not_ambiguous() {
        assert_ne!(WAIT_FAILED, WAIT_TIMEOUT);
    }
}
