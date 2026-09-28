//! Returning to sessions in their native tools. Every value that reaches a shell or
//! AppleScript is validated and escaped here.

use crate::models::{HubError, HubResult, Provider, Session};
use crate::providers::claude_code::read_registry;
use regex::Regex;
use serde::Serialize;
use std::path::Path;
use std::process::Command;
use std::sync::OnceLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalApp {
    ITerm,
    Terminal,
}

impl TerminalApp {
    pub fn name(&self) -> &'static str {
        match self {
            TerminalApp::ITerm => "iTerm",
            TerminalApp::Terminal => "Terminal",
        }
    }
    pub fn bundle_id(&self) -> &'static str {
        match self {
            TerminalApp::ITerm => "com.googlecode.iterm2",
            TerminalApp::Terminal => "com.apple.Terminal",
        }
    }
}

/// An app a running Claude Code session can live in: where "Go to terminal" goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostApp {
    ITerm,
    Terminal,
    VsCode,
    VsCodeInsiders,
}

impl HostApp {
    pub fn name(&self) -> &'static str {
        match self {
            HostApp::ITerm => "iTerm",
            HostApp::Terminal => "Terminal",
            HostApp::VsCode => "VS Code",
            HostApp::VsCodeInsiders => "VS Code Insiders",
        }
    }
    pub fn bundle_id(&self) -> &'static str {
        match self {
            HostApp::ITerm => TerminalApp::ITerm.bundle_id(),
            HostApp::Terminal => TerminalApp::Terminal.bundle_id(),
            HostApp::VsCode => "com.microsoft.VSCode",
            HostApp::VsCodeInsiders => "com.microsoft.VSCodeInsiders",
        }
    }
    /// The scriptable terminal behind this host, whose tabs can be selected by tty.
    pub fn terminal(&self) -> Option<TerminalApp> {
        match self {
            HostApp::ITerm => Some(TerminalApp::ITerm),
            HostApp::Terminal => Some(TerminalApp::Terminal),
            HostApp::VsCode | HostApp::VsCodeInsiders => None,
        }
    }
}

/// Apps Hoku may hand the foreground to: every `HostApp`.
pub const HOST_BUNDLES: [&str; 4] = [
    "com.googlecode.iterm2",
    "com.apple.Terminal",
    "com.microsoft.VSCode",
    "com.microsoft.VSCodeInsiders",
];

/// Since macOS 14 activation is cooperative: an app only comes forward if the frontmost app
/// yields to it *before* it asks. So at click time — while Hoku is still frontmost — Hoku
/// yields to the terminals; their own AppleScript `activate` is then honoured. Main thread only.
#[cfg(target_os = "macos")]
pub fn yield_to(bundle_ids: &[&str]) {
    use objc2::{msg_send, runtime::Bool, sel, MainThreadMarker};
    use objc2_app_kit::NSApplication;
    use objc2_foundation::NSString;
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let me = NSApplication::sharedApplication(mtm);
    let can_yield: Bool = unsafe {
        msg_send![&*me, respondsToSelector: sel!(yieldActivationToApplicationWithBundleIdentifier:)]
    };
    if can_yield.as_bool() {
        for id in bundle_ids {
            me.yieldActivationToApplicationWithBundleIdentifier(&NSString::from_str(id));
        }
    }
}

/// Bring an app forward from Hoku's own process (after `yield_to`). Main thread only.
#[cfg(target_os = "macos")]
pub fn activate_app(bundle_id: &str) -> bool {
    use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication};
    use objc2_foundation::NSString;
    let apps = NSRunningApplication::runningApplicationsWithBundleIdentifier(&NSString::from_str(
        bundle_id,
    ));
    let Some(target) = apps.firstObject() else {
        return false;
    };
    target.activateWithOptions(NSApplicationActivationOptions::ActivateAllWindows)
}

/// Is that app frontmost now?
#[cfg(target_os = "macos")]
pub fn is_active(bundle_id: &str) -> bool {
    use objc2_app_kit::NSRunningApplication;
    use objc2_foundation::NSString;
    NSRunningApplication::runningApplicationsWithBundleIdentifier(&NSString::from_str(bundle_id))
        .firstObject()
        .map(|a| a.isActive())
        .unwrap_or(false)
}

#[cfg(not(target_os = "macos"))]
pub fn yield_to(_: &[&str]) {}
#[cfg(not(target_os = "macos"))]
pub fn activate_app(_: &str) -> bool {
    false
}
#[cfg(not(target_os = "macos"))]
pub fn is_active(_: &str) -> bool {
    true
}

/// Fallback when in-process activation isn't possible.
pub fn open_by_bundle(bundle_id: &str) {
    let _ = Command::new("/usr/bin/open")
        .args(["-b", bundle_id])
        .status();
}

