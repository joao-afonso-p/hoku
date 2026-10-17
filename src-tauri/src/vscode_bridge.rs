//! Precise "Go to terminal" for Claude Code sessions in VS Code's integrated terminal.
//!
//! The Hoku VS Code extension (`extensions/vscode`) publishes one record per window under
//! `<home>/Library/Application Support/com.hoku.app/vscode-bridge/windows/`, listing the pids
//! of its terminals. Hoku matches a session's process to one of those terminals from a `ps`
//! snapshot, then asks that window (by `vscode://` URI plus a request file) to show the
//! terminal. Everything read from the bridge folder is untrusted: names, owners, sizes and
//! fields are checked, and symlinks are never followed. Side effects sit behind [`Desktop`]
//! so tests never open URLs or inspect real processes.

use crate::launch::{host_app_result, HostApp, OpenResult, Shown};
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

// ───────────────────────────── requests and replies ─────────────────────────────

const REPLY_MAX: u64 = 4_096;
/// How long Hoku waits for a focus reply (the extension itself waits up to 1.5 s for focus).
pub const FOCUS_WAIT_MS: i64 = 3_000;
/// How long the setup ping waits (VS Code may first ask whether to allow the link).
pub const PING_WAIT_MS: i64 = 60_000;
const POLL_MS: u64 = 50;
/// Requests and replies older than this are garbage.
const STALE_MS: i64 = 60_000;
/// Window records this fresh are never collected: their window may have started after the
/// `ps` snapshot was taken.
const RECORD_GRACE_MS: i64 = 5_000;

pub fn focus_url(flavor: Flavor, window_id: u32, id: &str) -> String {
    format!(
        "{}://{EXTENSION_ID}/focus?windowId={window_id}&request={id}",
        flavor.scheme()
    )
}

pub fn ping_url(flavor: Flavor, id: &str) -> String {
    format!("{}://{EXTENSION_ID}/ping?request={id}", flavor.scheme())
}

/// A fresh request id: 32 lowercase hex.
pub fn new_request_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

fn valid_request_id(id: &str) -> bool {
    id.len() == 32
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Create the bridge folders (0700) and make sure they're private, real folders we own.
/// `com.hoku.app` itself is created if missing but never chmodded.
pub fn ensure_dirs(bridge: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    if let Some(parent) = bridge.parent() {
        fs::create_dir_all(parent)?;
    }
    for dir in [
        bridge.to_path_buf(),
        bridge.join("windows"),
        bridge.join("requests"),
        bridge.join("replies"),
    ] {
        match fs::DirBuilder::new().mode(0o700).create(&dir) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e),
        }
        let meta = fs::symlink_metadata(&dir)?;
        if !meta.file_type().is_dir() || meta.uid() != unsafe { libc::geteuid() } {
            return Err(std::io::Error::other(
                "the bridge folder isn't a private folder",
            ));
        }
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// Write `dir/name` atomically with mode 0600: a `wx` temp file, then rename.
fn write_atomic(dir: &Path, name: &str, contents: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let tmp = dir.join(format!("{name}.tmp-{}", &new_request_id()[..8]));
    let written = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&tmp)
        .and_then(|mut f| f.write_all(contents))
        .and_then(|_| fs::rename(&tmp, dir.join(name)));
    if written.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    written
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequestKind {
    Focus { pid: i64, window_id: u32 },
    Ping,
}

impl RequestKind {
    pub fn name(&self) -> &'static str {
        match self {
            RequestKind::Focus { .. } => "focus",
            RequestKind::Ping => "ping",
        }
    }
}

/// `requests/<id>.json` (protocol v1).
pub fn write_request(
    bridge: &Path,
    id: &str,
    kind: RequestKind,
    created_at: i64,
) -> std::io::Result<()> {
    if !valid_request_id(id) {
        return Err(std::io::Error::other("invalid request id"));
    }
    let body = match kind {
        RequestKind::Focus { pid, window_id } => serde_json::json!({
            "schema": 1, "id": id, "kind": kind.name(), "pid": pid, "windowId": window_id, "createdAt": created_at,
        }),
        RequestKind::Ping => serde_json::json!({
            "schema": 1, "id": id, "kind": kind.name(), "createdAt": created_at,
        }),
    };
    write_atomic(
        &bridge.join("requests"),
        &format!("{id}.json"),
        body.to_string().as_bytes(),
    )
}

/// `replies/<id>.json`, written by the extension.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reply {
    pub schema: u32,
    pub id: String,
    pub kind: String,
    pub window_id: Option<i64>,
    pub host_pid: i64,
    pub status: String,
    pub shown_at: Option<i64>,
    pub focused_at: Option<i64>,
    pub replied_at: Option<i64>,
}

/// The reply to exactly this request id, if one has arrived (same file checks as records).
pub fn read_reply(bridge: &Path, id: &str) -> Option<Reply> {
    if !valid_request_id(id) {
        return None;
    }
    let bytes = read_owned_file(
        &bridge.join("replies").join(format!("{id}.json")),
        REPLY_MAX,
    )?;
    serde_json::from_slice(&bytes).ok()
}

/// Poll every 50 ms for this request's reply until `deadline` (ms since the epoch).
pub fn wait_for_reply(d: &dyn Desktop, bridge: &Path, id: &str, deadline: i64) -> Option<Reply> {
    loop {
        if let Some(r) = read_reply(bridge, id) {
            return Some(r);
        }
        if d.now_ms() >= deadline {
            return None;
        }
        d.sleep_ms(POLL_MS);
    }
}

/// Remove a request, its claimed copy and its reply. `remove_file` never follows symlinks.
pub fn cleanup_request(bridge: &Path, id: &str) {
    if !valid_request_id(id) {
        return;
    }
    let _ = fs::remove_file(bridge.join("requests").join(format!("{id}.json")));
    let _ = fs::remove_file(bridge.join("requests").join(format!("{id}.claimed")));
    let _ = fs::remove_file(bridge.join("replies").join(format!("{id}.json")));
}

fn mtime_ms(meta: &fs::Metadata) -> i64 {
    meta.mtime() * 1000 + meta.mtime_nsec() / 1_000_000
}

/// Remove stale requests and replies (older than 60 s) and the records of windows that are
/// gone or whose pid now belongs to another process. Symlinks are removed, never followed.
pub fn gc(d: &dyn Desktop, bridge: &Path, procs: &ProcTable) {
    let now = d.now_ms();
    for sub in ["requests", "replies"] {
        let Ok(entries) = fs::read_dir(bridge.join(sub)) else {
            continue;
        };
        for e in entries.flatten() {
            let Ok(meta) = fs::symlink_metadata(e.path()) else {
                continue;
            };
            if !meta.file_type().is_dir() && now - mtime_ms(&meta) > STALE_MS {
                let _ = fs::remove_file(e.path());
            }
        }
    }
    let Ok(entries) = fs::read_dir(bridge.join("windows")) else {
        return;
    };
    for e in entries.flatten() {
        let path = e.path();
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        let age = now - mtime_ms(&meta);
        if meta.file_type().is_dir() || age <= RECORD_GRACE_MS {
            continue;
        }
        let name = e.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let dead = match read_record(&path, name) {
            Some(r) => !r.flavor().is_some_and(|f| is_live(procs, &r, f, d)),
            // An interrupted write.
            None => name.contains(".tmp-") && age > STALE_MS,
        };
        if dead {
            let _ = fs::remove_file(&path);
        }
    }
}

