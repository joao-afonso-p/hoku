//! Domain types shared by the database layer, provider adapters and the IPC surface.
//! Serialized as camelCase so they map 1:1 onto `src/lib/types.ts`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Provider {
    #[serde(rename = "claude-code")]
    ClaudeCode,
    #[serde(rename = "claude")]
    Claude,
    #[serde(rename = "codex")]
    Codex,
}

impl Provider {
    pub fn as_str(&self) -> &'static str {
        match self {
            Provider::ClaudeCode => "claude-code",
            Provider::Claude => "claude",
            Provider::Codex => "codex",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "claude-code" => Some(Provider::ClaudeCode),
            "claude" => Some(Provider::Claude),
            "codex" => Some(Provider::Codex),
            _ => None,
        }
    }

    /// Accounts are per vendor: Claude Code and Claude Desktop share a Claude account.
    pub fn account_provider(&self) -> &'static str {
        match self {
            Provider::ClaudeCode | Provider::Claude => "claude",
            Provider::Codex => "codex",
        }
    }
}

/// Normalized, provider-agnostic runtime state. See docs/runtime-state.md.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeState {
    /// Actively executing a turn: generating, running tools.
    Working,
    /// Blocked on an explicit human action: permission, question, confirmation.
    NeedsInput,
    /// Finished its last turn; ready for a new prompt. Not the same as NeedsInput.
    Ready,
    /// Open / alive, nothing happening.
    Idle,
    /// Known historically, no live process or activity detected.
    Offline,
    /// A blocking failure ended the last turn.
    Error,
    /// Can't be determined reliably.
    Unknown,
}

impl RuntimeState {
    pub fn as_str(&self) -> &'static str {
        match self {
            RuntimeState::Working => "working",
            RuntimeState::NeedsInput => "needs_input",
            RuntimeState::Ready => "ready",
            RuntimeState::Idle => "idle",
            RuntimeState::Offline => "offline",
            RuntimeState::Error => "error",
            RuntimeState::Unknown => "unknown",
        }
    }
    pub fn parse(s: &str) -> Self {
        match s {
            "working" => RuntimeState::Working,
            "needs_input" => RuntimeState::NeedsInput,
            "ready" => RuntimeState::Ready,
            "idle" => RuntimeState::Idle,
            "offline" => RuntimeState::Offline,
            "error" => RuntimeState::Error,
            _ => RuntimeState::Unknown,
        }
    }
    /// A live process (or loaded thread) stands behind this session.
    pub fn is_live(&self) -> bool {
        matches!(
            self,
            RuntimeState::Working
                | RuntimeState::NeedsInput
                | RuntimeState::Ready
                | RuntimeState::Idle
                | RuntimeState::Error
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Confidence {
    High,
    Medium,
    Low,
}

impl Confidence {
    pub fn as_str(&self) -> &'static str {
        match self {
            Confidence::High => "high",
            Confidence::Medium => "medium",
            Confidence::Low => "low",
        }
    }
    pub fn parse(s: &str) -> Self {
        match s {
            "high" => Confidence::High,
            "medium" => Confidence::Medium,
            _ => Confidence::Low,
        }
    }
}

/// The runtime status stored per session. Written only by the runtime monitor
/// (`crate::runtime`) and the demo loader; never by scans.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub state: RuntimeState,
    pub confidence: Confidence,
    /// Short human reason: "Waiting for permission", "Running Bash".
    pub reason: Option<String>,
    /// Optional specifics (tool name, the question asked, an error message). ≤160 chars.
    pub detail: Option<String>,
    /// Which signal produced it: "claude-code-registry", "codex-rollout", …
    pub source: Option<String>,
    /// Needs a human to act. Always true for NeedsInput; true for errors like auth failures.
    pub action_required: bool,
    /// When the current state began (provider timestamp when known).
    pub since: Option<String>,
    /// When the monitor last evaluated it.
    pub last_observed_at: Option<String>,
}

