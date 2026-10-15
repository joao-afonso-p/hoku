//! Claude Desktop.
//!
//! * Chats are server-side; there is no safe local index, so they are **manual only**.
//!   `normalize_chat_reference` turns URLs / deep links / bare ids into one canonical form.
//! * Cowork (local agent mode) sessions have structured JSON metadata on disk and are
//!   discovered read-only. See docs/provider-discovery.md §4.

use super::{
    app_running, ms_to_iso, now_ms, text, Observation, RuntimeCapabilities, RuntimeProbe,
    RuntimeTarget, ScanOutcome, SessionAdapter,
};
use crate::association::repository_root;
use crate::models::{Confidence, DiscoveredSession, HubError, Provider, RuntimeState, Session};
use regex::Regex;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

fn uuid_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$").unwrap()
    })
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatReference {
    /// "chat" | "project" | "cowork"
    pub kind: String,
    pub id: String,
    pub deep_link: String,
    pub web_url: Option<String>,
}

/// Accepts `https://claude.ai/chat/<uuid>`, `claude://claude.ai/chat/<uuid>`,
/// `claude://claude.ai/project/<uuid>`, `claude://claude.ai/local_sessions/local_<uuid>`
/// or a bare conversation uuid.
pub fn normalize_chat_reference(input: &str) -> Result<ChatReference, HubError> {
    let raw = input
        .trim()
        .trim_matches(|c| c == '<' || c == '>' || c == '"' || c == '\'');
    if raw.is_empty() {
        return Err(HubError::new("Paste a Claude conversation link or ID."));
    }
    let chat = |id: &str| ChatReference {
        kind: "chat".into(),
        id: id.to_lowercase(),
        deep_link: format!("claude://claude.ai/chat/{}", id.to_lowercase()),
        web_url: Some(format!("https://claude.ai/chat/{}", id.to_lowercase())),
    };
    if uuid_re().is_match(raw) {
        return Ok(chat(raw));
    }
    let rest = raw
        .strip_prefix("claude://claude.ai/")
        .or_else(|| raw.strip_prefix("https://claude.ai/"))
        .or_else(|| raw.strip_prefix("http://claude.ai/"))
        .or_else(|| raw.strip_prefix("claude.ai/"))
        .ok_or_else(|| {
            HubError::with_detail("That doesn't look like a Claude conversation link.", raw)
        })?;
    let path = rest.split(['?', '#']).next().unwrap_or("");
    let mut parts = path.trim_end_matches('/').split('/');
    match (parts.next(), parts.next(), parts.next()) {
        (Some("chat"), Some(id), None) if uuid_re().is_match(id) => Ok(chat(id)),
        (Some("project"), Some(id), None) if uuid_re().is_match(id) => Ok(ChatReference {
            kind: "project".into(),
            id: id.to_lowercase(),
            deep_link: format!("claude://claude.ai/project/{}", id.to_lowercase()),
            web_url: Some(format!("https://claude.ai/project/{}", id.to_lowercase())),
        }),
        (Some("local_sessions"), Some(id), None)
            if id.strip_prefix("local_").map(|u| uuid_re().is_match(u)).unwrap_or(false) =>
        {
            Ok(ChatReference {
                kind: "cowork".into(),
                id: id.to_string(),
                deep_link: format!("claude://claude.ai/local_sessions/{id}"),
                web_url: None,
            })
        }
        _ => Err(HubError::with_detail(
            "That link isn't a Claude conversation. Copy the link of a chat (claude.ai/chat/…) and try again.",
            raw,
        )),
    }
}

pub struct CoworkAdapter {
    root: PathBuf,
}

impl CoworkAdapter {
    pub fn new(root: PathBuf) -> Self {
        CoworkAdapter { root }
    }
}

fn num_field(v: &Value, key: &str) -> Option<i64> {
    match v.get(key)? {
        Value::Number(n) => n.as_i64(),
        Value::String(s) => s.parse().ok(),
        _ => None,
    }
}