pub fn iterm_installed() -> bool {
    Path::new("/Applications/iTerm.app").exists()
        || Path::new(&format!(
            "{}/Applications/iTerm.app",
            crate::association::home_dir()
        ))
        .exists()
}

/// `pref` is the user's setting: "auto" | "iterm" | "terminal".
pub fn preferred_terminal(pref: &str) -> TerminalApp {
    match pref {
        "terminal" => TerminalApp::Terminal,
        "iterm" if iterm_installed() => TerminalApp::ITerm,
        _ if iterm_installed() => TerminalApp::ITerm,
        _ => TerminalApp::Terminal,
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenResult {
    /// "deep-link" | "attach" | "resume" | "focus" | "fallback"
    pub method: String,
    pub message: String,
    /// Bundle id to bring to the front afterwards (terminals). Done by the IPC layer on the
    /// main thread, where macOS lets Hoku yield activation.
    #[serde(skip)]
    pub activate: Option<String>,
    /// UI follow-up: "spaces-setting" = explain the macOS desktop-switching setting.
    pub hint: Option<String>,
}

fn ok(method: &str, message: impl Into<String>) -> HubResult<OpenResult> {
    Ok(OpenResult {
        method: method.into(),
        message: message.into(),
        activate: None,
        hint: None,
    })
}

fn ok_in(app: TerminalApp, method: &str, message: impl Into<String>) -> HubResult<OpenResult> {
    Ok(OpenResult {
        method: method.into(),
        message: message.into(),
        activate: Some(app.bundle_id().into()),
        hint: None,
    })
}

// ───────────────────────────── validation & escaping ─────────────────────────────

fn session_id_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    // The first character can't be `-`, so an id is never parsed as a CLI flag.
    RE.get_or_init(|| Regex::new(r"^[A-Za-z0-9][A-Za-z0-9_-]{5,79}$").unwrap())
}

pub fn validate_id(id: &str) -> HubResult<&str> {
    if session_id_re().is_match(id) {
        Ok(id)
    } else {
        Err(HubError::with_detail(
            "This session has an ID Hoku won't pass to a terminal.",
            id,
        ))
    }
}

/// POSIX single-quote a string for the shell.
pub fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// Escape a string for inclusion in an AppleScript double-quoted literal.
pub fn applescript_string(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

fn existing_dir(dir: Option<&str>) -> HubResult<&str> {
    let d =
        dir.ok_or_else(|| HubError::new("This session has no working directory to open it from."))?;
    if !d.starts_with('/') || !Path::new(d).is_dir() {
        return Err(HubError::with_detail(
            "The folder this session was started in no longer exists.",
            d,
        ));
    }
    Ok(d)
}

// ───────────────────────────── primitives ─────────────────────────────

fn run(cmd: &mut Command) -> Result<String, String> {
    let out = cmd.output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

pub fn osascript(script: &str) -> Result<String, String> {
    run(Command::new("/usr/bin/osascript").arg("-e").arg(script))
}

fn allowed_url(url: &str) -> bool {
    [
        "claude://",
        "codex://",
        "https://claude.ai/",
        "https://chatgpt.com/",
    ]
    .iter()
    .any(|p| url.starts_with(p))
}

pub fn open_url(url: &str) -> Result<(), String> {
    if !allowed_url(url) {
        return Err(format!("refusing to open unexpected URL: {url}"));
    }
    run(Command::new("/usr/bin/open").arg(url)).map(|_| ())
}

pub fn reveal(path: &str) -> HubResult<()> {
    if !Path::new(path).exists() {
        return Err(HubError::with_detail("That folder no longer exists.", path));
    }
    run(Command::new("/usr/bin/open").arg("-R").arg(path))
        .map(|_| ())
        .map_err(|e| HubError::with_detail("Finder couldn't reveal that folder.", e))
}

pub fn copy_to_clipboard(text: &str) -> HubResult<()> {
    use std::io::Write;
    let mut child = Command::new("/usr/bin/pbcopy")
        .stdin(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| HubError::with_detail("The clipboard isn't available.", e))?;
    child
        .stdin
        .take()
        .expect("piped")
        .write_all(text.as_bytes())
        .map_err(|e| HubError::with_detail("Couldn't copy.", e))?;
    child
        .wait()
        .map_err(|e| HubError::with_detail("Couldn't copy.", e))?;
    Ok(())
}

pub fn app_installed(bundle_path: &str) -> bool {
    Path::new(bundle_path).exists()
}

/// Run a shell command line in a new terminal window.
/// AppleScript that runs `cmd` in iTerm: as a new tab of window `into` when given, otherwise
/// in a new window (created on the current desktop).
pub fn iterm_script(cmd: &str, into: Option<i64>) -> String {
    match into {
        Some(id) => format!(
            "tell application \"iTerm\"\n set w to (first window whose id is {id})\n tell w\n  set t to (create tab with default profile)\n  tell current session of t to write text {cmd}\n end tell\n select w\n activate\nend tell"
        ),
        None => format!(
            "tell application \"iTerm\"\n activate\n set w to (create window with default profile)\n tell current session of w to write text {cmd}\nend tell"
        ),
    }
}

/// The frontmost iTerm window on the desktop you're looking at. A tab added to a window on
/// another desktop would be invisible, so windows elsewhere don't count.
fn iterm_window_here() -> Option<i64> {
    // `windows` lists front to back.
    let ids = osascript("tell application \"iTerm\" to get id of windows").ok()?;
    ids.split(',')
        .filter_map(|s| s.trim().parse::<i64>().ok())
        .find(|id| window_on_current_space(*id))
}

/// Run a command in the user's terminal. iTerm: a new tab in the frontmost window on this
/// desktop (a new window only if there's none). Terminal.app can't open tabs without
/// Accessibility access, so it gets a window. Returns where it went, for the message.
pub fn run_in_terminal(app: TerminalApp, command_line: &str) -> HubResult<&'static str> {
    let cmd = applescript_string(command_line);
    let (script, place) = match app {
        TerminalApp::ITerm => match iterm_window_here() {
            Some(id) => (iterm_script(&cmd, Some(id)), "tab"),
            None => (iterm_script(&cmd, None), "window"),
        },
        TerminalApp::Terminal => (
            format!("tell application \"Terminal\"\n activate\n do script {cmd}\nend tell"),
            "window",
        ),
    };
    osascript(&script).map(|_| place).map_err(|e| {
        let msg = if e.contains("-1743") || e.to_lowercase().contains("not allowed") {
            format!("macOS blocked Hoku from controlling {}. Allow it in System Settings → Privacy & Security → Automation.", app.name())
        } else {
            format!("{} couldn't start the session.", app.name())
        };
        HubError::with_detail(msg, e)
    })
}

fn tty_of(pid: i64) -> Option<String> {
    let out = run(Command::new("/bin/ps").args(["-o", "tty=", "-p", &pid.to_string()])).ok()?;
    let t = out.trim();
    if t.is_empty() || t == "??" {
        None
    } else {
        Some(format!("/dev/{t}"))
    }
}

/// A terminal already attached to background job `job` (`claude attach <job>`): its pid and tty.
/// Going to the session then means switching to that tab, not attaching a second time.
pub fn attached_client(job: &str) -> Option<(i64, String)> {
    let out = run(Command::new("/bin/ps").args(["-axo", "pid=,tty=,command="])).ok()?;
    find_attached(&out, job)
}

pub fn find_attached(ps: &str, job: &str) -> Option<(i64, String)> {
    ps.lines().find_map(|line| {
        let mut parts = line.split_whitespace();
        let pid: i64 = parts.next()?.parse().ok()?;
        let tty = parts.next()?;
        let args: Vec<&str> = parts.collect();
        let is_claude = args
            .first()
            .map(|a| a.ends_with("claude") || a.contains("/claude/versions/"))
            .unwrap_or(false);
        let attaches = args.windows(2).any(|w| w[0] == "attach" && w[1] == job);
        (is_claude && attaches && tty != "??").then(|| (pid, format!("/dev/{tty}")))
    })
}

/// Which host app an executable belongs to, from its `ps -o comm=` (the full executable path
/// on macOS). VS Code is recognised only by its own bundle or its `Code Helper` processes, so
/// other Electron apps and VS Code forks (Cursor, VSCodium, Windsurf…) never match.
pub fn host_of_executable(comm: &str) -> Option<HostApp> {
    if comm.contains("iTerm") {
        return Some(HostApp::ITerm);
    }
    if comm.ends_with("/Terminal") || comm == "Terminal" {
        return Some(HostApp::Terminal);
    }
    if comm.contains("/Visual Studio Code - Insiders.app/") {
        return Some(HostApp::VsCodeInsiders);
    }
    if comm.contains("/Visual Studio Code.app/") {
        return Some(HostApp::VsCode);
    }
    // A renamed or relocated bundle still runs its helpers under their own names:
    // `Code Helper`, `Code Helper (Plugin)`, `Code - Insiders Helper (Renderer)`…
    let exe = comm.rsplit('/').next().unwrap_or(comm);
    if exe.starts_with("Code - Insiders Helper") {
        return Some(HostApp::VsCodeInsiders);
    }
    if exe == "Code Helper" || exe.starts_with("Code Helper (") {
        return Some(HostApp::VsCode);
    }
    None
}

/// Walk up from `pid` through a `ps -axo pid=,ppid=,comm=` listing to the first host app.
/// In VS Code the chain is `claude` ← shell ← `Code Helper` (the terminal's pty host) ← `Code`;
/// started by an extension it is `claude` ← `Code Helper (Plugin)`. tmux and screen servers
/// are re-parented to launchd, so a session inside them has no host.
pub fn host_in_process_list(ps: &str, pid: i64) -> Option<HostApp> {
    let procs: std::collections::HashMap<i64, (i64, &str)> = ps
        .lines()
        .filter_map(|line| {
            let line = line.trim_start();
            let (pid, rest) = line.split_once(char::is_whitespace)?;
            let (ppid, comm) = rest.trim_start().split_once(char::is_whitespace)?;
            Some((pid.parse().ok()?, (ppid.parse().ok()?, comm.trim())))
        })
        .collect();
    let mut current = pid;
    for _ in 0..12 {
        let (ppid, comm) = procs.get(&current)?;
        if let Some(host) = host_of_executable(comm) {
            return Some(host);
        }
        if *ppid <= 1 {
            return None;
        }
        current = *ppid;
    }
    None
}

/// Which app hosts `pid`, from one snapshot of the process table.
fn hosting_app(pid: i64) -> Option<HostApp> {
    let ps = run(Command::new("/bin/ps").args(["-axo", "pid=,ppid=,comm="])).ok()?;
    host_in_process_list(&ps, pid)
}

/// Select the tab hosting `tty`. Returns the id of the window holding it (for iTerm and
/// Terminal this is the macOS window number), or None if no tab has that tty.
fn focus_tty(app: TerminalApp, tty: &str) -> Result<Option<i64>, String> {
    let t = applescript_string(tty);
    let script = match app {
        TerminalApp::ITerm => format!(
            "tell application \"iTerm\"
               repeat with w in windows
                 repeat with t in tabs of w
                   repeat with s in sessions of t
                     if tty of s is {t} then
                       select w
                       tell t to select
                       tell s to select
                       activate
                       return \"found:\" & (id of w)
                     end if
                   end repeat
                 end repeat
               end repeat
             end tell
             return \"missing\""
        ),
        TerminalApp::Terminal => format!(
            "tell application \"Terminal\"
               repeat with w in windows
                 repeat with t in tabs of w
                   if tty of t is {t} then
                     set selected of t to true
                     set index of w to 1
                     activate
                     return \"found:\" & (id of w)
                   end if
                 end repeat
               end repeat
             end tell
             return \"missing\""
        ),
    };
    osascript(&script).map(|r| {
        r.strip_prefix("found:")
            .and_then(|id| id.trim().parse().ok())
    })
}

/// Is this window on the Space the user is looking at? (`kCGWindowListOptionOnScreenOnly`
/// lists exactly the windows of the current Space(s).)
#[cfg(target_os = "macos")]
pub fn window_on_current_space(window_id: i64) -> bool {
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2_foundation::{NSArray, NSDictionary, NSNumber, NSString};
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGWindowListCopyWindowInfo(option: u32, relative_to: u32) -> *mut AnyObject;
    }
    const ON_SCREEN_ONLY: u32 = 1;
    // CFArray of CFDictionary, toll-free bridged; "Copy" → we own it.
    let raw = unsafe { CGWindowListCopyWindowInfo(ON_SCREEN_ONLY, 0) };
    let Some(list) =
        (unsafe { Retained::from_raw(raw as *mut NSArray<NSDictionary<NSString, AnyObject>>) })
    else {
        return true;
    };
    let key = NSString::from_str("kCGWindowNumber");
    list.iter().any(|w| {
        w.objectForKey(&key)
            .and_then(|n| n.downcast::<NSNumber>().ok())
            .map(|n| n.as_i64() == window_id)
            .unwrap_or(false)
    })
}

#[cfg(not(target_os = "macos"))]
pub fn window_on_current_space(_: i64) -> bool {
    true
}

/// Does the running app with this bundle id have a normal window on the Space the user is
/// looking at? For apps without a scriptable window list (VS Code). Owner pid and layer are
/// readable without Screen Recording permission; window titles are not, and aren't used.
#[cfg(target_os = "macos")]
pub fn app_window_on_current_space(bundle_id: &str) -> bool {
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2_app_kit::NSRunningApplication;
    use objc2_foundation::{NSArray, NSDictionary, NSNumber, NSString};
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGWindowListCopyWindowInfo(option: u32, relative_to: u32) -> *mut AnyObject;
    }
    const ON_SCREEN_ONLY: u32 = 1;
    let Some(app) = NSRunningApplication::runningApplicationsWithBundleIdentifier(
        &NSString::from_str(bundle_id),
    )
    .firstObject() else {
        return true;
    };
    let pid = app.processIdentifier() as i64;
    let raw = unsafe { CGWindowListCopyWindowInfo(ON_SCREEN_ONLY, 0) };
    let Some(list) =
        (unsafe { Retained::from_raw(raw as *mut NSArray<NSDictionary<NSString, AnyObject>>) })
    else {
        return true;
    };
    let number = |w: &NSDictionary<NSString, AnyObject>, key: &str| {
        w.objectForKey(&NSString::from_str(key))
            .and_then(|n| n.downcast::<NSNumber>().ok())
            .map(|n| n.as_i64())
    };
    list.iter().any(|w| {
        number(&w, "kCGWindowOwnerPID") == Some(pid) && number(&w, "kCGWindowLayer") == Some(0)
    })
}

