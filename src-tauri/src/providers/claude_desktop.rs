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
}
