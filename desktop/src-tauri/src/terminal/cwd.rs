use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use super::protocol::{error_codes, TerminalError};

pub fn resolve_initial_cwd(requested: Option<&str>) -> Result<PathBuf, TerminalError> {
    if let Some(path) = requested.map(str::trim).filter(|path| !path.is_empty()) {
        return validate_directory(PathBuf::from(path));
    }

    native_home_candidates()
        .into_iter()
        .find_map(|path| validate_directory(path).ok())
        .ok_or_else(|| TerminalError::new(error_codes::CWD_INVALID, "无法确定可用的终端初始目录"))
}

fn validate_directory(path: PathBuf) -> Result<PathBuf, TerminalError> {
    let metadata = fs::metadata(&path).map_err(|_| invalid_cwd_error(&path))?;
    if !metadata.is_dir() || fs::read_dir(&path).is_err() {
        return Err(invalid_cwd_error(&path));
    }
    Ok(path)
}

fn invalid_cwd_error(path: &Path) -> TerminalError {
    let display = path.to_string_lossy();
    let shortened: String = display.chars().take(240).collect();
    TerminalError::new(
        error_codes::CWD_INVALID,
        format!("终端初始目录无效：{shortened}"),
    )
}

fn native_home_candidates() -> Vec<PathBuf> {
    [env::var_os("USERPROFILE"), env::var_os("HOME")]
        .into_iter()
        .flatten()
        .map(PathBuf::from)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn fixture_root(label: &str) -> PathBuf {
        env::temp_dir().join(format!(
            "keydex-terminal-{label}-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn accepts_directory_with_spaces_and_unicode_without_rewriting_it() {
        let root = fixture_root("目录 with spaces");
        fs::create_dir_all(&root).unwrap();
        let resolved = resolve_initial_cwd(root.to_str()).unwrap();
        assert_eq!(resolved, root);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_missing_path_and_regular_file() {
        let root = fixture_root("invalid");
        let missing = root.join("missing");
        let missing_error = resolve_initial_cwd(missing.to_str()).unwrap_err();
        assert_eq!(missing_error.code, error_codes::CWD_INVALID);

        fs::create_dir_all(&root).unwrap();
        let file = root.join("file.txt");
        fs::write(&file, b"fixture").unwrap();
        assert_eq!(
            resolve_initial_cwd(file.to_str()).unwrap_err().code,
            error_codes::CWD_INVALID
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn empty_requested_path_uses_an_available_native_home() {
        let resolved = resolve_initial_cwd(Some("  ")).unwrap();
        assert!(resolved.is_dir());
    }
}