#[cfg(not(target_os = "macos"))]
pub fn app_window_on_current_space(_: &str) -> bool {
    true
}

/// A restored window takes a moment to land (the un-minimize animation). Poll, don't guess.
fn wait_until_on_current_space(window_id: i64, timeout: std::time::Duration) -> bool {
    let start = std::time::Instant::now();
    loop {
        if window_on_current_space(window_id) {
            return true;
        }
        if start.elapsed() > timeout {
            return false;
        }
        std::thread::sleep(std::time::Duration::from_millis(60));
    }
}

/// System Settings → Desktop & Dock → Mission Control → "When switching to an application,
/// switch to a Space with open windows for the application". macOS's default is on.
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

/// Hoku's own pane in System Settings → Notifications (a fixed URL, no input).
pub fn open_notification_settings() -> Result<(), String> {
    run(Command::new("/usr/bin/open").arg(
        "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=com.hoku.app",
    ))
    .map(|_| ())
}

/// Bring a terminal window to the current Space: macOS restores a minimized window onto the
/// Space you're on. Used only when the window is on another desktop and macOS is set not to
/// switch desktops on activation (System Settings → Desktop & Dock → Mission Control).
fn bring_window_here(app: TerminalApp, window_id: i64) -> Result<(), String> {
    let script = format!(
        "tell application \"{name}\"
           set w to (first window whose id is {window_id})
           set miniaturized of w to true
           repeat 40 times
             if miniaturized of w then exit repeat
             delay 0.05
           end repeat
           delay 0.15
           set miniaturized of w to false
           set index of w to 1
         end tell",
        name = if app == TerminalApp::ITerm {
            "iTerm"
        } else {
            "Terminal"
        },
    );
    osascript(&script).map(|_| ())
}