// ───────────────────────────── precise attempt ─────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Attempt {
    /// The window showed the terminal, confirmed focus, and it's on a reachable desktop.
    Precise,
    /// Shown, but the window didn't confirm it came forward.
    ShownUnfocused,
    /// Shown and focused, but on another desktop macOS won't switch to.
    Elsewhere,
    /// No reply in time. `handled_before`: the window has handled a Hoku link before, so it
    /// isn't waiting on VS Code's "allow this extension to open a link" prompt.
    Timeout { handled_before: bool },
    /// The window replied, but not with a valid "shown" for this request.
    Rejected(String),
    /// The request couldn't be written or the URI couldn't be opened.
    OpenFailed,
}

/// Ask the window in `record` to show the terminal whose process is `root`, and wait (≤ 3 s)
/// for its reply. The request, its claimed copy and the reply are always removed.
pub fn attempt(
    d: &dyn Desktop,
    procs: &ProcTable,
    bridge: &Path,
    flavor: Flavor,
    record: &WindowRecord,
    root: i64,
    window_id: u32,
) -> Attempt {
    gc(d, bridge, procs);
    if ensure_dirs(bridge).is_err() {
        return Attempt::OpenFailed;
    }
    let id = new_request_id();
    let created = d.now_ms();
    let kind = RequestKind::Focus {
        pid: root,
        window_id,
    };
    let url = focus_url(flavor, window_id, &id);
    if !valid_bridge_url(&url)
        || write_request(bridge, &id, kind, created).is_err()
        || d.open_url_background(&url).is_err()
    {
        cleanup_request(bridge, &id);
        return Attempt::OpenFailed;
    }
    let reply = wait_for_reply(d, bridge, &id, created + FOCUS_WAIT_MS);
    cleanup_request(bridge, &id);
    match reply {
        None => Attempt::Timeout {
            handled_before: record.uri_handled_before,
        },
        Some(reply) => evaluate_focus_reply(d, flavor, record, window_id, &id, created, &reply),
    }
}

/// Precise success needs this request's own "shown" reply from the targeted window, with
/// `createdAt ≤ shownAt ≤ focusedAt`, and a desktop the user can see.
pub fn evaluate_focus_reply(
    d: &dyn Desktop,
    flavor: Flavor,
    record: &WindowRecord,
    window_id: u32,
    id: &str,
    created: i64,
    reply: &Reply,
) -> Attempt {
    if reply.schema != 1 {
        return Attempt::Rejected("invalid".into());
    }
    if reply.id != id
        || reply.kind != "focus"
        || reply.window_id != Some(window_id as i64)
        || reply.host_pid != record.host_pid
    {
        return Attempt::Rejected("wrong-window".into());
    }
    if reply.status != "shown" {
        return Attempt::Rejected(reply.status.chars().take(32).collect());
    }
    let shown = match reply.shown_at {
        Some(s) if s >= created => s,
        _ => return Attempt::Rejected("invalid".into()),
    };
    if !reply.focused_at.is_some_and(|f| f >= shown) {
        return Attempt::ShownUnfocused;
    }
    if d.spaces_ok(flavor.bundle_id()) {
        Attempt::Precise
    } else {
        Attempt::Elsewhere
    }
}

/// The setup step's answer from a window of this flavour.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ping {
    Pong,
    NoReply,
    OpenFailed,
}

/// Send a ping (`open`, not `open -g`: the user is setting up and may need to answer VS Code's
/// prompt) and wait up to `wait_ms` for this request's `pong`. Cleans up either way. The
/// caller checks first that exactly one instance of this flavour is running.
pub fn ping(d: &dyn Desktop, bridge: &Path, flavor: Flavor, wait_ms: i64) -> Ping {
    if ensure_dirs(bridge).is_err() {
        return Ping::OpenFailed;
    }
    let id = new_request_id();
    let created = d.now_ms();
    let url = ping_url(flavor, &id);
    if !valid_bridge_url(&url)
        || write_request(bridge, &id, RequestKind::Ping, created).is_err()
        || d.open_url(&url).is_err()
    {
        cleanup_request(bridge, &id);
        return Ping::OpenFailed;
    }
    let reply = wait_for_reply(d, bridge, &id, created + wait_ms);
    cleanup_request(bridge, &id);
    match reply {
        Some(r) if r.schema == 1 && r.id == id && r.kind == "ping" && r.status == "pong" => {
            Ping::Pong
        }
        _ => Ping::NoReply,
    }
}

// ───────────────────────────── outcome → message ─────────────────────────────

/// Everything "Go to terminal" in VS Code can end with: a plan that ruled out a precise
/// attempt, or the attempt's result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Precise,
    ShownUnfocused,
    Elsewhere,
    Timeout { handled_before: bool },
    Rejected(String),
    OpenFailed,
    NoExtension,
    NotReporting,
    Ambiguous,
    TwoInstances,
    PanelSession,
    Unverified,
}

impl From<Attempt> for Outcome {
    fn from(a: Attempt) -> Outcome {
        match a {
            Attempt::Precise => Outcome::Precise,
            Attempt::ShownUnfocused => Outcome::ShownUnfocused,
            Attempt::Elsewhere => Outcome::Elsewhere,
            Attempt::Timeout { handled_before } => Outcome::Timeout { handled_before },
            Attempt::Rejected(s) => Outcome::Rejected(s),
            Attempt::OpenFailed => Outcome::OpenFailed,
        }
    }
}

impl From<Plan> for Outcome {
    fn from(p: Plan) -> Outcome {
        match p {
            // A precise plan always becomes an attempt; never claim success from a plan.
            Plan::Precise { .. } => Outcome::Unverified,
            Plan::NoExtension => Outcome::NoExtension,
            Plan::NotReporting => Outcome::NotReporting,
            Plan::Ambiguous => Outcome::Ambiguous,
            Plan::TwoInstances => Outcome::TwoInstances,
            Plan::PanelSession => Outcome::PanelSession,
            Plan::Unverified => Outcome::Unverified,
        }
    }
}

