//! Precise "Go to terminal" for Claude Code sessions in VS Code's integrated terminal.
//!
//! The Hoku VS Code extension (`extensions/vscode`) publishes one record per window under
//! `<home>/Library/Application Support/com.hoku.app/vscode-bridge/windows/`, listing the pids
//! of its terminals. Hoku matches a session's process to one of those terminals from a `ps`
//! snapshot, then asks that window (by `vscode://` URI plus a request file) to show the
//! terminal. Everything read from the bridge folder is untrusted: names, owners, sizes and
//! fields are checked, and symlinks are never followed. Side effects sit behind [`Desktop`]
//! so tests never open URLs or inspect real processes.

use crate::launch::HostApp;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

pub const EXTENSION_ID: &str = "joao-afonso-p.hoku-vscode";
pub const BUNDLED_EXTENSION_VERSION: &str = "0.1.0";

/// Which VS Code build a session runs in. Each has its own URI scheme and bundle.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Flavor {
    Stable,
    Insiders,
}

impl Flavor {
    pub const ALL: [Flavor; 2] = [Flavor::Stable, Flavor::Insiders];

    /// The URI scheme, also used as the flavour's key: `vscode` or `vscode-insiders`.
    pub fn scheme(&self) -> &'static str {
        match self {
            Flavor::Stable => "vscode",
            Flavor::Insiders => "vscode-insiders",
        }
    }
    pub fn bundle_id(&self) -> &'static str {
        self.host().bundle_id()
    }
    pub fn name(&self) -> &'static str {
        self.host().name()
    }
    pub fn host(&self) -> HostApp {
        match self {
            Flavor::Stable => HostApp::VsCode,
            Flavor::Insiders => HostApp::VsCodeInsiders,
        }
    }
    pub fn from_host(host: HostApp) -> Option<Flavor> {
        match host {
            HostApp::VsCode => Some(Flavor::Stable),
            HostApp::VsCodeInsiders => Some(Flavor::Insiders),
            HostApp::ITerm | HostApp::Terminal => None,
        }
    }
    pub fn from_scheme(scheme: &str) -> Option<Flavor> {
        match scheme {
            "vscode" => Some(Flavor::Stable),
            "vscode-insiders" => Some(Flavor::Insiders),
            _ => None,
        }
    }
}

// ───────────────────────────── process snapshot ─────────────────────────────

/// One `ps -axo pid=,ppid=,comm=` snapshot: pid → (ppid, executable path).
#[derive(Debug, Clone, Default)]
pub struct ProcTable(HashMap<i64, (i64, String)>);

/// What a VS Code process is, from its executable name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodeProc {
    /// The app's main process (`Code`, `Code - Insiders`).
    Main(Flavor),
    /// A plain `Code Helper`: the terminals' pty host when it's a shell's parent.
    Helper(Flavor),
    /// `Code Helper (Plugin)`: an extension host, one per window.
    Plugin(Flavor),
    /// Renderer, GPU and other helpers.
    OtherHelper(Flavor),
}

/// Classify by the last path component of `comm`. Forks (Cursor, VSCodium…) never match.
pub fn classify(comm: &str) -> Option<CodeProc> {
    let exe = comm.rsplit('/').next().unwrap_or(comm);
    let in_bundle = comm.contains(".app/Contents/MacOS/");
    for (flavor, base) in [
        (Flavor::Insiders, "Code - Insiders"),
        (Flavor::Stable, "Code"),
    ] {
        if exe == base {
            return in_bundle.then_some(CodeProc::Main(flavor));
        }
        let Some(rest) = exe
            .strip_prefix(base)
            .and_then(|r| r.strip_prefix(" Helper"))
        else {
            continue;
        };
        return match rest {
            "" => Some(CodeProc::Helper(flavor)),
            " (Plugin)" => Some(CodeProc::Plugin(flavor)),
            r if r.starts_with(" (") && r.ends_with(')') => Some(CodeProc::OtherHelper(flavor)),
            _ => None,
        };
    }
    None
}

/// Where a process sits in VS Code.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Anchor {
    /// Inside an integrated terminal: `root` is the terminal's shell (the pid the extension
    /// reports), `pty_host` its parent `Code Helper`.
    Terminal {
        root: i64,
        pty_host: i64,
    },
    /// Started by an extension (the Claude Code panel): no terminal to select.
    ExtensionHost {
        host: i64,
    },
    None,
}

const MAX_HOPS: usize = 12;

impl ProcTable {
    pub fn parse(ps: &str) -> ProcTable {
        ProcTable(
            ps.lines()
                .filter_map(|line| {
                    let line = line.trim_start();
                    let (pid, rest) = line.split_once(char::is_whitespace)?;
                    let (ppid, comm) = rest.trim_start().split_once(char::is_whitespace)?;
                    Some((
                        pid.parse().ok()?,
                        (ppid.parse().ok()?, comm.trim().to_string()),
                    ))
                })
                .collect(),
        )
    }

