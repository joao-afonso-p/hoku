//! How a shell command is handed to a Linux terminal emulator.
//!
//! The command line is always one argv element of `bash -lc`, so a path or id cannot be
//! split into extra arguments. Callers shell-quote anything they put in that line.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaunchStyle {
    /// `bin --working-directory CWD -- bash -lc CMD`
    WorkingDirectoryDashDash,
    /// `bin --workdir CWD -e bash -lc CMD` (Konsole)
    WorkdirExec,
    /// `bin --working-directory CWD -x bash -lc CMD` (xfce4-terminal)
    WorkingDirectoryExecute,
    /// `bin --detach --directory CWD bash -lc CMD` (kitty)
    Kitty,
    /// `bin --working-directory CWD -e bash -lc CMD` (Alacritty)
    WorkingDirectoryE,
    /// `bin start --cwd CWD -- bash -lc CMD` (WezTerm)
    Wezterm,
    /// `bin --working-directory CWD bash -lc CMD` (foot)
    Foot,
    /// `bin -e bash -lc CMD` (xterm has no working-directory flag; the command `cd`s)
    Xterm,
    /// `bin -- bash -lc CMD` (xdg-terminal-exec; the command `cd`s)
    Xdg,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TerminalKind {
    pub id: &'static str,
    pub label: &'static str,
    pub bins: &'static [&'static str],
    pub style: LaunchStyle,
}

/// Preference order for "auto": common desktop terminals, then a generic fallback.
pub fn known() -> &'static [TerminalKind] {
    &[
        TerminalKind {
            id: "gnome-terminal",
            label: "GNOME Terminal",
            bins: &["gnome-terminal"],
            style: LaunchStyle::WorkingDirectoryDashDash,
        },
        TerminalKind {
            id: "kgx",
            label: "Console",
            bins: &["kgx"],
            style: LaunchStyle::WorkingDirectoryDashDash,
        },
        TerminalKind {
            id: "ptyxis",
            label: "Ptyxis",
            bins: &["ptyxis"],
            style: LaunchStyle::WorkingDirectoryDashDash,
        },
        TerminalKind {
            id: "konsole",
            label: "Konsole",
            bins: &["konsole"],
            style: LaunchStyle::WorkdirExec,
        },
        TerminalKind {
            id: "xfce4-terminal",
            label: "Xfce Terminal",
            bins: &["xfce4-terminal"],
            style: LaunchStyle::WorkingDirectoryExecute,
        },
        TerminalKind {
            id: "kitty",
            label: "kitty",
            bins: &["kitty"],
            style: LaunchStyle::Kitty,
        },
        TerminalKind {
            id: "alacritty",
            label: "Alacritty",
            bins: &["alacritty"],
            style: LaunchStyle::WorkingDirectoryE,
        },
        TerminalKind {
            id: "wezterm",
            label: "WezTerm",
            bins: &["wezterm", "wezterm-gui"],
            style: LaunchStyle::Wezterm,
        },
        TerminalKind {
            id: "foot",
            label: "foot",
            bins: &["foot"],
            style: LaunchStyle::Foot,
        },
        TerminalKind {
            id: "xterm",
            label: "xterm",
            bins: &["xterm"],
            style: LaunchStyle::Xterm,
        },
        TerminalKind {
            id: "xdg-terminal-exec",
            label: "default terminal",
            bins: &["xdg-terminal-exec"],
            style: LaunchStyle::Xdg,
        },
    ]
}

