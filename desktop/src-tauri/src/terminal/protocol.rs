use std::fmt;

use serde::{Deserialize, Serialize};

pub const TERMINAL_CONTRACT_VERSION: u8 = 1;
pub const TERMINAL_SESSION_LIMIT: usize = 8;
pub const TERMINAL_GLOBAL_LIMIT: usize = 24;
pub const TERMINAL_REPLAY_LIMIT_BYTES: usize = 1024 * 1024;
pub const TERMINAL_MAX_OUTPUT_CHUNK_BYTES: usize = 32 * 1024;
pub const TERMINAL_MAX_INPUT_BYTES: usize = 64 * 1024;
pub const TERMINAL_MIN_SIZE: u16 = 2;
pub const TERMINAL_MAX_SIZE: u16 = 500;

pub mod error_codes {
    pub const SESSION_REQUIRED: &str = "terminal_session_required";
    pub const PROFILE_UNAVAILABLE: &str = "terminal_profile_unavailable";
    pub const CWD_INVALID: &str = "terminal_cwd_invalid";
    pub const SESSION_LIMIT_REACHED: &str = "terminal_session_limit_reached";
    pub const GLOBAL_LIMIT_REACHED: &str = "terminal_global_limit_reached";
    pub const NOT_FOUND: &str = "terminal_not_found";
    pub const NOT_RUNNING: &str = "terminal_not_running";
    pub const INPUT_INVALID: &str = "terminal_input_invalid";
    pub const INPUT_TOO_LARGE: &str = "terminal_input_too_large";
    pub const SIZE_INVALID: &str = "terminal_size_invalid";
    pub const TITLE_INVALID: &str = "terminal_title_invalid";
    pub const ATTACH_FAILED: &str = "terminal_attach_failed";
    pub const INTERNAL: &str = "terminal_internal";
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalError {
    pub code: String,
    pub message: String,
}

impl TerminalError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(error_codes::INTERNAL, message)
    }
}

impl fmt::Display for TerminalError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for TerminalError {}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TerminalStatus {
    Starting,
    Running,
    Exited,
    Failed,
    Closing,
}

impl TerminalStatus {
    pub fn is_running(self) -> bool {
        matches!(self, Self::Starting | Self::Running)
    }

    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Exited | Self::Failed)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalProfileSnapshot {
    pub id: String,
    pub label: String,
    pub available: bool,
    pub executable: Option<String>,
    pub args: Vec<String>,
    pub unavailable_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSnapshot {
    pub contract_version: u8,
    pub terminal_id: String,
    pub session_id: String,
    pub profile_id: String,
    pub cwd: String,
    pub title: String,
    pub status: TerminalStatus,
    pub seq: u64,
    pub exit_code: Option<i32>,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum TerminalEvent {
    Output {
        #[serde(rename = "terminalId")]
        terminal_id: String,
        seq: u64,
        #[serde(rename = "dataBase64")]
        data_base64: String,
    },
    ReplayTruncated {
        #[serde(rename = "terminalId")]
        terminal_id: String,
        #[serde(rename = "earliestSeq")]
        earliest_seq: u64,
    },
    Exited {
        #[serde(rename = "terminalId")]
        terminal_id: String,
        #[serde(rename = "exitCode")]
        exit_code: Option<i32>,
    },
    Failed {
        #[serde(rename = "terminalId")]
        terminal_id: String,
        code: String,
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalAttachSnapshot {
    pub snapshot: TerminalSnapshot,
    pub replay: Vec<TerminalEvent>,
    pub cursor: u64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSize {
    pub cols: u16,
    pub rows: u16,
    pub pixel_width: Option<u16>,
    pub pixel_height: Option<u16>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protocol_serializes_events_and_snapshots_with_camel_case_fields() {
        let snapshot = TerminalSnapshot {
            contract_version: TERMINAL_CONTRACT_VERSION,
            terminal_id: "terminal-1".into(),
            session_id: "session-1".into(),
            profile_id: "powershell".into(),
            cwd: "C:/repo".into(),
            title: "PowerShell 1".into(),
            status: TerminalStatus::Running,
            seq: 7,
            exit_code: None,
            created_at: 10,
            updated_at: 12,
        };
        let value = serde_json::to_value(&snapshot).expect("snapshot serializes");
        assert_eq!(value["contractVersion"], 1);
        assert_eq!(value["terminalId"], "terminal-1");
        assert_eq!(value["status"], "running");

        let event = TerminalEvent::Output {
            terminal_id: "terminal-1".into(),
            seq: 8,
            data_base64: "AAE=".into(),
        };
        let event_value = serde_json::to_value(&event).expect("event serializes");
        assert_eq!(event_value["event"], "output");
        assert_eq!(event_value["dataBase64"], "AAE=");
        assert_eq!(
            serde_json::from_value::<TerminalEvent>(event_value).unwrap(),
            event
        );
    }

    #[test]
    fn status_classification_is_stable() {
        assert!(TerminalStatus::Starting.is_running());
        assert!(TerminalStatus::Running.is_running());
        assert!(TerminalStatus::Exited.is_terminal());
        assert!(TerminalStatus::Failed.is_terminal());
        assert!(!TerminalStatus::Closing.is_terminal());
    }
}
