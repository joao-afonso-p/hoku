//! Provider adapters. Each adapter knows how to discover sessions for one source, read-only.
//! Opening sessions lives in `crate::launch`; UI concerns live in the frontend.

pub mod claude_code;
pub mod claude_desktop;
pub mod codex;
pub mod text;

use crate::models::{
    Confidence, DiscoveredSession, HubError, ProjectHint, Provider, RuntimeState, Session,
};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;

pub enum ScanOutcome {
    Found(Vec<DiscoveredSession>),
    /// The provider's local data isn't present on this computer. Not an error.
    Unavailable(String),
}

pub trait SessionAdapter: Send + Sync {
    /// Stable key, also used as `sessions.source`.
    fn key(&self) -> &'static str;
    fn provider(&self) -> Provider;
    fn label(&self) -> &'static str;
    fn scan(&self) -> Result<ScanOutcome, HubError>;
    /// Projects the provider itself knows about (e.g. Codex projects). Offered as suggestions.
    fn project_hints(&self) -> Vec<ProjectHint> {
        Vec::new()
    }
    /// Whether this adapter derives runtime state for a session. By default: same provider.
    fn owns_runtime(&self, s: &Session) -> bool {
        s.provider == self.provider()
    }
    /// Cheap runtime probe, run by the monitor every few seconds, read-only.
    /// `None` = this adapter can't say anything right now (the session keeps its state).
    fn runtime(&self, _targets: &[RuntimeTarget]) -> Option<RuntimeProbe> {
        None
    }
    /// What runtime signals this adapter can honestly provide.
    fn runtime_capabilities(&self) -> RuntimeCapabilities {
        RuntimeCapabilities::none("No live signal")
    }
}

/// What the monitor hands an adapter about one indexed session.
pub struct RuntimeTarget<'a> {
    pub external_id: &'a str,
    pub working_directory: Option<&'a str>,
    pub metadata: Option<&'a Value>,
}

/// One adapter's view of runtime right now.
pub struct RuntimeProbe {
    /// Keyed by external id.
    pub observations: HashMap<String, Observation>,
    /// Applies to every owned session not in `observations` (e.g. "no running process").
    pub fallback: Observation,
    /// Live sessions the provider reports that aren't indexed yet — triggers a quick discovery.
    pub unindexed_live: Vec<String>,
}

/// A raw, provider-derived observation. The monitor applies watchdog rules on top.
#[derive(Debug, Clone, PartialEq)]
pub struct Observation {
    pub state: RuntimeState,
    pub confidence: Confidence,
    pub reason: Option<String>,
    pub detail: Option<String>,
    pub source: &'static str,
    pub action_required: bool,
    /// When this state began, if the provider says.
    pub since: Option<String>,
    /// Latest activity the provider shows (feeds the stale-working watchdog and recency).
    pub activity_at: Option<String>,
}

impl Observation {
    pub fn new(state: RuntimeState, confidence: Confidence, source: &'static str) -> Self {
        Observation {
            state,
            confidence,
            reason: None,
            detail: None,
            source,
            action_required: state == RuntimeState::NeedsInput,
            since: None,
            activity_at: None,
        }
    }
    pub fn reason(mut self, r: impl Into<String>) -> Self {
        self.reason = Some(r.into());
        self
    }
    pub fn detail(mut self, d: Option<String>) -> Self {
        self.detail = d
            .map(|d| text::truncate(d.trim(), 160))
            .filter(|d| !d.is_empty());
        self
    }
    pub fn since(mut self, at: Option<String>) -> Self {
        self.since = at;
        self
    }
    pub fn activity(mut self, at: Option<String>) -> Self {
        self.activity_at = at;
        self
    }
    pub fn action(mut self, required: bool) -> Self {
        self.action_required = required;
        self
    }
}

/// Per-signal support level: "full" | "partial" | "none".
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeCapabilities {
    /// Overall: "full" | "partial" | "limited" | "none".
    pub live_status: &'static str,
    pub working: &'static str,
    pub needs_input: &'static str,
    pub ready: &'static str,
    pub error: &'static str,
    /// One line on where the signal comes from and its limits.
    pub detail: &'static str,
}

impl RuntimeCapabilities {
    pub fn none(detail: &'static str) -> Self {
        RuntimeCapabilities {
            live_status: "none",
            working: "none",
            needs_input: "none",
            ready: "none",
            error: "none",
            detail,
        }
    }
}

/// "this Mac" on macOS, "this computer" elsewhere. User-facing copy only.
pub fn computer() -> &'static str {
    if cfg!(target_os = "macos") {
        "this Mac"
    } else {
        "this computer"
    }
}

pub fn all_adapters() -> Vec<Box<dyn SessionAdapter>> {
    let home = std::path::PathBuf::from(crate::association::home_dir());
    vec![
        Box::new(claude_code::ClaudeCodeAdapter::new(home.join(".claude"))),
        Box::new(codex::CodexAdapter::new(home.join(".codex"))),
        Box::new(claude_desktop::CoworkAdapter::new(
            crate::platform::cowork_sessions_dir(&home),
        )),
    ]
}

/// Last `max` bytes of a file, starting at a line boundary. Cheap on multi-MB transcripts.
pub fn read_tail(path: &std::path::Path, max: u64) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    let start = len.saturating_sub(max);
    f.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::with_capacity((len - start) as usize);
    f.take(max).read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf).into_owned();
    Some(if start > 0 {
        text.split_once('\n')
            .map(|(_, rest)| rest.to_string())
            .unwrap_or_default()
    } else {
        text
    })
}

/// (len, mtime) — a cache key for re-parsing a file only when it changed.
pub fn file_stamp(path: &std::path::Path) -> Option<(u64, std::time::SystemTime)> {
    let m = std::fs::metadata(path).ok()?;
    Some((m.len(), m.modified().ok()?))
}

pub fn system_time_iso(t: std::time::SystemTime) -> String {
    let dt: chrono::DateTime<chrono::Utc> = t.into();
    dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Is an app bundle's main executable running? Cached per path for a few seconds: this is a
/// subprocess, and the monitor ticks often.
pub fn app_running(executable: &str) -> bool {
    use std::sync::Mutex;
    use std::time::{Duration, Instant};
    static CACHE: Mutex<Option<HashMap<String, (Instant, bool)>>> = Mutex::new(None);
    let mut guard = CACHE.lock().expect("app cache");
    let cache = guard.get_or_insert_with(HashMap::new);
    if let Some((at, v)) = cache.get(executable) {
        if at.elapsed() < Duration::from_secs(10) {
            return *v;
        }
    }
    let running = std::process::Command::new("/usr/bin/pgrep")
        .args(["-f", executable])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    cache.insert(executable.to_string(), (Instant::now(), running));
    running
}

pub fn ms_to_iso(ms: i64) -> Option<String> {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// `kill(pid, 0)` — does the process exist? (EPERM still means it exists.)
pub fn pid_alive(pid: i64) -> bool {
    if pid <= 0 || pid > i32::MAX as i64 {
        return false;
    }
    let r = unsafe { libc::kill(pid as i32, 0) };
    r == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}