    /// The real snapshot (`/bin/ps`). Never called from tests.
    pub fn snapshot() -> Option<ProcTable> {
        let out = Command::new("/bin/ps")
            .args(["-axo", "pid=,ppid=,comm="])
            .output()
            .ok()?;
        out.status
            .success()
            .then(|| ProcTable::parse(&String::from_utf8_lossy(&out.stdout)))
    }

    pub fn get(&self, pid: i64) -> Option<(i64, &str)> {
        self.0.get(&pid).map(|(ppid, comm)| (*ppid, comm.as_str()))
    }

    pub fn classify(&self, pid: i64) -> Option<CodeProc> {
        self.get(pid).and_then(|(_, comm)| classify(comm))
    }

    /// Walk up from `pid` (at most 12 hops) to the terminal or extension host it runs under.
    pub fn anchor(&self, pid: i64) -> Anchor {
        let mut cur = pid;
        let mut seen = HashSet::from([pid]);
        for _ in 0..MAX_HOPS {
            let Some((ppid, _)) = self.get(cur) else {
                return Anchor::None;
            };
            if ppid <= 1 || !seen.insert(ppid) {
                return Anchor::None;
            }
            match self.classify(ppid) {
                Some(CodeProc::Helper(_)) => {
                    return Anchor::Terminal {
                        root: cur,
                        pty_host: ppid,
                    }
                }
                Some(CodeProc::Plugin(_)) => return Anchor::ExtensionHost { host: ppid },
                _ => cur = ppid,
            }
        }
        Anchor::None
    }

    /// The main VS Code process `pid` belongs to (itself included).
    pub fn main_of(&self, pid: i64) -> Option<i64> {
        let mut cur = pid;
        let mut seen = HashSet::new();
        for _ in 0..=MAX_HOPS {
            if !seen.insert(cur) {
                return None;
            }
            let (ppid, comm) = self.get(cur)?;
            if matches!(classify(comm), Some(CodeProc::Main(_))) {
                return Some(cur);
            }
            if ppid <= 1 {
                return None;
            }
            cur = ppid;
        }
        None
    }

    /// Every running main process of this flavour. More than one means two instances
    /// (another `--user-data-dir`), whose window ids overlap.
    pub fn mains(&self, flavor: Flavor) -> Vec<i64> {
        let mut v: Vec<i64> = self
            .0
            .iter()
            .filter(|(_, (_, comm))| classify(comm) == Some(CodeProc::Main(flavor)))
            .map(|(pid, _)| *pid)
            .collect();
        v.sort_unstable();
        v
    }
}

// ───────────────────────────── side effects ─────────────────────────────

/// Everything that touches the rest of the system. Tests use a recording fake.
pub trait Desktop {
    fn now_ms(&self) -> i64;
    fn sleep_ms(&self, ms: u64);
    /// When `pid` started, in ms since the epoch.
    fn process_start_ms(&self, pid: i64) -> Option<i64>;
    /// `open -g <url>`: deliver the URI without Hoku bringing anything forward.
    fn open_url_background(&self, url: &str) -> Result<(), String>;
    /// `open <url>`: for the setup ping only.
    fn open_url(&self, url: &str) -> Result<(), String>;
    /// Would activating this app show its windows: Hoku is full screen, macOS switches
    /// desktops on activation, or the app has a window on the current desktop.
    fn spaces_ok(&self, bundle_id: &str) -> bool;
}

pub struct RealDesktop {
    pub hoku_fullscreen: bool,
}

impl Desktop for RealDesktop {
    fn now_ms(&self) -> i64 {
        now_ms()
    }
    fn sleep_ms(&self, ms: u64) {
        std::thread::sleep(std::time::Duration::from_millis(ms));
    }
    fn process_start_ms(&self, pid: i64) -> Option<i64> {
        process_start_ms(pid)
    }
    fn open_url_background(&self, url: &str) -> Result<(), String> {
        open_bridge_url(url, true)
    }
    fn open_url(&self, url: &str) -> Result<(), String> {
        open_bridge_url(url, false)
    }
    fn spaces_ok(&self, bundle_id: &str) -> bool {
        self.hoku_fullscreen
            || crate::launch::spaces_switch_on_activate()
            || crate::launch::app_window_on_current_space(bundle_id)
    }
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn open_bridge_url(url: &str, background: bool) -> Result<(), String> {
    if !valid_bridge_url(url) {
        return Err(format!("refusing to open unexpected URL: {url}"));
    }
    let mut cmd = Command::new("/usr/bin/open");
    if background {
        cmd.arg("-g");
    }
    let out = cmd.arg(url).output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

#[cfg(target_os = "macos")]
fn process_start_ms(pid: i64) -> Option<i64> {
    let pid = i32::try_from(pid).ok().filter(|p| *p > 0)?;
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as i32;
    let n = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            0,
            &mut info as *mut _ as *mut libc::c_void,
            size,
        )
    };
    (n == size).then(|| info.pbi_start_tvsec as i64 * 1000 + info.pbi_start_tvusec as i64 / 1000)
}