/// The message for an outcome. Only `Precise` leaves `activate` empty: the window already came
/// forward, and activating the app afterwards could raise a different VS Code window.
pub fn vscode_result(flavor: Flavor, shown: Shown, outcome: Outcome) -> OpenResult {
    let name = flavor.name();
    let fallback = |message: String, hint: Option<&str>| OpenResult {
        method: "focus".into(),
        message,
        activate: Some(flavor.bundle_id().into()),
        hint: hint.map(Into::into),
    };
    match outcome {
        Outcome::Precise => OpenResult {
            method: "focus".into(),
            message: match shown {
                Shown::Session => format!("Switched to this session's terminal in {name}"),
                Shown::Dashboard => {
                    format!("Switched to `claude agents` in {name}. Pick this session there.")
                }
            },
            activate: None,
            hint: None,
        },
        Outcome::ShownUnfocused => fallback(
            format!("Selected the session's terminal in {name}, but couldn't confirm its window came forward."),
            None,
        ),
        Outcome::Elsewhere => fallback(
            format!("The session is in {name} on another desktop"),
            Some("spaces-setting"),
        ),
        Outcome::Timeout { handled_before: false } => fallback(
            format!("Switched to {name}, but it didn't confirm the session's window. {name} may be asking whether to allow the Hoku extension to open a link: choose Open, then click Go to terminal again."),
            Some("vscode-setup"),
        ),
        Outcome::Timeout { handled_before: true } | Outcome::OpenFailed => fallback(
            format!("Switched to {name}, but it didn't confirm the session's window and terminal. Pick it there."),
            None,
        ),
        Outcome::Rejected(_) => fallback(
            format!("Switched to {name}, but the session's window didn't have its terminal any more. Pick it there."),
            None,
        ),
        Outcome::NoExtension => fallback(
            format!("Switched to {name}, where this session is running. Hoku couldn't select its window and terminal."),
            Some("vscode-extension"),
        ),
        Outcome::NotReporting => fallback(
            format!("Switched to {name}. This session's window isn't reporting to Hoku (reload it, or check the Hoku extension is installed in that VS Code profile)."),
            None,
        ),
        Outcome::Ambiguous | Outcome::TwoInstances => fallback(
            format!("Switched to {name}. Hoku couldn't tell which window holds this session, so it didn't pick one."),
            None,
        ),
        Outcome::PanelSession | Outcome::Unverified => host_app_result(flavor.host(), shown, false),
    }
}

/// "Go to terminal" for a process hosted by VS Code: plan, attempt when it's safe, and say
/// what happened. When no precise attempt is possible and VS Code's windows are on a desktop
/// macOS won't switch to, keep the "on another desktop" answer (checked before anything runs).
/// Generic activation (`OpenResult.activate`) only ever happens in fallbacks, after this returns.
pub fn focus(
    d: &dyn Desktop,
    procs: &ProcTable,
    bridge: &Path,
    flavor: Flavor,
    pid: i64,
    claude_started_at: Option<i64>,
    shown: Shown,
) -> OpenResult {
    let elsewhere = !d.spaces_ok(flavor.bundle_id());
    let records = read_records(bridge);
    let outcome = match plan(procs, pid, flavor, &records, d, claude_started_at) {
        Plan::Precise {
            record,
            root,
            window_id,
        } => attempt(d, procs, bridge, flavor, &record, root, window_id).into(),
        _ if elsewhere => return host_app_result(flavor.host(), shown, true),
        other => other.into(),
    };
    vscode_result(flavor, shown, outcome)
}

// ───────────────────────────── setup: status, install, ping ─────────────────────────────

/// How long `code --list-extensions` may take before Hoku stops it.
pub const LIST_TIMEOUT_MS: u64 = 10_000;
/// How long `code --install-extension` may take before Hoku stops it.
pub const INSTALL_TIMEOUT_MS: u64 = 120_000;

impl Flavor {
    /// The app bundle's name in `/Applications`.
    pub fn app_name(&self) -> &'static str {
        match self {
            Flavor::Stable => "Visual Studio Code",
            Flavor::Insiders => "Visual Studio Code - Insiders",
        }
    }
}

/// One VS Code build's extension status, for the setup sheet and the Integrations row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VsCodeStatus {
    pub flavor: &'static str,
    pub name: &'static str,
    pub app_installed: bool,
    /// Running main processes. More than one means two instances.
    pub running: usize,
    pub installed_version: Option<String>,
    pub bundled_version: &'static str,
    /// This build of Hoku carries the VSIX.
    pub bundled: bool,
    /// Live window records, remote ones included.
    pub connected_windows: usize,
    pub uri_handled_before: bool,
}

/// The setup ping's answer: "ready", "no-reply", "not-running" or "two-instances".
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SetupResult {
    pub status: &'static str,
}

/// Where the app bundle may live when LaunchServices doesn't know it.
pub fn app_fallbacks(flavor: Flavor, home: &Path) -> [PathBuf; 2] {
    let bundle = format!("{}.app", flavor.app_name());
    [
        Path::new("/Applications").join(&bundle),
        home.join("Applications").join(&bundle),
    ]
}

/// The app bundle: LaunchServices' answer for the bundle id first, then the usual folders.
pub fn find_app(flavor: Flavor, home: &Path) -> Option<PathBuf> {
    app_by_bundle_id(flavor.bundle_id())
        .into_iter()
        .chain(app_fallbacks(flavor, home))
        .find(|p| p.extension().is_some_and(|e| e == "app") && p.is_dir())
}

#[cfg(target_os = "macos")]
fn app_by_bundle_id(bundle_id: &str) -> Option<PathBuf> {
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::NSString;
    let url = NSWorkspace::sharedWorkspace()
        .URLForApplicationWithBundleIdentifier(&NSString::from_str(bundle_id))?;
    Some(PathBuf::from(url.path()?.to_string()))
}

#[cfg(not(target_os = "macos"))]
fn app_by_bundle_id(_: &str) -> Option<PathBuf> {
    None
}

/// The bundled command-line launcher: `bin/code-insiders` when present, else `bin/code`.
pub fn cli_path(app: &Path) -> Option<PathBuf> {
    let bin = app.join("Contents/Resources/app/bin");
    [bin.join("code-insiders"), bin.join("code")]
        .into_iter()
        .find(|p| p.is_file())
}

/// Arguments to list installed extensions with their versions.
pub fn list_args() -> Vec<std::ffi::OsString> {
    vec!["--list-extensions".into(), "--show-versions".into()]
}

/// Arguments to install (or reinstall) the bundled VSIX. Only Hoku's own resource path.
pub fn install_args(vsix: &Path) -> Vec<std::ffi::OsString> {
    vec![
        "--install-extension".into(),
        vsix.as_os_str().to_os_string(),
        "--force".into(),
    ]
}