pub fn argv(style: LaunchStyle, bin: &str, cwd: &str, command_line: &str) -> Vec<String> {
    let mut v = vec![bin.to_string()];
    match style {
        LaunchStyle::WorkingDirectoryDashDash => {
            v.push("--working-directory".into());
            v.push(cwd.into());
            v.push("--".into());
        }
        LaunchStyle::WorkdirExec => {
            v.push("--workdir".into());
            v.push(cwd.into());
            v.push("-e".into());
        }
        LaunchStyle::WorkingDirectoryExecute => {
            v.push("--working-directory".into());
            v.push(cwd.into());
            v.push("-x".into());
        }
        LaunchStyle::Kitty => {
            v.push("--detach".into());
            v.push("--directory".into());
            v.push(cwd.into());
        }
        LaunchStyle::WorkingDirectoryE => {
            v.push("--working-directory".into());
            v.push(cwd.into());
            v.push("-e".into());
        }
        LaunchStyle::Wezterm => {
            v.push("start".into());
            v.push("--cwd".into());
            v.push(cwd.into());
            v.push("--".into());
        }
        LaunchStyle::Foot => {
            v.push("--working-directory".into());
            v.push(cwd.into());
        }
        LaunchStyle::Xterm => {
            v.push("-e".into());
        }
        LaunchStyle::Xdg => {
            v.push("--".into());
        }
    }
    v.push("bash".into());
    v.push("-lc".into());
    v.push(command_line.into());
    v
}

/// `pref` is the Settings value. macOS-only values (`iterm`, `terminal`) fall through to auto.
pub fn resolve<'a>(
    pref: &str,
    mut present: impl FnMut(&TerminalKind) -> bool,
) -> Option<&'a TerminalKind> {
    let all = known();
    let explicit = match pref {
        "" | "auto" | "iterm" | "terminal" => None,
        other => Some(other),
    };
    if let Some(id) = explicit {
        if let Some(kind) = all.iter().find(|k| k.id == id) {
            if present(kind) {
                return Some(kind);
            }
        }
    }
    all.iter().find(|k| present(k))
}

/// A desktop entry's `Exec=` line, as the executable's basename (field codes dropped).
pub fn exec_basename(desktop_text: &str) -> Option<String> {
    let exec = desktop_text
        .lines()
        .map(str::trim)
        .find_map(|line| line.strip_prefix("Exec="))?;
    let bin = split_exec(exec)
        .into_iter()
        .find(|token| !token.starts_with('%') && token != "env" && !token.contains('='))?;
    let base = bin.rsplit('/').next().unwrap_or(&bin);
    (!base.is_empty()).then(|| base.to_string())
}

