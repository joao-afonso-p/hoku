//! Linux desktop integration.
//!
//! URLs go through `xdg-open`. Claude Code sessions start in a real terminal emulator
//! (`bash -lc` of an already-quoted command). There is no AppleScript, no Spaces API and
//! no Dock. Focusing a running session is best-effort (`wmctrl`) and reports when it
//! cannot select a tab.

use super::terminal::{self, TerminalKind};
use super::{InstalledApp, TerminalChoice};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const CLAUDE_DESKTOP_FILES: &[&str] = &[
    "claude.desktop",
    "claude-desktop.desktop",
    "Claude.desktop",
    "com.anthropic.claudefordesktop.desktop",
];

const CODEX_DESKTOP_FILES: &[&str] = &[
    "codex.desktop",
    "chatgpt.desktop",
    "com.openai.codex.desktop",
];

pub fn host_info() -> super::HostInfo {
    let kinds = terminal::known();
    let any = kinds.iter().any(kind_installed);
    let mut terminals = vec![TerminalChoice {
        id: "auto".into(),
        label: "Automatic".into(),
        installed: any,
    }];
    for kind in kinds {
        let installed = kind_installed(kind);
        if installed || kind.id == "xterm" {
            terminals.push(TerminalChoice {
                id: kind.id.into(),
                label: kind.label.into(),
                installed,
            });
        }
    }
    super::HostInfo {
        os: "linux",
        dock: false,
        spaces: false,
        terminals,
    }
}

pub fn open_url(url: &str) -> Result<(), String> {
    let bin = tool("xdg-open").ok_or_else(|| "xdg-open is not installed.".to_string())?;
    run(&mut Command::new(bin).arg(url)).map(|_| ())
}

pub fn reveal(path: &str) -> Result<(), String> {
    let bin = tool("xdg-open").ok_or_else(|| "xdg-open is not installed.".to_string())?;
    let target = Path::new(path);
    let open = if target.is_dir() {
        target.to_path_buf()
    } else {
        target
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| target.to_path_buf())
    };
    run(&mut Command::new(bin).arg(open))
        .map(|_| ())
        .map_err(|e| format!("The file manager couldn't open that folder. {e}"))
}

pub fn copy_text(text: &str) -> Result<(), String> {
    write_clipboard(text.as_bytes(), None)
}

pub fn copy_png(bytes: &[u8]) -> Result<(), String> {
    write_clipboard(bytes, Some("image/png"))
}

pub fn claude_desktop() -> InstalledApp {
    desktop_app(CLAUDE_DESKTOP_FILES, &["claude-desktop", "Claude"])
}

pub fn codex_desktop() -> InstalledApp {
    desktop_app(CODEX_DESKTOP_FILES, &["codex", "chatgpt"])
}

pub fn bundled_codex_cli() -> Option<PathBuf> {
    // The macOS app bundles a CLI inside ChatGPT.app. No equivalent fixed path is known
    // on Linux; `codex` on PATH is detected separately.
    None
}

pub fn cowork_sessions_dir(home: &Path) -> PathBuf {
    let config = xdg_config_home(home);
    let data = xdg_data_home(home);
    let candidates = [
        config.join("Claude/local-agent-mode-sessions"),
        config.join("Claude-3p/local-agent-mode-sessions"),
        data.join("Claude/local-agent-mode-sessions"),
        home.join(
            ".var/app/com.anthropic.claudefordesktop/config/Claude/local-agent-mode-sessions",
        ),
    ];
    candidates
        .iter()
        .find(|p| p.is_dir())
        .cloned()
        .unwrap_or_else(|| candidates[0].clone())
}

pub fn spaces_switch_on_activate() -> bool {
    // Linux has no Mission Control switch. Callers must not show the macOS Spaces sheet.
    true
}

pub fn open_spaces_settings() -> Result<(), String> {
    Err("Desktop switching settings are a macOS feature.".into())
}

pub fn open_notification_settings() -> Result<(), String> {
    Err("Open your desktop's notification settings to manage alerts. Hoku has no Linux pane in them.".into())
}

pub fn downloads_dir() -> PathBuf {
    let home = crate::association::home_dir();
    let user_dirs = xdg_config_home(Path::new(&home)).join("user-dirs.dirs");
    if let Ok(text) = std::fs::read_to_string(&user_dirs) {
        if let Some(dir) = terminal::downloads_from_user_dirs(&text, &home) {
            return dir;
        }
    }
    PathBuf::from(home).join("Downloads")
}