/// The Hoku extension's version in `--list-extensions --show-versions` output.
pub fn parse_installed_version(out: &str) -> Option<String> {
    out.lines().find_map(|line| {
        let (id, version) = line.trim().split_once('@')?;
        let version = version.trim();
        (id.eq_ignore_ascii_case(EXTENSION_ID)
            && !version.is_empty()
            && version.len() <= MAX_STR
            && version
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+')))
        .then(|| version.to_string())
    })
}

/// Assemble one flavour's status from what's on disk and in the process table.
pub fn status_for(
    flavor: Flavor,
    app_installed: bool,
    installed_version: Option<String>,
    bundled: bool,
    procs: &ProcTable,
    records: &[WindowRecord],
    d: &dyn Desktop,
) -> VsCodeStatus {
    let live = live_records(procs, records, flavor, d);
    VsCodeStatus {
        flavor: flavor.scheme(),
        name: flavor.name(),
        app_installed,
        running: procs.mains(flavor).len(),
        installed_version,
        bundled_version: BUNDLED_EXTENSION_VERSION,
        bundled,
        connected_windows: live.len(),
        uri_handled_before: live.iter().any(|r| r.uri_handled_before),
    }
}

/// The setup step: ask the one running instance of this flavour to answer a ping. The caller
/// has already yielded the foreground, since VS Code may need to ask the user first.
pub fn setup_ping(
    d: &dyn Desktop,
    bridge: &Path,
    flavor: Flavor,
    procs: &ProcTable,
    wait_ms: i64,
) -> SetupResult {
    let status = match procs.mains(flavor).len() {
        0 => "not-running",
        1 => match ping(d, bridge, flavor, wait_ms) {
            Ping::Pong => "ready",
            Ping::NoReply | Ping::OpenFailed => "no-reply",
        },
        _ => "two-instances",
    };
    SetupResult { status }
}

/// What a finished CLI run printed.
pub struct CliOutput {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
}

/// Run the VS Code CLI with fixed arguments (no shell), killing it after `timeout_ms`.
pub fn run_cli(
    cli: &Path,
    args: &[std::ffi::OsString],
    timeout_ms: u64,
) -> Result<CliOutput, String> {
    use std::process::Stdio;
    use std::time::{Duration, Instant};
    let mut child = Command::new(cli)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let mut out = child.stdout.take().expect("piped");
    let mut err = child.stderr.take().expect("piped");
    let out_t = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = out.read_to_string(&mut s);
        s
    });
    let err_t = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = err.read_to_string(&mut s);
        s
    });
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() >= Duration::from_millis(timeout_ms) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("stopped after {} seconds", timeout_ms / 1000));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(e) => return Err(e.to_string()),
        }
    };
    Ok(CliOutput {
        success: status.success(),
        stdout: out_t.join().unwrap_or_default(),
        stderr: err_t.join().unwrap_or_default(),
    })
}