#[cfg(not(target_os = "macos"))]
fn process_start_ms(_: i64) -> Option<i64> {
    None
}

/// The strict shape of the only URIs Hoku sends to VS Code.
pub fn valid_bridge_url(url: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"^(vscode|vscode-insiders)://joao-afonso-p\.hoku-vscode/(focus\?windowId=\d{1,9}&request=[0-9a-f]{32}|ping\?request=[0-9a-f]{32})$",
        )
        .unwrap()
    })
    .is_match(url)
}

// ───────────────────────────── bridge files ─────────────────────────────

pub fn bridge_root(home: &Path) -> PathBuf {
    home.join("Library/Application Support/com.hoku.app/vscode-bridge")
}

const RECORD_MAX: u64 = 16_384;
const MAX_STR: usize = 64;
const MAX_TERMINALS: usize = 512;
const MAX_WINDOW_ID: u32 = 999_999_999;
/// Allowed gap between a process's real start and the start a record or registry claims.
const START_SLACK_MS: i64 = 2_000;

/// Read a regular file we own, at most `max` bytes. Symlinks, other owners and oversize files
/// are refused, and the open itself won't follow a symlink swapped in after the check.
pub(crate) fn read_owned_file(path: &Path, max: u64) -> Option<Vec<u8>> {
    let meta = fs::symlink_metadata(path).ok()?;
    if !meta.file_type().is_file() || meta.uid() != unsafe { libc::geteuid() } || meta.len() > max {
        return None;
    }
    let f = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .ok()?;
    let mut buf = Vec::new();
    f.take(max + 1).read_to_end(&mut buf).ok()?;
    (buf.len() as u64 <= max).then_some(buf)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalRef {
    pub pid: i64,
}

/// `windows/<hostPid>.json`, written by the extension (protocol v1).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowRecord {
    pub schema: u32,
    pub extension_version: String,
    pub scheme: String,
    pub app_version: String,
    pub host_pid: i64,
    pub host_started_at: i64,
    pub window_id: Option<u32>,
    pub remote: bool,
    pub uri_handled_before: bool,
    pub terminals: Vec<TerminalRef>,
    pub updated_at: i64,
}

impl WindowRecord {
    pub fn flavor(&self) -> Option<Flavor> {
        Flavor::from_scheme(&self.scheme)
    }
    fn valid(&self) -> bool {
        self.schema == 1
            && self.flavor().is_some()
            && [&self.extension_version, &self.scheme, &self.app_version]
                .iter()
                .all(|s| s.chars().count() <= MAX_STR)
            && self.host_pid > 0
            && self.terminals.len() <= MAX_TERMINALS
            && self.terminals.iter().all(|t| t.pid > 0)
            && self.window_id.is_none_or(|w| w <= MAX_WINDOW_ID)
    }
    pub fn lists(&self, pid: i64) -> bool {
        self.terminals.iter().any(|t| t.pid == pid)
    }
}

fn record_name_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^\d{1,10}\.json$").unwrap())
}

fn read_record(path: &Path, name: &str) -> Option<WindowRecord> {
    if !record_name_re().is_match(name) {
        return None;
    }
    let stem: i64 = name.strip_suffix(".json")?.parse().ok()?;
    let bytes = read_owned_file(path, RECORD_MAX)?;
    let r: WindowRecord = serde_json::from_slice(&bytes).ok()?;
    (r.valid() && r.host_pid == stem).then_some(r)
}

/// Every valid window record. Invalid files are skipped, never followed.
pub fn read_records(bridge: &Path) -> Vec<WindowRecord> {
    let Ok(entries) = fs::read_dir(bridge.join("windows")) else {
        return Vec::new();
    };
    let mut out: Vec<WindowRecord> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name();
            read_record(&e.path(), name.to_str()?)
        })
        .collect();
    out.sort_by_key(|r| r.host_pid);
    out
}

/// The record's window is still running: its extension host is alive, is that flavour's
/// `Code Helper (Plugin)`, and started when the record says (not a reused pid).
pub fn is_live(procs: &ProcTable, record: &WindowRecord, flavor: Flavor, d: &dyn Desktop) -> bool {
    record.flavor() == Some(flavor)
        && procs.classify(record.host_pid) == Some(CodeProc::Plugin(flavor))
        && d.process_start_ms(record.host_pid)
            .is_some_and(|s| (s - record.host_started_at).abs() <= START_SLACK_MS)
}

/// The live records of one flavour.
pub fn live_records<'a>(
    procs: &ProcTable,
    records: &'a [WindowRecord],
    flavor: Flavor,
    d: &dyn Desktop,
) -> Vec<&'a WindowRecord> {
    records
        .iter()
        .filter(|r| is_live(procs, r, flavor, d))
        .collect()
}

