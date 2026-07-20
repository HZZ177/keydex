use std::process::{Command, Stdio};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug)]
pub struct ManagedProcessTree {
    pid: u32,
    #[cfg(windows)]
    job: Option<WindowsJob>,
}

impl ManagedProcessTree {
    #[cfg(windows)]
    pub fn attach(pid: u32, process_handle: Option<std::os::windows::io::RawHandle>) -> Self {
        Self {
            pid,
            job: process_handle.and_then(|handle| WindowsJob::attach(handle).ok()),
        }
    }

    #[cfg(not(windows))]
    pub fn attach(pid: u32, _process_handle: Option<*mut std::ffi::c_void>) -> Self {
        Self { pid }
    }

    pub fn kill(&self) -> Result<(), String> {
        #[cfg(windows)]
        if let Some(job) = &self.job {
            return job.kill();
        }

        self.kill_fallback()
    }

    #[cfg(windows)]
    fn kill_fallback(&self) -> Result<(), String> {
        let status = Command::new("taskkill")
            .args(["/PID", &self.pid.to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .map_err(|error| error.to_string())?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("无法结束终端进程树（PID {}）", self.pid))
        }
    }

    #[cfg(not(windows))]
    fn kill_fallback(&self) -> Result<(), String> {
        let _ = self.pid;
        Ok(())
    }
}

#[cfg(windows)]
#[derive(Debug)]
struct WindowsJob {
    handle: usize,
}

#[cfg(windows)]
unsafe impl Send for WindowsJob {}
#[cfg(windows)]
unsafe impl Sync for WindowsJob {}

#[cfg(windows)]
impl WindowsJob {
    fn attach(process_handle: std::os::windows::io::RawHandle) -> Result<Self, String> {
        use std::ffi::c_void;
        use std::mem::size_of;
        use windows::core::PCWSTR;
        use windows::Win32::Foundation::HANDLE;
        use windows::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };

        let job =
            unsafe { CreateJobObjectW(None, PCWSTR::null()) }.map_err(|error| error.to_string())?;
        let mut information = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configure_result = unsafe {
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &information as *const _ as *const c_void,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if let Err(error) = configure_result {
            unsafe {
                let _ = windows::Win32::Foundation::CloseHandle(job);
            }
            return Err(error.to_string());
        }

        let process = HANDLE(process_handle);
        if let Err(error) = unsafe { AssignProcessToJobObject(job, process) } {
            unsafe {
                let _ = windows::Win32::Foundation::CloseHandle(job);
            }
            return Err(error.to_string());
        }
        Ok(Self {
            handle: job.0 as usize,
        })
    }

    fn kill(&self) -> Result<(), String> {
        use windows::Win32::Foundation::HANDLE;
        use windows::Win32::System::JobObjects::TerminateJobObject;

        unsafe { TerminateJobObject(HANDLE(self.handle as *mut _), 1) }
            .map_err(|error| error.to_string())
    }
}

#[cfg(windows)]
impl Drop for WindowsJob {
    fn drop(&mut self) {
        use windows::Win32::Foundation::{CloseHandle, HANDLE};

        unsafe {
            let _ = CloseHandle(HANDLE(self.handle as *mut _));
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::fs;
    use std::os::windows::io::AsRawHandle;
    use std::path::PathBuf;
    use std::thread;
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    #[test]
    fn managed_job_terminates_the_owned_child_tree_only() {
        let pid_file = std::env::temp_dir().join(format!(
            "keydex-terminal-child-{}.pid",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let script = format!(
            "$ErrorActionPreference='Stop'; Start-Sleep -Milliseconds 500; \
             $child=Start-Process powershell.exe -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 30' -PassThru; \
             Set-Content -LiteralPath '{}' -Value $child.Id; Wait-Process -Id $child.Id",
            escape_powershell_literal(&pid_file)
        );
        let mut outer = Command::new("powershell.exe")
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                &script,
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .unwrap();
        let tree = ManagedProcessTree::attach(outer.id(), Some(outer.as_raw_handle()));

        let deadline = Instant::now() + Duration::from_secs(8);
        while !pid_file.is_file() {
            assert!(
                Instant::now() < deadline,
                "child PID fixture was not created"
            );
            thread::sleep(Duration::from_millis(25));
        }
        let child_pid = fs::read_to_string(&pid_file)
            .unwrap()
            .trim()
            .parse::<u32>()
            .unwrap();

        tree.kill().unwrap();
        let exit_deadline = Instant::now() + Duration::from_secs(8);
        while outer.try_wait().unwrap().is_none() {
            assert!(Instant::now() < exit_deadline, "owned shell did not exit");
            thread::sleep(Duration::from_millis(25));
        }
        while process_exists(child_pid) {
            assert!(
                Instant::now() < exit_deadline,
                "owned grandchild process was not terminated"
            );
            thread::sleep(Duration::from_millis(25));
        }
        let _ = fs::remove_file(pid_file);
    }

    fn escape_powershell_literal(path: &PathBuf) -> String {
        path.to_string_lossy().replace('\'', "''")
    }

    fn process_exists(pid: u32) -> bool {
        let filter = format!("PID eq {pid}");
        Command::new("tasklist")
            .args(["/FI", &filter, "/NH"])
            .stdin(Stdio::null())
            .output()
            .map(|output| String::from_utf8_lossy(&output.stdout).contains(&pid.to_string()))
            .unwrap_or(false)
    }
}