/// The last `max` characters of `s`, trimmed: enough of a CLI's stderr to explain a failure.
pub fn tail(s: &str, max: usize) -> String {
    let s = s.trim();
    let n = s.chars().count();
    s.chars().skip(n.saturating_sub(max)).collect()
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

    /// Plays the extension: builds a reply from (request id, request JSON, time of the open).
    pub type Responder = Box<dyn Fn(&str, &serde_json::Value, i64) -> serde_json::Value>;

    /// A recording fake. The clock only moves when the code sleeps. On an open it can play
    /// the extension: claim the request and drop a reply after `reply_after` polls.
    pub struct Fake {
        pub now: Cell<i64>,
        pub starts: HashMap<i64, i64>,
        pub spaces: bool,
        pub open_error: bool,
        pub calls: RefCell<Vec<String>>,
        pub bridge: PathBuf,
        /// Builds the reply from (request id, request JSON, time of the open).
        pub responder: Option<Responder>,
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
            self.respond(url)
        }
        fn open_url(&self, url: &str) -> Result<(), String> {
            self.calls.borrow_mut().push(format!("open {url}"));
            self.respond(url)
        }
        fn spaces_ok(&self, bundle_id: &str) -> bool {
            self.calls.borrow_mut().push(format!("spaces {bundle_id}"));
            self.spaces
        }
    }

    impl Fake {
        fn respond(&self, url: &str) -> Result<(), String> {
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

    // ───────────── commit 4: attempt, gc, ping, results, focus ─────────────

    const ID: &str = "0123456789abcdef0123456789abcdef";

    #[test]
    fn bridge_urls_are_strict() {
        let f = focus_url(Flavor::Stable, 3, ID);
        assert_eq!(
            f,
            format!("vscode://joao-afonso-p.hoku-vscode/focus?windowId=3&request={ID}")
        );
        assert!(valid_bridge_url(&f));
        assert!(valid_bridge_url(&focus_url(
            Flavor::Insiders,
            999_999_999,
            ID
        )));
        assert!(valid_bridge_url(&ping_url(Flavor::Insiders, ID)));
        assert!(valid_bridge_url(&focus_url(
            Flavor::Stable,
            1,
            &new_request_id()
        )));
        let bad = [
            format!("{f}&x=1"),
            format!("{f}#frag"),
            format!("{f}\n"),
            format!("{f}\nvscode://joao-afonso-p.hoku-vscode/ping?request={ID}"),
            f.replace("joao-afonso-p.hoku-vscode", "evil.ext"),
            f.replace("vscode://", "cursor://"),
            f.replace("vscode://", "https://"),
            format!("{f}0"),
            f.replace(ID, &ID.to_uppercase()),
            f.replace(ID, "0123"),
            f.replace("windowId=3", "windowId=1234567890"),
            f.replace("windowId=3", "windowId=-3"),
            f.replace("windowId=3&", "windowId=3&windowId=4&"),
            format!("vscode://joao-afonso-p.hoku-vscode/ping?request={ID}&windowId=3"),
            format!("vscode://joao-afonso-p.hoku-vscode/other?request={ID}"),
        ];
        for url in bad {
            assert!(!valid_bridge_url(&url), "{url:?}");
        }
    }

    fn shown_reply(id: &str, created: i64) -> serde_json::Value {
        serde_json::json!({
            "schema": 1, "id": id, "kind": "focus", "windowId": 3, "hostPid": 511,
            "status": "shown", "shownAt": created + 100, "focusedAt": created + 300,
            "repliedAt": created + 310,
        })
    }

    fn files_in(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = fs::read_dir(dir)
            .map(|es| {
                es.flatten()
                    .map(|e| e.file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default();
        v.sort();
        v
    }

    fn opens(d: &Fake) -> Vec<String> {
        d.calls
            .borrow()
            .iter()
            .filter(|c| c.starts_with("open"))
            .cloned()
            .collect()
    }

    /// Run one attempt against window 511 (window id 3) with a fake extension whose reply is
    /// `shown_reply` changed by `edit`.
    fn attempt_with(
        edit: impl Fn(&mut serde_json::Value) + 'static,
        spaces: bool,
    ) -> (Attempt, Fake, tempfile::TempDir) {
        let tmp = tempfile::tempdir().unwrap();
        let bridge = tmp.path().join("vscode-bridge");
        let mut d = fake_with_hosts(&bridge);
        d.spaces = spaces;
        d.responder = Some(Box::new(move |id, _, now| {
            let mut r = shown_reply(id, now);
            edit(&mut r);
            r
        }));
        let rec = record(511, Some(3), &[520]);
        let got = attempt(&d, &table(), &bridge, Flavor::Stable, &rec, 520, 3);
        (got, d, tmp)
    }

    #[test]
    fn a_confirmed_reply_is_precise_and_leaves_nothing_behind() {
        let (got, d, tmp) = attempt_with(|_| {}, true);
        assert_eq!(got, Attempt::Precise);
        let calls = opens(&d);
        assert_eq!(calls.len(), 1, "{calls:?}");
        let url = calls[0]
            .strip_prefix("open -g ")
            .expect("background open only");
        assert!(valid_bridge_url(url) && url.contains("/focus?windowId=3&request="));
        let (mode, dir_mode, req) = d.seen_request.borrow().clone().unwrap();
        assert_eq!(mode, 0o600);
        assert_eq!(dir_mode, 0o700);
        assert_eq!(req["schema"], 1);
        assert_eq!(req["kind"], "focus");
        assert_eq!(req["pid"], 520);
        assert_eq!(req["windowId"], 3);
        assert_eq!(req["createdAt"], 1_700_000_000_000i64);
        assert!(url.ends_with(req["id"].as_str().unwrap()));
        let bridge = tmp.path().join("vscode-bridge");
        for sub in ["", "windows", "requests", "replies"] {
            let m = fs::metadata(bridge.join(sub)).unwrap().permissions().mode() & 0o777;
            assert_eq!(m, 0o700, "{sub}");
        }
        assert!(files_in(&bridge.join("requests")).is_empty());
        assert!(files_in(&bridge.join("replies")).is_empty());
    }

    #[test]
    fn a_late_reply_within_three_seconds_still_counts() {
        let tmp = tempfile::tempdir().unwrap();
        let bridge = tmp.path().join("vscode-bridge");
        let rec = record(511, Some(3), &[520]);
        for (polls, want) in [
            (10, Attempt::Precise),
            (59, Attempt::Precise),
            (
                62,
                Attempt::Timeout {
                    handled_before: false,
                },
            ),
        ] {
            let mut d = fake_with_hosts(&bridge);
            d.reply_after = polls;
            d.responder = Some(Box::new(|id, _, now| shown_reply(id, now)));
            assert_eq!(
                attempt(&d, &table(), &bridge, Flavor::Stable, &rec, 520, 3),
                want,
                "{polls}"
            );
            assert!(d.now_ms() <= 1_700_000_000_000 + FOCUS_WAIT_MS + 50);
        }
        // A reply that turns up after Hoku stopped waiting is cleaned up by the next gc.
    }

    #[test]
    fn an_earlier_clicks_reply_is_ignored() {
        let tmp = tempfile::tempdir().unwrap();
        let bridge = tmp.path().join("vscode-bridge");
        ensure_dirs(&bridge).unwrap();
        fs::write(
            bridge.join("replies").join(format!("{ID}.json")),
            shown_reply(ID, 1_700_000_000_000).to_string(),
        )
        .unwrap();
        let d = fake_with_hosts(&bridge);
        let mut rec = record(511, Some(3), &[520]);
        assert_eq!(
            attempt(&d, &table(), &bridge, Flavor::Stable, &rec, 520, 3),
            Attempt::Timeout {
                handled_before: false
            }
        );
        rec.uri_handled_before = true;
        assert_eq!(
            attempt(&d, &table(), &bridge, Flavor::Stable, &rec, 520, 3),
            Attempt::Timeout {
                handled_before: true
            }
        );
        assert!(files_in(&bridge.join("requests")).is_empty());
    }

    #[test]
    fn replies_are_bound_to_the_request_and_window() {
        use serde_json::json;
        type Edit = Box<dyn Fn(&mut serde_json::Value)>;
        let rejected = |s: &str| Attempt::Rejected(s.into());
        let cases: Vec<(&str, Edit, Attempt)> = vec![
            (
                "other id",
                Box::new(|r| r["id"] = json!(ID)),
                rejected("wrong-window"),
            ),
            (
                "ping kind",
                Box::new(|r| r["kind"] = json!("ping")),
                rejected("wrong-window"),
            ),
            (
                "other window",
                Box::new(|r| r["windowId"] = json!(4)),
                rejected("wrong-window"),
            ),
            (
                "no window",
                Box::new(|r| r["windowId"] = json!(null)),
                rejected("wrong-window"),
            ),
            (
                "other host",
                Box::new(|r| r["hostPid"] = json!(512)),
                rejected("wrong-window"),
            ),
            (
                "schema",
                Box::new(|r| r["schema"] = json!(2)),
                rejected("invalid"),
            ),
            (
                "not-found",
                Box::new(|r| r["status"] = json!("not-found")),
                rejected("not-found"),
            ),
            (
                "expired",
                Box::new(|r| r["status"] = json!("expired")),
                rejected("expired"),
            ),
            (
                "remote",
                Box::new(|r| r["status"] = json!("remote")),
                rejected("remote"),
            ),
            (
                "wrong-window",
                Box::new(|r| r["status"] = json!("wrong-window")),
                rejected("wrong-window"),
            ),
            (
                "pong",
                Box::new(|r| r["status"] = json!("pong")),
                rejected("pong"),
            ),
            (
                "not shown",
                Box::new(|r| r["shownAt"] = json!(null)),
                rejected("invalid"),
            ),
            (
                "shown before the request",
                Box::new(|r| r["shownAt"] = json!(1_700_000_000_000i64 - 1)),
                rejected("invalid"),
            ),
            (
                "no focus",
                Box::new(|r| r["focusedAt"] = json!(null)),
                Attempt::ShownUnfocused,
            ),
            (
                "focus before show",
                Box::new(|r| r["focusedAt"] = json!(1_700_000_000_000i64 + 50)),
                Attempt::ShownUnfocused,
            ),
        ];
        for (what, edit, want) in cases {
            let (got, d, _tmp) = attempt_with(edit, true);
            assert_eq!(got, want, "{what}");
            // Only a confirmed, focused reply asks about desktops.
            assert!(
                !d.calls.borrow().iter().any(|c| c.starts_with("spaces")),
                "{what}"
            );
        }
        // Shown and focused, but on a desktop macOS won't switch to.
        assert_eq!(attempt_with(|_| {}, false).0, Attempt::Elsewhere);
    }

    #[test]
    fn a_failed_open_cleans_up() {
        let tmp = tempfile::tempdir().unwrap();
        let bridge = tmp.path().join("vscode-bridge");
        let mut d = fake_with_hosts(&bridge);
        d.open_error = true;
        let rec = record(511, Some(3), &[520]);
        assert_eq!(
            attempt(&d, &table(), &bridge, Flavor::Stable, &rec, 520, 3),
            Attempt::OpenFailed
        );
        assert_eq!(opens(&d).len(), 1);
        assert!(files_in(&bridge.join("requests")).is_empty());
        // A bridge folder that's a symlink is refused before anything is written or opened.
        let tmp2 = tempfile::tempdir().unwrap();
        let real = tmp2.path().join("real");
        fs::create_dir(&real).unwrap();
        let linked = tmp2.path().join("vscode-bridge");
        std::os::unix::fs::symlink(&real, &linked).unwrap();
        let d2 = fake_with_hosts(&linked);
        assert_eq!(
            attempt(&d2, &table(), &linked, Flavor::Stable, &rec, 520, 3),
            Attempt::OpenFailed
        );
        assert!(opens(&d2).is_empty());
        assert!(files_in(&real).is_empty());
    }

    #[test]
    fn gc_removes_stale_requests_and_dead_windows() {
        let tmp = tempfile::tempdir().unwrap();
        let bridge = tmp.path().join("vscode-bridge");
        ensure_dirs(&bridge).unwrap();
        for f in [
            "requests/a.json",
            "requests/b.claimed",
            "replies/c.json",
            "requests/x.json.tmp-1",
        ] {
            fs::write(bridge.join(f), "{}").unwrap();
        }
        write_record(&bridge, "511.json", &json(&record(511, Some(3), &[520])));
        write_record(&bridge, "4242.json", &json(&record(4242, Some(3), &[520])));
        let mut reused = record(512, Some(4), &[]);
        reused.host_started_at = 1;
        write_record(&bridge, "512.json", &json(&reused));
        write_record(&bridge, "abc.json", "{}");
        let outside = tmp.path().join("outside.json");
        fs::write(&outside, json(&record(4343, Some(1), &[1]))).unwrap();
        std::os::unix::fs::symlink(&outside, bridge.join("windows/4343.json")).unwrap();

        // Just written: within the grace period, so dead windows stay; requests aren't stale.
        let d = fake_with_hosts(&bridge);
        d.now.set(now_ms() + 2_000);
        gc(&d, &bridge, &table());
        assert_eq!(files_in(&bridge.join("requests")).len(), 3);
        assert_eq!(files_in(&bridge.join("windows")).len(), 5);

        d.now.set(now_ms() + 120_000);
        gc(&d, &bridge, &table());
        assert!(files_in(&bridge.join("requests")).is_empty());
        assert!(files_in(&bridge.join("replies")).is_empty());
        assert_eq!(
            files_in(&bridge.join("windows")),
            vec!["4343.json", "511.json", "abc.json"]
        );
        assert!(outside.exists(), "symlinks are never followed");
    }

    #[test]
    fn ping_waits_for_its_own_pong() {
        let tmp = tempfile::tempdir().unwrap();
        let bridge = tmp.path().join("vscode-bridge");
        let mut d = fake_with_hosts(&bridge);
        d.reply_after = 100;
        d.responder = Some(Box::new(|id, req, now| {
            assert_eq!(req["kind"], "ping");
            assert!(req.get("windowId").is_none() && req.get("pid").is_none());
            serde_json::json!({
                "schema": 1, "id": id, "kind": "ping", "windowId": 3, "hostPid": 511,
                "status": "pong", "shownAt": null, "focusedAt": null, "repliedAt": now,
            })
        }));
        assert_eq!(
            ping(&d, &bridge, Flavor::Insiders, PING_WAIT_MS),
            Ping::Pong
        );
        let calls = opens(&d);
        assert_eq!(calls.len(), 1);
        assert!(
            calls[0].starts_with("open vscode-insiders://joao-afonso-p.hoku-vscode/ping?request=")
        );
        assert!(files_in(&bridge.join("requests")).is_empty());
        assert!(files_in(&bridge.join("replies")).is_empty());

        let silent = fake_with_hosts(&bridge);
        assert_eq!(ping(&silent, &bridge, Flavor::Stable, 1_000), Ping::NoReply);
        assert!(files_in(&bridge.join("requests")).is_empty());
    }

    fn every_outcome() -> Vec<Outcome> {
        vec![
            Outcome::Precise,
            Outcome::ShownUnfocused,
            Outcome::Elsewhere,
            Outcome::Timeout {
                handled_before: false,
            },
            Outcome::Timeout {
                handled_before: true,
            },
            Outcome::Rejected("not-found".into()),
            Outcome::OpenFailed,
            Outcome::NoExtension,
            Outcome::NotReporting,
            Outcome::Ambiguous,
            Outcome::TwoInstances,
            Outcome::PanelSession,
            Outcome::Unverified,
        ]
    }

    #[test]
    fn every_outcome_has_its_message() {
        for flavor in Flavor::ALL {
            for shown in [Shown::Session, Shown::Dashboard] {
                for outcome in every_outcome() {
                    let r = vscode_result(flavor, shown, outcome.clone());
                    let precise = outcome == Outcome::Precise;
                    assert_eq!(r.method, "focus");
                    assert_eq!(r.activate.is_none(), precise, "{outcome:?}");
                    if !precise {
                        assert_eq!(r.activate.as_deref(), Some(flavor.bundle_id()));
                    }
                    assert_eq!(
                        r.message.contains("Switched to this session's terminal"),
                        precise && shown == Shown::Session,
                        "{outcome:?}"
                    );
                    assert!(r.message.contains(flavor.name()), "{outcome:?}");
                    let hint = match outcome {
                        Outcome::Elsewhere => Some("spaces-setting"),
                        Outcome::Timeout {
                            handled_before: false,
                        } => Some("vscode-setup"),
                        Outcome::NoExtension => Some("vscode-extension"),
                        _ => None,
                    };
                    assert_eq!(r.hint.as_deref(), hint, "{outcome:?}");
                    assert!(!r.message.contains("terminal tab"), "{outcome:?}");
                }
            }
        }
        let name = |o| vscode_result(Flavor::Stable, Shown::Session, o).message;
        assert_eq!(
            name(Outcome::Precise),
            "Switched to this session's terminal in VS Code"
        );
        assert_eq!(
            vscode_result(Flavor::Insiders, Shown::Dashboard, Outcome::Precise).message,
            "Switched to `claude agents` in VS Code Insiders. Pick this session there."
        );
        assert!(name(Outcome::Timeout {
            handled_before: false
        })
        .contains("choose Open"));
        assert!(!name(Outcome::Timeout {
            handled_before: true
        })
        .contains("choose Open"));
        assert!(name(Outcome::PanelSession).contains("window and terminal"));
        assert!(name(Outcome::Ambiguous).contains("didn't pick one"));
        assert_eq!(name(Outcome::TwoInstances), name(Outcome::Ambiguous));
        assert_eq!(
            name(Outcome::OpenFailed),
            name(Outcome::Timeout {
                handled_before: true
            })
        );
        assert!(name(Outcome::NotReporting).contains("isn't reporting"));
        assert!(name(Outcome::Rejected("expired".into())).contains("didn't have its terminal"));
        assert!(name(Outcome::ShownUnfocused).starts_with("Selected the session's terminal"));
    }

    /// The full click: only a precise result leaves `activate` empty; every other result asks
    /// for generic activation, which `commands::bring_forward` performs after `focus` returned.
    /// The fake never sees a foreground open.
    #[test]
    fn focus_activates_only_after_a_failed_or_skipped_attempt() {
        let tmp = tempfile::tempdir().unwrap();
        let bridge = tmp.path().join("vscode-bridge");
        let p = table();
        let responder = || -> Responder { Box::new(|id, _, now| shown_reply(id, now)) };

        // No extension yet.
        let d = fake_with_hosts(&bridge);
        let r = focus(
            &d,
            &p,
            &bridge,
            Flavor::Stable,
            521,
            STARTED,
            Shown::Session,
        );
        assert_eq!(r.hint.as_deref(), Some("vscode-extension"));
        assert_eq!(r.activate.as_deref(), Some("com.microsoft.VSCode"));
        assert!(opens(&d).is_empty());

        // ...and VS Code's windows are on another desktop: today's answer.
        let mut d = fake_with_hosts(&bridge);
        d.spaces = false;
        let r = focus(
            &d,
            &p,
            &bridge,
            Flavor::Stable,
            521,
            STARTED,
            Shown::Session,
        );
        assert_eq!(r.message, "The session is in VS Code on another desktop");
        assert_eq!(r.hint.as_deref(), Some("spaces-setting"));
        assert!(r.activate.is_some() && opens(&d).is_empty());

        write_record(
            &bridge,
            "511.json",
            &json(&record(511, Some(3), &[520, 530])),
        );
        write_record(&bridge, "512.json", &json(&record(512, Some(4), &[550])));

        // Precise: one background open, no activation.
        let mut d = fake_with_hosts(&bridge);
        d.responder = Some(responder());
        let r = focus(
            &d,
            &p,
            &bridge,
            Flavor::Stable,
            521,
            STARTED,
            Shown::Session,
        );
        assert_eq!(r.activate, None);
        assert_eq!(r.message, "Switched to this session's terminal in VS Code");
        let calls = opens(&d);
        assert_eq!(calls.len(), 1);
        assert!(
            calls[0].starts_with("open -g vscode://joao-afonso-p.hoku-vscode/focus?windowId=3&")
        );
        let (_, _, req) = d.seen_request.borrow().clone().unwrap();
        assert_eq!(req["pid"], 520);

        // A `claude agents` client in the other window.
        let mut d = fake_with_hosts(&bridge);
        d.responder = Some(Box::new(|id, _, now| {
            let mut r = shown_reply(id, now);
            r["windowId"] = serde_json::json!(4);
            r["hostPid"] = serde_json::json!(512);
            r
        }));
        let r = focus(&d, &p, &bridge, Flavor::Stable, 550, None, Shown::Dashboard);
        assert_eq!(r.activate, None);
        assert!(r.message.contains("claude agents"));

        // Precise plan but the window is on another desktop: the attempt says so.
        let mut d = fake_with_hosts(&bridge);
        d.responder = Some(responder());
        d.spaces = false;
        let r = focus(
            &d,
            &p,
            &bridge,
            Flavor::Stable,
            521,
            STARTED,
            Shown::Session,
        );
        assert_eq!(r.hint.as_deref(), Some("spaces-setting"));
        assert!(r.activate.is_some());

        // No reply: fall back to activation, after the attempt.
        let d = fake_with_hosts(&bridge);
        let r = focus(
            &d,
            &p,
            &bridge,
            Flavor::Stable,
            521,
            STARTED,
            Shown::Session,
        );
        assert_eq!(r.hint.as_deref(), Some("vscode-setup"));
        assert!(r.activate.is_some());
        assert_eq!(opens(&d).len(), 1);
        assert!(opens(&d)[0].starts_with("open -g "));

        // Panel sessions, tmux and reused pids make no window-level claim and open nothing.
        for (pid, started) in [(540, STARTED), (602, STARTED), (521, Some(1))] {
            let mut d = fake_with_hosts(&bridge);
            d.responder = Some(responder());
            let r = focus(
                &d,
                &p,
                &bridge,
                Flavor::Stable,
                pid,
                started,
                Shown::Session,
            );
            assert!(r.activate.is_some(), "{pid}");
            assert!(r.message.contains("window and terminal"), "{pid}");
            assert!(opens(&d).is_empty(), "{pid}");
        }
    }

    // ───────────── setup: status, install, ping ─────────────

    #[test]
    fn install_and_list_arguments_are_fixed() {
        let vsix = Path::new("/Applications/Hoku.app/Contents/Resources/vscode/hoku-vscode.vsix");
        assert_eq!(
            install_args(vsix),
            vec![
                std::ffi::OsString::from("--install-extension"),
                vsix.as_os_str().to_os_string(),
                "--force".into(),
            ]
        );
        // A path with spaces or shell characters stays one argument; no shell is involved.
        let odd = Path::new("/tmp/a b;$(x)/hoku-vscode.vsix");
        assert_eq!(install_args(odd)[1], odd.as_os_str());
        assert_eq!(list_args(), vec!["--list-extensions", "--show-versions"]);
    }

    #[test]
    fn parses_the_installed_version() {
        let out = "ms-python.python@2024.1.0\njoao-afonso-p.hoku-vscode@0.1.0\nfoo.bar@1.0.0\n";
        assert_eq!(parse_installed_version(out).as_deref(), Some("0.1.0"));
        assert_eq!(
            parse_installed_version("Joao-Afonso-P.Hoku-VSCode@0.2.0-beta.1\r\n").as_deref(),
            Some("0.2.0-beta.1")
        );
        assert_eq!(parse_installed_version(""), None);
        assert_eq!(parse_installed_version("ms-python.python@2024.1.0"), None);
        assert_eq!(parse_installed_version("joao-afonso-p.hoku-vscode"), None);
        assert_eq!(parse_installed_version("joao-afonso-p.hoku-vscode@"), None);
        assert_eq!(
            parse_installed_version("x.joao-afonso-p.hoku-vscode@1.0.0"),
            None
        );
        assert_eq!(
            parse_installed_version("joao-afonso-p.hoku-vscode@1.0; rm"),
            None
        );
    }

    #[test]
    fn finds_the_cli_and_app_fallbacks() {
        let tmp = tempfile::tempdir().unwrap();
        let app = tmp.path().join("Visual Studio Code - Insiders.app");
        let bin = app.join("Contents/Resources/app/bin");
        fs::create_dir_all(&bin).unwrap();
        assert_eq!(cli_path(&app), None);
        fs::write(bin.join("code"), "").unwrap();
        assert_eq!(cli_path(&app), Some(bin.join("code")));
        fs::write(bin.join("code-insiders"), "").unwrap();
        assert_eq!(cli_path(&app), Some(bin.join("code-insiders")));

        let home = Path::new("/Users/someone");
        assert_eq!(
            app_fallbacks(Flavor::Stable, home),
            [
                PathBuf::from("/Applications/Visual Studio Code.app"),
                PathBuf::from("/Users/someone/Applications/Visual Studio Code.app"),
            ]
        );
        assert_eq!(
            app_fallbacks(Flavor::Insiders, home)[1],
            PathBuf::from("/Users/someone/Applications/Visual Studio Code - Insiders.app")
        );
    }

    #[test]
    fn assembles_status_from_records_and_processes() {
        let tmp = tempfile::tempdir().unwrap();
        let d = fake_with_hosts(tmp.path());
        let mut remote = record(512, Some(4), &[]);
        remote.remote = true;
        remote.uri_handled_before = true;
        let mut dead = record(777, Some(5), &[]);
        dead.uri_handled_before = true;
        let mut insiders = record(1111, Some(1), &[1120]);
        insiders.scheme = "vscode-insiders".into();
        let records = vec![record(511, Some(3), &[520]), remote, dead, insiders];

        let s = status_for(
            Flavor::Stable,
            true,
            Some("0.1.0".into()),
            true,
            &table(),
            &records,
            &d,
        );
        assert_eq!(
            s,
            VsCodeStatus {
                flavor: "vscode",
                name: "VS Code",
                app_installed: true,
                running: 1,
                installed_version: Some("0.1.0".into()),
                bundled_version: BUNDLED_EXTENSION_VERSION,
                bundled: true,
                connected_windows: 2,
                uri_handled_before: true,
            }
        );
        let json = serde_json::to_value(&s).unwrap();
        for key in [
            "appInstalled",
            "installedVersion",
            "bundledVersion",
            "connectedWindows",
            "uriHandledBefore",
        ] {
            assert!(json.get(key).is_some(), "{key}");
        }

        let i = status_for(Flavor::Insiders, true, None, false, &table(), &records, &d);
        assert_eq!(
            (i.flavor, i.running, i.connected_windows),
            ("vscode-insiders", 1, 1)
        );
        assert!(!i.uri_handled_before && !i.bundled && i.installed_version.is_none());

        let none = status_for(
            Flavor::Stable,
            true,
            None,
            true,
            &ProcTable::parse("1 0 /sbin/launchd\n"),
            &records,
            &d,
        );
        assert_eq!((none.running, none.connected_windows), (0, 0));
    }

    fn pong_responder(reply_id: Option<&'static str>) -> Responder {
        Box::new(move |id, req, now| {
            assert_eq!(req["kind"], "ping");
            serde_json::json!({
                "schema": 1, "id": reply_id.unwrap_or(id), "kind": "ping", "windowId": 3,
                "hostPid": 511, "status": "pong", "shownAt": null, "focusedAt": null,
                "repliedAt": now,
            })
        })
    }

    fn leftovers(bridge: &Path) -> Vec<String> {
        let mut v = files_in(&bridge.join("requests"));
        v.extend(files_in(&bridge.join("replies")));
        v
    }

    #[test]
    fn setup_ping_is_ready_on_its_own_pong() {
        let tmp = tempfile::tempdir().unwrap();
        let bridge = tmp.path().join("vscode-bridge");
        let mut d = fake_with_hosts(&bridge);
        d.reply_after = 20;
        d.responder = Some(pong_responder(None));
        let r = setup_ping(&d, &bridge, Flavor::Stable, &table(), PING_WAIT_MS);
        assert_eq!(r.status, "ready");
        let calls = opens(&d);
        assert_eq!(calls.len(), 1);
        assert!(calls[0].starts_with("open vscode://joao-afonso-p.hoku-vscode/ping?request="));
        assert!(leftovers(&bridge).is_empty());
    }

    #[test]
    fn setup_ping_ignores_a_reply_for_another_request() {
        let tmp = tempfile::tempdir().unwrap();
        let bridge = tmp.path().join("vscode-bridge");
        let other = "0123456789abcdef0123456789abcdef";

        // A reply in this request's file that names another request isn't a pong.
        let mut d = fake_with_hosts(&bridge);
        d.responder = Some(pong_responder(Some(other)));
        let r = setup_ping(&d, &bridge, Flavor::Stable, &table(), 2_000);
        assert_eq!(r.status, "no-reply");
        assert!(leftovers(&bridge).is_empty());

        // An earlier request's pong left in the folder doesn't answer this one.
        let stale = serde_json::json!({
            "schema": 1, "id": other, "kind": "ping", "windowId": 3, "hostPid": 511,
            "status": "pong", "shownAt": null, "focusedAt": null, "repliedAt": 1,
        });
        fs::write(
            bridge.join("replies").join(format!("{other}.json")),
            stale.to_string(),
        )
        .unwrap();
        let d = fake_with_hosts(&bridge);
        let r = setup_ping(&d, &bridge, Flavor::Stable, &table(), 2_000);
        assert_eq!(r.status, "no-reply");
        assert!(
            d.now_ms() >= 1_700_000_000_000 + 2_000,
            "waited the full time"
        );
        assert!(files_in(&bridge.join("requests")).is_empty());
        assert_eq!(
            files_in(&bridge.join("replies")),
            vec![format!("{other}.json")]
        );
    }

    #[test]
    fn setup_ping_times_out_and_cleans_up() {
        let tmp = tempfile::tempdir().unwrap();
        let bridge = tmp.path().join("vscode-bridge");
        let d = fake_with_hosts(&bridge);
        let r = setup_ping(&d, &bridge, Flavor::Stable, &table(), PING_WAIT_MS);
        assert_eq!(r.status, "no-reply");
        assert!(d.now_ms() >= 1_700_000_000_000 + PING_WAIT_MS);
        assert!(leftovers(&bridge).is_empty());

        let mut failing = fake_with_hosts(&bridge);
        failing.open_error = true;
        let r = setup_ping(&failing, &bridge, Flavor::Stable, &table(), PING_WAIT_MS);
        assert_eq!(r.status, "no-reply");
        assert!(leftovers(&bridge).is_empty());
    }

    #[test]
    fn setup_ping_needs_exactly_one_instance() {
        let tmp = tempfile::tempdir().unwrap();
        let bridge = tmp.path().join("vscode-bridge");
        let mut d = fake_with_hosts(&bridge);
        d.responder = Some(pong_responder(None));

        let nothing = ProcTable::parse("1 0 /sbin/launchd\n");
        let r = setup_ping(&d, &bridge, Flavor::Stable, &nothing, PING_WAIT_MS);
        assert_eq!(r.status, "not-running");

        let two = ProcTable::parse(&(main(500) + &main(700)));
        let r = setup_ping(&d, &bridge, Flavor::Stable, &two, PING_WAIT_MS);
        assert_eq!(r.status, "two-instances");

        // Two stable instances say nothing about Insiders, which isn't running.
        let r = setup_ping(&d, &bridge, Flavor::Insiders, &two, PING_WAIT_MS);
        assert_eq!(r.status, "not-running");

        assert!(
            opens(&d).is_empty(),
            "nothing is opened without exactly one instance"
        );
        assert!(leftovers(&bridge).is_empty());
    }

    #[test]
    fn tail_keeps_the_end() {
        assert_eq!(tail("  short  ", 300), "short");
        let long = "a".repeat(400) + "the end";
        let t = tail(&long, 300);
        assert_eq!(t.chars().count(), 300);
        assert!(t.ends_with("the end"));
        assert_eq!(tail("ééé", 2), "éé");
    }
}