/// Go to a session in a host without scriptable terminal tabs (VS Code): the caller activates
/// the app, which brings its windows forward. Nothing is started.
fn focus_host_app(host: HostApp, ctx: &LaunchContext) -> OpenResult {
    let elsewhere = !ctx.hoku_fullscreen
        && !spaces_switch_on_activate()
        && !app_window_on_current_space(host.bundle_id());
    host_app_result(host, elsewhere)
}

/// VS Code exposes no API to select one of its integrated-terminal tabs from outside the app,
/// so the message says where to look. `elsewhere`: its windows are on another desktop and macOS
/// won't switch there on activation; they can't be moved here without Accessibility access.
pub fn host_app_result(host: HostApp, elsewhere: bool) -> OpenResult {
    let (message, hint) = if elsewhere {
        (
            format!("The session is in {} on another desktop", host.name()),
            Some("spaces-setting".into()),
        )
    } else {
        (
            format!(
                "Switched to {}, where this session is running. Hoku can't select its terminal tab there.",
                host.name()
            ),
            None,
        )
    };
    OpenResult {
        method: "focus".into(),
        message,
        activate: Some(host.bundle_id().into()),
        hint,
    }
}

// ───────────────────────────── per provider ─────────────────────────────

pub struct LaunchContext {
    pub claude_bin: Option<String>,
    pub terminal_pref: String,
    pub claude_home: std::path::PathBuf,
    /// Hoku is in its own full-screen Space: activating another app always leaves it, so a
    /// terminal on another desktop is reachable without moving it.
    pub hoku_fullscreen: bool,
}