fn split_exec(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    for c in s.chars() {
        match c {
            '"' => quoted = !quoted,
            c if c.is_whitespace() && !quoted => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            c => cur.push(c),
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// `wmctrl -lp` row → window id, when the third column is `pid`.
pub fn window_id_for_pid(listing: &str, pid: i64) -> Option<String> {
    listing.lines().find_map(|line| {
        let mut parts = line.split_whitespace();
        let id = parts.next()?;
        let _desktop = parts.next()?;
        let owner: i64 = parts.next()?.parse().ok()?;
        (owner == pid).then(|| id.to_string())
    })
}

/// `ppid` from `/proc/<pid>/stat`. `comm` may contain spaces and parentheses.
pub fn ppid_from_stat(stat: &str) -> Option<i64> {
    let end = stat.rfind(')')?;
    let rest = stat[end + 1..].trim_start();
    let mut parts = rest.split_whitespace();
    let _state = parts.next()?;
    parts.next()?.parse().ok()
}

/// Executable basename Hoku knows how to bring forward, if any.
pub fn host_label(exe: &str) -> Option<&'static str> {
    let base = exe.rsplit('/').next().unwrap_or(exe);
    match base {
        "code" => Some("VS Code"),
        "code-insiders" => Some("VS Code Insiders"),
        "gnome-terminal" | "gnome-terminal-server" => Some("GNOME Terminal"),
        "kgx" => Some("Console"),
        "ptyxis" => Some("Ptyxis"),
        "konsole" => Some("Konsole"),
        "kitty" => Some("kitty"),
        "alacritty" => Some("Alacritty"),
        "wezterm" | "wezterm-gui" => Some("WezTerm"),
        "foot" | "footclient" => Some("foot"),
        "xfce4-terminal" => Some("Xfce Terminal"),
        "xterm" => Some("xterm"),
        _ => None,
    }
}

/// `XDG_DOWNLOAD_DIR` from `user-dirs.dirs`. `$HOME` is expanded. Relative values are ignored.
pub fn downloads_from_user_dirs(text: &str, home: &str) -> Option<std::path::PathBuf> {
    for line in text.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix("XDG_DOWNLOAD_DIR=") else {
            continue;
        };
        let rest = rest.trim().trim_matches('"');
        let path = rest.replace("${HOME}", home).replace("$HOME", home);
        if path.starts_with('/') {
            return Some(std::path::PathBuf::from(path));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_stays_one_argument() {
        let cmd = "cd '/tmp/it'\\''s' && '/usr/bin/claude' --resume abcdef";
        for kind in known() {
            let argv = argv(kind.style, "/usr/bin/term", "/work/app", cmd);
            assert_eq!(argv.last().map(String::as_str), Some(cmd), "{}", kind.id);
            assert_eq!(argv[argv.len() - 3], "bash");
            assert_eq!(argv[argv.len() - 2], "-lc");
            assert!(
                !argv
                    .iter()
                    .any(|a| a.split_whitespace().count() > 1 && a != cmd),
                "{} split the command",
                kind.id
            );
        }
    }

    #[test]
    fn cwd_is_its_own_argument_when_the_terminal_has_one() {
        let argv = argv(
            LaunchStyle::WorkingDirectoryDashDash,
            "gnome-terminal",
            "/work/app",
            "cd '/work/app' && claude",
        );
        assert_eq!(
            argv,
            vec![
                "gnome-terminal",
                "--working-directory",
                "/work/app",
                "--",
                "bash",
                "-lc",
                "cd '/work/app' && claude",
            ]
        );
    }

    #[test]
    fn explicit_pref_wins_and_mac_values_fall_through() {
        let present = |k: &TerminalKind| k.id == "kitty" || k.id == "xterm";
        assert_eq!(resolve("kitty", present).unwrap().id, "kitty");
        assert_eq!(resolve("iterm", present).unwrap().id, "kitty");
        assert_eq!(resolve("terminal", present).unwrap().id, "kitty");
        assert_eq!(resolve("auto", present).unwrap().id, "kitty");
        assert_eq!(resolve("missing", present).unwrap().id, "kitty");
        assert!(resolve("auto", |_| false).is_none());
    }

    #[test]
    fn desktop_exec_basename_drops_field_codes() {
        assert_eq!(
            exec_basename("Name=Claude\nExec=/usr/bin/claude-desktop %u\n"),
            Some("claude-desktop".into())
        );
        assert_eq!(
            exec_basename("Exec=env CLAUDE=1 \"/opt/Claude Desktop/claude\" %F\n"),
            Some("claude".into())
        );
        assert_eq!(exec_basename("Name=Nope\n"), None);
    }

    #[test]
    fn wmctrl_and_stat_parsers() {
        let listing = "0x01 0 10 host Other\n0x0a2  1 4242 host Session title\n";
        assert_eq!(window_id_for_pid(listing, 4242).as_deref(), Some("0x0a2"));
        assert_eq!(window_id_for_pid(listing, 1), None);
        assert_eq!(ppid_from_stat("12 (bash) S 99 1 1"), Some(99));
        assert_eq!(ppid_from_stat("12 (code helper) S 7 1 1"), Some(7));
        assert_eq!(ppid_from_stat("nope"), None);
    }

    #[test]
    fn host_labels_skip_unrelated_binaries() {
        assert_eq!(host_label("/usr/share/code/code"), Some("VS Code"));
        assert_eq!(
            host_label("/usr/libexec/gnome-terminal-server"),
            Some("GNOME Terminal")
        );
        assert_eq!(host_label("/usr/bin/cursor"), None);
        assert_eq!(host_label("/bin/bash"), None);
    }

    #[test]
    fn user_dirs_download_expands_home() {
        let text = "XDG_DESKTOP_DIR=\"$HOME/Desktop\"\nXDG_DOWNLOAD_DIR=\"$HOME/Downloads\"\n";
        assert_eq!(
            downloads_from_user_dirs(text, "/home/me"),
            Some(std::path::PathBuf::from("/home/me/Downloads"))
        );
        assert_eq!(
            downloads_from_user_dirs("XDG_DOWNLOAD_DIR=\"Downloads\"\n", "/home/me"),
            None
        );
    }
}