pub fn parse_cowork_session(v: &Value, now: i64) -> Option<DiscoveredSession> {
    let id = v.get("sessionId")?.as_str()?.to_string();
    if v.get("isArchived")
        .and_then(|a| a.as_bool())
        .unwrap_or(false)
    {
        return None;
    }
    let initial = v
        .get("initialMessage")
        .and_then(|m| m.as_str())
        .unwrap_or("");
    let title = v
        .get("title")
        .and_then(|t| t.as_str())
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(|t| text::truncate(t, 64))
        .or_else(|| text::title_from_prompt(initial, 64))
        .unwrap_or_else(|| "Untitled Cowork session".into());
    let folder = v
        .get("userSelectedFolders")
        .and_then(|f| f.as_array())
        .and_then(|a| a.first())
        .and_then(|f| f.as_str())
        .map(str::to_string);
    let last_ms = num_field(v, "lastActivityAt").or_else(|| num_field(v, "createdAt"));
    let _ = now;

    let mut meta = serde_json::Map::new();
    meta.insert("surface".into(), json!("cowork"));
    if !initial.is_empty() {
        meta.insert("firstPrompt".into(), json!(text::preview(initial)));
    }
    for key in ["model", "processName"] {
        if let Some(s) = v.get(key).and_then(|m| m.as_str()) {
            meta.insert(key.into(), json!(s));
        }
    }
    if let Some(folders) = v.get("userSelectedFolders") {
        meta.insert("folders".into(), folders.clone());
    }

    Some(DiscoveredSession {
        deep_link: Some(format!("claude://claude.ai/local_sessions/{id}")),
        external_id: id,
        title,
        repository: folder.as_deref().and_then(repository_root),
        working_directory: folder,
        branch: None,
        source_url: None,
        last_activity_at: last_ms.and_then(ms_to_iso),
        account_hint: v
            .get("emailAddress")
            .and_then(|e| e.as_str())
            .map(str::to_string),
        metadata: meta,
    })
}

const SOURCE: &str = "claude-desktop-metadata";
const APP_EXECUTABLE: &str = "Claude.app/Contents/MacOS/Claude";

/// Claude Desktop exposes no turn state for Cowork, only when its metadata last changed.
/// So: app not running → offline (certain); metadata just changed → probably working (low);
/// otherwise we honestly don't know whether the session is open.
pub fn observe_cowork(app_up: bool, last_activity_ms: Option<i64>, now: i64) -> Observation {
    if !app_up {
        return Observation::new(RuntimeState::Offline, Confidence::High, SOURCE)
            .reason("Claude Desktop isn't running");
    }
    let age = last_activity_ms.map(|ms| now - ms).unwrap_or(i64::MAX);
    if age < 90_000 {
        Observation::new(RuntimeState::Working, Confidence::Low, SOURCE)
            .reason("Activity just now")
            .activity(last_activity_ms.and_then(ms_to_iso))
    } else if age < 30 * 60_000 {
        Observation::new(RuntimeState::Unknown, Confidence::Low, SOURCE)
            .reason("Claude Desktop doesn't expose live state")
    } else {
        Observation::new(RuntimeState::Offline, Confidence::Low, SOURCE)
            .reason("No recent activity")
    }
}

fn session_files(root: &Path) -> Vec<PathBuf> {
    // <root>/<account-uuid>/<org-uuid>/local_<uuid>.json
    let mut out = Vec::new();
    let Ok(accounts) = std::fs::read_dir(root) else {
        return out;
    };
    for account in accounts.flatten().filter(|e| e.path().is_dir()) {
        let Ok(orgs) = std::fs::read_dir(account.path()) else {
            continue;
        };
        for org in orgs.flatten().filter(|e| e.path().is_dir()) {
            let Ok(files) = std::fs::read_dir(org.path()) else {
                continue;
            };
            for f in files.flatten() {
                let name = f.file_name().to_string_lossy().into_owned();
                if name.starts_with("local_") && name.ends_with(".json") {
                    out.push(f.path());
                }
            }
        }
    }
    out
}

