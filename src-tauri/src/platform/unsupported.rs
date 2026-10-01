//! Any OS other than macOS or Linux. Hoku does not implement Windows. These returns
//! are refusals, not stand-ins for AppKit or `xdg-open`.

use super::{InstalledApp, TerminalChoice};
use std::path::{Path, PathBuf};

pub fn host_info() -> super::HostInfo {
    super::HostInfo {
        os: "unsupported",
        dock: false,
        spaces: false,
        terminals: vec![TerminalChoice {
            id: "auto".into(),
            label: "Automatic".into(),
            installed: false,
        }],
    }
}

pub fn open_url(_: &str) -> Result<(), String> {
    Err("Opening URLs is implemented for macOS and Linux.".into())
}

pub fn reveal(_: &str) -> Result<(), String> {
    Err("Revealing files is implemented for macOS and Linux.".into())
}

pub fn copy_text(_: &str) -> Result<(), String> {
    Err("The clipboard is implemented for macOS and Linux.".into())
}

pub fn copy_png(_: &[u8]) -> Result<(), String> {
    Err("Copying images is implemented for macOS and Linux.".into())
}

pub fn claude_desktop() -> InstalledApp {
    InstalledApp::missing()
}

pub fn codex_desktop() -> InstalledApp {
    InstalledApp::missing()
}

pub fn bundled_codex_cli() -> Option<PathBuf> {
    None
}

pub fn cowork_sessions_dir(home: &Path) -> PathBuf {
    home.join(".config/Claude/local-agent-mode-sessions")
}

pub fn spaces_switch_on_activate() -> bool {
    true
}

pub fn open_spaces_settings() -> Result<(), String> {
    Err("Desktop switching settings are a macOS feature.".into())
}

pub fn open_notification_settings() -> Result<(), String> {
    Err("Notification settings aren't available on this operating system.".into())
}

pub fn downloads_dir() -> PathBuf {
    PathBuf::from(crate::association::home_dir()).join("Downloads")
}

pub fn iterm_installed() -> bool {
    false
}

pub fn run_in_terminal(_: &str, _: &str, _: &str) -> Result<String, String> {
    Err("Opening a terminal is implemented for macOS and Linux.".into())
}

pub fn raise_pid(_: i64) -> Option<String> {
    None
}
