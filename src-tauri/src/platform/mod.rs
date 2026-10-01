//! OS integration that cannot be shared: opening URLs, clipboards, desktop apps,
//! terminal emulators and where Hoku's own files live.
//!
//! macOS keeps `/usr/bin/open`, Finder, `pbcopy` and `~/Library`. Linux uses `xdg-open`,
//! the installed terminal, and XDG directories. Neither side pretends to be the other.

// The argv builders are exercised on every OS. Linux is the only caller outside tests.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
mod terminal;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
mod unsupported;

#[cfg(target_os = "linux")]
use linux as os;
#[cfg(target_os = "macos")]
use macos as os;
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
use unsupported as os;

use serde::Serialize;
use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstalledApp {
    pub installed: bool,
    pub running: bool,
    pub version: Option<String>,
    pub path: Option<String>,
}

impl InstalledApp {
    #[cfg_attr(any(target_os = "macos", target_os = "linux"), allow(dead_code))]
    pub fn missing() -> Self {
        Self {
            installed: false,
            running: false,
            version: None,
            path: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalChoice {
    pub id: String,
    pub label: String,
    pub installed: bool,
}

/// What the UI needs to word itself for this operating system.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInfo {
    /// "macos" | "linux"
    pub os: &'static str,
    /// Dock badge and bounce exist here.
    pub dock: bool,
    /// Mission Control / Spaces help applies here.
    pub spaces: bool,
    pub terminals: Vec<TerminalChoice>,
}

pub fn host_info() -> HostInfo {
    os::host_info()
}

pub fn open_url(url: &str) -> Result<(), String> {
    os::open_url(url)
}

pub fn reveal(path: &str) -> Result<(), String> {
    os::reveal(path)
}

pub fn copy_text(text: &str) -> Result<(), String> {
    os::copy_text(text)
}

pub fn copy_png(bytes: &[u8]) -> Result<(), String> {
    os::copy_png(bytes)
}

pub fn claude_desktop() -> InstalledApp {
    os::claude_desktop()
}

pub fn codex_desktop() -> InstalledApp {
    os::codex_desktop()
}

pub fn claude_desktop_installed() -> bool {
    claude_desktop().installed
}

pub fn codex_desktop_installed() -> bool {
    codex_desktop().installed
}

pub fn bundled_codex_cli() -> Option<PathBuf> {
    os::bundled_codex_cli()
}

pub fn cowork_sessions_dir(home: &std::path::Path) -> PathBuf {
    os::cowork_sessions_dir(home)
}

pub fn spaces_switch_on_activate() -> bool {
    os::spaces_switch_on_activate()
}

pub fn open_spaces_settings() -> Result<(), String> {
    os::open_spaces_settings()
}

pub fn open_notification_settings() -> Result<(), String> {
    os::open_notification_settings()
}

pub fn downloads_dir() -> PathBuf {
    os::downloads_dir()
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn iterm_installed() -> bool {
    os::iterm_installed()
}

/// Run `command_line` (already a shell script) in a new terminal. Returns a short place
/// phrase for the UI, such as "GNOME Terminal window".
pub fn run_in_terminal(pref: &str, cwd: &str, command_line: &str) -> Result<String, String> {
    os::run_in_terminal(pref, cwd, command_line)
}

/// Best-effort: raise the terminal or editor that owns `pid`. `Some(label)` when a window
/// was actually raised. `None` when this OS can't select that window.
pub fn raise_pid(pid: i64) -> Option<String> {
    os::raise_pid(pid)
}