impl SessionAdapter for CoworkAdapter {
    fn key(&self) -> &'static str {
        "claude-cowork"
    }
    fn provider(&self) -> Provider {
        Provider::Claude
    }
    fn label(&self) -> &'static str {
        "Claude Desktop · Cowork"
    }

    fn scan(&self) -> Result<ScanOutcome, HubError> {
        if !self.root.is_dir() {
            return Ok(ScanOutcome::Unavailable(
                "Claude Desktop has no Cowork sessions on this Mac.".into(),
            ));
        }
        let now = now_ms();
        let found = session_files(&self.root)
            .into_iter()
            .filter_map(|p| std::fs::read_to_string(p).ok())
            .filter_map(|raw| serde_json::from_str::<Value>(&raw).ok())
            .filter_map(|v| parse_cowork_session(&v, now))
            .collect();
        Ok(ScanOutcome::Found(found))
    }

    fn owns_runtime(&self, s: &Session) -> bool {
        s.provider == Provider::Claude
            && (s.source.as_deref() == Some(self.key())
                || s.external_id
                    .as_deref()
                    .map(|e| e.starts_with("local_"))
                    .unwrap_or(false))
    }

    fn runtime(&self, targets: &[RuntimeTarget]) -> Option<RuntimeProbe> {
        if !self.root.is_dir() {
            return None;
        }
        let up = app_running(APP_EXECUTABLE);
        let now = now_ms();
        let mut observations = std::collections::HashMap::new();
        if up {
            // Only the metadata files' mtimes and lastActivityAt: cheap, and nothing else is read.
            let wanted: std::collections::HashSet<&str> =
                targets.iter().map(|t| t.external_id).collect();
            for path in session_files(&self.root) {
                let id = path
                    .file_stem()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_default();
                if !wanted.contains(id.as_str()) {
                    continue;
                }
                let modified = std::fs::metadata(&path)
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .map(|t| chrono::DateTime::<chrono::Utc>::from(t).timestamp_millis());
                observations.insert(id, observe_cowork(true, modified, now));
            }
        }
        Some(RuntimeProbe {
            observations,
            fallback: observe_cowork(up, None, now),
            unindexed_live: vec![],
        })
    }

    fn runtime_capabilities(&self) -> RuntimeCapabilities {
        RuntimeCapabilities {
            live_status: "limited",
            working: "partial",
            needs_input: "none",
            ready: "none",
            error: "none",
            detail:
                "Only whether Claude Desktop is running and when a session's metadata last changed",
        }
    }
}

// ───────────────────────────── remote Cowork (guarded) ─────────────────────────────

/// Recent Cowork sessions are server-side ("remote") and indexed by a single
/// `remote-session-spaces.json` per `<account>/<org>` dir, alongside the old `local_*.json`
/// files. Their ids use a new `session_…` form and a new `cowork_sessions` deep-link route
/// that Hoku can't yet verify, so discovery is kept in this **separate** adapter with its own
/// `flag_missing` scope, and opening never fires the unverified link. See
/// docs/provider-discovery.md §4. The existing local `CoworkAdapter` is untouched.
pub struct CoworkRemoteAdapter {
    root: PathBuf,
}

impl CoworkRemoteAdapter {
    pub fn new(root: PathBuf) -> Self {
        CoworkRemoteAdapter { root }
    }
}

const SOURCE_REMOTE: &str = "claude-desktop-remote";

/// Canonical remote-session id form, taken verbatim from Claude Desktop's own id validator
/// (`^(?:session_|cse_)(?:staging_)?[A-Za-z0-9…]+$`). A matching `id` is the strongest, narrowest
/// signal that an object is a session: spaces/projects carry bare-UUID ids, which never match.
fn remote_id_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^(?:session_|cse_)(?:staging_)?[A-Za-z0-9_-]{1,80}$").unwrap())
}

/// `<root>/<account-uuid>/<org-uuid>/remote-session-spaces.json`, mirroring `session_files`.
fn remote_index_files(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(accounts) = std::fs::read_dir(root) else {
        return out;
    };
    for account in accounts.flatten().filter(|e| e.path().is_dir()) {
        let Ok(orgs) = std::fs::read_dir(account.path()) else {
            continue;
        };
        for org in orgs.flatten().filter(|e| e.path().is_dir()) {
            let candidate = org.path().join("remote-session-spaces.json");
            if candidate.is_file() {
                out.push(candidate);
            }
        }
    }
    out
}