/// A semantic runtime transition, persisted for the Activity timeline.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityEvent {
    pub id: String,
    pub session_id: String,
    /// "started_working" | "needs_input" | "became_ready" | "became_idle" | "went_offline"
    /// | "error" | "resumed" | "opened" | "created" | "status_changed"
    #[serde(rename = "type")]
    pub event_type: String,
    pub provider: Provider,
    pub timestamp: String,
    /// Session title at the time of the event.
    pub title: Option<String>,
    pub from_state: Option<RuntimeState>,
    pub to_state: Option<RuntimeState>,
    pub reason: Option<String>,
    pub metadata: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub root_path: Option<String>,
    pub icon: Option<String>,
    pub color: Option<String>,
    /// Stable galaxy slot. Assigned once at creation; never recomputed.
    pub slot: i64,
    pub is_demo: bool,
    /// Archived projects leave the Galaxy but keep sessions, root and slot. Restorable.
    pub archived_at: Option<String>,
    /// Project Resume: what this project is, in the user's words (or an accepted AI draft).
    pub description: Option<String>,
    /// Project Resume: where to pick up next, in the user's words.
    pub next_step: Option<String>,
    /// When the description or next step last changed.
    pub resume_updated_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderAccount {
    pub id: String,
    pub provider: String,
    pub label: String,
    pub auth_mode: String,
    pub status: String,
    pub metadata: Option<Value>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub provider: Provider,
    pub provider_account_id: Option<String>,
    pub external_id: Option<String>,
    pub title: String,
    pub project_id: Option<String>,
    pub working_directory: Option<String>,
    pub repository: Option<String>,
    pub branch: Option<String>,
    /// Where the record came from: "manual", "claude-code-transcripts", "codex-state-db",
    /// "claude-cowork", "demo".
    pub source: Option<String>,
    pub source_url: Option<String>,
    pub deep_link: Option<String>,
    pub last_activity_at: Option<String>,
    pub last_opened_at: Option<String>,
    pub runtime: RuntimeStatus,
    pub favorite: bool,
    pub notes: Option<String>,
    pub metadata: Option<Value>,
    /// "manual" or "scan".
    pub discovery: String,
    /// User assigned a project explicitly; scans never override it.
    pub project_locked: bool,
    /// User renamed the session; scans never override it.
    pub title_locked: bool,
    /// The provider no longer has this session on disk (e.g. pruned transcript).
    pub source_missing: bool,
    /// In the user's Follow up queue. User-owned; scans and the runtime monitor never touch it.
    pub follow_up: Option<FollowUp>,
    pub created_at: String,
    pub updated_at: String,
}

/// The user's intention to come back to a session ("Review later"). Not a runtime state:
/// Needs You is the provider blocking on a human, Follow up is the human's own reminder.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FollowUp {
    /// When it was put in the queue.
    pub added_at: String,
    /// Remind at / snoozed until. None = no date, just "later".
    pub due_at: Option<String>,
}

/// What a provider adapter reports for one session. Normalized; no UI concerns.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredSession {
    pub external_id: String,
    pub title: String,
    pub working_directory: Option<String>,
    pub repository: Option<String>,
    pub branch: Option<String>,
    pub deep_link: Option<String>,
    pub source_url: Option<String>,
    pub last_activity_at: Option<String>,
    pub account_hint: Option<String>,
    pub metadata: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectHint {
    pub name: String,
    pub root_path: String,
    pub color: Option<String>,
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderScanResult {
    /// Adapter key: "claude-code-transcripts", "codex-state-db", "claude-cowork", "claude-chat".
    pub adapter: String,
    pub provider: Provider,
    pub label: String,
    /// "ok" | "unavailable" | "manual-only" | "error"
    pub status: String,
    pub found: usize,
    pub new: usize,
    pub updated: usize,
    pub message: Option<String>,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSuggestion {
    pub name: String,
    pub root_path: String,
    pub color: Option<String>,
    pub session_count: usize,
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanReport {
    pub started_at: String,
    pub finished_at: String,
    pub results: Vec<ProviderScanResult>,
    pub suggestions: Vec<ProjectSuggestion>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionLink {
    pub from_id: String,
    pub to_id: String,
    pub kind: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HubSnapshot {
    pub projects: Vec<Project>,
    pub sessions: Vec<Session>,
    pub accounts: Vec<ProviderAccount>,
    pub links: Vec<SessionLink>,
    pub last_scans: Vec<ScanRun>,
    pub settings: serde_json::Map<String, Value>,
    /// Recent semantic runtime events, newest first.
    pub activity: Vec<ActivityEvent>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanRun {
    pub adapter: String,
    pub finished_at: String,
    pub found: i64,
    pub new: i64,
    pub updated: i64,
    pub status: String,
}

/// Error surfaced to the UI: a human sentence plus optional technical detail.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HubError {
    pub message: String,
    pub detail: Option<String>,
}

impl HubError {
    pub fn new(message: impl Into<String>) -> Self {
        HubError {
            message: message.into(),
            detail: None,
        }
    }
    pub fn with_detail(message: impl Into<String>, detail: impl ToString) -> Self {
        HubError {
            message: message.into(),
            detail: Some(detail.to_string()),
        }
    }
}

impl From<rusqlite::Error> for HubError {
    fn from(e: rusqlite::Error) -> Self {
        HubError::with_detail("The local Hoku database could not be updated.", e)
    }
}

pub type HubResult<T> = Result<T, HubError>;
