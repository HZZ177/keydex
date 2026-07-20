use std::io::{Read, Write};
use std::path::Path;

use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};

use super::process_tree::ManagedProcessTree;
use super::profiles::ResolvedProfile;
use super::protocol::{
    error_codes, TerminalError, TerminalSize, TERMINAL_MAX_SIZE, TERMINAL_MIN_SIZE,
};

pub struct SpawnedTerminal {
    pub master: Box<dyn MasterPty + Send>,
    pub writer: Box<dyn Write + Send>,
    pub reader: Box<dyn Read + Send>,
    pub child: Box<dyn Child + Send + Sync>,
    pub killer: Box<dyn ChildKiller + Send + Sync>,
    pub process_tree: ManagedProcessTree,
}

pub fn spawn_terminal(
    profile: &ResolvedProfile,
    cwd: &Path,
    size: TerminalSize,
) -> Result<SpawnedTerminal, TerminalError> {
    validate_terminal_size(size)?;
    let pair = native_pty_system()
        .openpty(to_pty_size(size))
        .map_err(|error| TerminalError::internal(format!("创建终端失败：{error}")))?;

    let mut command = CommandBuilder::new(&profile.executable);
    command.args(&profile.args);
    command.cwd(cwd);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");

    let child_result = pair.slave.spawn_command(command);
    drop(pair.slave);
    let child = child_result.map_err(|error| {
        TerminalError::internal(format!("启动 {} 失败：{error}", profile.label))
    })?;

    let process_id = child
        .process_id()
        .ok_or_else(|| TerminalError::internal("终端进程启动后没有返回进程标识"))?;
    #[cfg(windows)]
    let process_handle = child.as_raw_handle();
    #[cfg(not(windows))]
    let process_handle = None;
    let process_tree = ManagedProcessTree::attach(process_id, process_handle);
    let killer = child.clone_killer();

    let reader = pair.master.try_clone_reader().map_err(|error| {
        let _ = process_tree.kill();
        TerminalError::internal(format!("打开终端输出失败：{error}"))
    })?;
    let writer = pair.master.take_writer().map_err(|error| {
        let _ = process_tree.kill();
        TerminalError::internal(format!("打开终端输入失败：{error}"))
    })?;

    Ok(SpawnedTerminal {
        master: pair.master,
        writer,
        reader,
        child,
        killer,
        process_tree,
    })
}

pub fn validate_terminal_size(size: TerminalSize) -> Result<(), TerminalError> {
    if !(TERMINAL_MIN_SIZE..=TERMINAL_MAX_SIZE).contains(&size.cols)
        || !(TERMINAL_MIN_SIZE..=TERMINAL_MAX_SIZE).contains(&size.rows)
    {
        return Err(TerminalError::new(
            error_codes::SIZE_INVALID,
            format!("终端尺寸必须在 {TERMINAL_MIN_SIZE} 到 {TERMINAL_MAX_SIZE} 之间"),
        ));
    }
    Ok(())
}

pub fn to_pty_size(size: TerminalSize) -> PtySize {
    PtySize {
        rows: size.rows,
        cols: size.cols,
        pixel_width: size.pixel_width.unwrap_or(0),
        pixel_height: size.pixel_height.unwrap_or(0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_size_accepts_boundaries_and_rejects_invalid_values() {
        for value in [TERMINAL_MIN_SIZE, TERMINAL_MAX_SIZE] {
            assert!(validate_terminal_size(TerminalSize {
                cols: value,
                rows: value,
                pixel_width: None,
                pixel_height: None,
            })
            .is_ok());
        }
        let error = validate_terminal_size(TerminalSize {
            cols: 1,
            rows: 24,
            pixel_width: None,
            pixel_height: None,
        })
        .unwrap_err();
        assert_eq!(error.code, error_codes::SIZE_INVALID);
    }
}