/// Accumulated result of walking a remote index, tracking enough to tell "understood but empty"
/// from "couldn't make sense of it" (so `scan` never returns `Found([])` on an unreadable index).
#[derive(Default)]
struct RemoteIndex {
    /// Active (non-archived) sessions to surface.
    sessions: Vec<DiscoveredSession>,
    /// Objects recognized as remote sessions, including archived ones that were skipped.
    recognized: usize,
    /// Saw an object carrying a string `id` that we did NOT recognize as a session — i.e. the
    /// file is populated with session-like data in a shape we don't understand.
    saw_unrecognized_id: bool,
}

enum RemoteObject {
    /// A live session to surface.
    Active(Box<DiscoveredSession>),
    /// Recognized as a remote session but intentionally skipped (archived).
    Skipped,
    /// Not a remote session (a space, a container, or anything ambiguous).
    NotASession,
}

/// Normalize any remote id to the canonical `session_…` form:
/// * already `session_…` → kept as-is;
/// * `cse_…` (the app's internal id) → `cse_` replaced by `session_`;
/// * anything else → prefixed with `session_`.
///
/// Deterministic and reversible enough for a stable `external_id`.
fn canonical_remote_id(id: &str) -> String {
    if id.starts_with("session_") {
        id.to_string()
    } else if let Some(rest) = id.strip_prefix("cse_") {
        format!("session_{rest}")
    } else {
        format!("session_{id}")
    }
}