// ───────────────────────────── planning ─────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Plan {
    /// Exactly one window reports this session's terminal.
    Precise {
        record: WindowRecord,
        root: i64,
        window_id: u32,
    },
    /// No live record of this flavour at all: the extension isn't installed or running.
    NoExtension,
    /// Live records exist, but none (local, with a window id) lists the terminal.
    NotReporting,
    /// More than one live local record lists the terminal.
    Ambiguous,
    /// More than one main process of this flavour is running.
    TwoInstances,
    /// Started by an extension (the Claude Code panel), not in a terminal.
    PanelSession,
    /// Not in a VS Code terminal Hoku can identify, or the pid was reused.
    Unverified,
}

/// Decide whether, and where, a precise focus can be attempted. Pure apart from reading start
/// times through `d`. `claude_started_at` is the live registry's start time for the session's
/// own process; None for a `claude attach` / `claude agents` client found by `ps`.
pub fn plan(
    procs: &ProcTable,
    pid: i64,
    flavor: Flavor,
    records: &[WindowRecord],
    d: &dyn Desktop,
    claude_started_at: Option<i64>,
) -> Plan {
    let (root, pty_host) = match procs.anchor(pid) {
        Anchor::Terminal { root, pty_host } => (root, pty_host),
        Anchor::ExtensionHost { .. } => return Plan::PanelSession,
        Anchor::None => return Plan::Unverified,
    };
    if let Some(started) = claude_started_at {
        match d.process_start_ms(pid) {
            Some(s) if s <= started + START_SLACK_MS => {}
            _ => return Plan::Unverified,
        }
    }
    if procs.mains(flavor).len() > 1 {
        return Plan::TwoInstances;
    }
    let live = live_records(procs, records, flavor, d);
    if live.is_empty() {
        return Plan::NoExtension;
    }
    let Some(pty_main) = procs.main_of(pty_host) else {
        return Plan::NotReporting;
    };
    let matches: Vec<&WindowRecord> = live
        .into_iter()
        .filter(|r| {
            !r.remote
                && r.window_id.is_some()
                && r.lists(root)
                && procs.main_of(r.host_pid) == Some(pty_main)
        })
        .collect();
    match matches.as_slice() {
        [] => Plan::NotReporting,
        [r] => Plan::Precise {
            record: (*r).clone(),
            root,
            window_id: r.window_id.expect("filtered"),
        },
        _ => Plan::Ambiguous,
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    use std::os::unix::fs::PermissionsExt;

    pub const VSC: &str = "/Applications/Visual Studio Code.app/Contents";
    pub const INS: &str = "/Applications/Visual Studio Code - Insiders.app/Contents";

    pub fn main(pid: i64) -> String {
        format!("{pid} 1 {VSC}/MacOS/Code\n")
    }
    pub fn helper(pid: i64, ppid: i64) -> String {
        format!("{pid} {ppid} {VSC}/Frameworks/Code Helper.app/Contents/MacOS/Code Helper\n")
    }
    pub fn plugin(pid: i64, ppid: i64) -> String {
        format!("{pid} {ppid} {VSC}/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)\n")
    }

    /// One stable VS Code (500) with a pty host (510), two windows' extension hosts (511, 512),
    /// a shell (520) running claude (521), and an Insiders instance.
    pub fn table() -> ProcTable {
        let mut ps = String::from("1 0 /sbin/launchd\n");
        ps += &main(500);
        ps += &helper(510, 500);
        ps += &plugin(511, 500);
        ps += &plugin(512, 500);
        ps += &format!("513 500 {VSC}/Frameworks/Code Helper (Renderer).app/Contents/MacOS/Code Helper (Renderer)\n");
        ps += "520 510 /bin/zsh\n521 520 /Users/u/.local/share/claude/versions/2.1.282\n";
        // claude ← node (npx) ← bash ← zsh ← pty host
        ps += "530 510 /bin/zsh\n531 530 /bin/bash\n532 531 node\n533 532 claude\n";
        // claude started by the Claude Code extension: its parent is the extension host.
        ps += "540 511 /Users/u/.local/share/claude/versions/2.1.282\n";
        // claude directly under the pty host (a terminal whose process is claude).
        ps += "550 510 claude\n";
        ps += "600 1 tmux\n601 600 -zsh\n602 601 claude\n";
        ps += &format!("1100 1 {INS}/MacOS/Code - Insiders\n");
        ps += &format!("1110 1100 {INS}/Frameworks/Code - Insiders Helper.app/Contents/MacOS/Code - Insiders Helper\n");
        ps += &format!("1111 1100 {INS}/Frameworks/Code - Insiders Helper (Plugin).app/Contents/MacOS/Code - Insiders Helper (Plugin)\n");
        ps += "1120 1110 /bin/zsh\n1121 1120 claude\n";
        ps += "900 1 /Applications/Cursor.app/Contents/MacOS/Cursor\n";
        ps += "910 900 /Applications/Cursor.app/Contents/Frameworks/Cursor Helper.app/Contents/MacOS/Cursor Helper\n";
        ps += "920 910 /bin/zsh\n921 920 claude\n";
        ProcTable::parse(&ps)
    }

    /// A recording fake. The clock only moves when the code sleeps. On `open_url_background`
    /// it can play the extension: claim the request and drop a reply after `reply_after` polls.
    pub struct Fake {
        pub now: Cell<i64>,
        pub starts: HashMap<i64, i64>,
        pub spaces: bool,
        pub open_error: bool,
        pub calls: RefCell<Vec<String>>,
        pub bridge: PathBuf,
        /// Builds the reply from (request id, request JSON, time of the open).
        #[allow(clippy::type_complexity)]
        pub responder: Option<Box<dyn Fn(&str, &serde_json::Value, i64) -> serde_json::Value>>,
        pub reply_after: u32,
        pub pending: RefCell<Option<(u32, String, serde_json::Value)>>,
        /// (request file mode, requests folder mode, request JSON) seen at open time.
        pub seen_request: RefCell<Option<(u32, u32, serde_json::Value)>>,
    }

    impl Fake {
        pub fn new(bridge: &Path) -> Fake {
            Fake {
                now: Cell::new(1_700_000_000_000),
                starts: HashMap::new(),
                spaces: true,
                open_error: false,
                calls: RefCell::new(Vec::new()),
                bridge: bridge.to_path_buf(),
                responder: None,
                reply_after: 0,
                pending: RefCell::new(None),
                seen_request: RefCell::new(None),
            }
        }
        fn deliver(&self, id: &str, reply: &serde_json::Value) {
            let dir = self.bridge.join("replies");
            fs::write(dir.join(format!("{id}.json")), reply.to_string()).unwrap();
        }
    }

    impl Desktop for Fake {
        fn now_ms(&self) -> i64 {
            self.now.get()
        }
        fn sleep_ms(&self, ms: u64) {
            self.now.set(self.now.get() + ms as i64);
            let mut p = self.pending.borrow_mut();
            if let Some((n, id, reply)) = p.as_mut() {
                if *n == 0 {
                    self.deliver(id, reply);
                    *p = None;
                } else {
                    *n -= 1;
                }
            }
        }
        fn process_start_ms(&self, pid: i64) -> Option<i64> {
            self.starts.get(&pid).copied()
        }
        fn open_url_background(&self, url: &str) -> Result<(), String> {
            self.calls.borrow_mut().push(format!("open -g {url}"));
            if self.open_error {
                return Err("boom".into());
            }
            let id = url.rsplit("request=").next().unwrap().to_string();
            let req_path = self.bridge.join("requests").join(format!("{id}.json"));
            let mode = fs::metadata(&req_path).unwrap().permissions().mode() & 0o777;
            let dir_mode = fs::metadata(self.bridge.join("requests"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            let req: serde_json::Value =
                serde_json::from_slice(&fs::read(&req_path).unwrap()).unwrap();
            *self.seen_request.borrow_mut() = Some((mode, dir_mode, req.clone()));
            if let Some(responder) = &self.responder {
                // Like the extension: claim the request, keep the .claimed file around.
                fs::rename(&req_path, req_path.with_extension("claimed")).unwrap();
                let reply = responder(&id, &req, self.now.get());
                if self.reply_after == 0 {
                    self.deliver(&id, &reply);
                } else {
                    *self.pending.borrow_mut() = Some((self.reply_after - 1, id, reply));
                }
            }
            Ok(())
        }
        fn open_url(&self, url: &str) -> Result<(), String> {
            self.calls.borrow_mut().push(format!("open {url}"));
            Ok(())
        }
        fn spaces_ok(&self, bundle_id: &str) -> bool {
            self.calls.borrow_mut().push(format!("spaces {bundle_id}"));
            self.spaces
        }
    }

    pub fn record(host: i64, window: Option<u32>, terminals: &[i64]) -> WindowRecord {
        WindowRecord {
            schema: 1,
            extension_version: "0.1.0".into(),
            scheme: "vscode".into(),
            app_version: "1.139.1".into(),
            host_pid: host,
            host_started_at: 1_699_999_000_000,
            window_id: window,
            remote: false,
            uri_handled_before: false,
            terminals: terminals.iter().map(|&pid| TerminalRef { pid }).collect(),
            updated_at: 1_700_000_000_000,
        }
    }

    /// Hosts 511, 512 and 1111 are alive and started when their records say.
    pub fn fake_with_hosts(bridge: &Path) -> Fake {
        let mut f = Fake::new(bridge);
        for pid in [511, 512, 1111] {
            f.starts.insert(pid, 1_699_999_000_500);
        }
        // claude processes started before their registry entries.
        for pid in [521, 533, 540, 550, 1121, 602, 921] {
            f.starts.insert(pid, 1_699_999_500_000);
        }
        f
    }

    #[test]
    fn bundled_version_matches_the_extension() {
        let pkg: serde_json::Value =
            serde_json::from_str(include_str!("../../extensions/vscode/package.json")).unwrap();
        assert_eq!(pkg["version"], BUNDLED_EXTENSION_VERSION);
        assert_eq!(
            format!(
                "{}.{}",
                pkg["publisher"].as_str().unwrap(),
                pkg["name"].as_str().unwrap()
            ),
            EXTENSION_ID
        );
    }

    #[test]
    fn flavors() {
        assert_eq!(Flavor::Stable.scheme(), "vscode");
        assert_eq!(Flavor::Insiders.scheme(), "vscode-insiders");
        assert_eq!(Flavor::Stable.bundle_id(), "com.microsoft.VSCode");
        assert_eq!(Flavor::Insiders.name(), "VS Code Insiders");
        assert_eq!(Flavor::from_host(HostApp::VsCode), Some(Flavor::Stable));
        assert_eq!(Flavor::from_host(HostApp::ITerm), None);
        assert_eq!(
            Flavor::from_scheme("vscode-insiders"),
            Some(Flavor::Insiders)
        );
        assert_eq!(Flavor::from_scheme("cursor"), None);
    }

    #[test]
    fn classifies_vscode_executables() {
        use CodeProc::*;
        use Flavor::*;
        let cases = [
            (format!("{VSC}/MacOS/Code"), Some(Main(Stable))),
            (format!("{INS}/MacOS/Code - Insiders"), Some(Main(Insiders))),
            ("Code".to_string(), None),
            ("/usr/local/bin/Code".to_string(), None),
            (format!("{VSC}/Frameworks/Code Helper.app/Contents/MacOS/Code Helper"), Some(Helper(Stable))),
            (format!("{INS}/Frameworks/x/Code - Insiders Helper"), Some(Helper(Insiders))),
            (format!("{VSC}/Frameworks/x/Code Helper (Plugin)"), Some(Plugin(Stable))),
            (format!("{INS}/Frameworks/x/Code - Insiders Helper (Plugin)"), Some(Plugin(Insiders))),
            (format!("{VSC}/Frameworks/x/Code Helper (Renderer)"), Some(OtherHelper(Stable))),
            (format!("{VSC}/Frameworks/x/Code Helper (GPU)"), Some(OtherHelper(Stable))),
            ("/x/Code Helperish".to_string(), None),
            ("/Applications/Cursor.app/Contents/Frameworks/Cursor Helper.app/Contents/MacOS/Cursor Helper".to_string(), None),
            ("/Applications/Cursor.app/Contents/MacOS/Cursor".to_string(), None),
            ("/bin/zsh".to_string(), None),
        ];
        for (comm, want) in cases {
            assert_eq!(classify(&comm), want, "{comm}");
        }
    }

    #[test]
    fn anchors() {
        let p = table();
        assert_eq!(
            p.anchor(521),
            Anchor::Terminal {
                root: 520,
                pty_host: 510
            }
        );
        assert_eq!(
            p.anchor(533),
            Anchor::Terminal {
                root: 530,
                pty_host: 510
            }
        );
        assert_eq!(
            p.anchor(550),
            Anchor::Terminal {
                root: 550,
                pty_host: 510
            }
        );
        assert_eq!(p.anchor(540), Anchor::ExtensionHost { host: 511 });
        assert_eq!(p.anchor(602), Anchor::None, "tmux");
        assert_eq!(
            p.anchor(1121),
            Anchor::Terminal {
                root: 1120,
                pty_host: 1110
            }
        );
        assert_eq!(p.anchor(921), Anchor::None, "Cursor");
        assert_eq!(p.anchor(4242), Anchor::None, "gone");
        assert_eq!(
            ProcTable::parse("5 6 a\n6 5 b\n").anchor(5),
            Anchor::None,
            "loop"
        );
        assert_eq!(
            ProcTable::parse("5 5 a\n").anchor(5),
            Anchor::None,
            "self loop"
        );
    }

    #[test]
    fn mains_and_main_of() {
        let p = table();
        assert_eq!(p.mains(Flavor::Stable), vec![500]);
        assert_eq!(p.mains(Flavor::Insiders), vec![1100]);
        assert_eq!(p.main_of(510), Some(500));
        assert_eq!(p.main_of(521), Some(500));
        assert_eq!(p.main_of(1111), Some(1100));
        assert_eq!(p.main_of(921), None);
        assert_eq!(ProcTable::parse("5 6 a\n6 5 b\n").main_of(5), None);
    }

    fn write_record(bridge: &Path, name: &str, body: &str) {
        let dir = bridge.join("windows");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(name), body).unwrap();
    }

    fn json(r: &WindowRecord) -> String {
        serde_json::to_string(r).unwrap()
    }

    #[test]
    fn reads_only_valid_records() {
        let tmp = tempfile::tempdir().unwrap();
        let b = tmp.path();
        assert!(read_records(b).is_empty(), "no folder yet");
        write_record(b, "511.json", &json(&record(511, Some(3), &[520])));
        // The protocol's own example parses.
        write_record(
            b,
            "123.json",
            r#"{ "schema": 1, "extensionVersion": "0.1.0", "scheme": "vscode", "appVersion": "1.139.1",
                 "hostPid": 123, "hostStartedAt": 1700000000000, "windowId": null, "remote": false,
                 "uriHandledBefore": false, "terminals": [{ "pid": 456 }], "updatedAt": 1700000000000 }"#,
        );
        // Symlink to a valid record: never followed.
        let target = b.join("elsewhere.json");
        fs::write(&target, json(&record(600, Some(1), &[1]))).unwrap();
        std::os::unix::fs::symlink(&target, b.join("windows/600.json")).unwrap();
        // Oversize.
        let mut big = record(601, Some(1), &[1]);
        big.app_version = "x".repeat(20_000);
        write_record(b, "601.json", &json(&big));
        // Bad schema.
        let mut s = record(602, Some(1), &[1]);
        s.schema = 2;
        write_record(b, "602.json", &json(&s));
        // Bad names.
        write_record(b, "603.json.bak", &json(&record(603, Some(1), &[1])));
        write_record(b, "abc.json", &json(&record(604, Some(1), &[1])));
        write_record(b, "12345678901.json", &json(&record(605, Some(1), &[1])));
        // Stem isn't hostPid.
        write_record(b, "606.json", &json(&record(607, Some(1), &[1])));
        // Bad scheme.
        let mut sc = record(608, Some(1), &[1]);
        sc.scheme = "cursor".into();
        write_record(b, "608.json", &json(&sc));
        // Too many terminals (still under the size limit).
        let many: Vec<i64> = (1..=513).collect();
        write_record(b, "609.json", &json(&record(609, Some(1), &many)));
        // Bad pids, long strings, huge window id, garbage.
        write_record(b, "610.json", &json(&record(610, Some(1), &[0])));
        let mut l = record(611, Some(1), &[1]);
        l.extension_version = "9".repeat(65);
        write_record(b, "611.json", &json(&l));
        write_record(
            b,
            "612.json",
            &json(&record(612, Some(1_000_000_000), &[1])),
        );
        write_record(b, "613.json", "{not json");
        fs::create_dir(b.join("windows/614.json")).unwrap();
        // Remote windows are valid records (they count as connected) with no terminals.
        let mut r = record(615, Some(4), &[]);
        r.remote = true;
        write_record(b, "615.json", &json(&r));
        // A file owned by another user is refused too (uid check); not testable without root.

        let got: Vec<i64> = read_records(b).iter().map(|r| r.host_pid).collect();
        assert_eq!(got, vec![123, 511, 615]);
    }

    #[test]
    fn liveness_needs_a_matching_extension_host() {
        let tmp = tempfile::tempdir().unwrap();
        let p = table();
        let d = fake_with_hosts(tmp.path());
        let ok = record(511, Some(3), &[520]);
        assert!(is_live(&p, &ok, Flavor::Stable, &d));
        // Flavour mismatch.
        assert!(!is_live(&p, &ok, Flavor::Insiders, &d));
        // Dead host.
        assert!(!is_live(
            &p,
            &record(4242, Some(3), &[520]),
            Flavor::Stable,
            &d
        ));
        // Not an extension host (the pty host).
        let mut d2 = fake_with_hosts(tmp.path());
        d2.starts.insert(510, 1_699_999_000_500);
        assert!(!is_live(
            &p,
            &record(510, Some(3), &[520]),
            Flavor::Stable,
            &d2
        ));
        // Start mismatch: the pid was reused.
        let mut late = ok.clone();
        late.host_started_at -= 2_001 + 500;
        assert!(!is_live(&p, &late, Flavor::Stable, &d));
        // Unknown start time.
        let mut d3 = fake_with_hosts(tmp.path());
        d3.starts.remove(&511);
        assert!(!is_live(&p, &ok, Flavor::Stable, &d3));
        // Insiders record against the Insiders host.
        let mut ins = record(1111, Some(1), &[1120]);
        ins.scheme = "vscode-insiders".into();
        assert!(is_live(&p, &ins, Flavor::Insiders, &d));
        assert!(!is_live(&p, &ins, Flavor::Stable, &d));
    }

    const STARTED: Option<i64> = Some(1_699_999_500_100);

    #[test]
    fn plans_every_case() {
        let tmp = tempfile::tempdir().unwrap();
        let p = table();
        let d = fake_with_hosts(tmp.path());
        let a = record(511, Some(3), &[520, 530]);
        let b = record(512, Some(4), &[550]);
        let recs = vec![a.clone(), b.clone()];

        assert_eq!(
            plan(&p, 521, Flavor::Stable, &recs, &d, STARTED),
            Plan::Precise {
                record: a.clone(),
                root: 520,
                window_id: 3
            }
        );
        // Through npx: the root is the terminal's shell.
        assert_eq!(
            plan(&p, 533, Flavor::Stable, &recs, &d, STARTED),
            Plan::Precise {
                record: a.clone(),
                root: 530,
                window_id: 3
            }
        );
        // claude as the terminal's own process, in the other window.
        assert_eq!(
            plan(&p, 550, Flavor::Stable, &recs, &d, None),
            Plan::Precise {
                record: b.clone(),
                root: 550,
                window_id: 4
            }
        );
        assert_eq!(
            plan(&p, 540, Flavor::Stable, &recs, &d, STARTED),
            Plan::PanelSession
        );
        assert_eq!(
            plan(&p, 602, Flavor::Stable, &recs, &d, STARTED),
            Plan::Unverified
        );
        assert_eq!(
            plan(&p, 921, Flavor::Stable, &recs, &d, STARTED),
            Plan::Unverified
        );
        assert_eq!(
            plan(&p, 521, Flavor::Stable, &[], &d, STARTED),
            Plan::NoExtension
        );
        // Records of the other flavour don't count.
        assert_eq!(
            plan(&p, 1121, Flavor::Insiders, &recs, &d, STARTED),
            Plan::NoExtension
        );
        assert_eq!(
            plan(
                &p,
                521,
                Flavor::Stable,
                std::slice::from_ref(&b),
                &d,
                STARTED
            ),
            Plan::NotReporting
        );
        // A record without a window id can't be targeted.
        assert_eq!(
            plan(
                &p,
                521,
                Flavor::Stable,
                &[record(511, None, &[520])],
                &d,
                STARTED
            ),
            Plan::NotReporting
        );
        // Remote windows never claim local terminals.
        let mut remote = a.clone();
        remote.remote = true;
        assert_eq!(
            plan(&p, 521, Flavor::Stable, &[remote], &d, STARTED),
            Plan::NotReporting
        );
        // Two windows list the same root.
        assert_eq!(
            plan(
                &p,
                521,
                Flavor::Stable,
                &[a.clone(), record(512, Some(4), &[520])],
                &d,
                STARTED
            ),
            Plan::Ambiguous
        );
        // PID reuse: this claude started well after the registry entry.
        assert_eq!(
            plan(
                &p,
                521,
                Flavor::Stable,
                &recs,
                &d,
                Some(1_699_999_500_000 - 2_001)
            ),
            Plan::Unverified
        );
        // ...or its start time can't be read.
        let mut d2 = fake_with_hosts(tmp.path());
        d2.starts.remove(&521);
        assert_eq!(
            plan(&p, 521, Flavor::Stable, &recs, &d2, STARTED),
            Plan::Unverified
        );
        // Attach clients (no registry start) skip that guard.
        assert!(matches!(
            plan(&p, 521, Flavor::Stable, &recs, &d2, None),
            Plan::Precise { .. }
        ));
    }

    #[test]
    fn two_instances_and_foreign_pty_hosts_are_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let d = fake_with_hosts(tmp.path());
        let a = record(511, Some(3), &[520]);
        // A second stable instance (another --user-data-dir).
        let mut ps = String::new();
        for line in [
            "1 0 /sbin/launchd\n".to_string(),
            main(500),
            helper(510, 500),
            plugin(511, 500),
        ] {
            ps += &line;
        }
        ps += "520 510 /bin/zsh\n521 520 claude\n";
        let one = ProcTable::parse(&ps);
        assert!(matches!(
            plan(
                &one,
                521,
                Flavor::Stable,
                std::slice::from_ref(&a),
                &d,
                STARTED
            ),
            Plan::Precise { .. }
        ));
        let two = ProcTable::parse(&(ps.clone() + &main(700)));
        assert_eq!(
            plan(
                &two,
                521,
                Flavor::Stable,
                std::slice::from_ref(&a),
                &d,
                STARTED
            ),
            Plan::TwoInstances
        );
        // The record's host belongs to a different main process than the terminal's pty host.
        let mut split = String::from("1 0 /sbin/launchd\n");
        split += &main(500);
        split += &helper(510, 500);
        split += "511 499 /x/Code Helper (Plugin)\n499 1 /x/Other\n";
        split += "520 510 /bin/zsh\n521 520 claude\n";
        let split = ProcTable::parse(&split);
        assert_eq!(
            plan(&split, 521, Flavor::Stable, &[a], &d, STARTED),
            Plan::NotReporting
        );
    }
}
