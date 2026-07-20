use std::collections::HashSet;
use std::env;
use std::path::PathBuf;

use super::protocol::{error_codes, TerminalError, TerminalProfileSnapshot};

pub const PROFILE_GIT_BASH: &str = "git-bash";
pub const PROFILE_POWERSHELL: &str = "powershell";
pub const PROFILE_CMD: &str = "cmd";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedProfile {
    pub id: String,
    pub label: String,
    pub executable: PathBuf,
    pub args: Vec<String>,
}

impl ResolvedProfile {
    fn snapshot(&self) -> TerminalProfileSnapshot {
        TerminalProfileSnapshot {
            id: self.id.clone(),
            label: self.label.clone(),
            available: true,
            executable: Some(self.executable.to_string_lossy().into_owned()),
            args: self.args.clone(),
            unavailable_reason: None,
        }
    }
}

pub fn list_shell_profiles() -> Vec<TerminalProfileSnapshot> {
    [PROFILE_GIT_BASH, PROFILE_POWERSHELL, PROFILE_CMD]
        .into_iter()
        .map(|id| match resolve_shell_profile(id) {
            Ok(profile) => profile.snapshot(),
            Err(error) => unavailable_snapshot(id, error.message),
        })
        .collect()
}

pub fn resolve_shell_profile(id: &str) -> Result<ResolvedProfile, TerminalError> {
    match id.trim() {
        PROFILE_GIT_BASH => resolve_git_bash(),
        PROFILE_POWERSHELL => resolve_powershell(),
        PROFILE_CMD => resolve_cmd(),
        _ => Err(TerminalError::new(
            error_codes::PROFILE_UNAVAILABLE,
            "不支持的终端配置",
        )),
    }
}

fn resolve_git_bash() -> Result<ResolvedProfile, TerminalError> {
    let mut candidates = Vec::new();
    for root in [
        env::var_os("ProgramFiles"),
        env::var_os("ProgramFiles(x86)"),
    ]
    .into_iter()
    .flatten()
    {
        candidates.push(
            PathBuf::from(&root)
                .join("Git")
                .join("bin")
                .join("bash.exe"),
        );
        candidates.push(
            PathBuf::from(&root)
                .join("Git")
                .join("usr")
                .join("bin")
                .join("bash.exe"),
        );
    }
    candidates.extend(git_registry_candidates());
    candidates.extend(
        executable_candidates(&["bash.exe"])
            .into_iter()
            .filter(|candidate| is_git_for_windows_bash(candidate)),
    );
    profile_from_candidates(
        PROFILE_GIT_BASH,
        "Git Bash",
        vec!["--login".into(), "-i".into()],
        candidates,
    )
}

fn is_git_for_windows_bash(candidate: &std::path::Path) -> bool {
    let normalized = candidate
        .to_string_lossy()
        .replace('/', "\\")
        .to_ascii_lowercase();
    normalized.ends_with("\\git\\bin\\bash.exe")
        || normalized.ends_with("\\git\\usr\\bin\\bash.exe")
}

fn resolve_powershell() -> Result<ResolvedProfile, TerminalError> {
    if let Some(executable) = first_existing(executable_candidates(&["pwsh.exe"])) {
        return Ok(ResolvedProfile {
            id: PROFILE_POWERSHELL.into(),
            label: "PowerShell".into(),
            executable,
            args: vec!["-NoLogo".into()],
        });
    }

    let mut candidates = executable_candidates(&["powershell.exe"]);
    if let Some(system_root) = env::var_os("SystemRoot") {
        candidates.push(
            PathBuf::from(system_root)
                .join("System32")
                .join("WindowsPowerShell")
                .join("v1.0")
                .join("powershell.exe"),
        );
    }
    profile_from_candidates(
        PROFILE_POWERSHELL,
        "PowerShell",
        vec!["-NoLogo".into()],
        candidates,
    )
}

fn resolve_cmd() -> Result<ResolvedProfile, TerminalError> {
    let mut candidates = Vec::new();
    if let Some(comspec) = env::var_os("COMSPEC") {
        candidates.push(PathBuf::from(comspec));
    }
    if let Some(system_root) = env::var_os("SystemRoot") {
        candidates.push(PathBuf::from(system_root).join("System32").join("cmd.exe"));
    }
    candidates.extend(executable_candidates(&["cmd.exe"]));
    profile_from_candidates(PROFILE_CMD, "CMD", vec!["/Q".into()], candidates)
}