/// "Go to terminal" / "Open in …": decided from live state at call time, never from the last
/// scan. A live Claude Code session is focused or attached — never started a second time.
pub fn open_session(session: &Session, ctx: &LaunchContext) -> HubResult<OpenResult> {
    match session.provider {
        Provider::ClaudeCode => open_claude_code(session, ctx),
        Provider::Codex => open_codex(session),
        Provider::Claude => open_claude(session),
    }
}

fn open_claude(session: &Session) -> HubResult<OpenResult> {
    let link = session
        .deep_link
        .as_deref()
        .ok_or_else(|| HubError::new("This Claude session has no link to open."))?;
    if !app_installed("/Applications/Claude.app") {
        if let Some(web) = session.source_url.as_deref() {
            open_url(web).map_err(|e| {
                HubError::with_detail("The conversation couldn't be opened in your browser.", e)
            })?;
            return ok(
                "fallback",
                "Claude Desktop isn't installed. Opened the conversation on claude.ai instead.",
            );
        }
        return Err(HubError::new("Claude Desktop isn't installed on this Mac."));
    }
    open_url(link).map_err(|e| {
        HubError::with_detail(
            "This Claude conversation could not be opened. The deep link may no longer be valid.",
            e,
        )
    })?;
    ok("deep-link", "Opened in Claude")
}