#[allow(dead_code)]
pub fn iterm_installed() -> bool {
    false
}

pub fn run_in_terminal(pref: &str, cwd: &str, command_line: &str) -> Result<String, String> {
    let kind = terminal::resolve(pref, kind_installed).ok_or_else(|| {
        "No supported terminal emulator was found. Install GNOME Terminal, Konsole, kitty, Alacritty, or xterm.".to_string()
    })?;
    let bin = kind
        .bins
        .iter()
        .find_map(|name| tool(name))
        .ok_or_else(|| format!("{} is not installed.", kind.label))?;
    let argv = terminal::argv(kind.style, &bin.to_string_lossy(), cwd, command_line);
    let mut cmd = Command::new(&argv[0]);
    cmd.args(&argv[1..])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    cmd.spawn()
        .map(|_| format!("{} window", kind.label))
        .map_err(|e| format!("{} couldn't start the session. {e}", kind.label))
}

pub fn raise_pid(pid: i64) -> Option<String> {
    let wmctrl = tool("wmctrl")?;
    let mut current = pid;
    for _ in 0..12 {
        if let Some(label) = host_of_pid(current) {
            if let Some(id) = window_id(&wmctrl, current) {
                let ok = Command::new(&wmctrl)
                    .args(["-ia", &id])
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status()
                    .map(|s| s.success())
                    .unwrap_or(false);
                if ok {
                    return Some(label.to_string());
                }
            }
        }
        let parent = ppid(current)?;
        if parent <= 1 || parent == current {
            return None;
        }
        current = parent;
    }
    None
}

fn kind_installed(kind: &TerminalKind) -> bool {
    kind.bins.iter().any(|name| tool(name).is_some())
}

fn host_of_pid(pid: i64) -> Option<&'static str> {
    let exe = std::fs::read_link(format!("/proc/{pid}/exe")).ok()?;
    terminal::host_label(&exe.to_string_lossy())
}

fn ppid(pid: i64) -> Option<i64> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    terminal::ppid_from_stat(&stat)
}

fn window_id(wmctrl: &Path, pid: i64) -> Option<String> {
    let out = Command::new(wmctrl).arg("-lp").output().ok()?;
    if !out.status.success() {
        return None;
    }
    terminal::window_id_for_pid(&String::from_utf8_lossy(&out.stdout), pid)
}

fn desktop_app(files: &[&str], names: &[&str]) -> InstalledApp {
    let found = find_desktop_file(files);
    let exec_name = found
        .as_deref()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .as_deref()
        .and_then(terminal::exec_basename);
    let running_names: Vec<&str> = exec_name
        .as_deref()
        .into_iter()
        .chain(names.iter().copied())
        .collect();
    let binary = exec_name.as_deref().and_then(tool);
    InstalledApp {
        installed: found.is_some() || binary.is_some(),
        running: running_names.iter().any(|n| process_exact(n)),
        version: None,
        path: found
            .map(|p| p.to_string_lossy().into_owned())
            .or_else(|| binary.map(|p| p.to_string_lossy().into_owned())),
    }
}

fn find_desktop_file(names: &[&str]) -> Option<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(home) = std::env::var_os("XDG_DATA_HOME") {
        dirs.push(PathBuf::from(home).join("applications"));
    }
    let home = crate::association::home_dir();
    dirs.push(PathBuf::from(&home).join(".local/share/applications"));
    if let Ok(dirs_env) = std::env::var("XDG_DATA_DIRS") {
        for dir in dirs_env.split(':') {
            if !dir.is_empty() {
                dirs.push(PathBuf::from(dir).join("applications"));
            }
        }
    }
    dirs.push(PathBuf::from("/usr/share/applications"));
    dirs.push(PathBuf::from("/usr/local/share/applications"));
    dirs.push(PathBuf::from("/var/lib/flatpak/exports/share/applications"));
    dirs.push(PathBuf::from(&home).join(".local/share/flatpak/exports/share/applications"));
    for dir in dirs {
        for name in names {
            let path = dir.join(name);
            if path.is_file() {
                return Some(path);
            }
        }
    }
    None
}

