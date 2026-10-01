//! macOS desktop integration. AppKit activation stays in `launch.rs`; this module is the
//! paths, `/usr/bin/open`, Finder and pasteboard text that the shared launch path calls.

use super::{InstalledApp, TerminalChoice};
use std::path::{Path, PathBuf};
use std::process::Command;

pub fn host_info() -> super::HostInfo {
    super::HostInfo {
        os: "macos",
        dock: true,
        spaces: true,
        terminals: vec![
            TerminalChoice {
                id: "auto".into(),
                label: "Automatic".into(),
                installed: true,
            },
            TerminalChoice {
                id: "iterm".into(),
                label: "iTerm".into(),
                installed: iterm_installed(),
            },
            TerminalChoice {
                id: "terminal".into(),
                label: "Terminal".into(),
                installed: true,
            },
        ],
    }
}

pub fn open_url(url: &str) -> Result<(), String> {
    run(Command::new("/usr/bin/open").arg(url)).map(|_| ())
}

pub fn reveal(path: &str) -> Result<(), String> {
    run(Command::new("/usr/bin/open").args(["-R", path]))
        .map(|_| ())
        .map_err(|e| format!("Finder couldn't reveal that folder. {e}"))
}

pub fn copy_text(text: &str) -> Result<(), String> {
    use std::io::Write;
    let mut child = Command::new("/usr/bin/pbcopy")
        .stdin(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("The clipboard isn't available. {e}"))?;
    child
        .stdin
        .take()
        .expect("piped")
        .write_all(text.as_bytes())
        .map_err(|e| format!("Couldn't copy. {e}"))?;
    child
        .wait()
        .map(|_| ())
        .map_err(|e| format!("Couldn't copy. {e}"))
}

pub fn copy_png(_: &[u8]) -> Result<(), String> {
    // PNG pasteboard is AppKit, in recap.rs. This path is not used on macOS.
    Err("Copying images uses the macOS pasteboard.".into())
}

pub fn claude_desktop() -> InstalledApp {
    app_at(&["/Applications/Claude.app"], "Claude")
}

pub fn codex_desktop() -> InstalledApp {
    app_at(
        &["/Applications/ChatGPT.app", "/Applications/Codex.app"],
        "ChatGPT",
    )
}

pub fn bundled_codex_cli() -> Option<PathBuf> {
    let bundled = PathBuf::from("/Applications/ChatGPT.app/Contents/Resources/codex");
    bundled.is_file().then_some(bundled)
}

pub fn cowork_sessions_dir(home: &Path) -> PathBuf {
    home.join("Library/Application Support/Claude/local-agent-mode-sessions")
}

pub fn spaces_switch_on_activate() -> bool {
    match Command::new("/usr/bin/defaults")
        .args(["read", "-g", "AppleSpacesSwitchOnActivate"])
        .output()
    {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).trim() != "0",
        _ => true,
    }
}

pub fn open_spaces_settings() -> Result<(), String> {
    run(Command::new("/usr/bin/open")
        .arg("x-apple.systempreferences:com.apple.Desktop-Settings.extension"))
    .map(|_| ())
}

pub fn open_notification_settings() -> Result<(), String> {
    run(Command::new("/usr/bin/open").arg(
        "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=com.hoku.app",
    ))
    .map(|_| ())
}

pub fn downloads_dir() -> PathBuf {
    PathBuf::from(crate::association::home_dir()).join("Downloads")
}

pub fn iterm_installed() -> bool {
    Path::new("/Applications/iTerm.app").exists()
        || Path::new(&format!(
            "{}/Applications/iTerm.app",
            crate::association::home_dir()
        ))
        .exists()
}

/// macOS opens terminals with AppleScript in `launch.rs`.
pub fn run_in_terminal(_: &str, _: &str, _: &str) -> Result<String, String> {
    Err("macOS terminals are opened with AppleScript.".into())
}

pub fn raise_pid(_: i64) -> Option<String> {
    None
}

fn app_at(candidates: &[&str], exe: &str) -> InstalledApp {
    let found = candidates.iter().map(PathBuf::from).find(|p| p.exists());
    InstalledApp {
        installed: found.is_some(),
        running: found
            .as_ref()
            .map(|p| process_running(&format!("{}/Contents/MacOS/{exe}", p.display())))
            .unwrap_or(false),
        version: found.as_deref().and_then(plist_version),
        path: found.map(|p| p.to_string_lossy().into_owned()),
    }
}

fn plist_version(app: &Path) -> Option<String> {
    let out = Command::new("/usr/bin/defaults")
        .arg("read")
        .arg(app.join("Contents/Info.plist"))
        .arg("CFBundleShortVersionString")
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn process_running(executable_path: &str) -> bool {
    Command::new("/usr/bin/pgrep")
        .args(["-f", executable_path])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn run(cmd: &mut Command) -> Result<String, String> {
    let out = cmd.output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}