/// First usable folder for a remote session: first entry of `userSelectedFolders`, else `cwd`.
fn remote_folder(v: &Value) -> Option<String> {
    v.get("userSelectedFolders")
        .and_then(|f| f.as_array())
        .and_then(|a| a.first())
        .and_then(|f| f.as_str())
        .or_else(|| v.get("cwd").and_then(|c| c.as_str()))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Strict object-shape test, grounded in the app binary. A remote session has a non-empty string
/// `id` AND a session-specific discriminator:
/// * the `id` matches the canonical `session_`/`cse_` id form (see `remote_id_re`), OR
/// * a non-null `environment_id`/`environmentId` string.
///
/// A bare-UUID `id` plus only a `status`/`title` is **not** enough — that shape is shared by spaces
/// and project objects, so it is rejected. Space objects (`name`/`folders`/`projects`/…) never
/// carry a session-form id or an environment id, so they fail here.
fn is_remote_session_shape(v: &Value) -> bool {
    let Some(map) = v.as_object() else {
        return false;
    };
    let Some(id) = map
        .get("id")
        .and_then(|i| i.as_str())
        .filter(|s| !s.is_empty())
    else {
        return false;
    };
    let id_is_session_form = remote_id_re().is_match(id);
    let has_env = map
        .get("environment_id")
        .or_else(|| map.get("environmentId"))
        .and_then(|e| e.as_str())
        .is_some();
    id_is_session_form || has_env
}

fn classify_remote_object(v: &Value, now: i64) -> RemoteObject {
    if !is_remote_session_shape(v) {
        return RemoteObject::NotASession;
    }
    let _ = now;
    let id = v.get("id").and_then(|i| i.as_str()).unwrap_or_default();
    let status = v.get("status").and_then(|s| s.as_str());
    // Archival is a boolean flag in the app (`isArchived`), as in the local format, and may also
    // appear as a `status`. Honor both so an archived session is never surfaced as live.
    let is_archived = v
        .get("isArchived")
        .and_then(|a| a.as_bool())
        .unwrap_or(false);
    if is_archived || status == Some("archived") {
        return RemoteObject::Skipped;
    }
    let external_id = canonical_remote_id(id);
    let title = v
        .get("title")
        .and_then(|t| t.as_str())
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(|t| text::truncate(t, 64))
        .unwrap_or_else(|| "Untitled Cowork session".into());
    let folder = remote_folder(v);
    let last_ms = num_field(v, "updatedAt")
        .or_else(|| num_field(v, "lastActivityAt"))
        .or_else(|| num_field(v, "createdAt"));

    let mut meta = serde_json::Map::new();
    meta.insert("surface".into(), json!("cowork"));
    meta.insert("remote".into(), json!(true));
    // Guard: the `cowork_sessions` deep link is unverified, so it lives here, not in `deep_link`.
    meta.insert("openUnverified".into(), json!(true));
    meta.insert(
        "openCandidate".into(),
        json!(format!("claude://claude.ai/cowork_sessions/{external_id}")),
    );
    if let Some(st) = status {
        meta.insert("status".into(), json!(st));
    }

    RemoteObject::Active(Box::new(DiscoveredSession {
        // No `deep_link`: `open_claude` must not fire the unverified `cowork_sessions` route.
        deep_link: None,
        external_id,
        title,
        repository: folder.as_deref().and_then(repository_root),
        working_directory: folder,
        branch: None,
        source_url: None,
        last_activity_at: last_ms.and_then(ms_to_iso),
        account_hint: None,
        metadata: meta,
    }))
}

fn collect_remote(v: &Value, now: i64, acc: &mut RemoteIndex) {
    match v {
        Value::Array(items) => {
            for item in items {
                collect_remote(item, now, acc);
            }
        }
        Value::Object(map) => match classify_remote_object(v, now) {
            RemoteObject::Active(s) => {
                acc.recognized += 1;
                acc.sessions.push(*s);
            }
            RemoteObject::Skipped => {
                acc.recognized += 1;
            }
            RemoteObject::NotASession => {
                // A session-like object (has a string `id`) we didn't recognize means the file
                // is populated in a shape we don't understand — not a legitimately empty index.
                if map.get("id").and_then(|i| i.as_str()).is_some() {
                    acc.saw_unrecognized_id = true;
                }
                // The exact container is unconfirmed, so recurse to find sessions nested anywhere.
                for child in map.values() {
                    collect_remote(child, now, acc);
                }
            }
        },
        _ => {}
    }
}

/// Tolerant to the container (recurse to locate session objects) but strict on object shape.
/// Returns only the active sessions to surface; archived and non-session objects are dropped.
/// Test-only: `scan` drives `collect_remote` directly for the fuller `RemoteIndex` accounting.
#[cfg(test)]
fn parse_remote_sessions_index(v: &Value, now: i64) -> Vec<DiscoveredSession> {
    let mut acc = RemoteIndex::default();
    collect_remote(v, now, &mut acc);
    acc.sessions
}

/// Claude Desktop exposes no per-session live state for remote Cowork sessions, and there is no
/// safe on-disk signal. So: app down → offline (certain); app up → honestly unknown.
pub fn observe_cowork_remote(app_up: bool, now: i64) -> Observation {
    let _ = now;
    if !app_up {
        Observation::new(RuntimeState::Offline, Confidence::High, SOURCE_REMOTE)
            .reason("Claude Desktop isn't running")
    } else {
        Observation::new(RuntimeState::Unknown, Confidence::Low, SOURCE_REMOTE)
            .reason("Claude Desktop doesn't expose live state for remote sessions")
    }
}

impl SessionAdapter for CoworkRemoteAdapter {
    fn key(&self) -> &'static str {
        "claude-cowork-remote"
    }
    fn provider(&self) -> Provider {
        Provider::Claude
    }
    fn label(&self) -> &'static str {
        "Claude Desktop · Cowork (remote)"
    }

    fn scan(&self) -> Result<ScanOutcome, HubError> {
        if !self.root.is_dir() {
            return Ok(ScanOutcome::Unavailable(
                "Claude Desktop has no remote Cowork sessions on this Mac.".into(),
            ));
        }
        let files = remote_index_files(&self.root);
        if files.is_empty() {
            // No index at all → leave any existing remote rows untouched (don't flag missing).
            return Ok(ScanOutcome::Unavailable(
                "Claude Desktop has no remote Cowork index on this Mac.".into(),
            ));
        }
        let now = now_ms();
        let mut acc = RemoteIndex::default();
        for path in &files {
            // "Could not read ≠ zero sessions": a present-but-unreadable or non-JSON index must
            // never become `Found([])`, or `flag_missing` would orphan still-valid remote rows.
            let Ok(raw) = std::fs::read_to_string(path) else {
                return Ok(ScanOutcome::Unavailable(
                    "Couldn't read the remote Cowork index.".into(),
                ));
            };
            let Ok(v) = serde_json::from_str::<Value>(&raw) else {
                return Err(HubError::new("A remote Cowork index wasn't valid JSON."));
            };
            collect_remote(&v, now, &mut acc);
        }
        if acc.recognized == 0 && acc.saw_unrecognized_id {
            // The index is populated with session-like objects we didn't recognize — treat as an
            // unreadable index rather than an empty one, so existing rows aren't flagged missing.
            return Err(HubError::new(
                "Hoku didn't recognize the remote Cowork index format.",
            ));
        }
        Ok(ScanOutcome::Found(acc.sessions))
    }

    fn owns_runtime(&self, s: &Session) -> bool {
        s.provider == Provider::Claude && s.source.as_deref() == Some(self.key())
    }

    fn runtime(&self, _targets: &[RuntimeTarget]) -> Option<RuntimeProbe> {
        if !self.root.is_dir() {
            return None;
        }
        let up = app_running(APP_EXECUTABLE);
        let now = now_ms();
        // No reliable per-session signal exists for remote sessions, so every owned session takes
        // the same honest fallback.
        Some(RuntimeProbe {
            observations: std::collections::HashMap::new(),
            fallback: observe_cowork_remote(up, now),
            unindexed_live: vec![],
        })
    }

    fn runtime_capabilities(&self) -> RuntimeCapabilities {
        RuntimeCapabilities {
            live_status: "limited",
            working: "none",
            needs_input: "none",
            ready: "none",
            error: "none",
            detail: "Only whether Claude Desktop is running; no live state for remote sessions",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "1f2e3d4c-5b6a-4789-8abc-def012345678";

    #[test]
    fn normalizes_all_chat_forms() {
        for input in [
            ID.to_string(),
            format!("https://claude.ai/chat/{ID}"),
            format!("https://claude.ai/chat/{ID}?foo=1"),
            format!("claude://claude.ai/chat/{ID}"),
            format!("  <https://claude.ai/chat/{}>  ", ID.to_uppercase()),
        ] {
            let r = normalize_chat_reference(&input).unwrap();
            assert_eq!(r.kind, "chat");
            assert_eq!(r.id, ID);
            assert_eq!(r.deep_link, format!("claude://claude.ai/chat/{ID}"));
        }
    }

    #[test]
    fn normalizes_projects_and_cowork() {
        assert_eq!(
            normalize_chat_reference(&format!("https://claude.ai/project/{ID}"))
                .unwrap()
                .kind,
            "project"
        );
        let c = normalize_chat_reference(&format!("claude://claude.ai/local_sessions/local_{ID}"))
            .unwrap();
        assert_eq!(c.kind, "cowork");
        assert_eq!(
            c.deep_link,
            format!("claude://claude.ai/local_sessions/local_{ID}")
        );
    }

    #[test]
    fn rejects_non_conversation_links() {
        assert!(normalize_chat_reference("https://claude.ai/settings").is_err());
        assert!(normalize_chat_reference("https://example.com/chat/x").is_err());
        assert!(normalize_chat_reference("claude://claude.ai/chat/not-a-uuid").is_err());
        assert!(normalize_chat_reference("").is_err());
    }

    #[test]
    fn parses_cowork_metadata_without_prompts() {
        let v = json!({
            "sessionId": format!("local_{ID}"), "title": "iPhone photo organization script",
            "initialMessage": "I need to run a script", "createdAt": 1, "lastActivityAt": "1788358991351",
            "isArchived": false, "userSelectedFolders": ["/nonexistent/Fotos"], "model": "claude-opus-5",
            "emailAddress": "me@example.com", "systemPrompt": "LARGE"
        });
        let s = parse_cowork_session(&v, 1788358991351 + 10_000).unwrap();
        assert_eq!(s.title, "iPhone photo organization script");
        assert_eq!(s.account_hint.as_deref(), Some("me@example.com"));
        assert_eq!(s.working_directory.as_deref(), Some("/nonexistent/Fotos"));
        assert!(!s.metadata.contains_key("systemPrompt"));
        let archived = json!({ "sessionId": "local_x", "isArchived": true });
        assert!(parse_cowork_session(&archived, 0).is_none());
    }

    #[test]
    fn cowork_runtime_is_honest_about_its_limits() {
        let o = observe_cowork(false, Some(0), 0);
        assert_eq!(
            (o.state, o.confidence),
            (RuntimeState::Offline, Confidence::High)
        );
        let o = observe_cowork(true, Some(1_000), 30_000);
        assert_eq!(
            (o.state, o.confidence),
            (RuntimeState::Working, Confidence::Low)
        );
        assert_eq!(
            observe_cowork(true, Some(0), 10 * 60_000).state,
            RuntimeState::Unknown
        );
        assert_eq!(
            observe_cowork(true, Some(0), 3 * 3_600_000).confidence,
            Confidence::Low
        );
        // Cowork never claims a session needs you — it can't know.
        assert!(!observe_cowork(true, Some(0), 1).action_required);
    }

    // ───────── remote Cowork ─────────

    #[test]
    fn normalizes_remote_ids_to_session_form() {
        assert_eq!(canonical_remote_id("session_abc"), "session_abc");
        assert_eq!(canonical_remote_id("cse_abc"), "session_abc");
        assert_eq!(canonical_remote_id("abc"), "session_abc");
    }

    #[test]
    fn remote_parse_accepts_sessions_and_fills_defaults() {
        // Accepted by `environment_id`; title present; folder from userSelectedFolders.
        let by_env = json!({
            "id": "cse_one", "environment_id": "env-1", "title": "Refactor the parser",
            "userSelectedFolders": ["/nonexistent/project"], "updatedAt": 1788358991351i64,
            "config": "BLOB", "events": "BLOB", "session_context": "BLOB"
        });
        // Accepted by canonical `session_` id form; no title → default; folder from cwd.
        let by_id = json!({
            "id": "session_two", "status": "paused", "cwd": "/nonexistent/other"
        });
        let v = json!([by_env, by_id]);
        let out = parse_remote_sessions_index(&v, 0);
        assert_eq!(out.len(), 2);

        let a = &out[0];
        assert_eq!(a.external_id, "session_one");
        assert_eq!(a.title, "Refactor the parser");
        assert_eq!(a.working_directory.as_deref(), Some("/nonexistent/project"));
        assert_eq!(a.deep_link, None);
        assert_eq!(
            a.metadata.get("surface").and_then(|v| v.as_str()),
            Some("cowork")
        );
        assert_eq!(
            a.metadata.get("remote").and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            a.metadata.get("openUnverified").and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            a.metadata.get("openCandidate").and_then(|v| v.as_str()),
            Some("claude://claude.ai/cowork_sessions/session_one")
        );
        // Never surface the heavy blobs.
        for blob in ["config", "events", "session_context"] {
            assert!(!a.metadata.contains_key(blob));
        }

        let b = &out[1];
        assert_eq!(b.external_id, "session_two");
        assert_eq!(b.title, "Untitled Cowork session");
        assert_eq!(b.working_directory.as_deref(), Some("/nonexistent/other"));
    }

    #[test]
    fn remote_parse_accepts_bare_id_with_environment_id() {
        // No `session_` id form, but a non-null environment id is a session-specific signal.
        let v = json!({ "id": "01HRAW", "environmentId": "env_9", "title": "Cloud run" });
        let out = parse_remote_sessions_index(&v, 0);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].external_id, "session_01HRAW");
    }

    #[test]
    fn remote_parse_skips_archived_and_unassigned_has_no_folder() {
        // Archived via `status`.
        let archived = json!({ "id": "session_a", "status": "archived", "title": "gone" });
        assert!(parse_remote_sessions_index(&archived, 0).is_empty());
        // Archived via the `isArchived` boolean, even when `status` says otherwise.
        let flagged = json!({ "id": "session_a2", "status": "active", "isArchived": true });
        assert!(parse_remote_sessions_index(&flagged, 0).is_empty());

        let no_folder = json!({ "id": "session_b", "status": "active", "title": "no folder" });
        let out = parse_remote_sessions_index(&no_folder, 0);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].working_directory, None);
        assert_eq!(out[0].repository, None);
    }

    #[test]
    fn remote_parse_rejects_spaces_and_ambiguous_objects() {
        // A space object: no session-form id, no environment id → never a session.
        let space = json!({
            "id": "517cceb3-24b5-45fb-8102-753cb74c3922",
            "name": "My space", "folders": ["/x"], "projects": [], "links": [],
            "instructions": "do things", "origin": "cloud",
            "createdAt": 1, "updatedAt": 2
        });
        assert!(parse_remote_sessions_index(&space, 0).is_empty());

        // The exact "uuid + status" shape the discriminator must reject: a bare-UUID id with only a
        // status (a project/space-like object) is NOT a session.
        let uuid_with_status =
            json!({ "id": "517cceb3-24b5-45fb-8102-753cb74c3922", "status": "active" });
        assert!(parse_remote_sessions_index(&uuid_with_status, 0).is_empty());

        // Empty id is not a session even with a status.
        assert!(
            parse_remote_sessions_index(&json!({ "id": "", "status": "active" }), 0).is_empty()
        );

        // Pure garbage.
        assert!(parse_remote_sessions_index(&json!({ "foo": 1 }), 0).is_empty());
        assert!(parse_remote_sessions_index(&json!("string"), 0).is_empty());
    }

    #[test]
    fn remote_parse_recurses_into_the_container() {
        // Sessions nested under an unknown container key, mixed arrays/objects.
        let nested = json!({
            "version": 1,
            "spaces": [ { "name": "S", "folders": [], "projects": [] } ],
            "sessions": [
                { "id": "session_flat", "status": "active" },
                { "wrapper": { "id": "cse_nested", "environment_id": "e" } }
            ]
        });
        let mut ids: Vec<String> = parse_remote_sessions_index(&nested, 0)
            .into_iter()
            .map(|s| s.external_id)
            .collect();
        ids.sort();
        assert_eq!(
            ids,
            vec!["session_flat".to_string(), "session_nested".to_string()]
        );
    }

    #[test]
    fn remote_runtime_is_offline_down_and_unknown_up() {
        let down = observe_cowork_remote(false, 0);
        assert_eq!(
            (down.state, down.confidence),
            (RuntimeState::Offline, Confidence::High)
        );
        let up = observe_cowork_remote(true, 0);
        assert_eq!(
            (up.state, up.confidence),
            (RuntimeState::Unknown, Confidence::Low)
        );
        assert!(!up.action_required);
    }

    fn write_remote_index(root: &Path, body: &str) -> PathBuf {
        let dir = root.join("account-uuid").join("org-uuid");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("remote-session-spaces.json");
        std::fs::write(&path, body).unwrap();
        path
    }

    #[test]
    fn remote_scan_partial_semantics_never_found_empty_on_unreadable() {
        // No root → Unavailable.
        let missing = CoworkRemoteAdapter::new(PathBuf::from("/nonexistent/hoku-remote"));
        assert!(matches!(missing.scan(), Ok(ScanOutcome::Unavailable(_))));

        // Root exists but no index file → Unavailable.
        let empty = tempfile::tempdir().unwrap();
        let adapter = CoworkRemoteAdapter::new(empty.path().to_path_buf());
        assert!(matches!(adapter.scan(), Ok(ScanOutcome::Unavailable(_))));

        // Non-JSON index → Err (not Found([])).
        let bad = tempfile::tempdir().unwrap();
        write_remote_index(bad.path(), "{ not json");
        let adapter = CoworkRemoteAdapter::new(bad.path().to_path_buf());
        assert!(adapter.scan().is_err());

        // Populated with id-bearing objects in a shape we don't recognize (no session-form id, no
        // environment id) → Err (not Found([])), so existing rows are never flagged missing.
        let unknown = tempfile::tempdir().unwrap();
        write_remote_index(
            unknown.path(),
            r#"[{"id":"517cceb3-24b5-45fb-8102-753cb74c3922","foo":"bar"}]"#,
        );
        let adapter = CoworkRemoteAdapter::new(unknown.path().to_path_buf());
        assert!(adapter.scan().is_err());

        // A real session → Found with it.
        let good = tempfile::tempdir().unwrap();
        write_remote_index(
            good.path(),
            r#"{"sessions":[{"id":"session_ok","status":"active","title":"Hi"}]}"#,
        );
        let adapter = CoworkRemoteAdapter::new(good.path().to_path_buf());
        match adapter.scan().unwrap() {
            ScanOutcome::Found(v) => {
                assert_eq!(v.len(), 1);
                assert_eq!(v[0].external_id, "session_ok");
            }
            _ => panic!("expected Found"),
        }
    }
}