fn profile_from_candidates(
    id: &str,
    label: &str,
    args: Vec<String>,
    candidates: Vec<PathBuf>,
) -> Result<ResolvedProfile, TerminalError> {
    first_existing(candidates)
        .map(|executable| ResolvedProfile {
            id: id.into(),
            label: label.into(),
            executable,
            args,
        })
        .ok_or_else(|| {
            TerminalError::new(
                error_codes::PROFILE_UNAVAILABLE,
                format!("{label} 在当前电脑上不可用"),
            )
        })
}

fn unavailable_snapshot(id: &str, message: String) -> TerminalProfileSnapshot {
    let label = match id {
        PROFILE_GIT_BASH => "Git Bash",
        PROFILE_POWERSHELL => "PowerShell",
        PROFILE_CMD => "CMD",
        _ => id,
    };
    TerminalProfileSnapshot {
        id: id.into(),
        label: label.into(),
        available: false,
        executable: None,
        args: Vec::new(),
        unavailable_reason: Some(message),
    }
}

fn executable_candidates(names: &[&str]) -> Vec<PathBuf> {
    let Some(path) = env::var_os("PATH") else {
        return Vec::new();
    };
    env::split_paths(&path)
        .flat_map(|directory| names.iter().map(move |name| directory.join(name)))
        .collect()
}

fn first_existing(candidates: Vec<PathBuf>) -> Option<PathBuf> {
    let mut seen = HashSet::new();
    candidates.into_iter().find(|candidate| {
        let identity = candidate.to_string_lossy().to_ascii_lowercase();
        seen.insert(identity) && candidate.is_file()
    })
}

#[cfg(windows)]
fn git_registry_candidates() -> Vec<PathBuf> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::RegKey;

    [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE]
        .into_iter()
        .filter_map(|hive| {
            RegKey::predef(hive)
                .open_subkey("SOFTWARE\\GitForWindows")
                .ok()
                .and_then(|key| key.get_value::<String, _>("InstallPath").ok())
        })
        .flat_map(|root| {
            let root = PathBuf::from(root);
            [
                root.join("bin").join("bash.exe"),
                root.join("usr").join("bin").join("bash.exe"),
            ]
        })
        .collect()
}

#[cfg(not(windows))]
fn git_registry_candidates() -> Vec<PathBuf> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn profile_list_has_stable_order_and_ids_without_wsl() {
        let profiles = list_shell_profiles();
        assert_eq!(
            profiles
                .iter()
                .map(|profile| profile.id.as_str())
                .collect::<Vec<_>>(),
            vec![PROFILE_GIT_BASH, PROFILE_POWERSHELL, PROFILE_CMD]
        );
        assert!(!profiles.iter().any(|profile| profile.id.contains("wsl")));
    }

    #[test]
    fn candidate_resolution_preserves_spaces_and_deduplicates_paths() {
        let root = env::temp_dir().join(format!(
            "keydex terminal profile {}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let executable = root.join("shell with spaces.exe");
        fs::write(&executable, b"").unwrap();
        let selected = first_existing(vec![executable.clone(), executable.clone()]);
        assert_eq!(selected, Some(executable));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn git_bash_candidate_rejects_windows_and_wsl_bash_aliases() {
        assert!(is_git_for_windows_bash(std::path::Path::new(
            r"C:\Program Files\Git\bin\bash.exe"
        )));
        assert!(is_git_for_windows_bash(std::path::Path::new(
            r"D:\Tools\Git\usr\bin\bash.exe"
        )));
        assert!(!is_git_for_windows_bash(std::path::Path::new(
            r"C:\Windows\System32\bash.exe"
        )));
        assert!(!is_git_for_windows_bash(std::path::Path::new(
            r"C:\Windows\System32\wsl.exe"
        )));
    }

    #[test]
    fn unknown_profile_is_not_treated_as_an_executable_path() {
        let error = resolve_shell_profile("C:/tools/custom.exe").unwrap_err();
        assert_eq!(error.code, error_codes::PROFILE_UNAVAILABLE);
    }
}