fn process_exact(name: &str) -> bool {
    let Some(bin) = tool("pgrep") else {
        return false;
    };
    Command::new(bin)
        .args(["-x", name])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn write_clipboard(bytes: &[u8], mime: Option<&str>) -> Result<(), String> {
    let wayland = std::env::var_os("WAYLAND_DISPLAY").is_some();
    let mut tools: Vec<(&str, Vec<String>)> = Vec::new();
    let wl = match mime {
        Some(mime) => vec!["--type".into(), mime.into()],
        None => Vec::new(),
    };
    let xclip = match mime {
        Some(mime) => vec![
            "-selection".into(),
            "clipboard".into(),
            "-t".into(),
            mime.into(),
        ],
        None => vec!["-selection".into(), "clipboard".into()],
    };
    let xsel = vec!["--clipboard".into(), "--input".into()];
    if wayland {
        tools.push(("wl-copy", wl.clone()));
        tools.push(("xclip", xclip.clone()));
        tools.push(("xsel", xsel.clone()));
    } else {
        tools.push(("xclip", xclip));
        tools.push(("xsel", xsel));
        tools.push(("wl-copy", wl));
    }
    let mut saw_tool = false;
    let mut last = String::from("The clipboard isn't available.");
    for (name, args) in tools {
        let Some(bin) = tool(name) else {
            continue;
        };
        saw_tool = true;
        match pipe_to(&bin, &args, bytes) {
            Ok(()) => return Ok(()),
            Err(e) => last = e,
        }
    }
    if saw_tool {
        Err(last)
    } else if mime.is_some() {
        Err("Copying images needs wl-clipboard or xclip.".into())
    } else {
        Err("No clipboard tool found. Install wl-clipboard or xclip.".into())
    }
}

fn pipe_to(bin: &Path, args: &[String], bytes: &[u8]) -> Result<(), String> {
    let mut child = Command::new(bin)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    child
        .stdin
        .take()
        .expect("piped")
        .write_all(bytes)
        .map_err(|e| e.to_string())?;
    let status = child.wait().map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("{} failed", bin.display()))
    }
}

fn xdg_config_home(home: &Path) -> PathBuf {
    match std::env::var_os("XDG_CONFIG_HOME") {
        Some(p) if Path::new(&p).is_absolute() => PathBuf::from(p),
        _ => home.join(".config"),
    }
}

fn xdg_data_home(home: &Path) -> PathBuf {
    match std::env::var_os("XDG_DATA_HOME") {
        Some(p) if Path::new(&p).is_absolute() => PathBuf::from(p),
        _ => home.join(".local/share"),
    }
}

/// An executable on `PATH`, then in the usual user and system bin directories.
fn tool(name: &str) -> Option<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&path));
    }
    let home = crate::association::home_dir();
    dirs.push(PathBuf::from(&home).join(".local/bin"));
    dirs.push(PathBuf::from("/usr/bin"));
    dirs.push(PathBuf::from("/usr/local/bin"));
    dirs.push(PathBuf::from("/bin"));
    dirs.into_iter()
        .map(|d| d.join(name))
        .find(|path| is_exec(path))
}

fn is_exec(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.is_file()
        && std::fs::metadata(path)
            .map(|m| m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
}

fn run(cmd: &mut Command) -> Result<String, String> {
    let out = cmd.output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        if err.is_empty() {
            Err(format!("exit {}", out.status))
        } else {
            Err(err)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cowork_dir_prefers_an_existing_xdg_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        let expected = home.join(".config/Claude/local-agent-mode-sessions");
        std::fs::create_dir_all(&expected).unwrap();
        let prev = std::env::var_os("XDG_CONFIG_HOME");
        std::env::remove_var("XDG_CONFIG_HOME");
        let got = cowork_sessions_dir(home);
        match prev {
            Some(v) => std::env::set_var("XDG_CONFIG_HOME", v),
            None => std::env::remove_var("XDG_CONFIG_HOME"),
        }
        assert_eq!(got, expected);
    }

    #[test]
    fn missing_cowork_dir_still_points_at_xdg_config() {
        let tmp = tempfile::tempdir().unwrap();
        let prev = std::env::var_os("XDG_CONFIG_HOME");
        std::env::remove_var("XDG_CONFIG_HOME");
        let got = cowork_sessions_dir(tmp.path());
        match prev {
            Some(v) => std::env::set_var("XDG_CONFIG_HOME", v),
            None => std::env::remove_var("XDG_CONFIG_HOME"),
        }
        assert_eq!(
            got,
            tmp.path().join(".config/Claude/local-agent-mode-sessions")
        );
        assert!(!got.exists());
    }
}