fn open_codex(session: &Session) -> HubResult<OpenResult> {
    let id = validate_id(session.external_id.as_deref().unwrap_or(""))?;
    if !app_installed("/Applications/ChatGPT.app") && !app_installed("/Applications/Codex.app") {
        copy_to_clipboard(id)?;
        return Err(HubError::new(
            "Codex Desktop isn't installed. The thread ID was copied to your clipboard.",
        ));
    }
    let link = format!("codex://threads/{id}");
    open_url(&link).map_err(|e| HubError::with_detail("Codex couldn't open this thread.", e))?;
    ok("deep-link", "Opened in Codex")
}

fn open_claude_code(session: &Session, ctx: &LaunchContext) -> HubResult<OpenResult> {
    let id = validate_id(session.external_id.as_deref().unwrap_or(""))?;
    let claude = ctx
        .claude_bin
        .clone()
        .ok_or_else(|| HubError::new("Claude Code was not found on this Mac."))?;
    let terminal = preferred_terminal(&ctx.terminal_pref);

    let registry = read_registry(&ctx.claude_home.join("sessions"));
    if let Some(live) = registry.get(id) {
        if live.is_background() {
            if let Some(job) = live.job_id.as_deref() {
                let job = validate_id(job)?;
                // Already attached in a terminal tab? Switch to it rather than attach again.
                if let Some((pid, tty)) = attached_client(job) {
                    let host = hosting_app(pid);
                    if let Some(host) = host.filter(|h| h.terminal().is_none()) {
                        return Ok(focus_host_app(host, ctx));
                    }
                    if let Some(app) = host.and_then(|h| h.terminal()) {
                        if let Ok(Some(_)) = focus_tty(app, &tty) {
                            return ok_in(
                                app,
                                "focus",
                                format!(
                                    "Switched to the tab attached to this session in {}",
                                    app.name()
                                ),
                            );
                        }
                    }
                }
                let cwd =
                    existing_dir(live.cwd.as_deref().or(session.working_directory.as_deref()))
                        .map(shell_quote)
                        .unwrap_or_else(|_| "~".into());
                let place = run_in_terminal(
                    terminal,
                    &format!("cd {cwd} && {} attach {job}", shell_quote(&claude)),
                )?;
                return ok_in(
                    terminal,
                    "attach",
                    format!(
                        "Attached to the background session in a new {} {place}",
                        terminal.name()
                    ),
                );
            }
            return Err(HubError::with_detail(
                "This background session is running, but Claude Code didn't publish an id to attach to. Open it with `claude agents`.",
                format!("pid {}", live.pid),
            ));
        } else {
            let host = hosting_app(live.pid);
            // VS Code: bring the app forward. Its terminal tabs can't be selected from outside.
            if let Some(host) = host.filter(|h| h.terminal().is_none()) {
                return Ok(focus_host_app(host, ctx));
            }
            if let (Some(app), Some(tty)) = (host.and_then(|h| h.terminal()), tty_of(live.pid)) {
                match focus_tty(app, &tty) {
                    Ok(Some(window)) => {
                        // A tab on another desktop: activation alone won't show it unless macOS
                        // switches Spaces, so move the window here instead.
                        let mut message = format!("Switched to the running session in {}", app.name());
                        let mut hint = None;
                        // With macOS's default (switch Spaces on activation) activation alone gets
                        // you there; only when that's off do we bring the window to you.
                        if !ctx.hoku_fullscreen && !spaces_switch_on_activate() && !window_on_current_space(window) {
                            let arrived = bring_window_here(app, window).is_ok() && wait_until_on_current_space(window, std::time::Duration::from_millis(1800));
                            if arrived {
                                message = format!("Moved {} to this desktop and switched to the session", app.name());
                            } else {
                                message = format!("The session is in {} on another desktop", app.name());
                                hint = Some("spaces-setting".into());
                            }
                        }
                        // The caller brings the app forward on the main thread (see `activate_app`).
                        return Ok(OpenResult { method: "focus".into(), message, activate: Some(app.bundle_id().into()), hint });
                    }
                    Ok(None) => {}
                    Err(e) if e.contains("-1743") => {
                        return Err(HubError::with_detail(
                            format!("This session is running in {}, but macOS blocked Hoku from switching to it. Allow it in System Settings → Privacy & Security → Automation.", app.name()),
                            e,
                        ))
                    }
                    Err(_) => {}
                }
            }
            // Never start a second copy of a live session: two processes on one conversation
            // conflict. Say where it is instead.
            return Err(HubError {
                message: "This session is already running in a terminal Hoku can't switch to (for example Warp or tmux). Go to it there.".into(),
                detail: Some(format!("pid {} · opening another copy would conflict with it", live.pid)),
            });
        }
    }

    if session.source_missing {
        return Err(HubError::new(
            "Claude Code no longer has this conversation on disk (it was cleaned up), so it can't be resumed.",
        ));
    }
    let cwd = existing_dir(session.working_directory.as_deref())?;
    let place = run_in_terminal(
        terminal,
        &format!(
            "cd {} && {} --resume {id}",
            shell_quote(cwd),
            shell_quote(&claude)
        ),
    )?;
    ok_in(
        terminal,
        "resume",
        format!("Resumed in a new {} {place}", terminal.name()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quoting_neutralizes_injection() {
        assert_eq!(shell_quote("/a/it's here"), r"'/a/it'\''s here'");
        assert_eq!(
            applescript_string(r#"say "hi" \ bye"#),
            r#""say \"hi\" \\ bye""#
        );
    }

    #[test]
    fn ids_are_validated() {
        assert!(validate_id("4d44b29a-bb72-4b82-81b2-79126dae948c").is_ok());
        assert!(validate_id("4d44b29a").is_ok());
        assert!(validate_id("x; rm -rf ~").is_err());
        assert!(validate_id("abc").is_err());
        assert!(validate_id("--dangerously-skip-permissions").is_err());
        assert!(validate_id("-abcdef").is_err());
    }

    /// `HOKU_WINDOW_IDS=1,2 cargo test probe_window_space -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn probe_window_space() {
        for id in std::env::var("HOKU_WINDOW_IDS")
            .unwrap_or_default()
            .split(',')
            .filter_map(|s| s.parse::<i64>().ok())
        {
            println!(
                "window {id} on current space: {}",
                window_on_current_space(id)
            );
        }
    }

    #[test]
    fn finds_an_existing_attach_client() {
        let ps = "  101 ttys003  -zsh\n  202 ttys004  /Users/j/.local/bin/claude attach 8cd6e7fd\n  303 ??       /Users/j/.local/share/claude/versions/2.1.282 attach 8cd6e7fd\n";
        assert_eq!(
            find_attached(ps, "8cd6e7fd"),
            Some((202, "/dev/ttys004".into()))
        );
        assert_eq!(find_attached(ps, "ffffffff"), None);
        // A shell that merely mentions the words isn't a client.
        assert_eq!(
            find_attached(
                "  9 ttys001  vim notes-about-claude-attach 8cd6e7fd\n",
                "8cd6e7fd"
            ),
            None
        );
    }

    #[test]
    fn iterm_reuses_a_window_as_a_new_tab() {
        let cmd = applescript_string("cd '/x' && claude --resume abc123");
        let tab = iterm_script(&cmd, Some(4242));
        assert!(
            tab.contains("first window whose id is 4242")
                && tab.contains("create tab with default profile")
        );
        assert!(!tab.contains("create window"));
        let window = iterm_script(&cmd, None);
        assert!(
            window.contains("create window with default profile") && !window.contains("create tab")
        );
    }

    const VSCODE: &str = "/Applications/Visual Studio Code.app/Contents";

    #[test]
    fn recognises_host_apps_by_executable() {
        let cases = [
            ("/Applications/iTerm.app/Contents/MacOS/iTerm2", Some(HostApp::ITerm)),
            ("/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal", Some(HostApp::Terminal)),
            (&format!("{VSCODE}/MacOS/Code"), Some(HostApp::VsCode)),
            (&format!("{VSCODE}/Frameworks/Code Helper.app/Contents/MacOS/Code Helper"), Some(HostApp::VsCode)),
            ("/Applications/Visual Studio Code - Insiders.app/Contents/MacOS/Code - Insiders", Some(HostApp::VsCodeInsiders)),
            // Renamed bundle: its helpers still say what they are.
            ("/Applications/VS Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)", Some(HostApp::VsCode)),
            ("/Applications/Code2.app/Contents/Frameworks/Code - Insiders Helper.app/Contents/MacOS/Code - Insiders Helper", Some(HostApp::VsCodeInsiders)),
            // VS Code forks and other Electron apps are not VS Code.
            ("/Applications/Cursor.app/Contents/Frameworks/Cursor Helper.app/Contents/MacOS/Cursor Helper", None),
            ("/Applications/Cursor.app/Contents/MacOS/Cursor", None),
            ("/Applications/VSCodium.app/Contents/Frameworks/VSCodium Helper.app/Contents/MacOS/VSCodium Helper", None),
            ("/Applications/Windsurf.app/Contents/MacOS/Electron", None),
            ("/Applications/Slack.app/Contents/Frameworks/Slack Helper.app/Contents/MacOS/Slack Helper", None),
            ("/Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper", None),
            ("/System/Library/PrivateFrameworks/TextInputUIMacHelper.framework/Versions/A/XPCServices/CursorUIViewService.xpc/Contents/MacOS/CursorUIViewService", None),
            ("/Applications/Warp.app/Contents/MacOS/stable", None),
            ("/bin/zsh", None),
            ("-zsh", None),
            ("tmux", None),
        ];
        for (comm, want) in cases {
            assert_eq!(host_of_executable(comm), want, "{comm}");
        }
    }

    #[test]
    fn walks_the_process_tree_to_the_host() {
        let ps = format!(
            "    1     0 /sbin/launchd
  500     1 {VSCODE}/MacOS/Code
  510   500 {VSCODE}/Frameworks/Code Helper.app/Contents/MacOS/Code Helper
  511   500 {VSCODE}/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)
  520   510 /bin/zsh
  521   520 /Users/j/.local/share/claude/versions/2.1.282
  530   511 /Users/j/.local/share/claude/versions/2.1.282
  600     1 /Applications/iTerm.app/Contents/MacOS/iTerm2
  601   600 /usr/bin/login
  602   601 -zsh
  603   602 claude
  700     1 /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal
  701   700 login
  702   701 -zsh
  703   702 claude
  800     1 tmux
  801   800 -zsh
  802   801 claude
  900     1 /Applications/Cursor.app/Contents/MacOS/Cursor
  910   900 /Applications/Cursor.app/Contents/Frameworks/Cursor Helper.app/Contents/MacOS/Cursor Helper
  920   910 /bin/zsh
  921   920 claude
 1000     1 /Applications/Warp.app/Contents/MacOS/stable
 1001  1000 /bin/zsh
 1002  1001 claude
 1100     1 /Applications/Visual Studio Code - Insiders.app/Contents/MacOS/Code - Insiders
 1110  1100 /Applications/Visual Studio Code - Insiders.app/Contents/Frameworks/Code - Insiders Helper.app/Contents/MacOS/Code - Insiders Helper
 1120  1110 /bin/zsh
 1121  1120 claude
"
        );
        // Integrated terminal: claude ← zsh ← Code Helper (pty host).
        assert_eq!(host_in_process_list(&ps, 521), Some(HostApp::VsCode));
        // Started by an extension: claude ← Code Helper (Plugin).
        assert_eq!(host_in_process_list(&ps, 530), Some(HostApp::VsCode));
        assert_eq!(
            host_in_process_list(&ps, 1121),
            Some(HostApp::VsCodeInsiders)
        );
        assert_eq!(host_in_process_list(&ps, 603), Some(HostApp::ITerm));
        assert_eq!(host_in_process_list(&ps, 703), Some(HostApp::Terminal));
        // Unsupported hosts keep the safe "go to it there" answer.
        assert_eq!(host_in_process_list(&ps, 802), None, "tmux");
        assert_eq!(host_in_process_list(&ps, 921), None, "Cursor");
        assert_eq!(host_in_process_list(&ps, 1002), None, "Warp");
        assert_eq!(host_in_process_list(&ps, 4242), None, "gone");
        // A parent loop can't hang the walk.
        assert_eq!(host_in_process_list("  5  6 a\n  6  5 b\n", 5), None);
    }

    #[test]
    fn every_host_is_yielded_to_and_only_terminals_have_tabs() {
        for host in [
            HostApp::ITerm,
            HostApp::Terminal,
            HostApp::VsCode,
            HostApp::VsCodeInsiders,
        ] {
            assert!(HOST_BUNDLES.contains(&host.bundle_id()), "{host:?}");
        }
        assert_eq!(HostApp::VsCode.bundle_id(), "com.microsoft.VSCode");
        assert_eq!(
            HostApp::VsCodeInsiders.bundle_id(),
            "com.microsoft.VSCodeInsiders"
        );
        assert_eq!(HostApp::ITerm.terminal(), Some(TerminalApp::ITerm));
        assert_eq!(HostApp::Terminal.terminal(), Some(TerminalApp::Terminal));
        assert_eq!(HostApp::VsCode.terminal(), None);
        assert_eq!(HostApp::VsCodeInsiders.terminal(), None);
    }

    #[test]
    fn vscode_is_focused_not_relaunched() {
        let r = host_app_result(HostApp::VsCode, false);
        assert_eq!(r.method, "focus");
        assert_eq!(r.activate.as_deref(), Some("com.microsoft.VSCode"));
        assert!(r.message.contains("VS Code") && r.message.contains("terminal tab"));
        assert_eq!(r.hint, None);
        let r = host_app_result(HostApp::VsCodeInsiders, true);
        assert_eq!(r.activate.as_deref(), Some("com.microsoft.VSCodeInsiders"));
        assert_eq!(r.hint.as_deref(), Some("spaces-setting"));
    }

    #[test]
    fn only_expected_urls_open() {
        assert!(allowed_url("claude://claude.ai/chat/x"));
        assert!(allowed_url("codex://threads/x"));
        assert!(!allowed_url("file:///etc/passwd"));
        assert!(!allowed_url("javascript:alert(1)"));
    }
}
